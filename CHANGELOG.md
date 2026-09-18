# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Debug-mode reasoning instrumentation: provider and AskClaude calls now log a
  dedicated `reasoning-map` record showing the OMP-requested reasoning level,
  the mapped Claude Agent SDK effort, and the effective Claude Code model id.
- Fully dynamic Claude model discovery from OMP's Anthropic catalogue. The
  picker has no hard-coded model-id **or family** allowlist: canonical
  `claude-<family>-<revision>` aliases are discovered structurally, dated
  snapshots/legacy ids are skipped, and catalogue metadata (context window,
  max tokens, thinking/effort capabilities) is preserved verbatim. New
  revisions and entirely new families therefore appear without a bridge source
  edit; Mythos 5/5.1 from OMP 18.2.2 are regression-covered examples.
- Runtime context smoke probe: `bun run smoke:context` sends a tiny request to
  the newest model in every discovered family and compares Claude Code's
  served `modelUsage.contextWindow` with OMP's catalogue. Models that are
  catalogued but unavailable to the authenticated account are reported as
  `UNAVAILABLE` and skipped; actual window mismatches, missing usage metadata,
  and unexpected errors still fail the smoke. `--all` probes every registered
  model; explicit ids can be supplied for targeted checks.
- AskClaude's public `thinking` parameter now accepts `max`, alongside `off`,
  `minimal`, `low`, `medium`, `high`, and `xhigh`. The value flows through the
  existing model-aware `mapReasoningToClaudeEffort` mapper (no AskClaude-side
  remap), so model-specific `max`/`xhigh` fallbacks are preserved.

### Fixed
- Faithful system-prompt transport. The provider previously replaced OMP's
  assembled system prompt with Claude Code's `claude_code` preset plus only
  AGENTS.md and the skills block, so a subagent's native `task.context` (e.g. a
  MYOMP sequential-decomposition child's `PRIOR_PHASE_RESULTS`) never reached
  Claude Code. The bridge now records each assembled prompt at
  `before_agent_start` and derives portable content from the exact rendered
  `systemPrompt[]` instead of re-discovering files from `process.cwd()`: rendered
  context files (with paths), skills, default-layout append text, custom-prompt
  user/project content, and the subagent role/context block are projected behind
  Claude Code's preset exactly once. The process-global capture registry lets a
  child record under one extension instance and resolve from the parent-owned
  provider callback, and is cleared only when that provider owner shuts down.
  Unknown prompts fail closed instead of silently dropping instructions. See
  [`src/prompt-capture.ts`](src/prompt-capture.ts).

### Changed
- Upgraded `@anthropic-ai/claude-agent-sdk` to `^0.3.274`, whose bundled Claude
  Code runtime is 2.1.274, so newly promoted Fable 5.1 works without requiring
  a separate system CLI override. Companion Anthropic/MCP/Zod dependencies are
  aligned with the SDK's current peer requirements; `pathToClaudeCodeExecutable`
  remains available as an explicit override.
- Context windows are now resolved entirely from OMP's Anthropic catalogue.
  Each discovered model is registered with the catalogue's canonical
  `contextWindow` verbatim and its canonical id is sent to Claude Code
  unchanged. This corrects stale metadata — Opus 5, Sonnet 5, Fable 5, Opus 4.6,
  and Sonnet 4.6 now register their true **1M** window instead of a 200K/`[1m]`
  approximation — and means a newly discovered revision or family inherits its
  window automatically, with no bridge source edit. Mythos 5/5.1 register at 1M
  directly from OMP 18.2.2; Haiku 4.5 stays 200K. MYOMP's context-fit decisions
  and OMP's status bar / auto-compaction now read catalogue capacities. Any
  runtime/catalogue mismatch reported by Claude Code is surfaced once to the
  user and can be reproduced with `bun run smoke:context`.
- `resolveModel` prefers an exact id match over partial containment, so an
  exact id never resolves to a newer revision containing it as a prefix.
- Thinking metadata is now projected from the catalogue into registration, and
  the effort table understands the new top `max` tier.
- `@oh-my-pi/*` devDependencies bumped to ^18.2.2 so typecheck/tests run
  against the same catalogue as current OMP installs (peer ranges unchanged).

### Removed
- Exact-id context-window machinery: `RUNTIME_OVERRIDE_IDS` and the
  `resolveAuto`/`resolveForcedOneM`/`resolveForcedTwoHundredK`/`availableOverrideRuntimes`/
  `resolveDynamicRuntimeModel` resolvers, the `[1m]` model-id spelling, and the
  synthetic `-1m`/`-200k` picker variants (`buildVariantModels`, `parseVariantId`).
  Every supported model has one canonical window, so there is nothing to select.
- `provider.contextWindow`, `provider.plan`, and `provider.longContextExtraUsage`.
  None affected true model capability once windows became catalogue-driven; the
  first two also risked misreporting capacity. Setting any of them now logs a
  one-time deprecation notice and is otherwise ignored. `plan`/`longContextExtraUsage`
  remain valid Anthropic billing concepts but never redefine a model's context window.

## [0.8.1] - 2026-07-07

### Fixed
- Spurious "Claude rate limit warning" toasts at trivial utilization. The Claude
  Agent SDK emits `allowed_warning` rate-limit events even at ~1% of the
  `seven_day` (weekly) limit; these are now surfaced only at ≥80% utilization.
  Hard-limit (`rejected`) notifications and the debug log are unchanged.

## [0.8.0] - 2026-07-07

### Added
- On-demand context-window variants in the `/model` picker: each model is now
  registered once per window it supports (1M and/or 200K) as a distinct,
  clearly-labeled entry (e.g. `Opus 4.8 (1M)` and `Opus 4.8 (200K)`). Switching
  a model's context window is a picker selection instead of a config edit plus
  reload.
- Suffixed model ids (`<model>-1m` / `<model>-200k`) that force a specific
  window regardless of the global default — usable from `modelRoles` and
  AskClaude short names. The unsuffixed id remains the config default, so
  existing `config.yml` roles keep working.

### Changed
- `provider.contextWindow` now sets the **default** window (which window the
  unsuffixed model id maps to) instead of hiding models that don't match it.
  Both windows stay pickable wherever a runtime exists.
- Each variant reports its true `contextWindow`, keeping the status bar and
  auto-compaction accurate for the selected window.

## [0.7.0] - 2026-07-06

First public release of the Oh My Pi port.

### Added
- `provider.contextWindow` setting with three modes:
  - `"auto"` (default) — per-model context policy based on measured SDK behavior.
  - `"1m"` — force the 1M context window; only 1M-capable models are registered.
  - `"200k"` — force the 200K context window; only 200K-capable models are registered.
- Models without a runtime for the selected forced window are hidden from the
  model picker instead of being misreported.
- `thinkingLevelMap` fallback so Sonnet 5 / Sonnet 4.6 expose `xhigh` (mapped to `max`).

### Changed
- Ported from Pi (`@earendil-works/*`) to Oh My Pi (`@oh-my-pi/*`): extension
  manifest (`omp.extensions`), provider registration, message conversion, and
  config directory resolution (`~/.omp/agent/claude-bridge.json`).
- Corrected the `claude-fable-5` context policy: the bare `claude-fable-5`
  runtime serves 200K (verified), while `claude-fable-5[1m]` serves 1M. In
  `"auto"` mode Fable 5 now registers at 200K.

### Credits
- Original `pi-claude-bridge` by [Eli Dickinson](https://github.com/elidickinson).
- Oh My Pi port and context-window controls by [Jonathan Borgwing](https://github.com/DevVig).
