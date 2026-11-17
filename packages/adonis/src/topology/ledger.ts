import { randomUUID } from 'node:crypto';
import type { WebhookEvent } from '../types.js';
import type { HubEventEnvelope, HubReplyMessage } from './protocol.js';

/**
 * What a gateway object is to the control plane. A customer is the payer (one per Hub account
 * and provider) and may be shared by several apps; every other kind belongs to exactly one app.
 */
export type TenantObjectKind = 'customer' | 'payment' | 'subscription' | 'checkout' | 'dispute';

/** The state of one call id, for replaying a retried call instead of running it twice. */
export type TenantCallState =
  /** First time this id is seen: the caller now holds it (`claim`) and runs the call. */
  | { state: 'new'; claim: string }
  /** Another attempt holds it and its lease has not expired yet. */
  | { state: 'running' }
  | { state: 'done'; reply: HubReplyMessage }
  /**
   * An earlier attempt took the id and never finished nor released it (the process died
   * mid-call) and its lease expired. The caller now holds it (`claim`) and must RECONCILE: re-run
   * only when the gateway deduplicates the call, else record an `indeterminate` answer.
   */
  | { state: 'stale'; claim: string };

/** Default lease of an in-flight call: longer than any gateway call is allowed to take. */
export const DEFAULT_CALL_LEASE_MS = 2 * 60 * 1000;

/**
 * The control plane's own bookkeeping: which app owns which gateway object, which forwarded
 * events each app still has to take, and the answers of calls already run (idempotency).
 *
 * Kept apart from the billing tables on purpose: the billing store stays the same contract in
 * every topology, and this ledger is the only thing that knows apps exist.
 */
export interface TenantLedger {
  /**
   * Record that `partition` owns a gateway object. Answers `false` (and records nothing) when a
   * single-owner kind already belongs to another app. A customer may have several apps.
   */
  claim(
    partition: string,
    kind: TenantObjectKind,
    gatewayId: string,
    provider: string,
  ): Promise<boolean>;
  /** The apps that own a gateway object (empty when none claimed it). */
  owners(kind: TenantObjectKind, gatewayId: string): Promise<string[]>;
  /** Queue a webhook event for an app. Queuing the same event twice is a no-op. */
  enqueue(partition: string, event: WebhookEvent): Promise<void>;
  /** The oldest events the app has not acknowledged yet. */
  pull(partition: string, limit: number): Promise<HubEventEnvelope[]>;
  /** Mark events delivered. Ids of another app are ignored. */
  ack(partition: string, seqs: readonly string[]): Promise<number>;
  /**
   * Claim a call id before running it. An in-flight claim older than `leaseMs` (default
   * {@link DEFAULT_CALL_LEASE_MS}) is taken over once, as `stale`.
   */
  beginCall(
    partition: string,
    id: string,
    options?: { leaseMs?: number },
  ): Promise<TenantCallState>;
  /**
   * Store a call's answer, so a retry of the same id gets it back. With `claim`, only while the
   * caller still holds the id (a run that outlived its lease does not overwrite its successor).
   */
  finishCall(partition: string, id: string, reply: HubReplyMessage, claim?: string): Promise<void>;
  /** Release a call id whose run failed, so a retry runs it again. `claim`: as in `finishCall`. */
  abandonCall(partition: string, id: string, claim?: string): Promise<void>;
  /**
   * Take a short-lived lock shared by every control-plane process (one gateway customer per
   * account). Answers the holder token, or `null` when someone else holds it. An expired lock is
   * taken over.
   */
  lock(key: string, leaseMs: number): Promise<string | null>;
  /** Release a lock this holder took. */
  unlock(key: string, holder: string): Promise<void>;
  /**
   * Delete delivered events, finished calls and abandoned in-flight calls (crashed runs) older
   * than `before`. Keep `before` far behind the call lease: a pruned id is a new id again.
   */
  prune(before: Date): Promise<{ events: number; calls: number }>;
  /** Undelivered events per app, for the console and the doctor. */
  backlog(): Promise<Record<string, number>>;
}

const SHARED_KINDS = new Set<TenantObjectKind>(['customer']);

/** Whether more than one app may own a gateway object of this kind. */
export function isSharedKind(kind: TenantObjectKind): boolean {
  return SHARED_KINDS.has(kind);
}

/** Plain JSON copy of a webhook event, the shape that travels to the tenant. */
export function serializeEvent(event: WebhookEvent): HubEventEnvelope['event'] {
  return JSON.parse(
    JSON.stringify({
      id: event.id,
      provider: event.provider,
      type: event.type,
      ...(event.createdAt !== undefined ? { createdAt: event.createdAt } : {}),
      data: event.data,
      raw: event.raw,
    }),
  ) as HubEventEnvelope['event'];
}

interface MemoryEvent {
  seq: number;
  partition: string;
  key: string;
  event: HubEventEnvelope['event'];
  createdAt: Date;
  deliveredAt: Date | null;
}

/**
 * An in-process ledger: for tests and for a single-process control plane that accepts losing the
 * queue on restart. Use {@link lucidTenantLedger} in production.
 */
export function memoryTenantLedger(): TenantLedger {
  const objects = new Map<string, { partitions: Set<string>; provider: string }>();
  const events: MemoryEvent[] = [];
  const keys = new Set<string>();
  const calls = new Map<
    string,
    { reply: HubReplyMessage | null; createdAt: Date; claim: string }
  >();
  const locks = new Map<string, { holder: string; expiresAt: number }>();
  let seq = 0;

  return {
    async claim(partition, kind, gatewayId, provider) {
      const key = `${kind}:${gatewayId}`;
      const entry = objects.get(key);
      if (entry === undefined) {
        objects.set(key, { partitions: new Set([partition]), provider });
        return true;
      }
      if (entry.partitions.has(partition)) return true;
      if (!isSharedKind(kind)) return false;
      entry.partitions.add(partition);
      return true;
    },
    async owners(kind, gatewayId) {
      return [...(objects.get(`${kind}:${gatewayId}`)?.partitions ?? [])];
    },
    async enqueue(partition, event) {
      const key = `${partition}|${event.provider}|${event.id}`;
      if (keys.has(key)) return;
      keys.add(key);
      seq += 1;
      events.push({
        seq,
        partition,
        key,
        event: serializeEvent(event),
        createdAt: new Date(),
        deliveredAt: null,
      });
    },
    async pull(partition, limit) {
      return events
        .filter((row) => row.partition === partition && row.deliveredAt === null)
        .slice(0, limit)
        .map((row) => ({ seq: String(row.seq), event: row.event }));
    },
    async ack(partition, seqs) {
      const wanted = new Set(seqs.map(String));
      let count = 0;
      for (const row of events) {
        if (row.partition !== partition || row.deliveredAt !== null) continue;
        if (!wanted.has(String(row.seq))) continue;
        row.deliveredAt = new Date();
        count += 1;
      }
      return count;
    },
    async beginCall(partition, id, options = {}) {
      const key = `${partition}|${id}`;
      const existing = calls.get(key);
      const claim = randomUUID();
      if (existing === undefined) {
        calls.set(key, { reply: null, createdAt: new Date(), claim });
        return { state: 'new', claim };
      }
      if (existing.reply !== null) return { state: 'done', reply: existing.reply };
      const leaseMs = options.leaseMs ?? DEFAULT_CALL_LEASE_MS;
      if (Date.now() - existing.createdAt.getTime() < leaseMs) return { state: 'running' };
      calls.set(key, { reply: null, createdAt: new Date(), claim });
      return { state: 'stale', claim };
    },
    async finishCall(partition, id, reply, claim) {
      const key = `${partition}|${id}`;
      const existing = calls.get(key);
      if (claim !== undefined && existing !== undefined && existing.claim !== claim) return;
      calls.set(key, { reply, createdAt: new Date(), claim: existing?.claim ?? claim ?? '' });
    },
    async abandonCall(partition, id, claim) {
      const key = `${partition}|${id}`;
      const existing = calls.get(key);
      if (existing === undefined || existing.reply !== null) return;
      if (claim !== undefined && existing.claim !== claim) return;
      calls.delete(key);
    },
    async lock(key, leaseMs) {
      const now = Date.now();
      const held = locks.get(key);
      if (held !== undefined && held.expiresAt > now) return null;
      const holder = randomUUID();
      locks.set(key, { holder, expiresAt: now + leaseMs });
      return holder;
    },
    async unlock(key, holder) {
      if (locks.get(key)?.holder === holder) locks.delete(key);
    },
    async prune(before) {
      let removedEvents = 0;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const row = events[index] as MemoryEvent;
        if (row.deliveredAt !== null && row.createdAt < before) {
          events.splice(index, 1);
          keys.delete(row.key);
          removedEvents += 1;
        }
      }
      let removedCalls = 0;
      for (const [key, call] of calls) {
        if (call.createdAt < before) {
          calls.delete(key);
          removedCalls += 1;
        }
      }
      return { events: removedEvents, calls: removedCalls };
    },
    async backlog() {
      const out: Record<string, number> = {};
      for (const row of events) {
        if (row.deliveredAt !== null) continue;
        out[row.partition] = (out[row.partition] ?? 0) + 1;
      }
      return out;
    },
  };
}
