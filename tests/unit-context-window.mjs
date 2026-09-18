import test from "node:test";
import assert from "node:assert/strict";

import { buildRegisteredModels, claudeCodeModelId } from "../src/models.ts";

// Minimal stand-ins for the projected catalogue entries OMP registers. The
// registered contextWindow is the model's canonical capacity, taken verbatim
// from OMP's Anthropic catalogue — no exact-id table rewrites it, and no
// synthetic window variants are fabricated. Values below mirror the current
// bundled catalogue (see unit-model-discovery.mjs for the real-catalogue check).
const MODELS = [
	{ id: "claude-fable-5-1", name: "Fable 5.1", contextWindow: 1_000_000 },
	{ id: "claude-fable-5", name: "Fable 5", contextWindow: 1_000_000 },
	{ id: "claude-opus-5", name: "Opus 5", contextWindow: 1_000_000 },
	{ id: "claude-opus-4-8", name: "Opus 4.8", contextWindow: 1_000_000 },
	{ id: "claude-opus-4-7", name: "Opus 4.7", contextWindow: 1_000_000 },
	{ id: "claude-opus-4-6", name: "Opus 4.6", contextWindow: 1_000_000 },
	{ id: "claude-sonnet-5", name: "Sonnet 5", contextWindow: 1_000_000 },
	{ id: "claude-sonnet-4-6", name: "Sonnet 4.6", contextWindow: 1_000_000 },
	{ id: "claude-haiku-4-5", name: "Haiku 4.5", contextWindow: 200_000 },
];

const byId = () => Object.fromEntries(buildRegisteredModels(MODELS).map((m) => [m.id, m]));

test("each catalogue model registers as exactly one canonical entry with its catalogue window", () => {
	const registered = buildRegisteredModels(MODELS);
	// One entry per model, no fabricated variants.
	assert.equal(registered.length, MODELS.length);
	for (const source of MODELS) {
		const entry = registered.find((m) => m.id === source.id);
		assert.ok(entry, `${source.id} is registered`);
		assert.equal(entry.contextWindow, source.contextWindow, `${source.id} keeps its catalogue window`);
		assert.equal(entry.name, source.name, `${source.id} keeps its catalogue name`);
	}
});

test("no synthetic -1m/-200k variant ids are ever registered", () => {
	const ids = buildRegisteredModels(MODELS).map((m) => m.id);
	for (const id of ids) {
		assert.ok(!id.endsWith("-1m"), `${id} is not a fabricated 1M variant`);
		assert.ok(!id.endsWith("-200k"), `${id} is not a fabricated 200K variant`);
	}
});

test("claudeCodeModelId sends the canonical id unchanged, with no [1m] spelling", () => {
	for (const source of MODELS) {
		const cli = claudeCodeModelId(source);
		assert.equal(cli, source.id, `${source.id} sends its canonical id`);
		assert.ok(!cli.includes("[1m]"), `${source.id} never fabricates a [1m] spelling`);
	}
});

test("Opus 5 registers at 1M under its canonical id", () => {
	const opus5 = byId()["claude-opus-5"];
	assert.equal(opus5.contextWindow, 1_000_000);
	assert.equal(claudeCodeModelId(opus5), "claude-opus-5");
});

test("Sonnet 5 registers at 1M under its canonical id", () => {
	const sonnet5 = byId()["claude-sonnet-5"];
	assert.equal(sonnet5.contextWindow, 1_000_000);
	assert.equal(claudeCodeModelId(sonnet5), "claude-sonnet-5");
});

test("Haiku 4.5 stays 200K under its canonical id", () => {
	const haiku = byId()["claude-haiku-4-5"];
	assert.equal(haiku.contextWindow, 200_000);
	assert.equal(claudeCodeModelId(haiku), "claude-haiku-4-5");
});

test("known-model matrix: every current model registers its authoritative window", () => {
	// Authoritative context capacity per current Anthropic/OMP-catalogue metadata.
	const EXPECTED = [
		["claude-fable-5-1", 1_000_000],
		["claude-fable-5", 1_000_000],
		["claude-opus-5", 1_000_000],
		["claude-opus-4-8", 1_000_000],
		["claude-opus-4-7", 1_000_000],
		["claude-opus-4-6", 1_000_000],
		["claude-sonnet-5", 1_000_000],
		["claude-sonnet-4-6", 1_000_000],
		["claude-haiku-4-5", 200_000],
	];
	const m = byId();
	for (const [id, window] of EXPECTED) {
		assert.equal(m[id].contextWindow, window, `${id} registers ${window}`);
		assert.equal(claudeCodeModelId(m[id]), id, `${id} keeps its canonical CLI id`);
	}
});

test("models without a catalogue context window are dropped, not registered with a guess", () => {
	const models = [
		{ id: "claude-opus-5", name: "Opus 5", contextWindow: 1_000_000 },
		{ id: "claude-opus-9", name: "Opus 9", contextWindow: null },
		{ id: "claude-opus-8", name: "Opus 8", contextWindow: undefined },
	];
	const ids = buildRegisteredModels(models).map((m) => m.id);
	assert.deepEqual(ids, ["claude-opus-5"]);
});

test("MYOMP context-safety: Opus 5 registered window fits a 300K conversation", () => {
	// A caller comparing current usage against the registered window must not be
	// misled by a stale 200K value into thinking a 300K conversation overflows.
	const opus5 = byId()["claude-opus-5"];
	const currentUsage = 300_000;
	assert.ok(currentUsage <= opus5.contextWindow, "300K usage fits Opus 5's real 1M window");
	assert.equal(opus5.contextWindow, 1_000_000);
});
