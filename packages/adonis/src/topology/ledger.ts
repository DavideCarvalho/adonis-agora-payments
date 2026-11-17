import type { WebhookEvent } from '../types.js';
import type { HubEventEnvelope, HubReplyMessage } from './protocol.js';

/**
 * What a gateway object is to the control plane. A customer is the payer (one per Hub account
 * and provider) and may be shared by several apps; every other kind belongs to exactly one app.
 */
export type TenantObjectKind = 'customer' | 'payment' | 'subscription' | 'checkout' | 'dispute';

/** The state of one call id, for replaying a retried call instead of running it twice. */
export type TenantCallState =
  | { state: 'new' }
  | { state: 'running' }
  | { state: 'done'; reply: HubReplyMessage };

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
  /** Claim a call id before running it. */
  beginCall(partition: string, id: string): Promise<TenantCallState>;
  /** Store a call's successful answer, so a retry of the same id gets it back. */
  finishCall(partition: string, id: string, reply: HubReplyMessage): Promise<void>;
  /** Release a call id whose run failed, so a retry runs it again. */
  abandonCall(partition: string, id: string): Promise<void>;
  /** Delete delivered events and finished calls older than `before`. */
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
  const calls = new Map<string, { reply: HubReplyMessage | null; createdAt: Date }>();
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
    async beginCall(partition, id) {
      const key = `${partition}|${id}`;
      const existing = calls.get(key);
      if (existing === undefined) {
        calls.set(key, { reply: null, createdAt: new Date() });
        return { state: 'new' };
      }
      return existing.reply === null
        ? { state: 'running' }
        : { state: 'done', reply: existing.reply };
    },
    async finishCall(partition, id, reply) {
      calls.set(`${partition}|${id}`, { reply, createdAt: new Date() });
    },
    async abandonCall(partition, id) {
      calls.delete(`${partition}|${id}`);
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
        if (call.reply !== null && call.createdAt < before) {
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
