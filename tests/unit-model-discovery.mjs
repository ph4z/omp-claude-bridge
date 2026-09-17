import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Same bundled catalogue the extension reads at runtime: the legacy pi-ai
// shim's getModels() is an alias of pi-catalog's getBundledModels().
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

import {
	buildModels,
	buildVariantModels,
	claudeCodeModelId,
	compareRevisions,
	isSupportedClaudeModel,
	mapReasoningToClaudeEffort,
	parseClaudeModelId,
	resolveModel,
} from "../src/models.ts";

const catalogEntry = (id, overrides = {}) => ({
	id,
	name: id,
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true },
	// Source routing fields that must NOT survive projection.
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	...overrides,
});

const settings = (contextWindow, extra = {}) => ({ plan: "pro", longContextExtraUsage: false, contextWindow, ...extra });

// --- Structural id parsing ---

test("parseClaudeModelId parses family and multi-part revisions", () => {
	assert.deepEqual(parseClaudeModelId("claude-opus-5"), { family: "opus", revision: [5] });
	assert.deepEqual(parseClaudeModelId("claude-fable-5-1"), { family: "fable", revision: [5, 1] });
	assert.deepEqual(parseClaudeModelId("claude-sonnet-4-6"), { family: "sonnet", revision: [4, 6] });
});

test("parseClaudeModelId rejects non-Claude, legacy, and snapshot ids", () => {
	assert.equal(parseClaudeModelId("gpt-5"), null);
	assert.equal(parseClaudeModelId("claude"), null);
	// Legacy claude-3-* ids put the version before the family.
	assert.equal(parseClaudeModelId("claude-3-5-sonnet-20241022"), null);
	// Dated snapshots duplicate their alias entry.
	assert.equal(parseClaudeModelId("claude-haiku-4-5-20251001"), null);
	assert.equal(parseClaudeModelId("claude-opus-4-20250514"), null);
	// Runtime-only [1m] ids are never catalogue ids.
	assert.equal(parseClaudeModelId("claude-fable-5[1m]"), null);
});

test("isSupportedClaudeModel accepts supported families at or above their baseline", () => {
	for (const id of ["claude-opus-5", "claude-fable-5-1", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-6-2"]) {
		assert.equal(isSupportedClaudeModel(id), true, id);
	}
});

test("isSupportedClaudeModel rejects unvalidated families and below-baseline revisions", () => {
	for (const id of ["claude-mythos-5", "claude-opus-4-5", "claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-0"]) {
		assert.equal(isSupportedClaudeModel(id), false, id);
	}
});

// --- Revision ordering ---

test("compareRevisions orders numerically, not lexicographically", () => {
	assert.ok(compareRevisions([5], [4, 8]) > 0);
	assert.ok(compareRevisions([5, 1], [5]) > 0);
	assert.ok(compareRevisions([5, 10], [5, 2]) > 0);
	assert.ok(compareRevisions([5, 10], [5, 9]) > 0);
	assert.ok(compareRevisions([4, 8], [5]) < 0);
	assert.equal(compareRevisions([5], [5, 0]), 0);
});

// --- Discovery over a synthetic catalogue ---

const SYNTHETIC_CATALOG = [
	catalogEntry("claude-opus-4-7"),
	catalogEntry("claude-mythos-5"),
	catalogEntry("claude-opus-5"),
	catalogEntry("claude-haiku-4-5", { contextWindow: 200_000, maxTokens: 64_000 }),
	catalogEntry("claude-fable-5"),
	catalogEntry("claude-haiku-4-5-20251001", { contextWindow: 200_000 }),
	catalogEntry("claude-opus-4-8"),
	catalogEntry("claude-opus-4-5"),
	catalogEntry("claude-fable-5-1"),
	catalogEntry("claude-sonnet-5"),
	catalogEntry("claude-3-5-sonnet-20241022"),
];

test("buildModels filters to supported models and sorts newest revision first per family", () => {
	assert.deepEqual(buildModels(SYNTHETIC_CATALOG).map((m) => m.id), [
		"claude-fable-5-1",
		"claude-fable-5",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-opus-4-7",
		"claude-sonnet-5",
		"claude-haiku-4-5",
	]);
});

test("partial names resolve to the newest revision; exact ids stay exact", () => {
	const models = buildModels(SYNTHETIC_CATALOG);
	assert.equal(resolveModel(models, "opus").id, "claude-opus-5");
	assert.equal(resolveModel(models, "fable").id, "claude-fable-5-1");
	assert.equal(resolveModel(models, "claude-fable-5").id, "claude-fable-5");
	assert.equal(resolveModel(models, "haiku").id, "claude-haiku-4-5");
});

test("a synthetic later revision is discovered and ordered first without source edits", () => {
	const models = buildModels([...SYNTHETIC_CATALOG, catalogEntry("claude-fable-5-2"), catalogEntry("claude-opus-5-1")]);
	assert.equal(models[0].id, "claude-fable-5-2");
	assert.equal(resolveModel(models, "fable").id, "claude-fable-5-2");
	assert.equal(resolveModel(models, "opus").id, "claude-opus-5-1");
});

test("projection preserves catalogue metadata and drops source routing fields", () => {
	const [model] = buildModels([catalogEntry("claude-opus-5", { name: "Claude Opus 5" })]);
	assert.equal(model.name, "Claude Opus 5");
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxTokens, 128_000);
	assert.deepEqual(model.thinking, { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true });
	// Subscription billing: costs are zeroed, never copied.
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	for (const field of ["api", "provider", "baseUrl", "compat"]) {
		assert.equal(field in model, false, field);
	}
});

// --- Discovery over the real OMP catalogue ---

test("Fable 5.1 and Opus 5 are discovered from the bundled OMP catalogue", () => {
	const catalog = getBundledModels("anthropic");
	const models = buildModels(catalog);
	const ids = models.map((m) => m.id);

	assert.ok(ids.includes("claude-fable-5-1"), `missing claude-fable-5-1 in ${ids}`);
	assert.ok(ids.includes("claude-opus-5"), `missing claude-opus-5 in ${ids}`);
	for (const id of ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
		assert.ok(ids.includes(id), `missing legacy model ${id}`);
	}
	for (const id of ids) {
		assert.ok(!id.startsWith("claude-mythos"), `unvalidated family leaked: ${id}`);
		assert.ok(!/\d{4,}/.test(id), `snapshot id leaked: ${id}`);
	}

	assert.equal(resolveModel(models, "fable").id, "claude-fable-5-1");
	assert.equal(resolveModel(models, "opus").id, "claude-opus-5");

	// Base discovery still preserves catalogue metadata; measured runtime policy
	// is applied later by buildVariantModels.
	for (const id of ["claude-fable-5-1", "claude-opus-5"]) {
		const registered = models.find((m) => m.id === id);
		const catalogModel = catalog.find((m) => m.id === id);
		assert.equal(registered.contextWindow, catalogModel.contextWindow, id);
		assert.equal(registered.maxTokens, catalogModel.maxTokens, id);
		assert.deepEqual(registered.thinking, catalogModel.thinking, id);
	}
});

test("future revisions remain dynamically discovered without exact-id source edits", () => {
	const source = readFileSync(new URL("../src/models.ts", import.meta.url), "utf8");
	assert.ok(!source.includes("claude-fable-5-2"));
	assert.ok(!source.includes("claude-opus-5-1"));
});

// --- Context-window policy for dynamically discovered models ---

test("auto: a future unmeasured model gets one canonical entry capped at 200K", () => {
	const models = buildModels([catalogEntry("claude-fable-5-2", { name: "Claude Fable 5.2" })]);
	const variants = buildVariantModels(models, settings("auto"));
	assert.equal(variants.length, 1);
	assert.equal(variants[0].id, "claude-fable-5-2");
	assert.equal(variants[0].contextWindow, 200_000);
	assert.equal(variants[0].name, "Claude Fable 5.2 (200K)");
	// The canonical id goes to Claude Code unchanged — no fabricated [1m].
	assert.equal(claudeCodeModelId(variants[0], settings("auto")), "claude-fable-5-2");
});

test("forced modes clamp a future unmeasured model's window but never rewrite its id", () => {
	const models = buildModels([catalogEntry("claude-fable-5-2")]);

	const forced200k = buildVariantModels(models, settings("200k"));
	assert.equal(forced200k.length, 1);
	assert.equal(forced200k[0].id, "claude-fable-5-2");
	assert.equal(forced200k[0].contextWindow, 200_000);
	assert.equal(claudeCodeModelId(forced200k[0], settings("200k")), "claude-fable-5-2");

	const forced1m = buildVariantModels(models, settings("1m"));
	assert.equal(forced1m.length, 0);
});

test("1m: a dynamic model whose catalogue window is below 1M is hidden", () => {
	const models = buildModels([catalogEntry("claude-haiku-5", { contextWindow: 200_000 })]);
	assert.equal(buildVariantModels(models, settings("1m")).length, 0);
	const auto = buildVariantModels(models, settings("auto"));
	assert.equal(auto.length, 1);
	assert.equal(auto[0].contextWindow, 200_000);
});

test("future dynamic models never emit -1m/-200k variant ids alongside override models", () => {
	const models = buildModels([catalogEntry("claude-fable-5-2"), catalogEntry("claude-fable-5")]);
	const variants = buildVariantModels(models, settings("auto"));
	assert.deepEqual(variants.map((m) => m.id), ["claude-fable-5-2", "claude-fable-5", "claude-fable-5-1m"]);
	// Override models keep their measured behavior: bare Fable 5 serves 200K.
	assert.equal(variants.find((m) => m.id === "claude-fable-5").contextWindow, 200_000);
	assert.equal(claudeCodeModelId(variants.find((m) => m.id === "claude-fable-5-1m"), settings("auto")), "claude-fable-5[1m]");
});

// --- Model-aware reasoning effort mapping ---

test("real xhigh tiers stay distinct from max", () => {
	const modern = catalogEntry("claude-opus-5", {
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
	});
	assert.equal(mapReasoningToClaudeEffort(modern, "xhigh"), "xhigh");
	assert.equal(mapReasoningToClaudeEffort(modern, "max"), "max");

	const fable51 = catalogEntry("claude-fable-5-1", {
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
	});
	assert.equal(mapReasoningToClaudeEffort(fable51, "xhigh"), "xhigh");
	assert.equal(mapReasoningToClaudeEffort(fable51, "max"), "max");
});

test("legacy models without a real xhigh tier retain the max fallback", () => {
	const opus46 = catalogEntry("claude-opus-4-6", {
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "max"] },
	});
	assert.equal(mapReasoningToClaudeEffort(opus46, "xhigh"), "max");
});

test("thinking effortMap is honored before sending the wire effort", () => {
	const mapped = catalogEntry("claude-opus-5", {
		thinking: {
			mode: "anthropic-adaptive",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			effortMap: { xhigh: "high" },
		},
	});
	assert.equal(mapReasoningToClaudeEffort(mapped, "xhigh"), "high");
});

test("dynamic context safety never promotes a future unmeasured catalogue model above 200K", () => {
	const oneMillion = buildModels([catalogEntry("claude-opus-6", { contextWindow: 1_000_000 })]);
	const auto = buildVariantModels(oneMillion, settings("auto"));
	assert.equal(auto.length, 1);
	assert.equal(auto[0].contextWindow, 200_000);
	assert.equal(claudeCodeModelId(auto[0], settings("auto")), "claude-opus-6");
	assert.equal(buildVariantModels(oneMillion, settings("1m")).length, 0);

	const smaller = buildModels([catalogEntry("claude-opus-6", { contextWindow: 128_000 })]);
	assert.equal(buildVariantModels(smaller, settings("auto"))[0].contextWindow, 128_000);
});
