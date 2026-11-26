import type { PaymentsDriver } from '../driver.js';
import { sealCardToken, verifyCardTicket } from './card_ticket.js';

/** What the tokenize endpoint answers. */
export interface CardTokenizeResponse {
  status: number;
  body: { token: string; last4?: string; brand?: string } | { error: string };
}

/** Attempts one ticket may make: enough to fix a typo. */
const MAX_PER_TICKET = 5;
/** Attempts per customer, and per IP, in a window: fresh tickets do not reset these. */
const MAX_PER_WINDOW = 10;
const WINDOW_MS = 60 * 60_000;

/**
 * Attempt counters, in this process (behind several instances each one keeps its own).
 *
 * - The counts are checked BEFORE anything is recorded: a refused attempt costs nothing and
 *   grows nothing, so hammering a spent ticket neither inflates the customer's and the IP's
 *   counters nor the map.
 * - Expired entries are swept at most once per `sweepEveryMs` (and when the map is full), not
 *   on every request; an expired entry still in the map reads as absent.
 * - The map holds at most `maxEntries` counters. When it is full of live ones, a NEW key is
 *   refused (fail closed: this guards a card-testing endpoint), never let through uncounted.
 */
export class AttemptLimiter {
  readonly #entries = new Map<string, { count: number; expiresAt: number }>();
  readonly #maxEntries: number;
  readonly #sweepEveryMs: number;
  #nextSweep = 0;

  constructor(options: { maxEntries?: number; sweepEveryMs?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 50_000;
    this.#sweepEveryMs = options.sweepEveryMs ?? 60_000;
  }

  get size(): number {
    return this.#entries.size;
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(key);
    this.#nextSweep = now + this.#sweepEveryMs;
  }

  #live(key: string, now: number): { count: number; expiresAt: number } | undefined {
    const entry = this.#entries.get(key);
    return entry !== undefined && entry.expiresAt > now ? entry : undefined;
  }

  /**
   * Records one attempt against every `[key, max, expiresAt]` when none of them is spent;
   * answers `false` (recording nothing) when one is, or when there is no room to count it.
   */
  spend(keys: ReadonlyArray<readonly [string, number, number]>, now: number): boolean {
    if (now >= this.#nextSweep) this.#sweep(now);
    for (const [key, max] of keys) {
      if ((this.#live(key, now)?.count ?? 0) >= max) return false;
    }
    const fresh = keys.filter(([key]) => this.#live(key, now) === undefined).length;
    if (this.#entries.size + fresh > this.#maxEntries) {
      this.#sweep(now);
      if (this.#entries.size + fresh > this.#maxEntries) return false;
    }
    for (const [key, , expiresAt] of keys) {
      const entry = this.#live(key, now);
      if (entry) entry.count += 1;
      else this.#entries.set(key, { count: 1, expiresAt });
    }
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#nextSweep = 0;
  }
}

const attempts = new AttemptLimiter();

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null;
const digits = (value: unknown, min: number, max: number) => {
  if (typeof value !== 'string') return null;
  const only = value.replace(/\D/g, '');
  return only.length >= min && only.length <= max ? only : null;
};

/**
 * `POST <accountConsole.path>/card/tokenize`: the card form of gateways that tokenize on the
 * server (Asaas). The request carries the page's signed ticket in `x-payments-card-ticket` and the
 * card as JSON; the answer is the gateway token, sealed for the customer, which the form then
 * submits to the account console. Nothing about the card is stored or logged.
 */
export async function handleCardTokenize(
  request: { header(name: string): string | null | undefined; body: unknown; ip: string },
  deps: {
    driver: (provider: string) => Promise<PaymentsDriver | undefined>;
    secret: string;
    now?: () => number;
  },
): Promise<CardTokenizeResponse> {
  const now = (deps.now ?? Date.now)();
  const raw = request.header('x-payments-card-ticket');
  const ticket = verifyCardTicket(deps.secret, raw, now);
  if (ticket === null || typeof raw !== 'string') {
    return { status: 401, body: { error: 'invalid or expired ticket' } };
  }
  const allowed = attempts.spend(
    [
      [`ticket:${raw}`, MAX_PER_TICKET, ticket.expiresAt],
      [`customer:${ticket.provider}:${ticket.customerId}`, MAX_PER_WINDOW, now + WINDOW_MS],
      [`ip:${request.ip}`, MAX_PER_WINDOW, now + WINDOW_MS],
    ],
    now,
  );
  if (!allowed) {
    return { status: 429, body: { error: 'too many attempts' } };
  }
  const driver = await deps.driver(ticket.provider);
  if (driver === undefined || typeof driver.tokenizeCard !== 'function') {
    return { status: 404, body: { error: 'this gateway does not tokenize cards here' } };
  }
  const body = (request.body ?? {}) as Record<string, unknown>;
  const holder = (body.holder ?? {}) as Record<string, unknown>;
  const expiry = typeof body.expiry === 'string' ? body.expiry.replace(/\s/g, '') : '';
  const [month, year] = expiry.split('/');
  const card = {
    holderName: text(body.holderName, 120),
    number: digits(body.number, 12, 19),
    expiryMonth: digits(month, 1, 2)?.padStart(2, '0') ?? null,
    expiryYear: digits(year, 2, 4),
    ccv: digits(body.cvc, 3, 4),
  };
  const person = {
    name: text(holder.name, 120) ?? card.holderName,
    email: text(holder.email, 254),
    cpfCnpj: digits(holder.cpfCnpj, 11, 14),
    postalCode: digits(holder.postalCode, 8, 8),
    addressNumber: text(holder.addressNumber, 20),
    phone: digits(holder.phone, 10, 13),
  };
  if (
    Object.values(card).some((v) => v === null) ||
    Object.values(person).some((v) => v === null)
  ) {
    return { status: 422, body: { error: 'missing or invalid card details' } };
  }
  const expiryYear = card.expiryYear!.length === 2 ? `20${card.expiryYear}` : card.expiryYear!;
  try {
    const tokenized = await driver.tokenizeCard({
      customerId: ticket.customerId,
      card: {
        holderName: card.holderName!,
        number: card.number!,
        expiryMonth: card.expiryMonth!,
        expiryYear,
        ccv: card.ccv!,
      },
      holder: {
        name: person.name!,
        email: person.email!,
        cpfCnpj: person.cpfCnpj!,
        postalCode: person.postalCode!,
        addressNumber: person.addressNumber!,
        phone: person.phone!,
      },
      remoteIp: request.ip,
    });
    return {
      status: 200,
      body: {
        token: sealCardToken(
          deps.secret,
          JSON.stringify({ t: tokenized.token, ip: request.ip, e: ticket.expiresAt }),
          ticket.customerId,
        ),
        last4: tokenized.last4,
        brand: tokenized.brand,
      },
    };
  } catch {
    // The gateway's message may echo card details: never pass it on.
    return { status: 422, body: { error: 'the card was refused' } };
  }
}

/** Test hook: forget the per-ticket attempt counts. */
export function resetCardTokenizeAttempts(): void {
  attempts.clear();
}
