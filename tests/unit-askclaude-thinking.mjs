import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mapReasoningToClaudeEffort } from "../src/models.ts";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

// Guard the public AskClaude schema so `max` cannot silently drop out later.
test("AskClaude thinking schema exposes the full effort ladder including max", () => {
	assert.match(
		source,
		/thinking: Type\.Optional\(stringEnum\(Type, \["off", "minimal", "low", "medium", "high", "xhigh", "max"\] as const/,
	);
});

// AskClaude must not remap `max` itself; it flows through the model-aware mapper.
// These cases pin the mapper semantics AskClaude relies on.
test("mapReasoningToClaudeEffort resolves max via the model ladder, not an AskClaude special-case", () => {
	// Modern model whose ladder includes max: max -> max.
	const modern = { thinking: { efforts: ["low", "medium", "high", "xhigh", "max"] } };
	assert.equal(mapReasoningToClaudeEffort(modern, "max"), "max");

	// Model supporting xhigh but not max: max -> xhigh (mapper's defined fallback).
	const noMax = { thinking: { efforts: ["low", "medium", "high", "xhigh"] } };
	assert.equal(mapReasoningToClaudeEffort(noMax, "max"), "xhigh");

	// Legacy model supporting max but not xhigh: xhigh -> max.
	const legacy = { thinking: { efforts: ["low", "medium", "high", "max"] } };
	assert.equal(mapReasoningToClaudeEffort(legacy, "xhigh"), "max");

	// No thinking metadata (AskClaude's `model ?? {}` path): pass max through.
	assert.equal(mapReasoningToClaudeEffort({}, "max"), "max");

	// off yields no explicit SDK effort.
	assert.equal(mapReasoningToClaudeEffort(modern, "off"), undefined);
});
