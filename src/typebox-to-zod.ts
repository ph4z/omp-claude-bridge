// TypeBox (JSON Schema) → Zod conversion used by buildMcpServers.
//
// Pi tools declare their parameters as TypeBox objects (i.e. JSON Schema at
// runtime). The Agent SDK's createSdkMcpServer requires Zod — its internal
// `Z0()` detects Zod via the `~standard` marker or `_def`/`_zod` properties
// and silently downgrades unrecognized schemas to
// `{type: "object", properties: {}}`, which leaves the model with no
// parameter info. This module bridges the two so MCP-exposed OMP tools retain
// their schemas. If this breaks after an SDK update, check whether `Z0()`
// detection changed or createSdkMcpServer now accepts raw JSON Schema.
//
// --- Why the JSON Schema is pinned ---
//
// These Zod objects cross a version boundary. The Agent SDK bundles its own
// copy of Zod (4.4.3 in @anthropic-ai/claude-agent-sdk 0.3.274/0.3.278) and
// renders `tools/list` with that copy's `toJSONSchema` walker, while the
// schemas are built by whichever Zod the host installed for the plugin —
// `zod@^4` floats, and OMP's plugin install resolves 4.6.5.
//
// The incompatibility is narrower than "Zod 4.5 changed its internals".
// `_zod.processJSONSchema` and `_zod.parent` both already exist in 4.4.3, and
// 4.4.3 handles its own schemas carrying them. What broke is one processor:
// from **Zod 4.5.3** the record JSON Schema processor requires `ctx.deferred`
// on the conversion context, and 4.4.3's `initializeContext()` does not
// allocate that field. A `z.record(...)` built by host Zod >= 4.5.3 therefore
// runs 4.5.3+ processor code against a 4.4.3 context and throws
// `undefined is not an object (evaluating 'ctx.deferred.push')`.
//
// Claude Code drops *every* tool of a server whose `tools/list` fails, so one
// object-typed parameter (e.g. bash's `env`) took the whole
// `mcp__custom-tools__*` namespace off the turn — `task` included — and the
// model reported OMP's tools as nonexistent.
//
// Both walkers consult `_zod.toJSONSchema()` before dispatching to any
// processor, so each property pins the JSON Schema OMP already declared. The
// walker then never traverses host-built internals, which makes the rendering
// independent of which Zod build performs it.
//
// The committed matrix in tests/crossversion-zod-wire-schema.mjs pins host
// Zod 4.4.3 / 4.5.2 / 4.5.3 / 4.6.5 as devDependency aliases and drives a real
// SDK MCP server: 4.5.2 is the last version the unpinned path renders on,
// 4.5.3 and 4.6.5 throw without the pin, and all four succeed with it.
//
// --- Why `.describe()` is gone and `_zod.parent` is cleared ---
//
// Neither is part of the original host-Zod incompatibility: unpinned
// `.describe()` renders correctly on every tested 4.x host. They are what
// makes the *pin* safe. `.describe()` returns a clone linked through
// `_zod.parent`, and the walker registers that parent in its `seen` map only
// on the branch the pin short-circuits; ref flattening then dereferences a
// missing `seen` entry and throws `undefined is not an object (evaluating
// 'c.ref')`. Dropping `.describe()` (the pinned schema already carries the
// description) and clearing `parent` keep the short-circuited traversal
// self-consistent.
//
// --- What this preserves, and what it does not ---
//
// Guaranteed: exact PROPERTY-LEVEL preservation. Every property whose schema is
// a plain JSON object, and the `required` list, are emitted verbatim as OMP
// declared them — including property-level `anyOf`, `default`, `enum`, nested
// objects, and values in data positions such as `default`/`const`/`examples`.
//
// Not guaranteed: the root schema. createSdkMcpServer rebuilds the top-level
// object wrapper from the shape, so root-level keywords OMP declared are
// dropped (on OMP 18.2.6: `additionalProperties` on every tool, plus a root
// `description` on `todo`) and the SDK adds its own `$schema`. That predates
// the pin and is unchanged by it. This is not byte-for-byte root preservation.
//
// Conservative degradation, never a throw. Each of these substitutes one
// property and is reported to the caller, so nothing is silently lost:
//
//   - a sub-schema that is not a plain JSON object (JSON Schema allows `true`/
//     `false`; malformed input can hold any JSON value) → `{}`. Pinning a
//     non-object makes the SDK walker throw and fails `tools/list` for the
//     WHOLE server, which is the blast radius this module exists to remove.
//   - a cyclic or non-JSON-safe schema → `{}`. Both traversals here are
//     depth-bounded, so neither a cycle nor deep nesting can throw a
//     `RangeError` out of buildMcpServers and cost the entire provider turn.
//   - an unresolved `$ref` *keyword* → the keyword is dropped, siblings kept.
//     `$defs` lives on the root the SDK rebuilds, so a copied `$ref` could
//     never resolve. A property legitimately NAMED `$ref` is a member of a
//     `properties`/`$defs` map, not a keyword, and survives untouched.
//
// Degrading toward a permissive schema is safe because OMP — not Claude Code —
// validates arguments and executes the call.

import { z } from "zod";

/**
 * Bound on how deep either traversal in this module descends.
 *
 * Both walks are depth-limited rather than trusting their input to be finite:
 * the sanitizer runs on a JSON round-tripped copy (so it cannot be cyclic, but
 * can be arbitrarily deep) and the Zod constructor runs on OMP's live object
 * (which a cycle through `items` would otherwise make infinite). Anything below
 * the bound degrades conservatively instead of throwing a `RangeError` out of
 * buildMcpServers, which would cost the whole provider turn rather than just
 * `tools/list`. Real OMP tool schemas nest a handful of levels.
 */
const MAX_SCHEMA_DEPTH = 64;

/** Why a property could not be pinned verbatim. */
export type WireSchemaDegradation =
	| "unresolved-$ref"
	| "not-json-serializable"
	| "not-an-object-schema"
	| "excessive-nesting";

export interface WireSchemaSnapshot {
	/** JSON text of the schema to emit; always parses to a plain object. */
	snapshot: string;
	/** Set when the emitted schema is a safe substitute rather than OMP's verbatim fragment. */
	degraded?: WireSchemaDegradation;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON Schema keyword positions. `$ref` is only a keyword when it appears as a
// key of a schema *node*; a member of a `properties`/`$defs` map is a property
// NAME and must survive untouched. Data-valued keywords (`default`, `const`,
// `examples`, `enum`, …) are never descended into, so a `$ref` string sitting
// inside a default value is left exactly as OMP wrote it.
const SUBSCHEMA_KEYS = [
	"items", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties",
	"contains", "propertyNames", "not", "if", "then", "else", "contentSchema",
] as const;
const SUBSCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SUBSCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;

interface SanitizeState {
	strippedRef: boolean;
	truncated: boolean;
}

/**
 * Copy a schema node, dropping `$ref` keywords in schema position.
 *
 * A pinned fragment is spliced into a root object that createSdkMcpServer
 * rebuilds, so a `$ref` target (`#/$defs/...` resolves against the document
 * root) cannot survive the move and would be emitted dangling. Resolving one
 * would need the root schema and a pointer resolver; dropping the keyword
 * instead makes the property strictly more permissive, which is safe because
 * OMP — not Claude Code — validates and executes the call. No OMP 18.2.6 tool
 * schema contains `$ref`/`$defs`, so this is a guard, not a live path.
 */
function sanitizeSchemaNode(node: unknown, depth: number, state: SanitizeState): unknown {
	if (depth > MAX_SCHEMA_DEPTH) {
		state.truncated = true;
		return {};
	}
	if (!isPlainObject(node)) return node;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(node)) {
		if (key === "$ref") {
			state.strippedRef = true;
			continue;
		}
		if ((SUBSCHEMA_KEYS as readonly string[]).includes(key)) {
			// draft-07 tuple form: `items` may hold an array of subschemas.
			out[key] = Array.isArray(child)
				? child.map(entry => sanitizeSchemaNode(entry, depth + 1, state))
				: sanitizeSchemaNode(child, depth + 1, state);
		} else if ((SUBSCHEMA_LIST_KEYS as readonly string[]).includes(key) && Array.isArray(child)) {
			out[key] = child.map(entry => sanitizeSchemaNode(entry, depth + 1, state));
		} else if ((SUBSCHEMA_MAP_KEYS as readonly string[]).includes(key) && isPlainObject(child)) {
			// Keys here are property NAMES, so a member literally called `$ref`
			// is a declared property and is preserved; only its *value* is a node.
			const mapped: Record<string, unknown> = {};
			for (const [name, sub] of Object.entries(child)) mapped[name] = sanitizeSchemaNode(sub, depth + 1, state);
			out[key] = mapped;
		} else {
			out[key] = child;
		}
	}
	return out;
}

/**
 * Serialize a property schema once, up front, so the lazy hook the walker calls
 * can only ever `JSON.parse` text that already parsed here — and can only ever
 * yield a plain object.
 *
 * Everything that can go wrong is handled outside `tools/list`. A non-JSON-safe
 * schema (cycle, BigInt), a non-object sub-schema (JSON Schema permits `true` /
 * `false`, and malformed input can hold any JSON value) or excessive nesting
 * degrades this one property instead of throwing inside the walker and costing
 * the whole server its tool list — the exact failure this module exists to
 * prevent. Callers surface `degraded` rather than swallowing it.
 *
 * A non-object sub-schema degrades to `{}` ("accept anything"). That is the
 * JSON Schema equivalent of `true`, is more permissive than `false`, and
 * matches what this bridge emitted for these shapes before schemas were pinned.
 */
export function resolveWireSnapshot(json: unknown): WireSchemaSnapshot {
	let serialized: string | undefined;
	let parsed: unknown;
	try {
		// Serialize FIRST. A cycle or a BigInt throws here, so everything after
		// this point walks a finite JSON tree.
		serialized = JSON.stringify(json);
		if (typeof serialized !== "string") return { snapshot: "{}", degraded: "not-json-serializable" };
		parsed = JSON.parse(serialized);
	} catch {
		return { snapshot: "{}", degraded: "not-json-serializable" };
	}
	// The SDK's walker assigns the pinned value straight into its result and then
	// treats it as an object; a boolean/string/number/array/null would make it
	// throw and take the whole server's tool list with it.
	if (!isPlainObject(parsed)) return { snapshot: "{}", degraded: "not-an-object-schema" };

	const state: SanitizeState = { strippedRef: false, truncated: false };
	const sanitized = sanitizeSchemaNode(parsed, 0, state);
	// Healthy schemas keep the original text byte-for-byte.
	if (!state.strippedRef && !state.truncated) return { snapshot: serialized };
	const rewritten = JSON.stringify(sanitized);
	return {
		snapshot: typeof rewritten === "string" ? rewritten : "{}",
		degraded: state.strippedRef ? "unresolved-$ref" : "excessive-nesting",
	};
}

type ZodInternals = { toJSONSchema?: () => unknown; parent?: unknown };

/**
 * Pin the JSON Schema a Zod schema renders to, bypassing the version-dependent
 * per-type processors. Applied to the outermost schema of each property, the
 * only node the SDK's own `z.object()` wrapper hands to a foreign processor.
 * Optionality still resolves from `_zod.optin`/`optout`, which are plain data
 * fields and therefore version-independent.
 *
 * `snapshot` is JSON text (see {@link resolveWireSnapshot}); it is re-parsed on
 * every call so a walker that annotates the result cannot mutate the pin.
 *
 * Clearing `_zod.parent` is load-bearing for any schema that carries one — a
 * `.describe()`/`.meta()` clone links its source that way, and the walker
 * registers that source in its `seen` map only on the branch this pin
 * short-circuits, so ref flattening would dereference a missing entry and
 * throw. This module no longer calls `.describe()`, but the guard keeps
 * `pinWireSchema` correct for any caller that pins a derived schema.
 */
export function pinWireSchema<T extends z.ZodTypeAny>(zodSchema: T, snapshot: string): T {
	const internals = (zodSchema as unknown as { _zod?: ZodInternals })._zod;
	if (!internals) return zodSchema;
	internals.toJSONSchema = () => JSON.parse(snapshot) as unknown;
	internals.parent = undefined;
	return zodSchema;
}

/**
 * Build the Zod mirror used for argument validation. Depth-bounded: a cycle
 * through `items` would otherwise recurse forever and throw out of
 * buildMcpServers. Depth is carried as a parameter, so concurrent conversions
 * share no mutable traversal state.
 */
/**
 * Build the validator for a JSON Schema `enum`.
 *
 * The advertised schema is OMP's, pinned verbatim, so the mirror must never be
 * *stricter* than what the model was told is allowed — otherwise Claude sends a
 * value the advertised schema permits and MCP rejects it before the handler
 * runs, with no way for the model to comply. `z.enum()` only models string
 * members, so a JSON enum holding numbers, booleans or `null` needs literals.
 *
 * JSON permits any value in an `enum`, including objects and arrays, which
 * literals cannot express. Those degrade to `z.unknown()`: accepting more than
 * advertised is harmless here because OMP re-validates and executes the call,
 * whereas rejecting an advertised value is a contract the model cannot satisfy.
 *
 * Uses only single-value `z.literal()` and `z.union()`, which are stable across
 * the whole `zod@^4` range the host may resolve.
 */
function enumToZod(values: readonly unknown[]): z.ZodTypeAny {
	// All-string (including the empty enum, which matches nothing in JSON Schema
	// and in `z.enum([])` alike) keeps the exact representation.
	if (values.every(value => typeof value === "string")) return z.enum(values as unknown as [string, ...string[]]);
	const representable = values.every(
		value => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean",
	);
	if (!representable) return z.unknown();
	const literals = values.map(value => z.literal(value as string | number | boolean | null));
	return literals.length === 1
		? literals[0]!
		: z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

export function jsonSchemaPropertyToZod(prop: unknown, depth = 0): z.ZodTypeAny {
	// No `.describe()`: the description rides the pinned wire schema, and the
	// clone `.describe()` returns is what links `_zod.parent`.
	if (!isPlainObject(prop) || depth > MAX_SCHEMA_DEPTH) return z.unknown();
	if (Array.isArray(prop.enum)) return enumToZod(prop.enum);
	switch (prop.type) {
		case "string": return z.string();
		case "number": case "integer": return z.number();
		case "boolean": return z.boolean();
		case "array": return prop.items
			? z.array(jsonSchemaPropertyToZod(prop.items, depth + 1))
			: z.array(z.unknown());
		case "object": return z.record(z.string(), z.unknown());
		default: return z.unknown();
	}
}

/** Reported when a property's wire schema had to be substituted; never silent. */
export interface WireSchemaDegradationReport {
	property: string;
	reason: WireSchemaDegradation;
}

export function jsonSchemaToZodShape(
	schema: unknown,
	onDegrade?: (report: WireSchemaDegradationReport) => void,
): Record<string, z.ZodTypeAny> {
	if (!isPlainObject(schema) || schema.type !== "object" || !isPlainObject(schema.properties)) return {};
	const props = schema.properties;
	const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(props)) {
		const { snapshot, degraded } = resolveWireSnapshot(prop);
		if (degraded) onDegrade?.({ property: key, reason: degraded });
		const zodProp = jsonSchemaPropertyToZod(prop);
		shape[key] = pinWireSchema(required.has(key) ? zodProp : zodProp.optional(), snapshot);
	}
	return shape;
}
