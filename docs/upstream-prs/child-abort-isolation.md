# Isolate a model turn from the run abort signal

## Title

Isolate model-turn abort listeners from the run signal

## Body

### Why

A run lives on one AbortSignal. Each model request attached its fetch and SDK listeners to that signal, and a step deadline composed onto it could abort the next turn. A long run then failed with a bare abort, and the signal grew a listener for every request.

### What

`createStepSignal` makes a child signal. It aborts when the caller aborts or when its own deadline fires, and `dispose` removes the one listener from the caller and cancels the deadline. `reliableModelStream` hands that child to the provider. Codex idle abort still listens to the child, so silence aborts the request and not the run. Ending or closing the stream disposes the child, including a close that happens before the first read.

### How tested

`reliableModelStream idle gating > keeps request abort listeners off the run signal` failed before the change: the signal handed to the provider was the run signal. After the change, each of five turns received a child signal. A listener added the way a fetch would did not increase the run's listener count past one, and closing the turn left the run with zero abort listeners. Aborting the run still aborted the next turn's signal with the run's reason.

Also covered by `does not let a step deadline abort a later turn on the same signal`, `keeps the caller listener count bounded across steps`, `still aborts the step when the caller aborts`, and the existing Codex idle tests, including that an idle timeout does not abort the caller.

PR CI: `pnpm lint` (including the translation-catalog check), `pnpm check`, `pnpm build` with the Electron preload smoke, `pnpm test`, `pnpm test:integration`, and `pnpm test:e2e`.
