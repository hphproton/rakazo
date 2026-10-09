/**
 * A step deadline and the abort listeners a fetch attaches must stay off the
 * caller's signal. The step aborts when the caller aborts or its own deadline
 * fires. Disposing drops the caller listener and cancels the deadline.
 */
export class StepTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`step timed out after ${timeoutMs} ms`);
    this.name = "StepTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface StepSignal {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
}

export function createStepSignal(parent?: AbortSignal, timeoutMs?: number): StepSignal {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onParent = () => {
    if (disposed || controller.signal.aborted) return;
    const reason = parent?.reason;
    if (reason === undefined) controller.abort();
    else controller.abort(reason);
  };

  if (parent?.aborted) onParent();
  else if (parent) parent.addEventListener("abort", onParent, { once: true });

  if (
    typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0 &&
    !controller.signal.aborted
  ) {
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new StepTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/** Run one request on a step signal and always drop the caller listener. */
export async function withStepSignal<T>(
  parent: AbortSignal | undefined,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const step = createStepSignal(parent);
  try {
    return await body(step.signal);
  } finally {
    step.dispose();
  }
}
