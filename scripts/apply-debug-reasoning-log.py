from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


# src/index.ts: provider path
p = Path("src/index.ts")
s = p.read_text()
old = '''\tconst cliModel = claudeCodeModelId(model, longContextSettings);\n\tconst extraArgs: Record<string, string | null> = { model: cliModel };\n'''
new = '''\tconst cliModel = claudeCodeModelId(model, longContextSettings);\n\tdebug("provider: reasoning-map",\n\t\t`registeredModel=${model.id} cliModel=${cliModel}`,\n\t\t`requestedReasoning=${options?.reasoning ?? "default"} mappedEffort=${effort ?? "default"}`);\n\tconst extraArgs: Record<string, string | null> = { model: cliModel };\n'''
s = replace_once(s, old, new, "provider reasoning-map insertion")

# src/index.ts: AskClaude path
old = '''\tif (effort) extraArgs["thinking-display"] = "summarized";\n\n\tdebug("askClaude:",\n'''
new = '''\tif (effort) extraArgs["thinking-display"] = "summarized";\n\n\tdebug("askClaude: reasoning-map",\n\t\t`model=${modelId} cliModel=${cliModel}`,\n\t\t`requestedReasoning=${options?.thinking ?? "default"} mappedEffort=${effort ?? "default"}`);\n\n\tdebug("askClaude:",\n'''
s = replace_once(s, old, new, "AskClaude reasoning-map insertion")
p.write_text(s)

# Deterministic source-level regression test: this does not call Claude.
Path("tests/unit-debug-reasoning.mjs").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("provider debug log exposes requested reasoning and mapped SDK effort", () => {
  assert.match(source, /debug\("provider: reasoning-map"/);
  assert.match(source, /requestedReasoning=\$\{options\?\.reasoning \?\? "default"\} mappedEffort=\$\{effort \?\? "default"\}/);
});

test("AskClaude debug log exposes requested reasoning and mapped SDK effort", () => {
  assert.match(source, /debug\("askClaude: reasoning-map"/);
  assert.match(source, /requestedReasoning=\$\{options\?\.thinking \?\? "default"\} mappedEffort=\$\{effort \?\? "default"\}/);
});
''')

# README: tell users where the debug output goes and how to grep the mapping.
p = Path("README.md")
s = p.read_text()
old = '''- **Bridge log** — `~/.omp/agent/claude-bridge.log`: every provider call, session-sync decision, tool-result delivery, and Claude Code stderr. Override the path with `CLAUDE_BRIDGE_DEBUG_PATH`.\n- **Per-query CLI logs** — `~/.omp/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log`: the Claude Code subprocess's own debug stream, one file per query. Tags are `provider`, `continuation`, or `askclaude`.\n'''
new = '''- **Bridge log** — `~/.omp/agent/claude-bridge.log`: every provider call, session-sync decision, tool-result delivery, and Claude Code stderr. Override the path with `CLAUDE_BRIDGE_DEBUG_PATH`.\n- **Reasoning-effort mapping** — provider and AskClaude calls emit a dedicated `reasoning-map` line with the registered/CLI model, the reasoning level requested by OMP, and the effort actually passed to the Claude Agent SDK. For example, `requestedReasoning=xhigh mappedEffort=xhigh`. Check it with `grep 'reasoning-map' ~/.omp/agent/claude-bridge.log`.\n- **Per-query CLI logs** — `~/.omp/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log`: the Claude Code subprocess's own debug stream, one file per query. Tags are `provider`, `continuation`, or `askclaude`.\n'''
s = replace_once(s, old, new, "README debugging section")
p.write_text(s)

# CHANGELOG
p = Path("CHANGELOG.md")
s = p.read_text()
old = '''### Added\n- Dynamic Claude model discovery from OMP's Anthropic catalogue. The picker is\n'''
new = '''### Added\n- Debug-mode reasoning instrumentation: provider and AskClaude calls now log a\n  dedicated `reasoning-map` record showing the OMP-requested reasoning level,\n  the mapped Claude Agent SDK effort, and the effective Claude Code model id.\n- Dynamic Claude model discovery from OMP's Anthropic catalogue. The picker is\n'''
s = replace_once(s, old, new, "CHANGELOG Added section")
p.write_text(s)
