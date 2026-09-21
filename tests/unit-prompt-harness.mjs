// Recognition of OMP's generated default system harness.
//
// The harness is non-portable: Claude Code's `claude_code` preset already carries
// an equivalent base harness, so block 0 of a default-layout prompt must never
// reach `capture.custom`. When recognition breaks, the whole OMP harness is
// forwarded as the projected append and the default append prompt is lost with
// it (`deriveCaptureInput` reads append from the PROJECT tail only when block 0
// is not custom). Both failure modes are asserted here.

import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveCaptureInput,
	projectPromptCapture,
	PromptCaptures,
	SUBAGENT_BLOCK_MARKER,
} from "../src/prompt-capture.ts";
import { defaultHarnessBlock, HARNESS_SENTINEL } from "./fixtures/omp-system-prompts.mjs";

const count = (haystack, needle) => haystack.split(needle).length - 1;

/** Block rendered from `prompts/system/project-prompt.md`, byte-identical across
 *  v18.2.2 … v18.2.8; `appendPrompt` renders at its tail. */
function projectBlock(marker) {
	return [
		"PROJECT",
		"",
		"<repo-rules>",
		"MUST follow these context files for all tasks:",
		'<file path="/repo/AGENTS.md">',
		`CONTEXT-${marker}`,
		"</file>",
		"</repo-rules>",
		"",
		"<critical>",
		"- Each response MUST advance the task; completion only stopping condition.",
		"generated project policy",
		"</critical>",
		"",
		`APPEND-${marker}`,
	].join("\n");
}

function project(assembled) {
	const key = assembled.join("\n\n");
	const captures = new PromptCaptures();
	captures.record(key, deriveCaptureInput(assembled));
	const projected = projectPromptCapture(captures.resolve(key));
	assert.ok(projected, "expected a projected append");
	return projected;
}

for (const generation of ["18.2.8", "18.2.6"]) {
	test(`OMP ${generation} default harness is stripped while its portable parts project once`, () => {
		const assembled = [
			defaultHarnessBlock({
				generation,
				skills: [`- bridge: SKILL-${generation}`],
				alwaysApplyRules: [`GENERIC-RULE-${generation}: always follow this.`],
				domainRules: [`- domain-${generation} (src/**): DOMAIN-RULE-${generation}`],
			}),
			projectBlock(generation),
		];

		const input = deriveCaptureInput(assembled);
		assert.equal(input.custom, undefined, "generated harness must not become custom content");
		assert.equal(input.append, `APPEND-${generation}`);
		assert.equal(input.rules?.length, 2, "both generated rule containers must be captured");

		const projected = project(assembled);
		assert.ok(!projected.includes(HARNESS_SENTINEL), "generated harness reached the projected append");
		assert.ok(!projected.includes("§ Delivery"), "generated harness sections reached the projected append");
		assert.equal(count(projected, `CONTEXT-${generation}`), 1);
		assert.equal(count(projected, `SKILL-${generation}`), 1);
		assert.equal(count(projected, `GENERIC-RULE-${generation}`), 1);
		assert.equal(count(projected, `DOMAIN-RULE-${generation}`), 1);
		assert.equal(count(projected, "<generic-rules>"), 1);
		assert.equal(count(projected, "<domain-rules>"), 1);
		assert.equal(count(projected, `APPEND-${generation}`), 1);
	});
}

test("user-authored rule text inside the harness block does not defeat recognition", () => {
	// `<generic-rules>` carries verbatim `.omp/rules/*.md` bodies, so arbitrary user
	// prose lands inside an otherwise generated block 0. Recognition must survive it.
	// The rule containers are portable user/project policy and must be projected
	// after the generated harness itself is stripped.
	const assembled = [
		defaultHarnessBlock({
			generation: "18.2.8",
			skills: ["- bridge: SKILL-RULES"],
			alwaysApplyRules: ["§ Delivery is my favourite section.", "RFC 2119: MUST, REQUIRED — quoted by a rule."],
			domainRules: ["- house (src/**): the house style."],
		}),
		projectBlock("RULES"),
	];

	assert.equal(deriveCaptureInput(assembled).custom, undefined);
	const projected = project(assembled);
	assert.ok(!projected.includes(HARNESS_SENTINEL));
	assert.equal(count(projected, "CONTEXT-RULES"), 1);
	assert.equal(count(projected, "SKILL-RULES"), 1);
	assert.equal(count(projected, "§ Delivery is my favourite section."), 1);
	assert.equal(count(projected, "RFC 2119: MUST, REQUIRED — quoted by a rule."), 1);
	assert.equal(count(projected, "- house (src/**): the house style."), 1);
	assert.equal(count(projected, "<generic-rules>"), 1);
	assert.equal(count(projected, "<domain-rules>"), 1);
	assert.equal(count(projected, "APPEND-RULES"), 1);
});

test("custom prompt text that uses rule-like tags stays custom and is not double-projected", () => {
	const custom = [
		"CUSTOM-RULE-WRAPPER-BEFORE",
		"<generic-rules>",
		"CUSTOM-TAGGED-RULE-MUST-SURVIVE",
		"</generic-rules>",
		"<domain-rules>",
		"- custom (lib/**): CUSTOM-DOMAIN-RULE-MUST-SURVIVE",
		"</domain-rules>",
		"CUSTOM-RULE-WRAPPER-AFTER",
	].join("\n");
	const assembled = [custom, projectBlock("CUSTOM-RULE-TAGS")];

	const input = deriveCaptureInput(assembled);
	assert.equal(input.rules?.length ?? 0, 0, "rule extraction must be scoped to a recognized default harness");
	assert.ok(input.custom?.includes("CUSTOM-TAGGED-RULE-MUST-SURVIVE"));

	const projected = project(assembled);
	assert.equal(count(projected, "CUSTOM-TAGGED-RULE-MUST-SURVIVE"), 1);
	assert.equal(count(projected, "CUSTOM-DOMAIN-RULE-MUST-SURVIVE"), 1);
});

test("inherited rule blocks project once when parent and child carry the same rendered rules", () => {
	const parentAssembled = [
		defaultHarnessBlock({
			generation: "18.2.8",
			alwaysApplyRules: ["INHERITED-GENERIC-RULE"],
			domainRules: ["- inherited (src/**): INHERITED-DOMAIN-RULE"],
		}),
		projectBlock("PARENT-RULES"),
	];
	const parentKey = parentAssembled.join("\n\n");
	const captures = new PromptCaptures();
	const parentInput = deriveCaptureInput(parentAssembled);
	captures.record(parentKey, parentInput);

	const childKey = `CHILD-BEFORE\n\n${parentKey}\n\nCHILD-AFTER`;
	captures.record(childKey, {
		custom: childKey,
		contextFiles: [],
		skills: [],
		rules: parentInput.rules,
	});

	const projected = projectPromptCapture(captures.resolve(childKey));
	assert.ok(projected);
	assert.equal(count(projected, "INHERITED-GENERIC-RULE"), 1);
	assert.equal(count(projected, "INHERITED-DOMAIN-RULE"), 1);
});

test("a custom prompt that pastes the bundled harness stays portable", () => {
	// custom-system-prompt.md renders customPrompt first, so a SYSTEM.md holding a
	// copy of the harness reproduces every positive anchor. Its own generated
	// containers — which system-prompt.md never emits — are what rejects it.
	const pasted = [
		defaultHarnessBlock({ generation: "18.2.8" }),
		"HOUSE-RULE-MUST-SURVIVE: ship with a changelog entry.",
		"",
		"<project>",
		"## Context",
		"<instructions>",
		'<file path="/repo/AGENTS.md">',
		"CONTEXT-PASTED",
		"</file>",
		"</instructions>",
		"</project>",
		"Skills are specialized knowledge. Scan descriptions for your task domain.",
		"<skills>",
		'<skill name="bridge">',
		"SKILL-PASTED",
		"</skill>",
		"</skills>",
	].join("\n");

	const assembled = [pasted, projectBlock("PASTED")];
	assert.ok(deriveCaptureInput(assembled).custom?.includes("HOUSE-RULE-MUST-SURVIVE"));

	const projected = project(assembled);
	assert.equal(count(projected, "HOUSE-RULE-MUST-SURVIVE"), 1);
	assert.equal(count(projected, "CONTEXT-PASTED"), 1);
	assert.equal(count(projected, "SKILL-PASTED"), 1);
});

test("a subagent turn projects its assignment without the generated base harness", () => {
	const subagent = [
		"§ Role",
		"You are the architecture subagent.",
		"",
		"§ Context",
		"PRIOR PHASE RESULTS:",
		"THIS-MUST-REACH-THE-CHILD",
		"",
		"§ Coop",
		SUBAGENT_BLOCK_MARKER,
	].join("\n");
	// task/executor.ts splices the subagent block in front of the PROJECT block.
	const projected = project([defaultHarnessBlock({ generation: "18.2.8" }), subagent, projectBlock("SUB")]);

	assert.equal(count(projected, "THIS-MUST-REACH-THE-CHILD"), 1);
	assert.equal(count(projected, "CONTEXT-SUB"), 1);
	assert.equal(count(projected, "APPEND-SUB"), 1);
	assert.ok(!projected.includes(HARNESS_SENTINEL));
});

// Dropping a genuine custom prompt is silent and unrecoverable, so recognition
// must need every anchor at once. Each case below carries real harness prose.
const notTheHarness = {
	"quotes the role sentence without opening like the harness": [
		"You are my release assistant.",
		"",
		"§ Role",
		"You are a helpful, trusted assistant working in Oh My Pi coding harness.",
		"",
		"§ Runtime",
		"§ Tool Policy",
		"§ Workflow",
		"§ Delivery",
		"§ Critical",
		"",
		"CUSTOM-MUST-SURVIVE",
	],
	"opens like the harness but carries a different role": [
		"RFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`.",
		"",
		"§ Role",
		"You are a release engineer for this repository.",
		"",
		"§ Runtime",
		"§ Tool Policy",
		"§ Workflow",
		"§ Delivery",
		"§ Critical",
		"",
		"CUSTOM-MUST-SURVIVE",
	],
	"reproduces the opening and role but not the section spine": [
		"RFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`.",
		"",
		"§ Role",
		"You are a helpful, trusted assistant working in Oh My Pi coding harness.",
		"",
		"§ Runtime",
		"Use the house style.",
		"",
		"CUSTOM-MUST-SURVIVE",
	],
	"carries the spine out of template order": [
		"RFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`.",
		"",
		"§ Role",
		"You are a helpful, trusted assistant working in Oh My Pi coding harness.",
		"",
		"§ Delivery",
		"§ Critical",
		"§ Runtime",
		"§ Tool Policy",
		"§ Workflow",
		"",
		"CUSTOM-MUST-SURVIVE",
	],
};

for (const [label, lines] of Object.entries(notTheHarness)) {
	test(`a custom prompt that ${label} stays portable`, () => {
		const assembled = [lines.join("\n"), projectBlock("CUSTOM")];

		const input = deriveCaptureInput(assembled);
		assert.ok(input.custom?.includes("CUSTOM-MUST-SURVIVE"), "custom prompt was classified as generated harness");

		const projected = project(assembled);
		assert.equal(count(projected, "CUSTOM-MUST-SURVIVE"), 1);
		assert.equal(count(projected, "CONTEXT-CUSTOM"), 1);
	});
}
