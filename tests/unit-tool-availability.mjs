import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ToolAvailabilityMonitor } from "../src/tool-availability.ts";

const SERVER = "custom-tools";
const OMP_TOOLS = ["mcp__custom-tools__bash", "mcp__custom-tools__task", "mcp__custom-tools__read"];
// Claude Code always advertises its own built-ins alongside MCP tools.
const CLAUDE_NATIVE = ["Bash", "Read", "Edit", "Write", "ToolSearch"];

function init(tools, status = "connected") {
	return { type: "system", subtype: "init", tools, mcp_servers: [{ name: SERVER, status, source: "sdk" }] };
}

test("a healthy roster produces no warning", () => {
	const monitor = new ToolAvailabilityMonitor();
	const result = monitor.inspect(init([...OMP_TOOLS]), OMP_TOOLS, SERVER);
	assert.deepEqual(result.missing, []);
	assert.equal(result.message, undefined);
});

test("Claude-native extra tools do not matter: the check is a subset test", () => {
	const monitor = new ToolAvailabilityMonitor();
	const result = monitor.inspect(init([...CLAUDE_NATIVE, ...OMP_TOOLS]), OMP_TOOLS, SERVER);
	assert.deepEqual(result.missing, []);
	// ...and a Claude built-in going missing is none of this detector's business.
	const fewerNatives = monitor.inspect(init([...OMP_TOOLS]), OMP_TOOLS, SERVER);
	assert.deepEqual(fewerNatives.missing, []);
});

test("one missing OMP tool is reported by name", () => {
	const monitor = new ToolAvailabilityMonitor();
	const result = monitor.inspect(init([...CLAUDE_NATIVE, "mcp__custom-tools__bash", "mcp__custom-tools__read"]), OMP_TOOLS, SERVER);
	assert.deepEqual(result.missing, ["mcp__custom-tools__task"]);
	assert.equal(result.firstReport, true);
	assert.match(result.message, /did not load 1 of 3 OMP tools/);
	assert.match(result.message, /mcp__custom-tools__task/);
});

test("the whole-server failure mode reports every tool, and the connected status", () => {
	// A server whose `tools/list` throws still reports itself `connected`; that is
	// precisely why the advertised list, not the status, is the signal.
	const monitor = new ToolAvailabilityMonitor();
	const result = monitor.inspect(init([...CLAUDE_NATIVE]), OMP_TOOLS, SERVER);
	assert.deepEqual(result.missing.sort(), [...OMP_TOOLS].sort());
	assert.equal(result.status, "connected");
	assert.match(result.message, /did not load 3 of 3 OMP tools/);
});

test("an absent server is labelled rather than crashing the check", () => {
	const monitor = new ToolAvailabilityMonitor();
	const result = monitor.inspect({ type: "system", subtype: "init", tools: [], mcp_servers: [] }, OMP_TOOLS, SERVER);
	assert.equal(result.status, "absent");
	assert.equal(result.firstReport, true);
});

test("zero expected OMP tools produces no result at all", () => {
	// OMP side requests (auto-thinking, classifiers) carry no tools.
	const monitor = new ToolAvailabilityMonitor();
	assert.equal(monitor.inspect(init([...CLAUDE_NATIVE]), [], SERVER), undefined);
});

test("a CLI that advertises no tool list is not treated as a failure", () => {
	const monitor = new ToolAvailabilityMonitor();
	assert.equal(monitor.inspect({ type: "system", subtype: "init", mcp_servers: [] }, OMP_TOOLS, SERVER), undefined);
});

test("the same failure repeated across continuation queries is deduped", () => {
	const monitor = new ToolAvailabilityMonitor();
	const broken = () => monitor.inspect(init([...CLAUDE_NATIVE]), OMP_TOOLS, SERVER);
	assert.equal(broken().firstReport, true);
	// Each continuation/replay query spawns its own CLI process and its own init.
	for (let i = 0; i < 5; i++) {
		const repeat = broken();
		assert.equal(repeat.firstReport, false);
		// The full detail stays available for debug logging on every occurrence.
		assert.deepEqual(repeat.missing.sort(), [...OMP_TOOLS].sort());
		assert.ok(repeat.message);
	}
	assert.equal(monitor.size, 1);
});

test("a materially different missing set reports again", () => {
	const monitor = new ToolAvailabilityMonitor();
	assert.equal(monitor.inspect(init(["mcp__custom-tools__bash", "mcp__custom-tools__read"]), OMP_TOOLS, SERVER).firstReport, true);
	assert.equal(monitor.inspect(init(["mcp__custom-tools__bash"]), OMP_TOOLS, SERVER).firstReport, true);
	// ...but each distinct set is still reported only once.
	assert.equal(monitor.inspect(init(["mcp__custom-tools__bash"]), OMP_TOOLS, SERVER).firstReport, false);
});

test("the missing set is order-insensitive", () => {
	const monitor = new ToolAvailabilityMonitor();
	assert.equal(monitor.inspect(init(["mcp__custom-tools__bash"]), OMP_TOOLS, SERVER).firstReport, true);
	const reversed = [...OMP_TOOLS].reverse();
	assert.equal(monitor.inspect(init(["mcp__custom-tools__bash"]), reversed, SERVER).firstReport, false);
});

test("recovery clears the memory so a later genuine failure is never suppressed", () => {
	const monitor = new ToolAvailabilityMonitor();
	assert.equal(monitor.inspect(init([...CLAUDE_NATIVE]), OMP_TOOLS, SERVER).firstReport, true);
	assert.equal(monitor.inspect(init([...OMP_TOOLS]), OMP_TOOLS, SERVER).missing.length, 0);
	assert.equal(monitor.size, 0);
	assert.equal(monitor.inspect(init([...CLAUDE_NATIVE]), OMP_TOOLS, SERVER).firstReport, true);
});

test("the dedupe memory stays bounded under a flapping roster", () => {
	const monitor = new ToolAvailabilityMonitor(4);
	for (let i = 0; i < 50; i++) {
		monitor.inspect(init([]), [`mcp__custom-tools__t${i}`], SERVER);
		assert.ok(monitor.size <= 4, `size ${monitor.size} after ${i}`);
	}
});

test("duplicate expected names are collapsed before counting", () => {
	// resolveMcpTools records each tool under its name and its lowercased name.
	const monitor = new ToolAvailabilityMonitor();
	const result = monitor.inspect(init([]), ["mcp__custom-tools__task", "mcp__custom-tools__task"], SERVER);
	assert.deepEqual(result.expected, ["mcp__custom-tools__task"]);
	assert.match(result.message, /1 of 1 OMP tools/);
});

// --- Name-matching policy ---

test("case-only spelling differences do not raise a false missing warning", () => {
	// The bridge matches tool names exactly first, then case-insensitively
	// (`mapToolName` in index.ts). A host that normalised case would otherwise
	// toast about tools that are in fact present.
	const monitor = new ToolAvailabilityMonitor();
	const result = monitor.inspect(init(["mcp__custom-tools__Task"]), ["mcp__custom-tools__task"], SERVER);
	assert.deepEqual(result.missing, []);
});

test("the case-insensitive fallback never merges two genuinely distinct names", () => {
	// MCP tool names are case-sensitive on the wire. When two registered names
	// fold to the same key, only an exact match counts — otherwise one advertised
	// spelling would silently vouch for both.
	const monitor = new ToolAvailabilityMonitor();
	const result = monitor.inspect(
		init(["mcp__custom-tools__task"]),
		["mcp__custom-tools__task", "mcp__custom-tools__Task"],
		SERVER,
	);
	assert.deepEqual(result.missing, ["mcp__custom-tools__Task"]);
});

// --- The invariant that makes the advertised list a sound signal ---

/** Text of the balanced delimiter group that opens at or after `from`. */
function balancedGroup(source, from, openers = "({[") {
	let start = from;
	while (start < source.length && !openers.includes(source[start])) start++;
	assert.ok(start < source.length, "no opening delimiter found");
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if ("({[".includes(ch)) depth++;
		else if (")}]".includes(ch)) {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	return assert.fail("unbalanced delimiter group in src/index.ts");
}

/** Arguments of the first call to `name`, whatever the formatting. */
function callArguments(source, name) {
	const at = source.indexOf(`${name}(`);
	assert.notEqual(at, -1, `${name}( not found in src/index.ts`);
	return balancedGroup(source, at + name.length, "(");
}

/** Object literal assigned to the first `const <name>`, skipping its type annotation. */
function declaredObjectLiteral(source, name) {
	const at = source.indexOf(`const ${name}`);
	assert.notEqual(at, -1, `const ${name} not found in src/index.ts`);
	const assign = source.indexOf("= {", at);
	assert.notEqual(assign, -1, `const ${name} is not assigned an object literal`);
	return balancedGroup(source, assign + 1, "{");
}

test("the bridge keeps OMP tools out of Claude Code's Tool Search deferral", () => {
	// Deferred MCP tools are legitimately absent from the advertised init list,
	// which would make this detector report every one of them as missing. Two
	// things prevent that:
	//   1. `alwaysLoad: true` on the SDK MCP server (the load-bearing guarantee);
	//   2. `tools: []` in the provider query options, which leaves Claude Code
	//      without a ToolSearchTool at all (defence in depth).
	// That `alwaysLoad: true` really produces `_meta['anthropic/alwaysLoad']` is
	// asserted behaviourally in tests/crossversion-zod-wire-schema.mjs; this
	// guard only pins the call sites, since buildMcpServers lives in index.ts and
	// is not importable without refactoring the toolCallId correlation path.
	// Arguments are matched through balanced-delimiter extraction, so reformatting
	// or reordering the options does not break the assertion.
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(callArguments(source, "createSdkMcpServer"), /\balwaysLoad\s*:\s*true\b/);
	assert.match(declaredObjectLiteral(source, "queryOptions"), /\btools\s*:\s*\[\s*\]/);
});
