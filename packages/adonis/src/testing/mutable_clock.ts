/**
 * A clock whose time can be advanced manually — for deterministic time-based tests
 * (retries, trial windows) without real waits. Mirrors durable's testing `MutableClock`.
 */
export class MutableClock {
  #now: Date;

  constructor(start = new Date('2026-01-01T00:00:00.000Z')) {
    this.#now = start;
  }

  now(): Date {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }

  set(date: Date): void {
    this.#now = date;
  }
}
