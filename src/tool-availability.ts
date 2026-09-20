// Detection of OMP tools that the bridge registered but Claude Code did not load.
//
// Claude Code drops every tool of an MCP server whose `tools/list` fails, and
// the server still reports itself `connected` in that state. The advertised
// tool list on the `init` message is therefore the only reliable signal, and
// the first place the loss is observable — before that, a turn simply runs with
// no OMP tool and the model reports them as nonexistent.
//
// Extracted from index.ts so the logic is unit-testable without activating the
// extension, following the same split as rate-limit.ts / prompt-transport.ts:
// this module decides *what* to report, index.ts owns debug/notify/diagDump.
//
// --- Why the advertised list is a sound signal ---
//
// Claude Code can defer MCP tools behind its Tool Search tool, in which case
// they are legitimately absent from the advertised list and this detector would
// report every one of them as missing. Two things keep that from happening, and
// both are asserted by tests:
//
//   1. buildMcpServers passes `alwaysLoad: true` to createSdkMcpServer, which
//      marks every tool `_meta['anthropic/alwaysLoad']` so it is never deferred.
//      That the flag really produces that marker is asserted behaviourally in
//      tests/crossversion-zod-wire-schema.mjs against a live SDK MCP server.
//   2. The provider's query options pass `tools: []`, which leaves Claude Code
//      without a ToolSearchTool at all ("Tool search disabled: ToolSearchTool
//      is not available" in the CLI log).
//
// (1) is the load-bearing guarantee; (2) is defence in depth. Relying on (2)
// alone would be an undocumented accidental interaction.

import type { SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ToolAvailabilityResult {
	/** Registered tool names Claude Code did not advertise; empty when healthy. */
	missing: string[];
	/** Every tool name the bridge registered, in SDK (`mcp__…`) form. */
	expected: string[];
	/** Every tool name Claude Code advertised, including its own built-ins. */
	advertised: string[];
	/** Status Claude Code reports for the bridge's MCP server, or "absent". */
	status: string;
	/** Human-readable report; present only when `missing` is non-empty. */
	message?: string;
	/**
	 * True when this exact missing set has not been reported yet. Callers gate
	 * user-visible notifications and diagnostic dumps on it; plain debug logging
	 * should ignore it so every occurrence stays traceable.
	 */
	firstReport: boolean;
}

/**
 * Remembers which missing-tool conditions have already been reported.
 *
 * Continuation/replay queries each spawn their own CLI process and therefore
 * their own `init`, so without this a single broken tool schema would toast and
 * dump on every query of every turn. Mirrors the `warnedContextWindowDrift`
 * pattern in index.ts, with two additions the tool roster needs:
 *
 *   - a *different* missing set is a different condition and reports again;
 *   - a healthy init clears the memory, so a later genuine failure is never
 *     permanently suppressed by an earlier recovery.
 *
 * State is bounded: it holds at most {@link maxSignatures} short strings and is
 * cleared whenever the roster comes back healthy.
 */
export class ToolAvailabilityMonitor {
	readonly #reported = new Set<string>();
	readonly #maxSignatures: number;

	constructor(maxSignatures = 8) {
		this.#maxSignatures = Math.max(1, maxSignatures);
	}

	/** Number of remembered conditions; exposed so tests can assert boundedness. */
	get size(): number {
		return this.#reported.size;
	}

	/**
	 * Compare what the bridge registered against what Claude Code advertised.
	 *
	 * `expectedSdkToolNames` are the fully-qualified `mcp__<server>__<tool>`
	 * names. Claude-native tools in the advertised list are irrelevant: this is
	 * a subset test, never an equality test. Returns undefined when there is
	 * nothing to check — no registered tools (OMP side requests such as
	 * auto-thinking send none) or a CLI too old to advertise a tool list.
	 */
	inspect(init: SDKSystemMessage, expectedSdkToolNames: Iterable<string>, serverName: string): ToolAvailabilityResult | undefined {
		const expected = [...new Set(expectedSdkToolNames)];
		if (expected.length === 0) return undefined;
		const advertised = init.tools;
		if (!Array.isArray(advertised)) return undefined;

		// Name matching follows the same policy as the rest of the bridge
		// (`mapToolName` in index.ts): exact match first, then a case-insensitive
		// fallback. MCP tool names are case-sensitive on the wire, so the fallback
		// is applied only when it cannot merge two genuinely distinct registered
		// names — i.e. when exactly one expected name folds to that lowercase key.
		// Without it, a host that normalised case would produce a user-visible
		// "did not load N of M OMP tools" toast for tools that are in fact present.
		const advertisedSet = new Set(advertised);
		const advertisedFolded = new Set(advertised.map(name => name.toLowerCase()));
		const foldCollisions = new Map<string, number>();
		for (const name of expected) {
			const key = name.toLowerCase();
			foldCollisions.set(key, (foldCollisions.get(key) ?? 0) + 1);
		}
		const isAdvertised = (name: string): boolean => {
			if (advertisedSet.has(name)) return true;
			const key = name.toLowerCase();
			return foldCollisions.get(key) === 1 && advertisedFolded.has(key);
		};
		const missing = expected.filter(name => !isAdvertised(name));
		const status = init.mcp_servers?.find(server => server.name === serverName)?.status ?? "absent";

		if (missing.length === 0) {
			// Healthy roster: forget past conditions so a future failure reports.
			this.#reported.clear();
			return { missing, expected, advertised, status, firstReport: false };
		}

		const signature = [...missing].sort().join(",");
		const firstReport = !this.#reported.has(signature);
		if (firstReport) {
			// Cap the memory rather than letting a flapping roster grow it. Clearing
			// (instead of evicting one entry) keeps the invariant simple: at worst a
			// long-past condition is reported a second time.
			if (this.#reported.size >= this.#maxSignatures) this.#reported.clear();
			this.#reported.add(signature);
		}

		const message =
			`Claude Code did not load ${missing.length} of ${expected.length} OMP tools ` +
			`(MCP server "${serverName}" is ${status}): ${missing.join(", ")}. ` +
			`Rerun with CLAUDE_BRIDGE_DEBUG=1 and check the Claude Code CLI log for a ` +
			`"Failed to fetch tools" error.`;

		return { missing, expected, advertised, status, message, firstReport };
	}
}
