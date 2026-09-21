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
			defaultHarnessBlock({ generation, skills: [`- bridge: SKILL-${generation}`] }),
			projectBlock(generation),
		];

		const input = deriveCaptureInput(assembled);
		assert.equal(input.custom, undefined, "generated harness must not become custom content");
		assert.equal(input.append, `APPEND-${generation}`);

		const projected = project(assembled);
		assert.ok(!projected.includes(HARNESS_SENTINEL), "generated harness reached the projected append");
		assert.ok(!projected.includes("§ Delivery"), "generated harness sections reached the projected append");
		assert.equal(count(projected, `CONTEXT-${generation}`), 1);
		assert.equal(count(projected, `SKILL-${generation}`), 1);
		assert.equal(count(projected, `APPEND-${generation}`), 1);
	});
}

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
