import test from "node:test";
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
