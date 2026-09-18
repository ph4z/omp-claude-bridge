// Prompt capture + projection for faithful OMP → Claude Code system-prompt transport.
//
// Claude Code keeps its own `claude_code` preset, which already carries the base
// coding-agent harness (tool policy, workstation, general guidance). What it does
// NOT carry is the portable material OMP assembled for THIS agent: project
// context files (AGENTS.md/CLAUDE.md), the skills block, custom/append prompt
// text, and — the bug this module fixes — a subagent's `§ Role`/`§ Context`
// block, which is where native `task.context` (e.g. PRIOR_PHASE_RESULTS) lives.
//
// The bridge must project ONLY those portable parts behind the preset. Appending
// OMP's entire assembled system prompt is rejected: it duplicates the harness and
// tool catalog, recursively re-embeds parent prompts into child prompts, and
// mixes OMP-specific runtime instructions with Claude Code's own harness.
//
// OMP 18.2.2's `before_agent_start` exposes only the fully assembled
// `systemPrompt: string[]` (no structured `systemPromptOptions`), so index.ts
// derives the structured `PromptCaptureInput` from that array and records it here,
// keyed by the assembled prompt. The provider then resolves the `context.systemPrompt`
// it receives against the capture and projects the portable parts.
//
// Design (mechanism, not code) ported from elidickinson/pi-claude-bridge's
// `PromptCaptures`, adapted to this fork: text sections instead of `Skill[]`
// objects (OMP does not expose them to extensions), plus a process-global shared
// registry so a child session that records under one extension module instance is
// resolvable from the provider callback owned by the parent instance.

import { formatProjectContext } from "./agents-md.js";

/** One applicable skill, kept as pre-rendered text. `id` dedupes across inheritance
 *  (equivalent to the reference's `filePath`). `disabled` skips model-invocable rendering. */
export interface CapturedSkill {
	id: string;
	content: string;
	disabled?: boolean;
}

/** The portable, structured inputs OMP used to assemble one agent's prompt. */
export interface PromptCaptureInput {
	/** Per-agent custom prose. For a subagent this is the `§ Role`/`§ Context`/`§ Plan`
	 *  block carrying its assignment and native `task.context`. */
	custom?: string;
	/** User-authored append text (session config / CLI `--append-system-prompt`). */
	append?: string;
	/** Project context files (AGENTS.md/CLAUDE.md), deduped by `path` on projection. */
	contextFiles: Array<{ path: string; content: string }>;
	/** Skills available to this agent, deduped by `id` on projection. */
	skills: CapturedSkill[];
}

interface InheritedPrompt {
	start: number;
	end: number;
	parent: PromptCapture;
}

export type PromptCapture = PromptCaptureInput & {
	assembledPrompt: string;
	/** Exact previously assembled prompts embedded in `custom`. */
	inherited: InheritedPrompt[];
};

export interface PromptCaptureDiagnostic {
	/** The prompt that matched nothing; too large to log inline, so callers log a
	 *  fingerprint plus the closest known match's first divergent offset. */
	systemPrompt: string;
	matches: Array<{ key: string; firstDivergent: number }>;
}

/**
 * Captures keyed by the fully assembled prompt OMP sends to a provider.
 *
 * A subagent's system prompt may embed a previously assembled parent prompt
 * verbatim. OMP 18.2.2 exposes it as ordinary prompt text without provenance, so
 * linking exact prior keys recovers the inheritance graph without recognizing OMP
 * prose or subagent markers.
 */
export class PromptCaptures {
	private readonly captures = new Map<string, PromptCapture>();
	private readonly onDiagnose: (diagnostic: PromptCaptureDiagnostic) => void;

	/** `limit` is set well above any plausible working set: a capture is tens of KB,
	 *  while evicting a still-live one fails a turn. The bound only caps an extension
	 *  that rebuilds the prompt every turn. */
	constructor(private readonly limit = 256, onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void) {
		this.onDiagnose = onDiagnose ?? (() => {});
	}

	record(systemPrompt: string, input: PromptCaptureInput): void {
		if (!systemPrompt) return;
		const existing = this.captures.get(systemPrompt);
		const customChanged = existing?.custom !== input.custom;
		const capture: PromptCapture = existing ?? {
			...input,
			assembledPrompt: systemPrompt,
			contextFiles: [],
			skills: [],
			inherited: [],
		};

		capture.custom = input.custom;
		capture.append = input.append;
		capture.contextFiles = input.contextFiles.map((file) => ({ ...file }));
		capture.skills = input.skills.map((skill) => ({ ...skill }));
		if (!existing || customChanged) {
			capture.inherited = this.findInheritedPrompts(systemPrompt, input.custom);
		}

		// Mutate the existing node in place so descendants keep a live reference,
		// then re-insert its key so Map order tracks recency.
		this.touch(systemPrompt, capture);
	}

	/** Exact lookup only. Query servers want {@link resolveOrDerive}. */
	resolve(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const capture = this.captures.get(systemPrompt);
		if (capture) this.touch(systemPrompt, capture);
		return capture;
	}

	/**
	 * The capture to project for one query.
	 *
	 * Exact key is the normal case. A prompt that only *embeds* known prompts —
	 * anything that wrapped what OMP assembled after we recorded it — resolves to a
	 * transient descendant over the whole prompt: projection swaps each embedded
	 * capture for its portable parts and carries the surrounding wrapper text
	 * through unchanged (dropping it would be the silent instruction loss this
	 * exists to prevent).
	 *
	 * Throws when a prompt matches neither route. Returning an empty capture would
	 * hand Claude Code a turn with none of the user's context files, skills, custom
	 * or append text — silently discarding policy the user wrote down. A failed turn
	 * is recoverable; a silently under-instructed one is not.
	 */
	resolveOrDerive(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const exact = this.captures.get(systemPrompt);
		if (exact) {
			this.touch(systemPrompt, exact);
			return exact;
		}

		// A capture can outlive its lookup key: eviction drops the key while
		// inheritance edges keep the node alive. Revive an exact-content match.
		const revived = this.reachableCaptures().find((node) => node.assembledPrompt === systemPrompt);
		if (revived) {
			this.touch(systemPrompt, revived);
			return revived;
		}

		const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt);
		if (embedded.length === 0) {
			const matches = this.closestKnown(systemPrompt);
			this.onDiagnose({ systemPrompt, matches });
			throw new Error(
				`prompt-capture: no capture for this ${systemPrompt.length}-char system prompt, and it embeds none of the ${this.captures.size} known. `
				+ `Closest known match diverges at offset ${matches[0]?.firstDivergent ?? "?"} (${matches.length ? matches[0].key.length : 0}-char key). `
				+ `Claude Code would receive none of this turn's context files, skills or custom instructions. `
				+ `The usual cause is an extension loaded after claude-bridge that rewrites the system prompt from before_agent_start, or OMP rebuilding the prompt outside before_agent_start.`,
			);
		}

		// `custom` is the prompt itself and edges keep their original offsets, so
		// projection substitutes the embedded captures in place and preserves every
		// byte between and around them.
		return { assembledPrompt: systemPrompt, custom: systemPrompt, contextFiles: [], skills: [], inherited: embedded };
	}

	get size(): number {
		return this.captures.size;
	}

	/** Recency is by use, not just by record: a parent records once then only
	 *  resolves, so counting writes alone ages it out behind churning subagent
	 *  prompts. */
	private touch(systemPrompt: string, capture: PromptCapture): void {
		this.captures.delete(systemPrompt);
		this.captures.set(systemPrompt, capture);
		for (const key of this.captures.keys()) {
			if (this.captures.size <= this.limit) break;
			this.captures.delete(key);
		}
	}

	/** Longest shared-prefix matches, best first, for the throw diagnostic. */
	private closestKnown(systemPrompt: string): Array<{ key: string; firstDivergent: number }> {
		let shared = 0;
		const matches: Array<{ key: string; firstDivergent: number }> = [];
		for (const key of this.captures.keys()) {
			const limit = Math.min(key.length, systemPrompt.length);
			let i = 0;
			while (i < limit && key.charCodeAt(i) === systemPrompt.charCodeAt(i)) i++;
			if (i >= shared) {
				if (i > shared) {
					shared = i;
					matches.length = 0;
				}
				matches.push({ key, firstDivergent: i });
			}
		}
		return matches;
	}

	private findInheritedPrompts(systemPrompt: string, custom?: string): InheritedPrompt[] {
		if (!custom) return [];

		const candidates: Array<InheritedPrompt & { length: number }> = [];
		for (const parent of this.reachableCaptures()) {
			const key = parent.assembledPrompt;
			if (key === systemPrompt || key.length === 0) continue;
			for (let start = custom.indexOf(key); start !== -1; start = custom.indexOf(key, start + key.length)) {
				candidates.push({ start, end: start + key.length, length: key.length, parent });
			}
		}

		// A grandchild embeds both its parent's key and the grandparent nested
		// inside it. Keep the longest exact non-overlapping matches.
		candidates.sort((a, b) => b.length - a.length || a.start - b.start);
		const selected: InheritedPrompt[] = [];
		for (const candidate of candidates) {
			if (selected.some((edge) => candidate.start < edge.end && candidate.end > edge.start)) continue;
			selected.push({ start: candidate.start, end: candidate.end, parent: candidate.parent });
		}
		return selected.sort((a, b) => a.start - b.start);
	}

	private reachableCaptures(): PromptCapture[] {
		const result: PromptCapture[] = [];
		const seen = new Set<PromptCapture>();
		const visit = (capture: PromptCapture): void => {
			if (seen.has(capture)) return;
			seen.add(capture);
			result.push(capture);
			for (const edge of capture.inherited) visit(edge.parent);
		};
		for (const capture of this.captures.values()) visit(capture);
		return result;
	}
}

/** Project a capture to the portable append that follows Claude Code's preset. */
export function projectPromptCapture(capture: PromptCapture): string | undefined {
	return projectCapture(capture, new Set());
}

/** Skills reachable through inherited prompts, ancestor first, once per id. */
export function collectPromptSkills(capture: PromptCapture): CapturedSkill[] {
	const result: CapturedSkill[] = [];
	const seenIds = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const skill of node.skills) {
			if (skill.disabled || seenIds.has(skill.id)) continue;
			seenIds.add(skill.id);
			result.push(skill);
		}
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return result;
}

/** Context-file paths reachable through inherited prompts, once each. */
export function collectPromptContextPaths(capture: PromptCapture): Set<string> {
	const paths = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const file of node.contextFiles) paths.add(file.path);
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return paths;
}

function renderSkills(skills: CapturedSkill[]): string | undefined {
	const parts = skills.map((skill) => skill.content.trim()).filter((content) => content.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function projectCapture(capture: PromptCapture, visiting: Set<PromptCapture>): string | undefined {
	if (visiting.has(capture)) throw new Error("Cyclic prompt inheritance");
	visiting.add(capture);
	try {
		// Skills/context an ancestor already contributes are rendered via the
		// substituted parent projection inside `custom`; drop them from this node so
		// inherited material appears exactly once.
		const inheritedSkillIds = new Set(
			capture.inherited.flatMap((edge) => collectPromptSkills(edge.parent).map((skill) => skill.id)),
		);
		const ownSkillIds = new Set<string>();
		const ownSkills = capture.skills.filter((skill) => {
			if (skill.disabled || inheritedSkillIds.has(skill.id) || ownSkillIds.has(skill.id)) return false;
			ownSkillIds.add(skill.id);
			return true;
		});

		const inheritedContextPaths = new Set(
			capture.inherited.flatMap((edge) => [...collectPromptContextPaths(edge.parent)]),
		);
		const ownContextPaths = new Set<string>();
		const ownContextFiles = capture.contextFiles.filter((file) => {
			if (inheritedContextPaths.has(file.path) || ownContextPaths.has(file.path)) return false;
			ownContextPaths.add(file.path);
			return true;
		});

		const custom = projectCustom(capture, visiting);
		const parts = [
			formatProjectContext(ownContextFiles),
			renderSkills(ownSkills),
			custom,
			capture.append,
		].filter((part): part is string => Boolean(part && part.trim()));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	} finally {
		visiting.delete(capture);
	}
}

function projectCustom(capture: PromptCapture, visiting: Set<PromptCapture>): string | undefined {
	if (!capture.custom || capture.inherited.length === 0) return capture.custom;

	let result = "";
	let cursor = 0;
	for (const edge of capture.inherited) {
		result += capture.custom.slice(cursor, edge.start);
		result += projectCapture(edge.parent, visiting) ?? "";
		cursor = edge.end;
	}
	return result + capture.custom.slice(cursor);
}

// --- Process-global shared registry ---------------------------------------
//
// OMP child sessions may re-load this extension while the shared ModelRegistry's
// streamSimple still belongs to the parent instance (see provider-registration.ts).
// A child records its prompt in whichever module instance handled its
// before_agent_start; the provider callback that later resolves it may run from
// another instance. A single module-local `new PromptCaptures()` would not see
// both, so the registry lives in a Symbol.for() global keyed like the shared
// provider stream. Mirrors that lifecycle: process-global, LRU-bounded, never
// cleared per session (a child may still need a parent capture after the parent's
// turn ended).

export const PROMPT_CAPTURES_KEY = Symbol.for("claude-bridge:promptCaptures");

export function sharedPromptCaptures(
	globalState: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
	options?: { limit?: number; onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void },
): PromptCaptures {
	const existing = globalState[PROMPT_CAPTURES_KEY] as PromptCaptures | undefined;
	if (existing) return existing;
	const created = new PromptCaptures(options?.limit ?? 256, options?.onDiagnose);
	globalState[PROMPT_CAPTURES_KEY] = created;
	return created;
}

// --- OMP 18.2.2 assembled-array derivation ---------------------------------
//
// OMP exposes only the fully assembled `systemPrompt: string[]` at
// before_agent_start, so the structured PromptCaptureInput is derived from it.
// Context files and the skills block are sourced independently by the caller
// (AGENTS.md walk-up from disk, and skills-block extraction), because OMP bakes
// them into rendered templates that cannot be cleanly split back out. The one
// portable part that lives as its own array entry is the subagent block, which
// carries `§ Role`/`§ Context` (native `task.context`, e.g. PRIOR_PHASE_RESULTS)
// and is exactly what the old AGENTS+skills-only extraction dropped.

/** Verbatim line unique to `subagent-system-prompt.md`; marks the array entry
 *  that holds a subagent's role, assignment context, and plan. */
export const SUBAGENT_BLOCK_MARKER = "You are operating on a piece of work assigned to you by the main agent.";

/** The subagent role/context/plan block from an assembled prompt array, or
 *  undefined for a main-agent prompt that has no such block. */
export function extractSubagentBlock(assembled: string[]): string | undefined {
	const block = assembled.find((part) => part.includes(SUBAGENT_BLOCK_MARKER));
	return block ? block.trim() : undefined;
}

/** Build the structured capture input from OMP's assembled prompt plus the
 *  independently-sourced portable sections. */
export function deriveCaptureInput(
	assembled: string[],
	sources: { contextFiles?: Array<{ path: string; content: string }>; skillsBlock?: string; append?: string },
): PromptCaptureInput {
	return {
		custom: extractSubagentBlock(assembled),
		append: sources.append,
		contextFiles: sources.contextFiles ?? [],
		skills: sources.skillsBlock ? [{ id: "omp-skills", content: sources.skillsBlock }] : [],
	};
}
