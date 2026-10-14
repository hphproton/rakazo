# Isolate a model turn from the run abort signal

## Title

Isolate model-turn abort listeners from the run signal

## Body

### Why

A run lives on one AbortSignal. Each model request attached its fetch and SDK listeners to that signal, and a step deadline composed onto it could abort the next turn. A long run then failed with a bare abort, and the signal grew a listener for every request.

### Repro

Pass the run signal into several model turns and add the listener a fetch would add. The handed signal is the run signal, so those listeners stay after the turn ends. A deadline armed on that same signal aborts every later turn.

### Fix

`createStepSignal` makes a child signal. It aborts when the caller aborts or when its own deadline fires, and `dispose` removes the one listener from the caller and cancels the deadline. `reliableModelStream` hands that child to the provider. Codex idle abort still listens to the child, so silence aborts the request and not the run. Ending or closing the stream disposes the child, including a close that happens before the first read.

### Tests

- `does not let a step deadline abort a later turn on the same signal`
- `keeps the caller listener count bounded across steps`
- `still aborts the step when the caller aborts`
- `keeps request abort listeners off the run signal`
- Existing Codex idle tests still pass, including that an idle timeout does not abort the caller.

## Evidence

Test `reliableModelStream idle gating > keeps request abort listeners off the run signal`.

Before: the signal handed to the provider was the run signal (`Object.is` equality). The assertion that it is a different signal failed.

After: each of five turns received a child signal. A listener added the way a fetch would did not increase the run's listener count past one, and closing the turn left the run with zero abort listeners. Aborting the run still aborted the next turn's signal with the run's reason. The step-deadline tests left the run open and cleared its listener.

`step-signal`, `pi-runtime-stream-idle`, and `pi-runtime-transport` unit tests passed (54). Typecheck passed for `@rakazo/adapters`. Biome passed on the touched files.
