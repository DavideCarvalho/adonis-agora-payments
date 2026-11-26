import { describe, expect, it } from 'vitest';
import { AttemptLimiter } from '../src/account_console/tokenize_endpoint.js';

const keys = (ticket: string, ip = '1.1.1.1', expiresAt = 10_000) =>
  [
    [`ticket:${ticket}`, 2, expiresAt],
    ['customer:asaas:c', 5, expiresAt],
    [`ip:${ip}`, 5, expiresAt],
  ] as const;

describe('card tokenize attempt limiter', () => {
  it('checks the counts before recording: a refused attempt costs the other counters nothing', () => {
    const limiter = new AttemptLimiter();
    expect(limiter.spend(keys('t1'), 0)).toBe(true);
    expect(limiter.spend(keys('t1'), 0)).toBe(true);
    // The ticket is spent: hammering it records nothing against the customer or the IP.
    for (let i = 0; i < 50; i++) expect(limiter.spend(keys('t1'), 0)).toBe(false);
    // So the customer still has its 3 remaining attempts on a fresh ticket.
    expect(limiter.spend(keys('t2'), 0)).toBe(true);
    expect(limiter.spend(keys('t2'), 0)).toBe(true);
    expect(limiter.spend(keys('t3'), 0)).toBe(true);
    expect(limiter.spend(keys('t3'), 0)).toBe(false);
    expect(limiter.size).toBe(5);
  });

  it('treats an expired counter as gone, and sweeps expired ones without a scan per request', () => {
    const limiter = new AttemptLimiter({ sweepEveryMs: 1_000 });
    expect(limiter.spend(keys('t1', '1.1.1.1', 100), 0)).toBe(true);
    expect(limiter.spend(keys('t1', '1.1.1.1', 100), 0)).toBe(true);
    expect(limiter.spend(keys('t1', '1.1.1.1', 100), 50)).toBe(false);
    // Past its expiry the ticket reads as fresh even before a sweep removed it.
    expect(limiter.spend(keys('t1', '1.1.1.1', 2_000), 200)).toBe(true);
    expect(limiter.spend(keys('t9', '9.9.9.9', 300), 200)).toBe(true);
    expect(limiter.size).toBe(5);
    // The next sweep (one per second here) drops what expired (t9 and 9.9.9.9).
    limiter.spend([['ip:x', 5, 5_000]], 1_500);
    expect(limiter.size).toBe(4);
  });

  it('never holds more than maxEntries, and refuses a new key rather than letting it uncounted', () => {
    const limiter = new AttemptLimiter({ maxEntries: 3 });
    expect(limiter.spend(keys('t1'), 0)).toBe(true);
    expect(limiter.size).toBe(3);
    // A new ticket needs a new counter: no room, so it is refused, and nothing is recorded.
    expect(limiter.spend(keys('t2'), 0)).toBe(false);
    expect(limiter.size).toBe(3);
    // Known keys keep working.
    expect(limiter.spend(keys('t1'), 0)).toBe(true);
    // Once the live ones expire, the room comes back.
    expect(limiter.spend(keys('t2', '1.1.1.1', 50_000), 20_000)).toBe(true);
    expect(limiter.size).toBe(3);
  });
});
