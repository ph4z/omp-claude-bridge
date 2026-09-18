// Dynamic Claude model discovery over OMP's Anthropic catalogue.
// Extracted from index.ts so tests can import without activating the extension.
// Deliberately free of runtime imports so the discovery + context-window policy
// stays unit-testable in isolation.

// --- Discovery: which catalogue entries are bridge models -------------------

export type ParsedClaudeModel = {
	family: string;
	revision: number[];
};

// The input to buildModels is already OMP's Anthropic catalogue, so family
// names are deliberately NOT allowlisted here. Canonical Claude aliases are
// accepted structurally; dated snapshots and legacy version-before-family ids
// are excluded by parseClaudeModelId. This lets a new Anthropic family (for
// example Mythos) appear in the bridge as soon as OMP catalogs it, without a
// bridge source edit.

// Structurally parse `claude-<family>-<rev>[-<rev>...]` ids. Returns null for:
// - non-Claude ids and legacy `claude-3-*` ids (version before family);
// - dated snapshot ids (`claude-opus-4-5-20251101`): any revision segment with
//   4+ digits is a date stamp, and snapshots duplicate their alias entry.
export function parseClaudeModelId(id: string): ParsedClaudeModel | null {
	const match = /^claude-([a-z]+)((?:-\d+)+)$/.exec(id);
	if (!match) return null;
	const segments = match[2].slice(1).split("-");
	if (segments.some((s) => s.length >= 4)) return null;
	return { family: match[1], revision: segments.map(Number) };
}

// Numeric segment-wise comparison; missing segments count as 0, so 5-1 > 5 and
// 5-10 > 5-2 (naive lexicographic sorting would get both wrong).
export function compareRevisions(a: readonly number[], b: readonly number[]): number {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export function isSupportedClaudeModel(id: string): boolean {
	return parseClaudeModelId(id) != null;
}

// Discover bridge models from OMP's Anthropic catalogue and project each entry
// down to the fields OMP's registerProvider expects, preserving the catalogue
// metadata (context window, max tokens, thinking capabilities, input modes).
// Source routing fields (`api`, `provider`, `baseUrl`, `compat`) are NOT
// copied: they would bypass the bridge's custom streamSimple implementation.
// Costs are zeroed because usage bills against the Claude subscription.
//
// Ordering is deterministic without a family allowlist: family name, then newer
// revisions first, so `resolveModel("opus")` partial-matches the newest opus revision.
export type DiscoverableCatalogModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: readonly string[];
	contextWindow: number | null;
	maxTokens: number | null;
	thinking?: object;
};

export function buildModels<T extends DiscoverableCatalogModel>(piAiModels: readonly T[]) {
	return piAiModels
		.map((model, sourceIndex) => ({ model, parsed: parseClaudeModelId(model.id), sourceIndex }))
		.filter((entry): entry is { model: T; parsed: ParsedClaudeModel; sourceIndex: number } =>
			entry.parsed != null)
		.sort((a, b) => {
			// Dynamic deterministic family ordering: no family-name table. Within a
			// family, newest canonical revision wins partial selectors such as "opus".
			const familyDiff = a.parsed.family.localeCompare(b.parsed.family);
			if (familyDiff !== 0) return familyDiff;
			const revisionDiff = compareRevisions(b.parsed.revision, a.parsed.revision);
			return revisionDiff !== 0 ? revisionDiff : a.sourceIndex - b.sourceIndex;
		})
		.map(({ model: { id, name, reasoning, input, contextWindow, maxTokens, thinking } }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			...(thinking ? { thinking } : {}),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

// Translate OMP's canonical reasoning level to the Claude Code SDK wire effort.
// OMP 18.x models expose the supported effort ladder and optional effortMap in
// thinking metadata. Preserve a real xhigh tier when present (Opus 4.7+,
// Fable 5.1+, etc.); only fall back to max for models whose ladder has max but
// no xhigh (for example Opus 4.6). AskClaude can bypass OMP's normal clamping,
// so this helper also clamps its explicit request to a safe supported tier.
export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";

type ThinkingModel = {
	thinking?: {
		efforts?: readonly string[];
		effortMap?: Readonly<Record<string, string>>;
	};
};

export function mapReasoningToClaudeEffort(model: ThinkingModel, requested?: string): ClaudeCodeEffort | undefined {
	if (!requested || requested === "off") return undefined;

	const efforts = model.thinking?.efforts;
	let canonical = requested;

	if (efforts?.length && !efforts.includes(canonical)) {
		if (canonical === "minimal" && efforts.includes("low")) {
			canonical = "low";
		} else if (canonical === "xhigh" && efforts.includes("max")) {
			// Legacy adaptive models such as Opus 4.6 expose max as their top
			// tier and historically used it for an xhigh request.
			canonical = "max";
		} else if (canonical === "xhigh" && efforts.includes("high")) {
			canonical = "high";
		} else if (canonical === "max" && efforts.includes("xhigh")) {
			canonical = "xhigh";
		}
	}

	const wire = model.thinking?.effortMap?.[canonical] ?? canonical;
	switch (wire) {
		case "minimal": return "low"; // SDK has no minimal EffortLevel yet.
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return wire;
		default:
			return undefined;
	}
}

// --- Context-window resolution ----------------------------------------------
//
// A Claude model has exactly one canonical context window, read straight from
// OMP's Anthropic catalogue (model.contextWindow), which buildModels already
// preserves on every discovered entry. The bridge keeps NO exact-id capability
// table: a newly discovered revision of a supported family inherits its
// catalogue window automatically, with zero source edits here.
//
// The Claude Agent SDK exposes no pre-flight context-window capability API —
// ModelInfo from query.supportedModels() carries display/effort metadata but no
// contextWindow — and its only 1M switch, the `context-1m-2025-08-07` beta,
// applies to Sonnet 4/4.5, which predate every family the bridge supports. Each
// supported model therefore serves its catalogue window under its canonical id,
// so the bridge sends that id to Claude Code unchanged: no fabricated `[1m]`
// spelling, and no synthetic `-1m`/`-200k` picker variants. The *served* window
// is still logged from result modelUsage for observability (see index.ts,
// logServedContextWindow), which surfaces any future runtime/catalogue drift
// without lowering the registered capability MYOMP's context-safe router reads.

type CatalogModel = { id: string };

// The Claude Code CLI model id for a registered model: its canonical catalogue
// id, unchanged. A model has one canonical window, so there is nothing to
// select at request time and no window suffix to encode.
export function claudeCodeModelId(model: CatalogModel): string {
	return model.id;
}

// Exact id match wins over partial containment, so an exact id never resolves
// to a newer revision whose id merely contains it as a prefix.
export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower) ?? models.find((m) => m.id.includes(lower));
}

// Project discovered catalogue models to the entries OMP registers. Each model
// becomes exactly one picker entry, keyed by its canonical id and carrying its
// catalogue context window verbatim. A model whose catalogue omits a context
// window is dropped rather than registered with a guessed capacity: MYOMP's
// context-safe router must never read a fabricated window.
export function buildRegisteredModels<T extends { id: string; contextWindow?: number | null }>(models: T[]): T[] {
	return models.filter((m) => {
		if (m.contextWindow == null) {
			console.error(`claude-bridge: model ${m.id} has no catalogue context window; not registering`);
			return false;
		}
		return true;
	});
}
