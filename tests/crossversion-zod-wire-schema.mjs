// Cross-version regression for the Zod boundary that broke OMP tool forwarding.
//
// This is not a simulation: it builds property schemas with four *real* pinned
// Zod versions, hands them to the real `createSdkMcpServer`, and reads the real
// `tools/list` response over an in-memory MCP transport — the same path Claude
// Code drives. The SDK renders that response with its own bundled Zod (4.4.3),
// so a host version mismatch reproduces production exactly.
//
// The versions are devDependency aliases (`zod-4-5-3: npm:zod@4.5.3`), so the
// matrix is pinned by the lockfile and needs no network at test time. Kept out
// of the `tests/unit-*.mjs` glob because it loads four extra pinned copies of
// Zod, but it runs as part of `bun test` (via all.test.mjs) and standalone via
// `bun run test:crossversion`.
//
// Boundary under test: from Zod 4.5.3 the record JSON-Schema processor requires
// `ctx.deferred`, which the SDK's bundled 4.4.3 `initializeContext()` does not
// allocate. Pinning `_zod.toJSONSchema` keeps that processor from ever running.

import assert from "node:assert/strict";
import test from "node:test";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z as repoZod } from "zod";
import { jsonSchemaPropertyToZod, pinWireSchema, resolveWireSnapshot } from "../src/typebox-to-zod.ts";

import { z as z443 } from "zod-4-4-3";
import { z as z452 } from "zod-4-5-2";
import { z as z453 } from "zod-4-5-3";
import { z as z465 } from "zod-4-6-5";

const HOSTS = [["4.4.3", z443], ["4.5.2", z452], ["4.5.3", z453], ["4.6.5", z465]];
/** Versions whose record processor needs `ctx.deferred` (absent in the SDK's 4.4.3). */
const BREAKS_UNPINNED = new Set(["4.5.3", "4.6.5"]);

// A property set covering the constructs the bridge emits, including the
// object-typed property (`env`) that took the whole namespace down.
const OMP_PROPERTIES = {
	cmd: { type: "string", description: "The command to run" },
	env: { type: "object", description: "Extra environment variables" },
	mode: { enum: ["read", "write"], description: "Access mode" },
	// Non-string enum: `z.enum()` cannot model it, so this is the property that
	// drives the literal/union conversion path on every pinned host.
	retries: { enum: [0, 1, 2], description: "Attempts before giving up" },
	paths: { type: "array", items: { type: "string" }, description: "Files to include" },
	timeout: { type: "integer", description: "Milliseconds", default: 120000 },
	target: { description: "Where to run", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
};
const REQUIRED = ["cmd"];

/**
 * The enum construction `enumToZod` performs, against an arbitrary host Zod:
 * all-string keeps `z.enum`, other JSON primitives become literals or a union
 * of literals, and anything else degrades permissively.
 */
function buildEnum(z, values) {
	if (values.every(value => typeof value === "string")) return z.enum(values);
	const representable = values.every(
		value => value === null || ["string", "number", "boolean"].includes(typeof value),
	);
	if (!representable) return z.unknown();
	const literals = values.map(value => z.literal(value));
	return literals.length === 1 ? literals[0] : z.union(literals);
}

/**
 * The Zod construction `jsonSchemaPropertyToZod` performs, against an arbitrary
 * host Zod. Kept in lockstep with production by the drift guard below, which
 * asserts the real function yields the same Zod node type for every case.
 */
function buildBase(z, prop) {
	if (Array.isArray(prop.enum)) return buildEnum(z, prop.enum);
	switch (prop.type) {
		case "string": return z.string();
		case "number": case "integer": return z.number();
		case "boolean": return z.boolean();
		case "array": return prop.items ? z.array(buildBase(z, prop.items)) : z.array(z.unknown());
		case "object": return z.record(z.string(), z.unknown());
		default: return z.unknown();
	}
}

/** Current (pinned) shape: production `pinWireSchema`/`resolveWireSnapshot` over a host-built base. */
function pinnedShape(z) {
	const shape = {};
	for (const [key, prop] of Object.entries(OMP_PROPERTIES)) {
		const base = buildBase(z, prop);
		const outer = REQUIRED.includes(key) ? base : base.optional();
		shape[key] = pinWireSchema(outer, resolveWireSnapshot(prop).snapshot);
	}
	return shape;
}

/** Pre-fix shape: `.describe()` and no pin, so the host's own processors run. */
function unpinnedShape(z) {
	const shape = {};
	for (const [key, prop] of Object.entries(OMP_PROPERTIES)) {
		let base = buildBase(z, prop);
		if (typeof prop.description === "string") base = base.describe(prop.description);
		shape[key] = REQUIRED.includes(key) ? base : base.optional();
	}
	return shape;
}

/** Run `fn` against a live SDK MCP server + client pair over an in-memory transport. */
async function withServer(shape, fn) {
	const server = createSdkMcpServer({
		name: "custom-tools", version: "1.0.0", alwaysLoad: true,
		tools: [{ name: "bash", description: "d", inputSchema: shape, handler: async () => ({ content: [] }) }],
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "1.0.0" });
	await server.instance.connect(serverTransport);
	await client.connect(clientTransport);
	try {
		return await fn(client);
	} finally {
		await client.close().catch(() => {});
		await server.instance.close().catch(() => {});
	}
}

/** Drive a real SDK MCP server's `tools/list` over an in-memory transport. */
function listTools(shape) {
	return withServer(shape, client => client.listTools());
}

test("the mirrored constructor matches production jsonSchemaPropertyToZod", () => {
	// Guards this file's `buildBase` against drifting from the real converter.
	for (const [key, prop] of Object.entries(OMP_PROPERTIES)) {
		assert.equal(buildBase(repoZod, prop)._zod.def.type, jsonSchemaPropertyToZod(prop)._zod.def.type, key);
	}
});

for (const [version, z] of HOSTS) {
	test(`host Zod ${version}: pinned schemas render and stay property-faithful`, async () => {
		const listed = await listTools(pinnedShape(z));
		const tool = listed.tools.find(t => t.name === "bash");
		assert.ok(tool, "bash must be advertised");
		assert.deepEqual(tool.inputSchema.properties, OMP_PROPERTIES);
		assert.deepEqual(tool.inputSchema.required, REQUIRED);
	});

	test(`host Zod ${version}: the non-string enum validates exactly as advertised`, async () => {
		// The advertised schema is pinned from OMP's JSON, so the validator must
		// not be stricter than it: every advertised member has to survive a real
		// `tools/call`, or the model is told a value is legal and cannot use it.
		const { enum: members, ...rest } = OMP_PROPERTIES.retries;
		await withServer(pinnedShape(z), async client => {
			const advertised = (await client.listTools()).tools[0].inputSchema;
			assert.deepEqual(advertised.properties.retries, { enum: members, ...rest });
			assert.deepEqual(advertised.required, REQUIRED);

			// The SDK reports argument-validation failures as `isError` results
			// rather than JSON-RPC rejections, so assert on that.
			const accepts = async args => (await client.callTool({ name: "bash", arguments: args })).isError !== true;

			for (const value of members) {
				assert.equal(await accepts({ cmd: "x", retries: value }), true, `advertised member ${value} must validate`);
			}
			// Exactly representable, so outsiders must still be rejected.
			assert.equal(await accepts({ cmd: "x", retries: 9 }), false, "a value outside the enum must be rejected");
			assert.equal(await accepts({ cmd: "x", retries: "0" }), false, "a string lookalike must be rejected");
			// Required semantics: the optional enum may be omitted, `cmd` may not.
			assert.equal(await accepts({ cmd: "x" }), true, "an optional enum may be omitted");
			assert.equal(await accepts({ retries: 1 }), false, "a required property may not be omitted");
		});
	});

	test(`host Zod ${version}: unpinned schemas reproduce the 4.5.3 boundary`, async () => {
		if (BREAKS_UNPINNED.has(version)) {
			// The failure that removed every OMP tool from the turn.
			await assert.rejects(() => listTools(unpinnedShape(z)), /push/);
			return;
		}
		// Below the boundary the old path renders, but never faithfully: the Zod
		// mirror re-derives `env` and loses `anyOf`/`default`.
		const listed = await listTools(unpinnedShape(z));
		const props = listed.tools[0].inputSchema.properties;
		assert.notDeepEqual(props, OMP_PROPERTIES);
		assert.notDeepEqual(props.env, OMP_PROPERTIES.env);
	});
}

test("the SDK MCP server marks every tool alwaysLoad, keeping it out of Tool Search deferral", async () => {
	// Behavioural counterpart to the source guard in unit-tool-availability.mjs:
	// asserts the metadata `alwaysLoad: true` actually produces, rather than the
	// spelling of the call site.
	const listed = await listTools(pinnedShape(repoZod));
	assert.equal(listed.tools[0]._meta?.["anthropic/alwaysLoad"], true);
});

test("without alwaysLoad the SDK emits no such marker", async () => {
	// Proves the assertion above is not vacuously true of every SDK server.
	const server = createSdkMcpServer({
		name: "custom-tools", version: "1.0.0",
		tools: [{ name: "bash", description: "d", inputSchema: pinnedShape(repoZod), handler: async () => ({ content: [] }) }],
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "1.0.0" });
	await server.instance.connect(serverTransport);
	await client.connect(clientTransport);
	const listed = await client.listTools();
	await client.close().catch(() => {});
	await server.instance.close().catch(() => {});
	assert.notEqual(listed.tools[0]._meta?.["anthropic/alwaysLoad"], true);
});
