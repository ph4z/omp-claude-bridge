// Dynamic Claude model discovery over OMP's Anthropic catalogue.
// Extracted from index.ts so tests can import without activating the extension.
// Deliberately free of runtime imports so the discovery + context-window policy
// stays unit-testable in isolation.

// --- Discovery: which catalogue entries are bridge models -------------------

export type ParsedClaudeModel = {
	family: string;
	revision: number[];
};

// Claude families the bridge has validated against the Claude Code runtime, in
// picker display order. minRevision is the oldest revision the bridge exposes:
// older catalogue entries (e.g. claude-opus-4-1) predate the bridge's measured
// Claude Code behavior and are deliberately kept out of the picker. Any NEWER
// revision of a listed family is discovered automatically — never add exact
// model ids here. A completely new family (e.g. mythos) must be validated
// against the Claude Code runtime before being listed; that step is explicit
// on purpose, not guessed from the catalogue.
const SUPPORTED_FAMILIES: ReadonlyArray<{ family: string; minRevision: readonly number[] }> = [
	{ family: "fable", minRevision: [5] },
	{ family: "opus", minRevision: [4, 6] },
	{ family: "sonnet", minRevision: [4, 6] },
	{ family: "haiku", minRevision: [4, 5] },
];

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

function supportedFamilyIndex(parsed: ParsedClaudeModel): number {
	return SUPPORTED_FAMILIES.findIndex(
		(f) => f.family === parsed.family && compareRevisions(parsed.revision, f.minRevision) >= 0,
	);
}

export function isSupportedClaudeModel(id: string): boolean {
	const parsed = parseClaudeModelId(id);
	return parsed != null && supportedFamilyIndex(parsed) !== -1;
}

// Discover bridge models from OMP's Anthropic catalogue and project each entry
// down to the fields OMP's registerProvider expects, preserving the catalogue
// metadata (context window, max tokens, thinking capabilities, input modes).
// Source routing fields (`api`, `provider`, `baseUrl`, `compat`) are NOT
// copied: they would bypass the bridge's custom streamSimple implementation.
// Costs are zeroed because usage bills against the Claude subscription.
//
// Ordering is deterministic: family display order, then newer revisions first,
// so `resolveModel("opus")` partial-matches the newest opus revision.
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
		.map((model) => ({ model, parsed: parseClaudeModelId(model.id) }))
		.filter((entry): entry is { model: T; parsed: ParsedClaudeModel } =>
			entry.parsed != null && supportedFamilyIndex(entry.parsed) !== -1)
		.sort((a, b) => {
			const familyDiff = supportedFamilyIndex(a.parsed) - supportedFamilyIndex(b.parsed);
			if (familyDiff !== 0) return familyDiff;
			return compareRevisions(b.parsed.revision, a.parsed.revision);
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

// --- Context-window policy ---------------------------------------------------

// User-selectable context-window policy (see provider.contextWindow in config).
//   "auto"  - per-model default policy (measured SDK behavior, else catalogue window).
//   "1m"    - force 1M: only register 1M-capable models, request [1m] where known.
//   "200k"  - force 200K: register models at (most) 200K, request bare model ids.
export type ContextWindowMode = "auto" | "1m" | "200k";

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	contextWindow: ContextWindowMode;
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// Models with measured Claude Agent SDK subscription/OAuth behavior — the ONLY
// place exact ids are allowed. This is a runtime-override table, not a
// discovery allowlist: models absent from it are still registered and follow
// the catalogue-window path in resolveDynamicRuntimeModel. Do not infer these
// entries from the catalogue's advertised contextWindow: bare Opus 4.7 serves
// 1M, bare Opus 4.8 does not, bare Fable 5 serves 200K while claude-fable-5[1m]
// serves 1M, and [1m] entitlement differs by model. A newly discovered model
// gets an entry here only once its runtime behavior has been measured.
const RUNTIME_OVERRIDE_IDS: Record<string, true> = {
	"claude-opus-4-8": true, "claude-opus-4-7": true, "claude-opus-4-6": true,
	"claude-fable-5": true, "claude-sonnet-5": true, "claude-sonnet-4-6": true, "claude-haiku-4-5": true,
};

export function hasRuntimeOverride(modelId: string): boolean {
	return RUNTIME_OVERRIDE_IDS[modelId] === true;
}

type CatalogModel = { id: string; contextWindow?: number | null };

// Resolve the Claude Code runtime for a registered model. Models with an
// explicit override keep their measured behavior; every other (dynamically
// discovered) model passes its canonical id unchanged to Claude Code but
// registers conservatively at no more than 200K until that bare-id runtime has
// been measured. The global 1m/200k preference selects the window where the
// override model actually supports it, but never forces an impossible runtime
// onto a single-window model (e.g. Haiku 4.5 is 200K-only, Opus 4.7 is 1M-only):
// such a model falls back to its sole supported window. Returns null only for the
// dynamic (unmeasured) forced-1M case or when catalogue context metadata is
// absent; those cases must not be guessed by a context-safe router.
export function resolveClaudeCodeRuntimeModel(model: CatalogModel, settings: LongContextSettings): ClaudeCodeRuntimeModel | null {
	if (hasRuntimeOverride(model.id)) {
		if (settings.contextWindow === "auto") return resolveAutoRuntimeModel(model.id, settings);
		// A forced 1m/200k preference picks that window when supported; otherwise it
		// degrades to the model's only valid window rather than throwing. This mirrors
		// buildVariantModels' default-variant selection, so the unsuffixed picker entry
		// and its runtime always agree.
		const available = availableOverrideRuntimes(model.id);
		const preferred = available.find((a) => a.mode === settings.contextWindow);
		return preferred?.runtime ?? available[0]?.runtime ?? null;
	}
	return resolveDynamicRuntimeModel(model, settings.contextWindow);
}

// The window(s) an override model actually supports, in 1M-first order. Derived
// from the measured forced-runtime resolvers so single- vs dual-window behavior
// is never special-cased per model id.
function availableOverrideRuntimes(modelId: string): Array<{ mode: "1m" | "200k"; runtime: ClaudeCodeRuntimeModel }> {
	const out: Array<{ mode: "1m" | "200k"; runtime: ClaudeCodeRuntimeModel }> = [];
	const oneM = resolveForcedOneMRuntimeModel(modelId);
	if (oneM != null) out.push({ mode: "1m", runtime: oneM });
	const twoK = resolveForcedTwoHundredKRuntimeModel(modelId);
	if (twoK != null) out.push({ mode: "200k", runtime: twoK });
	return out;
}

// Catalogue-window path for models without a measured override. The canonical
// id is sent to Claude Code as-is (no fabricated [1m] variant), while the
// registered window is capped at 200K until runtime behavior is measured.
// MYOMP's context-safe router relies on this value, so catalogue capability
// alone is never treated as proof that the bare-id runtime serves 1M.
function resolveDynamicRuntimeModel(model: CatalogModel, mode: ContextWindowMode): ClaudeCodeRuntimeModel | null {
	const catalogWindow = model.contextWindow ?? null;
	if (catalogWindow == null) {
		console.error(`claude-bridge: model ${model.id} has no catalogue context window; hiding unmeasured runtime`);
		return null;
	}

	// The OMP catalogue describes model capability, not necessarily the window
	// Claude Code serves for this user's subscription/bare-id runtime. Until a
	// model is measured and promoted to RUNTIME_OVERRIDE_IDS, cap registration
	// at 200K. This is deliberately conservative: MYOMP's context-safe router
	// must never assume an unverified 1M runtime and trigger hidden compaction.
	const safeWindow = Math.min(catalogWindow, TWO_HUNDRED_K_CONTEXT);
	switch (mode) {
		case "1m":
			// Never claim/request 1M for an unmeasured bare id.
			return null;
		case "200k":
		case "auto":
			return { cliModelId: model.id, contextWindow: safeWindow };
	}
}

function resolveAutoRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel {
	switch (modelId) {
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6": {
			const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
			return {
				cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
				contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		}
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return {
				cliModelId: settings.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
				contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			throw new Error(`claude-bridge: ${modelId} is in RUNTIME_OVERRIDE_IDS but has no auto runtime entry`);
	}
}

function resolveForcedOneMRuntimeModel(modelId: string): ClaudeCodeRuntimeModel | null {
	switch (modelId) {
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6":
			return { cliModelId: "claude-opus-4-6[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return { cliModelId: "claude-sonnet-4-6[1m]", contextWindow: ONE_M_CONTEXT };
		default:
			return null;
	}
}

function resolveForcedTwoHundredKRuntimeModel(modelId: string): ClaudeCodeRuntimeModel | null {
	switch (modelId) {
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-4-7":
			return null;
		case "claude-opus-4-6":
			return { cliModelId: "claude-opus-4-6", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-4-6":
			return { cliModelId: "claude-sonnet-4-6", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			return null;
	}
}

// Split a registered picker id into its base model id and the forced window it
// encodes. Variant ids carry a "-1m"/"-200k" suffix (see buildVariantModels); the
// unsuffixed id maps to the config default. Base ids never end in those suffixes,
// so the split is unambiguous.
export function parseVariantId(id: string): { baseId: string; forced?: "1m" | "200k" } {
	if (id.endsWith("-1m")) return { baseId: id.slice(0, -3), forced: "1m" };
	if (id.endsWith("-200k")) return { baseId: id.slice(0, -5), forced: "200k" };
	return { baseId: id };
}

export function claudeCodeModelId(model: CatalogModel, settings: LongContextSettings): string {
	const { baseId, forced } = parseVariantId(model.id);
	// Only override-table models register forced-window variant ids, so a
	// suffix implies a forced-resolver entry; dynamic models keep their
	// canonical id and follow the catalogue-window path.
	const runtimeModel = forced === "1m"
		? resolveForcedOneMRuntimeModel(baseId)
		: forced === "200k"
			? resolveForcedTwoHundredKRuntimeModel(baseId)
			: resolveClaudeCodeRuntimeModel(model, settings);
	if (runtimeModel == null) {
		const requested = forced ?? settings.contextWindow;
		throw new Error(`claude-bridge: model ${model.id} has no Claude Code runtime (contextWindow=${requested})`);
	}
	return runtimeModel.cliModelId;
}

// Exact id match wins over partial containment, so an exact id never resolves
// to a newer revision whose id merely contains it as a prefix.
export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower) ?? models.find((m) => m.id.includes(lower));
}

function variantName(baseName: string, contextWindow: number): string {
	const label = contextWindow === ONE_M_CONTEXT ? "1M" : "200K";
	// Strip any window hint pi-ai already baked into the name so we don't double it.
	const base = baseName.replace(/\s*(?:\((?:1M|200K)\)|\b1M\b)\s*$/i, "").trimEnd();
	return `${base} (${label})`;
}

// Expand each override-table model into one registered entry per context window
// it supports, so the user picks the window on demand from OMP's model picker.
// The unsuffixed id (e.g. claude-opus-4-8) maps to the config default window;
// every other available window gets a "-1m"/"-200k" suffixed id. Each entry's
// contextWindow must match the window the bridge actually requests (see
// claudeCodeModelId), or OMP's status bar and auto-compaction threshold will
// misreport. Dynamically discovered models (no override) get exactly one
// canonical entry capped at 200K: the bridge has no evidence for a larger
// bare-id runtime, so it never fabricates a [1m] or a forced 1M variant.
export function buildVariantModels<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	const result: T[] = [];
	for (const m of models) {
		if (!hasRuntimeOverride(m.id)) {
			const runtimeModel = resolveDynamicRuntimeModel(m, settings.contextWindow);
			if (runtimeModel != null) result.push({ ...m, contextWindow: runtimeModel.contextWindow, name: variantName(m.name, runtimeModel.contextWindow) });
			continue;
		}

		// Known models always have at least one available window.
		const available: Array<{ kind: "1m" | "200k"; contextWindow: number }> = [];
		if (resolveForcedOneMRuntimeModel(m.id) != null) available.push({ kind: "1m", contextWindow: ONE_M_CONTEXT });
		if (resolveForcedTwoHundredKRuntimeModel(m.id) != null) available.push({ kind: "200k", contextWindow: TWO_HUNDRED_K_CONTEXT });

		// The config default decides which window is unsuffixed; fall back to the sole
		// available window when the preferred one has no runtime (e.g. Haiku under
		// "1m", Opus 4.7 under "200k").
		const defaultRuntime = resolveClaudeCodeRuntimeModel(m, settings);
		const preferredKind: "1m" | "200k" | undefined = defaultRuntime == null
			? undefined
			: defaultRuntime.contextWindow === ONE_M_CONTEXT ? "1m" : "200k";
		const defaultKind = preferredKind != null && available.some((a) => a.kind === preferredKind)
			? preferredKind
			: available[0].kind;

		const ordered = [
			...available.filter((a) => a.kind === defaultKind),
			...available.filter((a) => a.kind !== defaultKind),
		];
		for (const { kind, contextWindow } of ordered) {
			const id = kind === defaultKind ? m.id : `${m.id}-${kind}`;
			result.push({ ...m, id, contextWindow, name: variantName(m.name, contextWindow) });
		}
	}
	return result;
}
