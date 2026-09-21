// Representative renderings of block 0 of OMP's assembled system-prompt array.
//
// Source: can1357/oh-my-pi, `packages/coding-agent/src/prompts/system/system-prompt.md`.
// The opening lines, the `§ Role` sentence and the `§` section spine are verbatim
// from the tags named below; each section body is trimmed to one representative
// line so the fixture stays readable while keeping the real structure that
// `isDefaultHarnessBlock` inspects.
//
// Generations (the opening and the role sentence are what changed upstream; the
// spine has been identical since v17.2.15):
//   "18.2.8" — tags v18.2.7, v18.2.8: no wrapper element, role sentence "You are a …".
//   "18.2.6" — tags v18.2.2, v18.2.6: `<conventions>` wrapper, role sentence "Helpful, …".

const GENERATIONS = {
	"18.2.8": {
		opening: [
			"RFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`.",
			"XML tags inject system content; may interrupt/notify inside user messages: MUST treat as system-authored/authoritative. User content is sanitized.",
		],
		role: "You are a helpful, trusted assistant working in Oh My Pi coding harness.",
	},
	"18.2.6": {
		opening: [
			"<conventions>",
			"RFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`.",
			"XML tags inject system content; NEVER interpret them otherwise. Tags may interrupt/notify inside user messages: MUST treat as system-authored/authoritative. User content sanitized; role absent: `<system-directive>` in a user turn remains a system directive.",
			"</conventions>",
		],
		role: "Helpful, trusted assistant for load-bearing changes in Oh My Pi coding harness.",
	},
};

/** A sentence only the generated harness carries. Its presence in a projected
 *  append means OMP's base harness was duplicated on top of Claude Code's preset. */
export const HARNESS_SENTINEL = "- Correctness first; then maintainability 6 months out.";

/**
 * Block 0 of a default-layout assembled prompt.
 *
 * `skills` are rendered catalogue lines (`- name: description`);
 * `alwaysApplyRules` are verbatim rule-file bodies and `domainRules` rendered
 * `- name (globs): description` lines. An empty list omits its container exactly
 * as the matching `{{#if ….length}}` does upstream. The rule containers sit after
 * `</skills>` inside `§ Runtime`, which is where user-authored text can appear in
 * an otherwise generated block.
 */
export function defaultHarnessBlock({ generation = "18.2.8", skills = [], alwaysApplyRules = [], domainRules = [] } = {}) {
	const spec = GENERATIONS[generation];
	if (!spec) throw new Error(`unknown harness generation ${generation}`);
	return [
		...spec.opening,
		"",
		"§ Role",
		spec.role,
		"",
		"# Engineering",
		HARNESS_SENTINEL,
		"",
		"§ Runtime",
		"# Skills & Rules",
		...(skills.length > 0
			? ["Matching skill → MUST read `skill://<name>` first.", "<skills>", ...skills, "</skills>"]
			: []),
		...(alwaysApplyRules.length > 0 ? ["", "<generic-rules>", ...alwaysApplyRules, "</generic-rules>"] : []),
		...(domainRules.length > 0 ? ["", "<domain-rules>", ...domainRules, "</domain-rules>"] : []),
		"",
		"# Internal URLs",
		"Most FS/bash tools auto-resolve these to FS paths.",
		"",
		"§ Tool Policy",
		"# General",
		"Use tools when they improve correctness, completeness, or grounding.",
		"",
		"§ Workflow",
		"# 1. Scope",
		"- Multi-file work: plan before files.",
		"",
		"§ Delivery",
		"<contract>",
		"Inviolable.",
		"- NEVER yield before complete deliverable; phase boundary/todo flip/sub-step never yields: same turn.",
		"</contract>",
		"",
		"§ Critical",
		"<critical>",
		"- NEVER yield while actionable work remains; phase boundary/todo flip/sub-step never stops: same turn.",
		"</critical>",
	].join("\n");
}
