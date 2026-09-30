/**
 * Circuit breaker state machine.
 *
 * Tracks consecutive failures and transitions between CLOSED, OPEN, and
 * HALF_OPEN states. A call is permitted only when the circuit is not OPEN
 * (OPEN always blocks; HALF_OPEN allows one trial call).
 *
 * Design decisions:
 *
 *  - Time is injected via a `now` function (default: `Date.now`). This makes
 *    every transition deterministic and testable without ever sleeping or
 *    touching the wall clock. Transition timing depends entirely on what the
 *    caller's clock returns.
 *
 *  - HALF_OPEN permits exactly one trial call. While a trial is in flight the
 *    circuit stays HALF_OPEN but blocks further calls until the trial is
 *    resolved via `recordSuccess` or `recordFailure`. This prevents a stampede
 *    of retries during the probe window, which is the whole reason circuit
 *    breakers exist.
 *
 *  - A single success in HALF_OPEN fully resets the failure counter and closes
 *    the circuit. A single failure in HALF_OPEN re-opens it immediately. We do
 *    not require N successes to close; that is a different policy and we picked
 *    one rather than trying to support both.
 *
 *  - In CLOSED, only consecutive failures drive the count up; a success resets
 *    it to zero. We do not track a sliding time-window of failures; the count
 *    is purely consecutive. This is the simplest honest reading of
 *    "consecutive failures".
 */

export const CLOSED = 'closed';
export const OPEN = 'open';
export const HALF_OPEN = 'half-open';

const DEFAULTS = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
};

/**
 * @typedef {Object} CircuitBreakerOptions
 * @property {number} [failureThreshold] Consecutive failures required to
 *   open the circuit from CLOSED. Must be a positive integer. Default 5.
 * @property {number} [resetTimeoutMs] Milliseconds the circuit stays OPEN
 *   before transitioning to HALF_OPEN. Must be a non-negative finite number.
 *   Default 30000.
 * @property {() => number} [now] Clock function returning epoch milliseconds.
 *   Default `Date.now`. Inject a fake in tests; never assert on real time.
 */

/**
 * Build a circuit breaker.
 *
 * @param {CircuitBreakerOptions} [options]
 */
export class CircuitBreaker {
  #state = CLOSED;
  #consecutiveFailures = 0;
  #openedAt = null;        // ms value of the clock when OPEN began
  #halfOpenTrialInFlight = false;

  #failureThreshold;
  #resetTimeoutMs;
  #now;

  constructor(options = {}) {
    const {
      failureThreshold = DEFAULTS.failureThreshold,
      resetTimeoutMs = DEFAULTS.resetTimeoutMs,
      now = () => Date.now(),
    } = options;

    if (!Number.isInteger(failureThreshold) || failureThreshold <= 0) {
      throw new RangeError(
        `failureThreshold must be a positive integer, got ${failureThreshold}`
      );
    }
    if (typeof resetTimeoutMs !== 'number' ||
        !Number.isFinite(resetTimeoutMs) ||
        resetTimeoutMs < 0) {
      throw new RangeError(
        `resetTimeoutMs must be a finite non-negative number, got ${resetTimeoutMs}`
      );
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function returning epoch ms');
    }

    this.#failureThreshold = failureThreshold;
    this.#resetTimeoutMs = resetTimeoutMs;
    this.#now = now;
  }

  /** Current state name. One of CLOSED, OPEN, HALF_OPEN. */
  get state() {
    this.#maybeTransitionToHalfOpen();
    return this.#state;
  }

  /** Current consecutive failure count (for inspection / metrics). */
  get consecutiveFailures() {
    this.#maybeTransitionToHalfOpen();
    return this.#consecutiveFailures;
  }

  /**
   * Whether a call is permitted right now.
   *
   * CLOSED: always allowed.
   * OPEN: never allowed. If the reset timeout has elapsed, the state becomes
   *   HALF_OPEN and one trial call is permitted.
   * HALF_OPEN: allowed only if no trial call is already in flight.
   *
   * @returns {boolean}
   */
  canExecute() {
    this.#maybeTransitionToHalfOpen();

    switch (this.#state) {
      case CLOSED:
        return true;
      case OPEN:
        return false;
      case HALF_OPEN:
        if (this.#halfOpenTrialInFlight) return false;
        this.#halfOpenTrialInFlight = true;
        return true;
      default:
        // Defensive: the state is always one of the three constants above.
        return false;
    }
  }

  /**
   * Record a successful call.
   *
   * In CLOSED, resets the consecutive failure counter to zero.
   * In HALF_OPEN, clears the trial flag, resets failures, and closes.
   * In OPEN, this is a no-op: callers should not be calling the underlying
   *   resource while open, so a stray success is ignored rather than
   *   silently closing the circuit early.
   */
  recordSuccess() {
    this.#maybeTransitionToHalfOpen();

    if (this.#state === HALF_OPEN) {
      this.#halfOpenTrialInFlight = false;
    }
    if (this.#state === OPEN) {
      return;
    }
    this.#consecutiveFailures = 0;
    this.#state = CLOSED;
    this.#openedAt = null;
  }

  /**
   * Record a failed call.
   *
   * In CLOSED, increments the counter; if it reaches the threshold, opens.
   * In HALF_OPEN, the trial failed: re-open immediately and reset the trial
   *   flag so the next half-open window can admit exactly one call again.
   * In OPEN, a failure during open is a stale/late result from a call made
   *   before opening; ignore it. We never count a failure that wasn't
   *   permitted.
   */
  recordFailure() {
    this.#maybeTransitionToHalfOpen();

    if (this.#state === OPEN) {
      return;
    }

    if (this.#state === HALF_OPEN) {
      this.#halfOpenTrialInFlight = false;
      this.#open();
      return;
    }

    // CLOSED
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= this.#failureThreshold) {
      this.#open();
    }
  }

  /**
   * Force the circuit into CLOSED and clear all counters.
   *
   * Intended for ops/health-checks, not for normal call flow.
   */
  reset() {
    this.#state = CLOSED;
    this.#consecutiveFailures = 0;
    this.#openedAt = null;
    this.#halfOpenTrialInFlight = false;
  }

  // ---- internals --------------------------------------------------------

  #open() {
    this.#state = OPEN;
    this.#openedAt = this.#now();
    // Preserve #consecutiveFailures as-is: a caller inspecting an open
    // breaker can see how many consecutive failures drove it open.
    this.#halfOpenTrialInFlight = false;
  }

  #maybeTransitionToHalfOpen() {
    if (this.#state !== OPEN || this.#openedAt === null) return;
    const elapsed = this.#now() - this.#openedAt;
    if (elapsed >= this.#resetTimeoutMs) {
      this.#state = HALF_OPEN;
      this.#halfOpenTrialInFlight = false;
      // Keep #consecutiveFailures: if the half-open trial fails we re-open
      // immediately, and the count remains meaningful for observability.
    }
  }
}
