from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


# --- src/models.ts -----------------------------------------------------------
p = Path("src/models.ts")
s = p.read_text()

marker = "// --- Context-window policy ---------------------------------------------------\n"
helper = '''// Translate OMP's canonical reasoning level to the Claude Code SDK wire effort.
// OMP 18.x models expose the supported effort ladder and optional effortMap in
// thinking metadata. Preserve a real xhigh tier when present (Opus 4.7+,
// Fable 5.1+, etc.); only fall back to max for models whose ladder has max but
// no xhigh (for example Opus 4.6). AskClaude can bypass OMP's normal clamping,
// so this helper also clamps its explicit request to a safe supported tier.
export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";

type ThinkingModel = {
\tthinking?: {
\t\tefforts?: readonly string[];
\t\teffortMap?: Readonly<Record<string, string>>;
\t};
};

export function mapReasoningToClaudeEffort(model: ThinkingModel, requested?: string): ClaudeCodeEffort | undefined {
\tif (!requested || requested === "off") return undefined;

\tconst efforts = model.thinking?.efforts;
\tlet canonical = requested;

\tif (efforts?.length && !efforts.includes(canonical)) {
\t\tif (canonical === "minimal" && efforts.includes("low")) {
\t\t\tcanonical = "low";
\t\t} else if (canonical === "xhigh" && efforts.includes("max")) {
\t\t\t// Legacy adaptive models such as Opus 4.6 expose max as their top
\t\t\t// tier and historically used it for an xhigh request.
\t\t\tcanonical = "max";
\t\t} else if (canonical === "xhigh" && efforts.includes("high")) {
\t\t\tcanonical = "high";
\t\t} else if (canonical === "max" && efforts.includes("xhigh")) {
\t\t\tcanonical = "xhigh";
\t\t}
\t}

\tconst wire = model.thinking?.effortMap?.[canonical] ?? canonical;
\tswitch (wire) {
\t\tcase "minimal": return "low"; // SDK has no minimal EffortLevel yet.
\t\tcase "low":
\t\tcase "medium":
\t\tcase "high":
\t\tcase "xhigh":
\t\tcase "max":
\t\t\treturn wire;
\t\tdefault:
\t\t\treturn undefined;
\t}
}

'''
if helper.strip() not in s:
    s = replace_once(s, marker, helper + marker, "insert effort helper")

pattern = re.compile(r'''function resolveDynamicRuntimeModel\(model: CatalogModel, mode: ContextWindowMode\): ClaudeCodeRuntimeModel \| null \{.*?\n\}\n\nfunction resolveAutoRuntimeModel''', re.S)
replacement = '''function resolveDynamicRuntimeModel(model: CatalogModel, mode: ContextWindowMode): ClaudeCodeRuntimeModel | null {
\tconst catalogWindow = model.contextWindow ?? null;
\tif (catalogWindow == null) {
\t\tconsole.error(`claude-bridge: model ${model.id} has no catalogue context window; hiding unmeasured runtime`);
\t\treturn null;
\t}

\t// The OMP catalogue describes model capability, not necessarily the window
\t// Claude Code serves for this user's subscription/bare-id runtime. Until a
\t// model is measured and promoted to RUNTIME_OVERRIDE_IDS, cap registration
\t// at 200K. This is deliberately conservative: MYOMP's context-safe router
\t// must never assume an unverified 1M runtime and trigger hidden compaction.
\tconst safeWindow = Math.min(catalogWindow, TWO_HUNDRED_K_CONTEXT);
\tswitch (mode) {
\t\tcase "1m":
\t\t\t// Never claim/request 1M for an unmeasured bare id.
\t\t\treturn null;
\t\tcase "200k":
\t\tcase "auto":
\t\t\treturn { cliModelId: model.id, contextWindow: safeWindow };
\t}
}

function resolveAutoRuntimeModel'''
s, n = pattern.subn(replacement, s, count=1)
if n != 1:
    raise SystemExit(f"dynamic resolver: expected one replacement, got {n}")

s = s.replace(
    "// discovered) model passes its canonical id unchanged to Claude Code and\n// registers the OMP catalogue contextWindow, so the registered window is never\n// fabricated. Returns null when a model has no runtime for the requested\n// forced window (that model is hidden from the picker in that mode).",
    "// discovered) model passes its canonical id unchanged to Claude Code but\n// registers conservatively at no more than 200K until that bare-id runtime has\n// been measured. Returns null for forced 1M or when catalogue context metadata\n// is absent; those cases must not be guessed by a context-safe router.",
)
s = s.replace(
    "// id is sent to Claude Code as-is (no fabricated [1m] or forced-200K variant)\n// and the registered window mirrors the catalogue, clamped down (never up) by\n// a forced mode. MYOMP's context-safe router relies on the registered window,\n// so over-reporting relative to the id actually sent is never acceptable.",
    "// id is sent to Claude Code as-is (no fabricated [1m] variant), while the\n// registered window is capped at 200K until runtime behavior is measured.\n// MYOMP's context-safe router relies on this value, so catalogue capability\n// alone is never treated as proof that the bare-id runtime serves 1M.",
)
s = s.replace(
    "// canonical entry at the catalogue window: the bridge has no evidence for\n// alternate windows, so it fabricates neither a [1m] nor a forced-200K variant.",
    "// canonical entry capped at 200K: the bridge has no evidence for a larger\n// bare-id runtime, so it never fabricates a [1m] or a forced 1M variant.",
)
p.write_text(s)


# --- src/index.ts ------------------------------------------------------------
p = Path("src/index.ts")
s = p.read_text()
s = replace_once(
    s,
    'import { buildVariantModels, buildModels, claudeCodeModelId, type ContextWindowMode, type LongContextSettings, resolveModel as _resolveModel } from "./models.js";',
    'import { buildVariantModels, buildModels, claudeCodeModelId, mapReasoningToClaudeEffort, type ContextWindowMode, type LongContextSettings, resolveModel as _resolveModel } from "./models.js";',
    "models import",
)
effort_block = '''// --- Effort level mapping ---
// OMP reasoning levels → CC SDK effort levels. "max" appears on newer models
// (Fable/Opus 5 era) whose registered thinking metadata exposes it directly.

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
\tminimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

'''
s = replace_once(
    s,
    effort_block,
    '''// --- Effort level mapping ---
// Model-aware translation lives in models.ts so real xhigh and max tiers stay
// distinct and the behavior is unit-testable.

''',
    "remove generic effort table",
)
s = replace_once(
    s,
    '''\t// OMP clamps options.reasoning to the model's registered thinking.efforts
\t// (projected from the catalogue in buildModels), so the generic table only
\t// translates OMP's effort names into CC SDK effort levels.
\tconst effort = options?.reasoning ? REASONING_TO_EFFORT[options.reasoning] : undefined;''',
    '''\t// OMP normally clamps options.reasoning to the registered thinking ladder.
\t// The model-aware mapper preserves a genuine xhigh tier instead of folding it
\t// into max, while retaining legacy fallback behavior where xhigh is absent.
\tconst effort = mapReasoningToClaudeEffort(model, options?.reasoning);''',
    "provider effort mapping",
)
s = replace_once(
    s,
    '''\tconst effort = options?.thinking && options.thinking !== "off"
\t\t? REASONING_TO_EFFORT[options.thinking] : undefined;''',
    '''\tconst effort = options?.thinking && options.thinking !== "off"
\t\t? mapReasoningToClaudeEffort(model ?? {}, options.thinking) : undefined;''',
    "AskClaude effort mapping",
)
count = s.count('...(effort ? { effort } : {}),')
if count != 2:
    raise SystemExit(f"effort SDK boundaries: expected 2 matches, got {count}")
s = s.replace('...(effort ? { effort } : {}),', '...(effort ? { effort: effort as EffortLevel } : {}),')
p.write_text(s)


# --- tests/unit-model-discovery.mjs -----------------------------------------
p = Path("tests/unit-model-discovery.mjs")
s = p.read_text()
s = replace_once(
    s,
    '''\tcompareRevisions,
\tisSupportedClaudeModel,''',
    '''\tcompareRevisions,
\tisSupportedClaudeModel,
\tmapReasoningToClaudeEffort,''',
    "test helper import",
)
s = s.replace(
    'test("auto: a dynamic model gets one canonical entry at the catalogue window", () => {',
    'test("auto: a dynamic unmeasured model gets one canonical entry capped at 200K", () => {',
)
s = replace_once(
    s,
    'assert.equal(variants[0].contextWindow, 1_000_000);\n\tassert.equal(variants[0].name, "Claude Fable 5.1 (1M)");',
    'assert.equal(variants[0].contextWindow, 200_000);\n\tassert.equal(variants[0].name, "Claude Fable 5.1 (200K)");',
    "auto dynamic expectation",
)
s = replace_once(
    s,
    '''\tconst forced1m = buildVariantModels(models, settings("1m"));
\tassert.equal(forced1m.length, 1);
\tassert.equal(forced1m[0].contextWindow, 1_000_000);
\tassert.equal(claudeCodeModelId(forced1m[0], settings("1m")), "claude-fable-5-1");''',
    '''\tconst forced1m = buildVariantModels(models, settings("1m"));
\tassert.equal(forced1m.length, 0);''',
    "forced 1m dynamic expectation",
)
s += '''

// --- Model-aware reasoning effort mapping ---

test("real xhigh tiers stay distinct from max", () => {
\tconst modern = catalogEntry("claude-opus-5", {
\t\tthinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
\t});
\tassert.equal(mapReasoningToClaudeEffort(modern, "xhigh"), "xhigh");
\tassert.equal(mapReasoningToClaudeEffort(modern, "max"), "max");

\tconst fable51 = catalogEntry("claude-fable-5-1", {
\t\tthinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
\t});
\tassert.equal(mapReasoningToClaudeEffort(fable51, "xhigh"), "xhigh");
\tassert.equal(mapReasoningToClaudeEffort(fable51, "max"), "max");
});

test("legacy models without a real xhigh tier retain the max fallback", () => {
\tconst opus46 = catalogEntry("claude-opus-4-6", {
\t\tthinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "max"] },
\t});
\tassert.equal(mapReasoningToClaudeEffort(opus46, "xhigh"), "max");
});

test("thinking effortMap is honored before sending the wire effort", () => {
\tconst mapped = catalogEntry("claude-opus-5", {
\t\tthinking: {
\t\t\tmode: "anthropic-adaptive",
\t\t\tefforts: ["low", "medium", "high", "xhigh", "max"],
\t\t\teffortMap: { xhigh: "high" },
\t\t},
\t});
\tassert.equal(mapReasoningToClaudeEffort(mapped, "xhigh"), "high");
});

test("dynamic context safety never promotes an unmeasured catalogue model above 200K", () => {
\tconst oneMillion = buildModels([catalogEntry("claude-opus-5", { contextWindow: 1_000_000 })]);
\tconst auto = buildVariantModels(oneMillion, settings("auto"));
\tassert.equal(auto.length, 1);
\tassert.equal(auto[0].contextWindow, 200_000);
\tassert.equal(claudeCodeModelId(auto[0], settings("auto")), "claude-opus-5");
\tassert.equal(buildVariantModels(oneMillion, settings("1m")).length, 0);

\tconst smaller = buildModels([catalogEntry("claude-opus-6", { contextWindow: 128_000 })]);
\tassert.equal(buildVariantModels(smaller, settings("auto"))[0].contextWindow, 128_000);
});
'''
p.write_text(s)


# --- README ------------------------------------------------------------------
p = Path("README.md")
s = p.read_text()
s = s.replace(
    "**Dynamically discovered** models (any newer revision the bridge has not measured yet — e.g. Fable 5.1, Opus 5) get exactly **one canonical entry**: the bare model id is sent to Claude Code unchanged and the registered window mirrors OMP's catalogue (clamped down, never up, by a forced mode). The bridge never fabricates a `[1m]` request or a forced-200K variant for a model it hasn't measured.",
    "**Dynamically discovered** models (any newer revision the bridge has not measured yet — e.g. Fable 5.1, Opus 5) get exactly **one canonical entry**: the bare model id is sent to Claude Code unchanged, but the registered window is conservatively capped at **200K** (or lower if the catalogue says lower) until that bare-id runtime is measured. Forced `1m` hides unmeasured models rather than claiming an unverified 1M runtime.",
)
s = s.replace("| `claude-bridge/claude-fable-5-1` | 1M (catalogue, discovered) |", "| `claude-bridge/claude-fable-5-1` | 200K (runtime unmeasured; catalogue advertises 1M) |")
s = s.replace("| `claude-bridge/claude-opus-5` | 1M (catalogue, discovered) |", "| `claude-bridge/claude-opus-5` | 200K (runtime unmeasured; catalogue advertises 1M) |")
s = s.replace(
    "applies the selected context-window policy (measured overrides for known models, catalogue windows for newly discovered ones)",
    "applies the selected context-window policy (measured overrides for known models, conservative ≤200K registration for newly discovered ones)",
)
p.write_text(s)


# --- CHANGELOG ---------------------------------------------------------------
p = Path("CHANGELOG.md")
s = p.read_text()
s = s.replace(
    "- Models without measured Claude Code runtime behavior get a single canonical\n  picker entry: the bare id is sent to Claude Code and the registered window\n  mirrors the OMP catalogue (never fabricated `[1m]` / forced-200K variants).\n  Measured models keep their existing per-window entries and runtime overrides.",
    "- Models without measured Claude Code runtime behavior get a single canonical\n  picker entry: the bare id is sent to Claude Code and the registered window is\n  conservatively capped at 200K until measured; forced `1m` hides them instead\n  of claiming an unverified runtime. Measured models keep their existing\n  per-window entries and runtime overrides.",
)
p.write_text(s)
