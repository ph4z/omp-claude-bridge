import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
	jsonSchemaPropertyToZod,
	jsonSchemaToZodShape,
	pinWireSchema,
	resolveWireSnapshot,
} from "../src/typebox-to-zod.ts";

/** Convert one property in isolation, collecting any degradation reports. */
function convertProperty(prop) {
	const reports = [];
	const shape = jsonSchemaToZodShape({ type: "object", properties: { p: prop }, required: [] }, r => reports.push(r));
	return { rendered: z.toJSONSchema(z.object(shape), { io: "input" }).properties.p, reasons: reports.map(r => r.reason) };
}

// Mirrors the shape of a real OMP 18.2.6 tool schema: a required described
// string, an object-typed property (the one that killed `tools/list`), an enum,
// an array, a property-level `anyOf` union and a property-level `default` —
// `anyOf` and `default` both appear in the live OMP tool set.
const OMP_TOOL_SCHEMA = {
	type: "object",
	properties: {
		cmd: { type: "string", description: "The command to run" },
		env: { type: "object", description: "Extra environment variables" },
		mode: { enum: ["read", "write"], description: "Access mode" },
		paths: { type: "array", items: { type: "string" }, description: "Files to include" },
		timeout: { type: "integer", description: "Milliseconds", default: 120000 },
		target: {
			description: "Where to run",
			anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
		},
	},
	required: ["cmd"],
};

/** What createSdkMcpServer does: wrap the shape and render it with its own Zod. */
function renderWireSchema(shape) {
	return z.toJSONSchema(z.object(shape), { io: "input" });
}

// --- Property-level fidelity ---

test("each property pins OMP's own JSON Schema instead of a re-derived one", () => {
	const shape = jsonSchemaToZodShape(OMP_TOOL_SCHEMA);
	for (const [key, expected] of Object.entries(OMP_TOOL_SCHEMA.properties)) {
		assert.deepEqual(shape[key]._zod.toJSONSchema(), expected, `property ${key}`);
	}
});

test("the wire schema the SDK renders equals OMP's, optionality included", () => {
	const rendered = renderWireSchema(jsonSchemaToZodShape(OMP_TOOL_SCHEMA));
	assert.deepEqual(rendered.properties, OMP_TOOL_SCHEMA.properties);
	assert.deepEqual(rendered.required, ["cmd"]);
});

test("property-level anyOf, default, enum, record and description survive verbatim", () => {
	const rendered = renderWireSchema(jsonSchemaToZodShape(OMP_TOOL_SCHEMA));
	assert.deepEqual(rendered.properties.target.anyOf, OMP_TOOL_SCHEMA.properties.target.anyOf);
	assert.equal(rendered.properties.timeout.default, 120000);
	assert.deepEqual(rendered.properties.mode.enum, ["read", "write"]);
	// The pre-fix conversion re-derived `env` as a Zod record and emitted
	// `{propertyNames, additionalProperties}`; OMP declared neither.
	assert.deepEqual(rendered.properties.env, { type: "object", description: "Extra environment variables" });
	assert.equal(rendered.properties.cmd.description, "The command to run");
});

test("the guarantee is property-level, not whole-root: the SDK still owns the wrapper", () => {
	// Documents the known, pre-existing limit so nobody reads the pin as
	// byte-for-byte root preservation.
	const withRootKeywords = { ...OMP_TOOL_SCHEMA, additionalProperties: false, description: "root doc" };
	const rendered = renderWireSchema(jsonSchemaToZodShape(withRootKeywords));
	assert.deepEqual(rendered.properties, OMP_TOOL_SCHEMA.properties);
	assert.equal(rendered.description, undefined);
});

// --- Cross-version safety ---

test("clearing _zod.parent is load-bearing, not defensive decoration", () => {
	// `.describe()` returns a clone linked through `_zod.parent` (true in 4.4.3
	// too). The walker registers that parent in `seen` only on the branch the pin
	// short-circuits, so a surviving link makes ref flattening throw on `c.ref`.
	// Asserting `parent === undefined` on schemas this module builds would be
	// vacuous — it no longer calls `.describe()` — so drive the real failure.
	const snapshot = resolveWireSnapshot({ type: "string", description: "d" }).snapshot;
	assert.notEqual(z.string().describe("d")._zod.parent, undefined, "precondition: describe() links a parent");

	const cleared = pinWireSchema(z.string().describe("d"), snapshot);
	assert.equal(cleared._zod.parent, undefined);
	assert.deepEqual(renderWireSchema({ p: cleared }).properties.p, { type: "string", description: "d" });

	// Same pin with the parent link put back: what dropping that line would do.
	const kept = z.string().describe("d");
	const parent = kept._zod.parent;
	pinWireSchema(kept, snapshot);
	kept._zod.parent = parent;
	assert.throws(() => renderWireSchema({ p: kept }), /ref/);
});

test("schemas this module builds carry no parent link", () => {
	const shape = jsonSchemaToZodShape(OMP_TOOL_SCHEMA);
	for (const [key, schema] of Object.entries(shape)) {
		assert.equal(schema._zod.parent, undefined, `property ${key}`);
	}
});

test("rendering never enters a per-schema processor from this package's Zod", () => {
	// Faithful stand-in for the real cross-version failure. The SDK bundles Zod
	// 4.4.3, whose `initializeContext()` allocates no `ctx.deferred`; from host
	// Zod 4.5.3 the record processor requires that field. Simulating that
	// processor reproduces the original `ctx.deferred.push` throw against this
	// repo's own 4.4.3, so the test fails for the same reason production did if
	// the pin ever stops short-circuiting.
	const shape = jsonSchemaToZodShape(OMP_TOOL_SCHEMA);
	for (const schema of Object.values(shape)) {
		schema._zod.processJSONSchema = ctx => { ctx.deferred.push(() => {}); };
	}
	assert.deepEqual(renderWireSchema(shape).properties, OMP_TOOL_SCHEMA.properties);
});

test("the simulated 4.5.3 record processor really does throw on this Zod's context", () => {
	// Guards the test above from silently degenerating into a no-op: an unpinned
	// schema carrying that processor must still blow up.
	const unpinned = z.record(z.string(), z.unknown());
	unpinned._zod.processJSONSchema = ctx => { ctx.deferred.push(() => {}); };
	// V8: "Cannot read properties of undefined (reading 'push')";
	// JSC/Bun (what production hit): "undefined is not an object (evaluating 'ctx.deferred.push')".
	assert.throws(() => renderWireSchema({ env: unpinned }), /push/);
});

// --- Degradation boundaries ---

test("a non-object sub-schema degrades instead of killing tools/list", () => {
	// JSON Schema permits boolean sub-schemas, and malformed input can hold any
	// JSON value. A non-object pin makes the SDK walker throw
	// ("Cannot use 'in' operator to search for '_prefault' in true"), which fails
	// `tools/list` for the whole server — the blast radius this module exists to
	// remove. Each case must degrade to a permissive `{}` and be reported.
	for (const [label, value] of [
		["true", true], ["false", false], ["string", "x"], ["number", 42], ["null", null], ["array", []],
	]) {
		const { rendered, reasons } = convertProperty(value);
		assert.deepEqual(rendered, {}, `${label} must render as {}`);
		assert.deepEqual(reasons, ["not-an-object-schema"], `${label} must be reported`);
	}
	// An empty object IS a valid schema: pinned verbatim, nothing reported.
	const empty = convertProperty({});
	assert.deepEqual(empty.rendered, {});
	assert.deepEqual(empty.reasons, []);
});

test("one bad property never costs its siblings or the tool", () => {
	const reports = [];
	const shape = jsonSchemaToZodShape(
		{ type: "object", properties: { ok: { type: "string" }, bad: true }, required: ["ok"] },
		r => reports.push(r),
	);
	const rendered = renderWireSchema(shape);
	assert.deepEqual(rendered.properties.ok, { type: "string" });
	assert.deepEqual(rendered.properties.bad, {});
	assert.deepEqual(rendered.required, ["ok"]);
	assert.deepEqual(reports, [{ property: "bad", reason: "not-an-object-schema" }]);
});

test("cyclic schemas degrade instead of throwing, on every recursive branch", () => {
	// Each cycle must traverse a branch the converter actually follows. The
	// `items` cycle is the one that used to throw RangeError out of
	// buildMcpServers, killing the whole provider turn rather than tools/list.
	const viaItems = () => { const c = { type: "array" }; c.items = c; return c; };
	const viaNestedItems = () => { const c = { type: "array" }; c.items = { type: "array", items: c }; return c; };
	const viaProperties = () => { const c = { type: "object", properties: {} }; c.properties.self = c; return c; };
	const viaArray = () => { const c = { type: "object", anyOf: [] }; c.anyOf.push(c); return c; };
	for (const [label, make] of [
		["items", viaItems], ["nested items", viaNestedItems], ["properties", viaProperties], ["anyOf", viaArray],
	]) {
		const { rendered, reasons } = convertProperty(make());
		assert.deepEqual(rendered, {}, `${label} cycle must render as {}`);
		assert.deepEqual(reasons, ["not-json-serializable"], `${label} cycle must be reported`);
	}
});

test("acyclic but excessively nested schemas degrade rather than exhausting the stack", () => {
	let deep = { type: "string" };
	for (let i = 0; i < 400; i++) deep = { type: "array", items: deep };
	const { rendered, reasons } = convertProperty(deep);
	assert.deepEqual(reasons, ["excessive-nesting"]);
	// Still a usable, conservative schema rather than a throw.
	assert.equal(typeof rendered, "object");
});

test("resolveWireSnapshot always yields parseable text", () => {
	const cyclic = {};
	cyclic.self = cyclic;
	const bad = resolveWireSnapshot(cyclic);
	assert.equal(bad.degraded, "not-json-serializable");
	assert.deepEqual(JSON.parse(bad.snapshot), {});
	const good = resolveWireSnapshot({ type: "string" });
	assert.equal(good.degraded, undefined);
	assert.deepEqual(JSON.parse(good.snapshot), { type: "string" });
});

test("an unresolved $ref keyword is dropped rather than emitted dangling", () => {
	// `$defs` belongs to the root schema the SDK rebuilds, so a copied `$ref`
	// could never resolve. Dropping the keyword is strictly more permissive;
	// OMP still validates and executes the call.
	const reports = [];
	const shape = jsonSchemaToZodShape({
		type: "object",
		properties: {
			plain: { type: "string" },
			reffed: { type: "object", description: "keeps siblings", $ref: "#/$defs/Thing" },
			nested: { type: "array", items: { $ref: "#/$defs/Thing" }, description: "nested ref" },
			branch: { type: "object", anyOf: [{ $ref: "#/$defs/Thing" }, { type: "string" }] },
		},
		required: [],
	}, r => reports.push(r));
	assert.deepEqual(reports.map(r => r.property).sort(), ["branch", "nested", "reffed"]);
	assert.ok(reports.every(r => r.reason === "unresolved-$ref"));
	const rendered = renderWireSchema(shape);
	assert.equal(JSON.stringify(rendered).includes("$ref"), false);
	assert.deepEqual(rendered.properties.reffed, { type: "object", description: "keeps siblings" });
	assert.deepEqual(rendered.properties.nested, { type: "array", items: {}, description: "nested ref" });
	assert.deepEqual(rendered.properties.branch, { type: "object", anyOf: [{}, { type: "string" }] });
	assert.deepEqual(rendered.properties.plain, { type: "string" });
});

test("an unresolved $ref keyword nested inside a schema map is still handled", () => {
	// The map branches (`properties`, `$defs`, …) hold name -> subschema pairs:
	// the NAME is data, but the VALUE is a schema node and must be sanitized.
	// Without that recursion a nested `$ref` ships dangling while the top-level
	// "property named $ref" test still passes, so this case is its own guard.
	const nested = {
		type: "object",
		properties: {
			inner: { $ref: "#/$defs/Thing", description: "kept" },
			fine: { type: "string" },
		},
	};
	const { rendered, reasons } = convertProperty(nested);
	assert.deepEqual(reasons, ["unresolved-$ref"]);
	assert.equal(JSON.stringify(rendered).includes("$ref"), false);
	assert.deepEqual(rendered, {
		type: "object",
		properties: { inner: { description: "kept" }, fine: { type: "string" } },
	});
});

test("an unresolved $ref keyword nested inside $defs is still handled", () => {
	const withDefs = { type: "object", $defs: { Thing: { $ref: "#/$defs/Other", title: "kept" } } };
	const { rendered, reasons } = convertProperty(withDefs);
	assert.deepEqual(reasons, ["unresolved-$ref"]);
	assert.deepEqual(rendered, { type: "object", $defs: { Thing: { title: "kept" } } });
});

test("a $ref keyword and a property named $ref coexist in one schema", () => {
	// Distinguishes the two positions in a single fragment: the keyword goes,
	// the declared property stays.
	const both = {
		type: "object",
		$ref: "#/$defs/Base",
		properties: { $ref: { type: "string", description: "a field called $ref" } },
	};
	const { rendered, reasons } = convertProperty(both);
	assert.deepEqual(reasons, ["unresolved-$ref"]);
	assert.deepEqual(rendered, {
		type: "object",
		properties: { $ref: { type: "string", description: "a field called $ref" } },
	});
});

test("a property legitimately NAMED $ref survives untouched", () => {
	// Members of a `properties`/`$defs` map are property NAMES, not keywords.
	// A blanket key strip would silently delete a declared property.
	const cases = {
		cfg: { type: "object", properties: { $ref: { type: "string", description: "a field called $ref" } } },
		deep: { type: "object", properties: { inner: { type: "object", properties: { $ref: { type: "number" } } } } },
		defs: { type: "object", $defs: { $ref: { type: "string" } } },
	};
	const reports = [];
	const shape = jsonSchemaToZodShape({ type: "object", properties: cases, required: [] }, r => reports.push(r));
	assert.deepEqual(reports, [], "a property name is not an unresolved reference");
	assert.deepEqual(renderWireSchema(shape).properties, cases);
});

test("$ref sitting in a data position is left exactly as OMP wrote it", () => {
	// `default`/`const`/`examples` hold values, not sub-schemas.
	const prop = { type: "string", default: { $ref: "not a keyword here" }, examples: [{ $ref: "also data" }] };
	const { rendered, reasons } = convertProperty(prop);
	assert.deepEqual(reasons, []);
	assert.deepEqual(rendered, prop);
});

test("a schema free of $ref is passed through untouched, not rebuilt", () => {
	const reports = [];
	jsonSchemaToZodShape(OMP_TOOL_SCHEMA, r => reports.push(r));
	assert.deepEqual(reports, []);
});

// --- API edges ---

test("pinWireSchema tolerates a value carrying no Zod internals", () => {
	const notZod = { hello: "world" };
	assert.equal(pinWireSchema(notZod, '{"type":"string"}'), notZod);
	assert.equal("_zod" in notZod, false);
});

test("pinning leaves the schemas usable for argument validation", () => {
	const validator = z.object(jsonSchemaToZodShape(OMP_TOOL_SCHEMA));
	assert.deepEqual(
		validator.parse({ cmd: "ls", env: { PATH: "/bin" }, mode: "read", paths: ["a"] }),
		{ cmd: "ls", env: { PATH: "/bin" }, mode: "read", paths: ["a"] },
	);
	assert.deepEqual(validator.parse({ cmd: "ls" }), { cmd: "ls" });
	assert.throws(() => validator.parse({ env: {} }));
	assert.throws(() => validator.parse({ cmd: "ls", mode: "delete" }));
});

test("the pin is re-parsed per call so a walker cannot mutate it", () => {
	const shape = jsonSchemaToZodShape(OMP_TOOL_SCHEMA);
	const first = shape.cmd._zod.toJSONSchema();
	first.description = "mutated by a walker";
	assert.deepEqual(shape.cmd._zod.toJSONSchema(), OMP_TOOL_SCHEMA.properties.cmd);
});

test("jsonSchemaPropertyToZod maps the JSON Schema types the bridge supports", () => {
	const type = prop => jsonSchemaPropertyToZod(prop)._zod.def.type;
	assert.equal(type({ type: "string" }), "string");
	assert.equal(type({ type: "integer" }), "number");
	assert.equal(type({ type: "boolean" }), "boolean");
	assert.equal(type({ type: "array" }), "array");
	assert.equal(type({ type: "object" }), "record");
	assert.equal(type({ enum: ["a"] }), "enum");
	assert.equal(type({ anyOf: [{ type: "string" }] }), "unknown");
	// Non-object input must not throw on the way to the Zod mirror.
	for (const value of [true, false, "x", 42, null, undefined, []]) {
		assert.equal(jsonSchemaPropertyToZod(value)._zod.def.type, "unknown", String(value));
	}
});

// --- Enum: the advertised schema and the validator must agree ---

/** Everything OMP advertises as allowed must validate; the reverse is optional. */
function enumContract(values) {
	const shape = jsonSchemaToZodShape({ type: "object", properties: { v: { enum: values } }, required: ["v"] });
	const advertised = renderWireSchema(shape).properties.v;
	const validator = z.object(shape);
	const accepts = value => {
		try { validator.parse({ v: value }); return true; } catch { return false; }
	};
	return { advertised, accepts };
}

test("every value an enum advertises is accepted by the validator", () => {
	// A mirror stricter than the advertised schema is a contract the model
	// cannot satisfy: it is told the value is legal, then MCP rejects the call
	// before the handler runs. `z.enum()` only models strings, so numeric,
	// boolean and null members need literals.
	for (const values of [["a", "b"], [1, 2, 3], [true, false], [null], [1, "a", null, true], [7], []]) {
		const { advertised, accepts } = enumContract(values);
		assert.deepEqual(advertised, { enum: values }, `advertised ${JSON.stringify(values)}`);
		for (const value of values) {
			assert.equal(accepts(value), true, `${JSON.stringify(value)} of ${JSON.stringify(values)} must validate`);
		}
	}
});

test("values outside an exactly representable enum are still rejected", () => {
	assert.equal(enumContract(["a", "b"]).accepts("c"), false);
	assert.equal(enumContract([1, 2, 3]).accepts(4), false);
	assert.equal(enumContract([true, false]).accepts("x"), false);
	assert.equal(enumContract([null]).accepts("x"), false);
	assert.equal(enumContract([1, "a", null, true]).accepts(2), false);
	assert.equal(enumContract([7]).accepts(8), false);
	// An empty enum matches nothing in JSON Schema, and the mirror agrees.
	assert.equal(enumContract([]).accepts("x"), false);
});

test("string enums keep their exact z.enum representation", () => {
	// The live OMP 18.2.6 tools use string enums only; this path must not move.
	const shape = jsonSchemaToZodShape({ type: "object", properties: { mode: { enum: ["read", "write"] } }, required: [] });
	assert.equal(shape.mode._zod.def.innerType._zod.def.type, "enum");
});

test("an enum holding non-primitive values degrades permissively, never stricter", () => {
	// Objects and arrays cannot be expressed as literals. Accepting more than
	// advertised is safe — OMP re-validates and executes the call — whereas
	// rejecting an advertised value is not.
	const { advertised, accepts } = enumContract([{ a: 1 }, ["x"]]);
	assert.deepEqual(advertised, { enum: [{ a: 1 }, ["x"]] });
	assert.equal(accepts({ a: 1 }), true);
	assert.equal(accepts(["x"]), true);
	assert.equal(accepts("anything"), true);
});

test("a non-object schema still yields an empty shape", () => {
	assert.deepEqual(jsonSchemaToZodShape(undefined), {});
	assert.deepEqual(jsonSchemaToZodShape({ type: "string" }), {});
});
