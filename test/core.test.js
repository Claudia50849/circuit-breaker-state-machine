import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CLOSED, OPEN, HALF_OPEN } from '../src/index.js';

// Deterministic clock helper. Tests never touch wall-clock time.
function makeClock(start = 0) {
  let t = start;
  return {
    advance(ms) { t += ms; },
    now() { return t; },
  };
}

test('starts closed and permits calls', () => {
  const cb = new CircuitBreaker();
  assert.equal(cb.state, CLOSED);
  assert.equal(cb.canExecute(), true);
});

test('respects default exports of state constants', () => {
  assert.equal(CLOSED, 'closed');
  assert.equal(OPEN, 'open');
  assert.equal(HALF_OPEN, 'half-open');
});

test('fails fast on invalid options', () => {
  assert.throws(() => new CircuitBreaker({ failureThreshold: 0 }), RangeError);
  assert.throws(() => new CircuitBreaker({ failureThreshold: 1.5 }), RangeError);
  assert.throws(() => new CircuitBreaker({ resetTimeoutMs: -1 }), RangeError);
  assert.throws(() => new CircuitBreaker({ resetTimeoutMs: Infinity }), RangeError);
  assert.throws(() => new CircuitBreaker({ now: 'not a fn' }), TypeError);
});

test('opens after exactly failureThreshold consecutive failures', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state, CLOSED);
  cb.recordFailure();
  assert.equal(cb.state, OPEN);
  assert.equal(cb.canExecute(), false);
});

test('a single success in CLOSED resets the failure count', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess();
  assert.equal(cb.consecutiveFailures, 0);
  cb.recordFailure();
  assert.equal(cb.state, CLOSED, 'count restarted, not yet at threshold');
});

test('OPEN blocks calls and exposes a stable failure count', () => {
  const cb = new CircuitBreaker({ failureThreshold: 2 });
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state, OPEN);
  assert.equal(cb.canExecute(), false);
  assert.equal(cb.consecutiveFailures, 2);
});

test('OPEN auto-transitions to HALF_OPEN after resetTimeoutMs', () => {
  const clock = makeClock(1000);
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 5000,
    now: clock.now,
  });
  cb.recordFailure();
  assert.equal(cb.state, OPEN);

  clock.advance(4999);
  assert.equal(cb.state, OPEN, 'just under the timeout stays open');

  clock.advance(1);
  assert.equal(cb.state, HALF_OPEN);
});

test('HALF_OPEN admits exactly one trial call at a time', () => {
  const clock = makeClock(0);
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1000,
    now: clock.now,
  });
  cb.recordFailure();
  clock.advance(1000);
  assert.equal(cb.state, HALF_OPEN);

  assert.equal(cb.canExecute(), true, 'first trial call permitted');
  assert.equal(cb.canExecute(), false, 'second call blocked while trial pending');
});

test('HALF_OPEN success closes the circuit and clears the trial', () => {
  const clock = makeClock(0);
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1000,
    now: clock.now,
  });
  cb.recordFailure();
  clock.advance(1000);
  assert.equal(cb.state, HALF_OPEN);

  assert.equal(cb.canExecute(), true);
  cb.recordSuccess();
  assert.equal(cb.state, CLOSED);
  assert.equal(cb.consecutiveFailures, 0);
  // After closing, calls flow again.
  assert.equal(cb.canExecute(), true);
});

test('HALF_OPEN failure re-opens immediately with a fresh timeout', () => {
  const clock = makeClock(0);
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1000,
    now: clock.now,
  });
  cb.recordFailure();
  clock.advance(1000);
  assert.equal(cb.state, HALF_OPEN);

  assert.equal(cb.canExecute(), true);
  cb.recordFailure();
  assert.equal(cb.state, OPEN);
  assert.equal(cb.canExecute(), false);

  // The new open window uses the current clock time as its anchor.
  clock.advance(999);
  assert.equal(cb.state, OPEN);
  clock.advance(1);
  assert.equal(cb.state, HALF_OPEN);
});

test('reset() forces CLOSED and clears all counters and trial state', () => {
  const clock = makeClock(0);
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1000,
    now: clock.now,
  });
  cb.recordFailure();
  clock.advance(1000);
  assert.equal(cb.state, HALF_OPEN);
  assert.equal(cb.canExecute(), true, 'trial in flight');

  cb.reset();
  assert.equal(cb.state, CLOSED);
  assert.equal(cb.consecutiveFailures, 0);
  assert.equal(cb.canExecute(), true, 'no lingering trial flag after reset');
});

test('late result in OPEN is ignored and does not close the circuit', () => {
  const clock = makeClock(0);
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1000,
    now: clock.now,
  });
  // First failure opens the circuit.
  cb.recordFailure();
  assert.equal(cb.state, OPEN);

  // A success that arrives while OPEN (e.g. a slow call that completed after
  // the breaker opened) must not prematurely close the circuit.
  cb.recordSuccess();
  assert.equal(cb.state, OPEN);
  assert.equal(cb.consecutiveFailures, 1, 'count unchanged by stray success');

  // A late failure while OPEN is similarly ignored — it wasn't permitted.
  cb.recordFailure();
  assert.equal(cb.state, OPEN);
});
