import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createStepSignal, StepTimeoutError } from "./step-signal.js";

describe("createStepSignal", () => {
  it("does not let a step deadline abort a later turn on the same signal", async () => {
    const run = new AbortController();
    const tool = createStepSignal(run.signal, 15);
    await new Promise<void>((resolve) => {
      tool.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(tool.timedOut).toBe(true);
    expect(tool.signal.reason).toBeInstanceOf(StepTimeoutError);
    expect(run.signal.aborted).toBe(false);
    tool.dispose();

    const turn = createStepSignal(run.signal);
    expect(turn.signal.aborted).toBe(false);
    expect(run.signal.aborted).toBe(false);
    turn.dispose();
    expect(getEventListeners(run.signal, "abort")).toHaveLength(0);
  });

  it("keeps the caller listener count bounded across steps", () => {
    const run = new AbortController();
    for (let i = 0; i < 40; i += 1) {
      const step = createStepSignal(run.signal, 60_000);
      step.signal.addEventListener("abort", () => undefined);
      expect(getEventListeners(run.signal, "abort").length).toBeLessThanOrEqual(1);
      step.dispose();
    }
    expect(getEventListeners(run.signal, "abort")).toHaveLength(0);
    expect(run.signal.aborted).toBe(false);
  });

  it("still aborts the step when the caller aborts", () => {
    const run = new AbortController();
    const step = createStepSignal(run.signal, 60_000);
    run.abort(new Error("stopped"));
    expect(step.signal.aborted).toBe(true);
    expect(step.timedOut).toBe(false);
    expect((step.signal.reason as Error).message).toBe("stopped");
    step.dispose();
    expect(getEventListeners(run.signal, "abort")).toHaveLength(0);
  });
});
