# Circuit Breaker State Machine

A tiny, dependency-free TypeScript-style ESM library that tracks consecutive
failures and transitions a circuit between `closed`, `open`, and `half-open`
states, gating whether a call is permitted based on configurable thresholds.

## Usage

```js
import { CircuitBreaker, CLOSED, OPEN, HALF_OPEN } from './src/index.js';

const cb = new CircuitBreaker({
  failureThreshold: 5,   // consecutive failures to open
  resetTimeoutMs: 30000, // ms open before a half-open trial
  now: () => Date.now(), // inject a clock for deterministic tests
});

if (cb.canExecute()) {
  try {
    await doWork();
    cb.recordSuccess();
  } catch (err) {
    cb.recordFailure();
  }
}
```

Exported names: `CircuitBreaker` (class), `CLOSED`, `OPEN`, `HALF_OPEN`
(state-name constants).

## Why this exists

You have an operation that can fail transiently and you want to stop hammering
a downstream resource once it's clearly broken. The trade-off here is
simplicity over policy richness: this library implements one policy well rather
than supporting several.

The policy is:

- In `closed`, only **consecutive** failures move the count. Any success resets
  it to zero. There is no sliding time-window.
- On reaching `failureThreshold`, the circuit opens.
- After `resetTimeoutMs` of wall-clock time (read from the injected clock),
  the circuit moves to `half-open` and admits **exactly one** trial call.
- A `half-open` success closes the circuit and clears the count. A `half-open`
  failure re-opens it immediately with a fresh timeout.

## The awkward edge

While a `half-open` trial call is in flight, `canExecute()` returns `false` for
*all* callers, including the one already running the trial. This is deliberate —
it prevents a stampede of retries during the probe window — but it means your
caller must treat `canExecute() === false` as "back off", not as "the resource
is permanently down". Inspect `cb.state` to distinguish `open` (blocked until
the timeout) from `half-open` (a trial is running).

Results that arrive while the circuit is `open` (e.g. a slow call that
completed after the breaker tripped) are ignored: a stray success will not
prematurely close the circuit, and a stray failure will not extend the open
window.

Time is injected via the `now` option so tests never depend on wall-clock
time. The default is `Date.now`.
