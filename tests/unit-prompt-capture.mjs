import assert from "node:assert/strict";
import test from "node:test";
import {
	PromptCaptures,
	projectPromptCapture,
	deriveCaptureInput,
	extractSubagentBlock,
	sharedPromptCaptures,
	releaseSharedPromptCaptures,
	SUBAGENT_BLOCK_MARKER,
} from "../src/prompt-capture.ts";

const count = (haystack, needle) => haystack.split(needle).length - 1;

test("1. basic projection carries each portable section exactly once, in order", () => {
	const captures = new PromptCaptures();
	const key = "ASSEMBLED-PROMPT-BASIC";
	captures.record(key, {
		custom: "CUSTOM-PROMPT-TEXT",
		append: "APPEND-PROMPT-TEXT",
		contextFiles: [{ path: "/proj/AGENTS.md", content: "CONTEXT-FILE-TEXT" }],
		skills: [{ id: "s1", content: "SKILL-ONE-TEXT" }],
	});

	const projected = projectPromptCapture(captures.resolveOrDerive(key));
	assert.ok(projected);
	assert.equal(count(projected, "CONTEXT-FILE-TEXT"), 1);
	assert.equal(count(projected, "SKILL-ONE-TEXT"), 1);
	assert.equal(count(projected, "CUSTOM-PROMPT-TEXT"), 1);
	assert.equal(count(projected, "APPEND-PROMPT-TEXT"), 1);

	// Order: context files → skills → custom → append.
	assert.ok(
		projected.indexOf("CONTEXT-FILE-TEXT") <
			projected.indexOf("SKILL-ONE-TEXT") &&
			projected.indexOf("SKILL-ONE-TEXT") < projected.indexOf("CUSTOM-PROMPT-TEXT") &&
			projected.indexOf("CUSTOM-PROMPT-TEXT") < projected.indexOf("APPEND-PROMPT-TEXT"),
	);
});

test("2. real OMP default layout preserves task.context, append, skills, and rendered context files", () => {
	const subagentBlock = [
		"§ Role",
		"You are the architecture subagent.",
		"",
		"§ Context",
		"PRIOR PHASE RESULTS:",
		"[architecture]",
		"THIS-MUST-REACH-THE-CHILD",
		"",
		"§ Coop",
		SUBAGENT_BLOCK_MARKER,
		"",
		"§ Completion",
		"Report results with yield.",
	].join("\n");

	// Mirrors the relevant OMP 18.2.2 template boundaries:
	// system-prompt.md → subagent-system-prompt.md → project-prompt.md.
	const harness = [
		"<conventions>",
		"OMP-HARNESS-MUST-NOT-BE-APPENDED",
		"</conventions>",
		"",
		"§ Runtime",
		"# Skills & Rules",
		"Matching skill → MUST read `skill://<name>` first.",
		"<skills>",
		"- bridge: BRIDGE-SKILL-MUST-SURVIVE",
		"</skills>",
	].join("\n");
	const project = [
		"PROJECT",
		"",
		"<repo-rules>",
		"MUST follow these context files for all tasks:",
		'<file path="/worktree/root/AGENTS.md">',
		"ROOT-CONTEXT-MUST-SURVIVE",
		"</file>",
		'<file path="/worktree/root/pkg/AGENTS.md">',
		"CHILD-CONTEXT-MUST-SURVIVE",
		"</file>",
		"</repo-rules>",
		"",
		"<critical>",
		"- Each response MUST advance the task; completion only stopping condition.",
		"generated project policy",
		"</critical>",
		"",
		"APPEND-MUST-SURVIVE",
	].join("\n");

	const assembled = [harness, subagentBlock, project];
	const key = assembled.join("\n\n");
	const captures = new PromptCaptures();
	captures.record(key, deriveCaptureInput(assembled));

	const projected = projectPromptCapture(captures.resolveOrDerive(key));
	assert.ok(projected);
	assert.equal(count(projected, "THIS-MUST-REACH-THE-CHILD"), 1);
	assert.equal(count(projected, "APPEND-MUST-SURVIVE"), 1);
	assert.equal(count(projected, "BRIDGE-SKILL-MUST-SURVIVE"), 1);
	assert.equal(count(projected, "ROOT-CONTEXT-MUST-SURVIVE"), 1);
	assert.equal(count(projected, "CHILD-CONTEXT-MUST-SURVIVE"), 1);
	assert.ok(projected.includes('<project_instructions path="/worktree/root/AGENTS.md">'));
	assert.ok(projected.includes('<project_instructions path="/worktree/root/pkg/AGENTS.md">'));
	assert.ok(projected.includes("PRIOR PHASE RESULTS:"));
	assert.ok(!projected.includes("OMP-HARNESS-MUST-NOT-BE-APPENDED"));
});

test("3. parent → child inheritance projects portable parent parts, not raw harness", () => {
	const captures = new PromptCaptures();

	// Parent's full assembled prompt embeds a non-portable harness marker.
	const parentAssembled = "PARENT-HARNESS-BLAH\n\nPARENT-CUSTOM-XYZ";
	captures.record(parentAssembled, {
		custom: "PARENT-PORTABLE-CUSTOM",
		contextFiles: [],
		skills: [{ id: "p-skill", content: "PARENT-SKILL" }],
	});

	// Child's own custom embeds the parent's assembled prompt verbatim.
	const childCustom = `CHILD-BEFORE\n\n${parentAssembled}\n\nCHILD-AFTER`;
	const childKey = "CHILD-ASSEMBLED-KEY";
	captures.record(childKey, { custom: childCustom, contextFiles: [], skills: [] });

	const projected = projectPromptCapture(captures.resolveOrDerive(childKey));
	assert.ok(projected);
	// Child's own instructions preserved.
	assert.ok(projected.includes("CHILD-BEFORE"));
	assert.ok(projected.includes("CHILD-AFTER"));
	// Parent's portable instructions inherited exactly once.
	assert.equal(count(projected, "PARENT-PORTABLE-CUSTOM"), 1);
	assert.equal(count(projected, "PARENT-SKILL"), 1);
	// Parent's raw assembled harness is NOT recursively copied.
	assert.ok(!projected.includes("PARENT-HARNESS-BLAH"));
});

test("4. wrapped known prompt preserves wrapper and substitutes the portable projection", () => {
	const captures = new PromptCaptures();
	const knownAssembled = "KNOWN-HARNESS-XYZ\n\nKNOWN-BODY";
	captures.record(knownAssembled, {
		custom: "KNOWN-CUSTOM",
		contextFiles: [],
		skills: [{ id: "k", content: "KNOWN-SKILL" }],
	});

	// Another extension wraps the previously captured prompt with extra text.
	const wrapped = `WRAPPER-PREFIX\n\n${knownAssembled}\n\nWRAPPER-SUFFIX`;
	const capture = captures.resolveOrDerive(wrapped);
	const projected = projectPromptCapture(capture);
	assert.ok(projected);
	// Unknown surrounding wrapper preserved.
	assert.ok(projected.includes("WRAPPER-PREFIX"));
	assert.ok(projected.includes("WRAPPER-SUFFIX"));
	// Known capture substituted with its portable projection.
	assert.ok(projected.includes("KNOWN-SKILL"));
	assert.ok(projected.includes("KNOWN-CUSTOM"));
	// The embedded raw assembled harness is replaced, not carried through.
	assert.ok(!projected.includes("KNOWN-HARNESS-XYZ"));
});

test("5. unknown/unaccountable prompt fails closed (throws, never append: undefined)", () => {
	const captures = new PromptCaptures();
	captures.record("SOME-RECORDED-PROMPT-AAAA", {
		custom: "C",
		contextFiles: [],
		skills: [],
	});

	assert.throws(
		() => captures.resolveOrDerive("COMPLETELY-UNRELATED-PROMPT-ZZZZ-NO-OVERLAP"),
		/no capture for this/,
	);
	// An empty/absent prompt is the legitimate "no system prompt" case, not a loss.
	assert.equal(captures.resolveOrDerive(undefined), undefined);
	assert.equal(captures.resolveOrDerive(""), undefined);
});

test("6. cross-extension-instance capture is visible through the shared registry", () => {
	// Two extension module instances sharing one process global (Symbol.for),
	// exactly like provider streamSimple ownership.
	const globalState = {};
	const instanceA = sharedPromptCaptures(globalState);
	const instanceB = sharedPromptCaptures(globalState);
	assert.equal(instanceA, instanceB, "both instances resolve to the same shared registry");

	// Instance B records a child's before_agent_start prompt...
	const childKey = "CHILD-PROMPT-RECORDED-BY-B";
	instanceB.record(childKey, {
		custom: "CHILD-B-CUSTOM",
		contextFiles: [],
		skills: [],
	});

	// ...and instance A (owning the provider streamSimple) resolves it.
	const capture = instanceA.resolveOrDerive(childKey);
	assert.ok(capture);
	assert.ok(projectPromptCapture(capture).includes("CHILD-B-CUSTOM"));
});

test("7. inherited AGENTS/skills are not duplicated", () => {
	const captures = new PromptCaptures();
	const parentAssembled = "PARENT-ASSEMBLED-DEDUP";
	captures.record(parentAssembled, {
		custom: "PARENT-CUSTOM-D",
		contextFiles: [{ path: "/proj/AGENTS.md", content: "SHARED-CTX" }],
		skills: [{ id: "shared", content: "SHARED-SKILL" }],
	});

	// Child carries the same context file + skill AND inherits the parent prompt.
	const childKey = "CHILD-ASSEMBLED-DEDUP";
	captures.record(childKey, {
		custom: `CHILD-D-BEFORE\n\n${parentAssembled}\n\nCHILD-D-AFTER`,
		contextFiles: [{ path: "/proj/AGENTS.md", content: "SHARED-CTX" }],
		skills: [{ id: "shared", content: "SHARED-SKILL" }],
	});

	const projected = projectPromptCapture(captures.resolveOrDerive(childKey));
	assert.ok(projected);
	assert.equal(count(projected, "SHARED-CTX"), 1, "context file appears once");
	assert.equal(count(projected, "SHARED-SKILL"), 1, "skill appears once");
});

test("extractSubagentBlock lifts only the subagent role/context array entry", () => {
	const subagentBlock = `§ Role\nX\n\n§ Coop\n${SUBAGENT_BLOCK_MARKER}`;
	assert.equal(extractSubagentBlock(["BASE", subagentBlock, "FOOTER"]), subagentBlock);
	assert.equal(extractSubagentBlock(["BASE-ONLY", "FOOTER-ONLY"]), undefined);
});

test("disabled skills are not rendered", () => {
	const captures = new PromptCaptures();
	captures.record("K-DISABLED", {
		custom: undefined,
		contextFiles: [],
		skills: [
			{ id: "on", content: "SKILL-ON" },
			{ id: "off", content: "SKILL-OFF", disabled: true },
		],
	});
	const projected = projectPromptCapture(captures.resolveOrDerive("K-DISABLED"));
	assert.ok(projected.includes("SKILL-ON"));
	assert.ok(!projected.includes("SKILL-OFF"));
});

test("LRU eviction survives via inheritance revival", () => {
	const captures = new PromptCaptures(2);
	captures.record("PARENT-KEY", { custom: "P-CUSTOM", contextFiles: [], skills: [] });
	// Child references the parent's assembled key; the edge holds a live node ref.
	captures.record("CHILD-KEY", { custom: "before\n\nPARENT-KEY\n\nafter", contextFiles: [], skills: [] });
	// One more capture evicts the parent's KEY (limit 2), but not the child's.
	captures.record("OTHER-KEY", { custom: "other", contextFiles: [], skills: [] });
	// Parent's key is gone, yet the child still projects the parent's portable custom.
	const projected = projectPromptCapture(captures.resolveOrDerive("CHILD-KEY"));
	assert.ok(projected.includes("P-CUSTOM"));
});

test("custom OMP layout preserves custom+append while projecting context and skills once", () => {
	const custom = [
		"SYSTEM-CUSTOMIZATION-MUST-SURVIVE",
		"CUSTOM-MUST-SURVIVE",
		"APPEND-CUSTOM-MODE-MUST-SURVIVE",
		"<project>",
		"## Context",
		"<instructions>",
		'<file path="/custom/worktree/AGENTS.md">',
		"CUSTOM-CONTEXT-MUST-SURVIVE",
		"</file>",
		"</instructions>",
		"## Version Control",
		"GENERATED-VCS-MUST-NOT-SURVIVE",
		"</project>",
		"Skills are specialized knowledge. Scan descriptions for your task domain.",
		"<skills>",
		'<skill name="custom-skill">',
		"CUSTOM-SKILL-MUST-SURVIVE",
		"</skill>",
		"</skills>",
	].join("\n");
	const generatedProject = [
		"PROJECT",
		"<workstation>",
		"- OS: linux",
		"</workstation>",
		"<critical>",
		"generated project policy",
		"</critical>",
	].join("\n");
	const assembled = [custom, generatedProject];
	const key = assembled.join("\n\n");
	const captures = new PromptCaptures();
	captures.record(key, deriveCaptureInput(assembled));

	const projected = projectPromptCapture(captures.resolveOrDerive(key));
	assert.ok(projected);
	assert.equal(count(projected, "SYSTEM-CUSTOMIZATION-MUST-SURVIVE"), 1);
	assert.equal(count(projected, "CUSTOM-MUST-SURVIVE"), 1);
	assert.equal(count(projected, "APPEND-CUSTOM-MODE-MUST-SURVIVE"), 1);
	assert.equal(count(projected, "CUSTOM-CONTEXT-MUST-SURVIVE"), 1);
	assert.equal(count(projected, "CUSTOM-SKILL-MUST-SURVIVE"), 1);
	assert.ok(projected.includes('<project_instructions path="/custom/worktree/AGENTS.md">'));
	assert.ok(!projected.includes("GENERATED-VCS-MUST-NOT-SURVIVE"));
});

test("shared prompt registry is released only through its owning registry reference", () => {
	const globalState = {};
	const owner = sharedPromptCaptures(globalState);
	const child = sharedPromptCaptures(globalState);
	owner.record("OWNER-PROMPT", { custom: "OWNER-CUSTOM", contextFiles: [], skills: [] });
	assert.equal(child.size, 1);

	const unrelated = new PromptCaptures();
	assert.equal(releaseSharedPromptCaptures(unrelated, globalState), false);
	assert.equal(owner.size, 1, "non-owner release cannot clear the shared registry");

	assert.equal(releaseSharedPromptCaptures(owner, globalState), true);
	assert.equal(owner.size, 0);
	const replacement = sharedPromptCaptures(globalState);
	assert.notEqual(replacement, owner, "owner shutdown creates a fresh registry for the next session");
});

