# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Debug-mode reasoning instrumentation: provider and AskClaude calls now log a
  dedicated `reasoning-map` record showing the OMP-requested reasoning level,
  the mapped Claude Agent SDK effort, and the effective Claude Code model id.
- Dynamic Claude model discovery from OMP's Anthropic catalogue. The picker is
  no longer driven by a hard-coded model-id list: any revision of a validated
  family (fable, opus, sonnet, haiku) at or above its baseline is discovered,
  ordered newest-first, and registered with the catalogue's metadata (context
  window, max tokens, thinking/effort capabilities). Newly shipped revisions
  such as Fable 5.1 and Opus 5 appear automatically.
- AskClaude's public `thinking` parameter now accepts `max`, alongside `off`,
  `minimal`, `low`, `medium`, `high`, and `xhigh`. The value flows through the
  existing model-aware `mapReasoningToClaudeEffort` mapper (no AskClaude-side
  remap), so model-specific `max`/`xhigh` fallbacks are preserved.

### Changed
- Promoted Opus 5 and Fable 5.1 from conservative dynamic registration to
  measured Claude Code runtime overrides. Verified with Claude Code 2.1.274:
  bare `claude-opus-5` serves 200K and `claude-opus-5[1m]` serves 1M; bare
  `claude-fable-5-1` serves 1M and no separate 200K runtime is claimed. The
  picker now exposes the measured windows instead of capping both models at
  the unmeasured 200K fallback.
- Models without measured Claude Code runtime behavior get a single canonical
  picker entry: the bare id is sent to Claude Code and the registered window is
  conservatively capped at 200K until measured; forced `1m` hides them instead
  of claiming an unverified runtime. Measured models keep their existing
  per-window entries and runtime overrides.
- `resolveModel` prefers an exact id match over partial containment, so an
  exact id never resolves to a newer revision containing it as a prefix.
- Thinking metadata is now projected from the catalogue into registration, and
  the effort table understands the new top `max` tier.
- `@oh-my-pi/*` devDependencies bumped to ^18.2.2 so typecheck/tests run
  against the same catalogue as current OMP installs (peer ranges unchanged).

### Fixed
- Single-window measured models no longer throw when the global
  `provider.contextWindow` preference names the other window. A model that
  supports only one Claude Code runtime (Haiku 4.5 is 200K-only; Fable 5.1 and
  Opus 4.7 are 1M-only) now degrades to its sole supported window instead of
  fabricating an impossible runtime or raising. The runtime is derived from the
  model's measured windows so any future single-window model behaves the same;
  dual-window models still honor the global preference.

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
