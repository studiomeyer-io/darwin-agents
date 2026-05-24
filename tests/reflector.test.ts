/**
 * Tests for the GEPA-style Reflector (Phase 2 A2, S1185).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Reflector, type RunPromptFn } from "../src/evolution/reflector.js";
import type { ExecutionTrace } from "../src/types.js";

const trace = (overrides: Partial<ExecutionTrace> = {}): ExecutionTrace => ({
  version: 1,
  toolCalls: [],
  textBlockCount: 0,
  turnCount: 1,
  mcpInvocations: 0,
  errors: [],
  capturedAt: "2026-05-25T08:00:00.000Z",
  ...overrides,
});

describe("Reflector — construction", () => {
  it("throws when runPrompt is not a function", () => {
    assert.throws(() => new Reflector(undefined as unknown as RunPromptFn), TypeError);
  });

  it("accepts a valid runPrompt", () => {
    const r = new Reflector(async () => "");
    assert.ok(r instanceof Reflector);
  });
});

describe("Reflector — input validation", () => {
  it("rejects empty currentPrompt", async () => {
    const r = new Reflector(async () => "x");
    await assert.rejects(
      r.reflect("", [{ variantId: "v1", score: 1, textFeedback: "fb" }]),
      TypeError,
    );
  });

  it("rejects empty feedbacks array", async () => {
    const r = new Reflector(async () => "x");
    await assert.rejects(r.reflect("current", []), TypeError);
  });
});

describe("Reflector — meta-prompt construction", () => {
  it("substitutes {N}, {CURRENT_PROMPT}, {FEEDBACKS}", async () => {
    let captured = "";
    const runPrompt: RunPromptFn = async (p) => {
      captured = p;
      return "mutated";
    };
    const r = new Reflector(runPrompt);
    await r.reflect("original instruction", [
      { variantId: "v1", score: 0.8, textFeedback: "good" },
      { variantId: "v2", score: 0.3, textFeedback: "bad" },
    ]);
    assert.ok(captured.includes("2 variant evaluations"));
    assert.ok(captured.includes("original instruction"));
    assert.ok(captured.includes("v1 (score 0.80)"));
    assert.ok(captured.includes("v2 (score 0.30)"));
    assert.ok(captured.includes("good"));
    assert.ok(captured.includes("bad"));
  });

  it("respects feedbackCap to keep meta-prompt bounded", async () => {
    let captured = "";
    const runPrompt: RunPromptFn = async (p) => {
      captured = p;
      return "mutated";
    };
    const r = new Reflector(runPrompt);
    const huge = "x".repeat(5000);
    await r.reflect(
      "current",
      [{ variantId: "v1", score: 0.5, textFeedback: huge }],
      { feedbackCap: 100 },
    );
    assert.ok(captured.includes("[...truncated]"));
    assert.ok(!captured.includes("x".repeat(200)));
  });

  it("includes trace summary when trace provided", async () => {
    let captured = "";
    const runPrompt: RunPromptFn = async (p) => {
      captured = p;
      return "mutated";
    };
    const r = new Reflector(runPrompt);
    await r.reflect("current", [
      {
        variantId: "v1",
        score: 0.5,
        textFeedback: "fb",
        trace: trace({
          turnCount: 4,
          toolCalls: [
            { id: "1", tool: "mcp__nex__search", outcome: "success", durationMs: 100, turn: 1 },
            { id: "2", tool: "Read", outcome: "success", durationMs: 5, turn: 2 },
          ],
        }),
      },
    ]);
    assert.ok(captured.includes("4 turns"));
    assert.ok(captured.includes("2 tool calls"));
    assert.ok(captured.includes("mcp__nex__search"));
  });

  it("supports custom reflectionPromptTemplate", async () => {
    let captured = "";
    const runPrompt: RunPromptFn = async (p) => {
      captured = p;
      return "mutated";
    };
    const r = new Reflector(runPrompt);
    await r.reflect(
      "current",
      [{ variantId: "v1", score: 0.5, textFeedback: "fb" }],
      {
        reflectionPromptTemplate: "MINIMAL: prompt={CURRENT_PROMPT}, feedbacks={FEEDBACKS}",
      },
    );
    assert.ok(/^MINIMAL: prompt=current, feedbacks=/.test(captured));
  });
});

describe("Reflector — output cleaning", () => {
  it("strips ``` fences", async () => {
    const r = new Reflector(async () => "```\nmutated text\n```");
    const out = await r.reflect("current", [{ variantId: "v1", score: 0.5, textFeedback: "fb" }]);
    assert.equal(out, "mutated text");
  });

  it("strips ```language fences", async () => {
    const r = new Reflector(async () => "```markdown\nmutated text\n```");
    const out = await r.reflect("current", [{ variantId: "v1", score: 0.5, textFeedback: "fb" }]);
    assert.equal(out, "mutated text");
  });

  it("trims leading/trailing whitespace", async () => {
    const r = new Reflector(async () => "  \n  mutated text  \n  ");
    const out = await r.reflect("current", [{ variantId: "v1", score: 0.5, textFeedback: "fb" }]);
    assert.equal(out, "mutated text");
  });
});

describe("Reflector — length truncation", () => {
  it("truncates at sentence boundary when output exceeds max", async () => {
    const r = new Reflector(async () =>
      "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.",
    );
    const out = await r.reflect(
      "short current",
      [{ variantId: "v1", score: 0.5, textFeedback: "fb" }],
      { maxMutationLength: 40 },
    );
    assert.ok(out.length <= 40);
    assert.ok(out.endsWith("."));
  });

  it("default max is max(currentPrompt * 1.3, 3500)", async () => {
    const r = new Reflector(async () => "y".repeat(10000));
    const out = await r.reflect("short", [
      { variantId: "v1", score: 0.5, textFeedback: "fb" },
    ]);
    assert.ok(out.length <= 3500);
  });
});
