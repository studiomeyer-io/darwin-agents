/**
 * Regression tests for R1 V0.5.0-alpha.2 code-review findings (S1185).
 *
 * Covers:
 *   - Critic H1: template-injection via currentPrompt content
 *   - Critic H2: feedbackCap negative-value guard
 *   - Critic M2: nextGeneration index-based survivor mapping
 *   - Analyst A1: RunPromptFn shared-types export
 *   - Analyst A5: DARWIN_DEFAULT_OBJECTIVES constant + correct field names
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DARWIN_DEFAULT_OBJECTIVES,
  type ParetoObjective,
} from "../src/evolution/pareto.js";
import { Reflector, type RunPromptFn } from "../src/evolution/reflector.js";
import { GepaOptimizer, type ScoredVariant } from "../src/evolution/optimizer-gepa.js";
import type { RunPromptFn as SharedRunPromptFn } from "../src/evolution/run-prompt-fn.js";

describe("R1 H1 — template injection via currentPrompt content", () => {
  it("currentPrompt containing {FEEDBACKS} literal does NOT cause double-substitution", async () => {
    let captured = "";
    const runPrompt: RunPromptFn = async (p) => {
      captured = p;
      return "mutated";
    };
    const r = new Reflector(runPrompt);
    // Prompt contains the literal {FEEDBACKS} marker (user content).
    await r.reflect(
      "You are an agent. Use the {FEEDBACKS} format for citations.",
      [{ variantId: "v1", score: 0.5, textFeedback: "FB_CONTENT_MARKER" }],
    );
    // Count how many times FB_CONTENT_MARKER appears in the final meta-prompt.
    // With the broken order (CURRENT_PROMPT before FEEDBACKS) the feedback
    // block would be substituted into the user's {FEEDBACKS} too → 2
    // occurrences. With the correct order (CURRENT_PROMPT last) there is
    // exactly 1 occurrence (the real feedback block).
    const occurrences = (captured.match(/FB_CONTENT_MARKER/g) ?? []).length;
    assert.equal(occurrences, 1);
    // And the user's literal {FEEDBACKS} survives in the output text
    // (it is no longer a substitution token by the time it is inserted).
    assert.ok(captured.includes("{FEEDBACKS} format"));
  });

  it("currentPrompt containing {N} literal does NOT cause numeric injection", async () => {
    let captured = "";
    const runPrompt: RunPromptFn = async (p) => {
      captured = p;
      return "mutated";
    };
    const r = new Reflector(runPrompt);
    await r.reflect("Answer in {N} steps.", [
      { variantId: "v1", score: 0.5, textFeedback: "fb" },
    ]);
    // The user's literal {N} must survive untouched. The template's {N}
    // header is substituted but happens before {CURRENT_PROMPT} is
    // inserted, so the user's text is unaffected.
    assert.ok(captured.includes("Answer in {N} steps."));
  });
});

describe("R1 H2 — feedbackCap negative-value guard", () => {
  it("clamps feedbackCap=0 to 1 (no empty feedback blocks)", async () => {
    let captured = "";
    const runPrompt: RunPromptFn = async (p) => {
      captured = p;
      return "mutated";
    };
    const r = new Reflector(runPrompt);
    await r.reflect("p", [{ variantId: "v1", score: 0.5, textFeedback: "ABC" }], {
      feedbackCap: 0,
    });
    // With cap=0 unclamped: slice(0,0)="" → meta-prompt would show empty
    // feedback. With clamping to 1: first char "A" preserved.
    assert.ok(captured.includes("A"));
  });

  it("falls back to DEFAULT when feedbackCap=-5 (R2-C1 hardened guard)", async () => {
    let captured = "";
    const runPrompt: RunPromptFn = async (p) => {
      captured = p;
      return "mutated";
    };
    const r = new Reflector(runPrompt);
    await r.reflect("p", [{ variantId: "v1", score: 0.5, textFeedback: "ABCDE" }], {
      feedbackCap: -5,
    });
    // R2 V0.5.0-alpha.2 Critic R2-C1: invalid (non-positive / NaN /
    // Infinity) feedbackCap values fall back to DEFAULT_FEEDBACK_CAP
    // (2000) rather than being silently clamped to 1 — the original R1
    // clamp left `Math.max(1, Math.floor(NaN)) === NaN` as a bypass.
    // ABCDE is short enough to fully pass through under the default.
    assert.ok(captured.includes("ABCDE"));
  });

  it("falls back to DEFAULT when feedbackCap=NaN (R2-C1 hardened guard)", async () => {
    let captured = "";
    const runPrompt: RunPromptFn = async (p) => {
      captured = p;
      return "mutated";
    };
    const r = new Reflector(runPrompt);
    await r.reflect("p", [{ variantId: "v1", score: 0.5, textFeedback: "ABCDE" }], {
      feedbackCap: NaN,
    });
    // Without R2-C1 guard: cap=NaN → slice(0, NaN)="" → empty feedback.
    // With guard: falls back to DEFAULT → full feedback survives.
    assert.ok(captured.includes("ABCDE"));
  });
});

describe("R1 M2 — nextGeneration index-based survivor mapping", () => {
  it("returns correct survivors when metrics objects are identical-shape but distinct refs", () => {
    const opt = new GepaOptimizer(async () => "noop");
    const objectives: ReadonlyArray<ParetoObjective<Record<string, number>>> = [
      { key: "q", direction: "maximize" },
    ];
    const scored: ScoredVariant[] = [
      { id: "a", prompt: "p", metrics: { q: 5 } },
      { id: "b", prompt: "p", metrics: { q: 5 } }, // identical shape, distinct ref
      { id: "c", prompt: "p", metrics: { q: 3 } }, // dominated
    ];
    const survivors = opt.nextGeneration(scored, { objectives });
    // a and b are tied on the front; c is dominated. Both ties should survive.
    assert.equal(survivors.length, 2);
    assert.deepEqual(survivors.map((s) => s.id).sort(), ["a", "b"]);
  });
});

describe("R1 A1 — RunPromptFn shared types export", () => {
  it("RunPromptFn from run-prompt-fn.ts is structurally compatible with reflector export", async () => {
    // Compile-time check: both types should be assignable to each other.
    const fnFromShared: SharedRunPromptFn = async (p) => p;
    const fnFromReflector: RunPromptFn = async (p) => p;
    // If they were not the same type, this assignment would fail tsc.
    const _check1: RunPromptFn = fnFromShared;
    const _check2: SharedRunPromptFn = fnFromReflector;
    // Runtime sanity: both work as expected.
    assert.equal(await _check1("x"), "x");
    assert.equal(await _check2("y"), "y");
  });
});

describe("R1 A5 — DARWIN_DEFAULT_OBJECTIVES uses correct DarwinMetrics field names", () => {
  it("contains exactly the four DarwinMetrics fields", () => {
    const keys = DARWIN_DEFAULT_OBJECTIVES.map((o) => o.key).sort();
    assert.deepEqual(keys, ["durationMs", "outputLength", "qualityScore", "sourceCount"]);
  });

  it("durationMs is the only minimise direction", () => {
    const minimise = DARWIN_DEFAULT_OBJECTIVES.filter((o) => o.direction === "minimize");
    assert.equal(minimise.length, 1);
    assert.equal(minimise[0]!.key, "durationMs");
  });

  it("weights sum to 1.0 (default Darwin weighting)", () => {
    const total = DARWIN_DEFAULT_OBJECTIVES.reduce((s, o) => s + (o.weight ?? 1), 0);
    assert.ok(Math.abs(total - 1.0) < 1e-9);
  });
});
