/**
 * Per-run detector state machines for the budget governor. Both detectors can
 * clear: a successful tool call resets the failure run, and edits leaving the
 * bounded window stop counting toward churn. The engine in `./index.ts` owns
 * when they are fed and what a trip does.
 *
 * @module @econym/dsh-budget-governor/detectors
 */

/**
 * Counts consecutive failed tool calls in one child run. Any successful call
 * resets the count to zero, so a run that recovers is never terminated for its
 * history.
 */
export class ConsecutiveFailureCounter {
  private count = 0

  /**
   * @param ceiling - consecutive failures at which {@link observe} reports a trip.
   */
  constructor(private readonly ceiling: number) {}

  /**
   * Record one tool outcome.
   * @param failed - whether the call's model-facing result was an error.
   * @returns whether the consecutive-failure count reached the ceiling.
   */
  observe(failed: boolean): boolean {
    this.count = failed ? this.count + 1 : 0
    return this.count >= this.ceiling
  }

  /** The current consecutive-failure count, for termination reports. */
  get current(): number {
    return this.count
  }
}

/**
 * Bounded sliding window over one child run's most recent edit-tool calls,
 * counting how many target the same file. Entries older than the window fall
 * out and stop counting, so steady progress across many files never trips.
 */
export class EditChurnWindow {
  private readonly recent: string[] = []
  private tripCount = 0

  /**
   * @param ceiling - same-file edits within the window that constitute churn.
   * @param window - how many recent edit calls are retained.
   */
  constructor(private readonly ceiling: number, private readonly window: number) {}

  /**
   * Record one edit call's target path.
   * @param path - the edited file path exactly as the model supplied it.
   * @returns whether `path` now accounts for at least the ceiling of the window.
   */
  observe(path: string): boolean {
    this.recent.push(path)
    if (this.recent.length > this.window) this.recent.shift()
    this.tripCount = this.recent.filter(entry => entry === path).length
    return this.tripCount >= this.ceiling
  }

  /** The same-file count computed by the last {@link observe}, for termination reports. */
  get current(): number {
    return this.tripCount
  }
}
