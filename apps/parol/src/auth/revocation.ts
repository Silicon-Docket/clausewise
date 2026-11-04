/**
 * Session values that have been signed out of. The session cookie is a signed value that the server
 * does not store (docs/parol/06), so on its own nothing stops a copy of it from working until it
 * expires: clearing the cookie in the browser does not clear a copy somewhere else. Signing out
 * therefore also records the value here, and `readPrincipal` refuses a recorded value.
 *
 * It lives in memory, for one process. That is enough for what the demo identity is: a server
 * started with a random secret forgets every session when it stops, and so would this. A server
 * started with a fixed secret forgets the record too, and a copy taken before the restart works
 * again until its eight hours are up. A deployment that needed more would keep this in the
 * database, with a per-user epoch inside the signed value.
 *
 * A value is kept only until it would have expired anyway, and the record is bounded, so it cannot
 * grow without limit. Only values with a correct signature are ever recorded, so an anonymous
 * caller cannot fill it.
 */
export class SessionRevocations {
  private readonly until = new Map<string, number>();

  constructor(private readonly limit = 10_000) {}

  /** Records `value` as ended until `expiresAtMs`. Expired entries are dropped first. */
  revoke(value: string, expiresAtMs: number, nowMs: number): void {
    for (const [key, expiry] of this.until) if (expiry <= nowMs) this.until.delete(key);
    this.until.delete(value);
    this.until.set(value, expiresAtMs);
    // Map keeps insertion order, so the first key is the oldest.
    while (this.until.size > this.limit) {
      const oldest = this.until.keys().next();
      if (oldest.done === true) break;
      this.until.delete(oldest.value);
    }
  }

  /**
   * Takes `value` off the record. A session value is the same string for the same person in the
   * same second, so signing in again right after signing out issues the value that was just ended;
   * that sign-in is a fresh grant and must work.
   */
  release(value: string): void {
    this.until.delete(value);
  }

  isRevoked(value: string, nowMs: number): boolean {
    const expiry = this.until.get(value);
    if (expiry === undefined) return false;
    if (expiry <= nowMs) {
      this.until.delete(value);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.until.size;
  }
}
