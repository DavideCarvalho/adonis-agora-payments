import type { BillingStore, CustomerListItem } from '../billing/billing_store.js';

/**
 * What a federated payments console may see of another app, and how it is masked.
 *
 * The console (the Hub's) reads the owning app's billing tables straight from its database and
 * receives the answers of the actions it asks the app to run. Neither path may carry a gateway
 * credential, a webhook secret, a raw gateway payload, a full document number or card/PIX data:
 *
 * - {@link readOnlyBillingStore} hands the console only the store's read methods, and masks the
 *   customer's document number at the row;
 * - {@link federatedSafe} walks every answer (a read on the console side, an action's answer on
 *   the owning app's side, before it is published on Redis) and masks or drops what may not leave.
 */

/** A store method a federated console may call: reads, counts and aggregates. */
const READ_METHOD =
  /^(find|list|count)[A-Z]|^(revenue|netRevenue|subscriptionAmountByCycle|webhookEventBreakdown|usageReport)$/;

/** A write refused on another app's store. */
export class ReadOnlyStoreError extends Error {
  constructor(method: string) {
    super(
      `[@adonis-agora/payments] another app's billing store is read-only in this console (${method}): its actions are sent to that app`,
    );
    this.name = 'ReadOnlyStoreError';
  }
}

/**
 * `store` as a federated console may touch it: every read, count and aggregate, with the
 * customer's document number masked at the row; every write (`save*`, `record*`, `mark*`,
 * `create*`, `update*`…) throws {@link ReadOnlyStoreError}. Nothing the console reads is recorded in
 * that app's audit trail (it cannot write there); every action is, by the app itself.
 */
export function readOnlyBillingStore(store: BillingStore): BillingStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const name = String(property);
      if (!READ_METHOD.test(name)) {
        return () => {
          throw new ReadOnlyStoreError(name);
        };
      }
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        return /Customer/.test(name) ? maskCustomers(result) : result;
      };
    },
  }) as BillingStore;
}

/** A customer row (or a list of them) with its document number masked. */
function maskCustomers(result: unknown): unknown {
  if (Array.isArray(result)) return result.map((row) => maskCustomers(row));
  if (!result || typeof result !== 'object') return result;
  const row = result as Partial<CustomerListItem> & Record<string, unknown>;
  if (!('taxId' in row)) return result;
  // A view, not a copy and not a write: a Lucid model keeps its methods, and the owning app's row
  // (an in-memory store hands out its own objects) is never changed.
  return new Proxy(row, {
    get(target, property, receiver) {
      if (property === 'taxId') return maskDocument(Reflect.get(target, property, receiver));
      if (property === 'toJSON' || property === 'serialize') {
        const fn = Reflect.get(target, property, receiver);
        if (typeof fn !== 'function') return fn;
        return (...args: unknown[]) => {
          const out = fn.apply(target, args) as Record<string, unknown>;
          return out && typeof out === 'object' && 'taxId' in out
            ? { ...out, taxId: maskDocument(out.taxId) }
            : out;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * A document number partially masked: a CPF shows its middle six digits (`***.456.789-**`, the
 * usual way a Brazilian receipt prints it), a CNPJ its root (`12.345.678/****-**`, the company,
 * public anyway), anything else its last 2 characters.
 */
export function maskDocument(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  if (raw === '') return '';
  // Already masked (the row was, then the answer is): keep it as it is.
  if (raw.includes('*')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11) return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  if (digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/****-**`;
  }
  const visible = raw.length > 4 ? raw.slice(-2) : '';
  return `${'*'.repeat(Math.max(raw.length - visible.length, 3))}${visible}`;
}

/** Keys whose value never leaves the owning app: credentials, raw payloads, card and PIX data. */
const DROPPED_KEY =
  /^(payload|raw|normalized|headers|signature|secret|.*secret|.*apikey|.*api_key|.*token|.*password|authorization|credentials?|cvv|cvc|pan|cardnumber|card_number|number|expiry|exp_?month|exp_?year|pix_?key|pixcopiaecola|brcode|br_code|emv|qr_?code.*|encodedimage|.*payload)$/i;

/** Keys that hold a document number. */
const DOCUMENT_KEY = /^(taxid|tax_id|document|documentnumber|cpf|cnpj|cpfcnpj|cpf_cnpj)$/i;

/** Keys that hold a payment method (reduced to brand + last 4). */
const CARD_KEY = /^(card|creditcard|credit_card|paymentmethod|payment_method|method_details)$/i;

/** A run of 13–19 digits (spaces/dashes allowed) that passes Luhn: a card number. */
const CARD_NUMBER = /\b\d(?:[ -]?\d){12,18}\b/g;

/** A PIX "copia e cola" (EMV) code. */
const PIX_EMV = /000201\d{2}[0-9A-Za-z.\-/:@*+ ]{20,}/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A string with any card number reduced to its last 4 and any PIX code dropped. */
function safeString(value: string): string {
  return value
    .replace(CARD_NUMBER, (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 13 && luhn(digits) ? `•••• ${digits.slice(-4)}` : match;
    })
    .replace(PIX_EMV, '[pix code redacted]');
}

/** A payment method as brand + last 4, whatever shape the gateway gave it. */
function cardSummary(value: unknown): { brand: string | null; last4: string | null } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return { brand: null, last4: null };
  const card = value as Record<string, unknown>;
  const inner =
    card.card && typeof card.card === 'object' ? (card.card as Record<string, unknown>) : card;
  const brand = [inner.brand, inner.creditCardBrand, inner.network].find(
    (b) => typeof b === 'string' && b !== '',
  ) as string | undefined;
  const last4Raw = [inner.last4, inner.lastFour, inner.creditCardNumber, inner.number].find(
    (n) => typeof n === 'string' || typeof n === 'number',
  );
  const last4 = last4Raw === undefined ? null : String(last4Raw).replace(/\D/g, '').slice(-4);
  return { brand: brand ?? null, last4: last4 === '' ? null : last4 };
}

/**
 * `value` as it may leave the owning app: document numbers masked, payment methods reduced to
 * brand + last 4, card numbers in free text reduced to their last 4, PIX codes, raw payloads,
 * headers, signatures and anything named like a credential dropped. Plain JSON in, plain JSON out
 * (dates become ISO strings, as on the wire).
 */
export function federatedSafe<T>(value: T): T {
  return walk(JSON.parse(JSON.stringify(value ?? null)), 0) as T;
}

/** An identifier: never scanned for card numbers (a numeric gateway id may pass Luhn). */
const ID_KEY = /(^id$|Id$|_id$|Ids$|^cursor$|Cursor$)/;

function walk(value: unknown, depth: number, key?: string): unknown {
  if (depth > 32) return null;
  if (typeof value === 'string') {
    return key !== undefined && ID_KEY.test(key) ? value : safeString(value);
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, key));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (DOCUMENT_KEY.test(key)) {
      out[key] =
        typeof inner === 'string' || typeof inner === 'number' ? maskDocument(inner) : null;
    } else if (CARD_KEY.test(key)) {
      out[key] = cardSummary(inner);
    } else if (DROPPED_KEY.test(key)) {
      // Dropped, not emptied: a reader must not mistake `""` for "the gateway sent nothing".
    } else {
      out[key] = walk(inner, depth + 1, key);
    }
  }
  return out;
}

/**
 * Whether `granted` (a console viewer's capabilities) allows `needed`: an exact match, `'*'`, or a
 * `prefix:*` wildcard covering it (`payments:*`, `payments:subscriptions:*`).
 */
export function capabilityAllows(granted: readonly string[] | undefined, needed: string): boolean {
  if (!granted) return false;
  for (const capability of granted) {
    if (capability === '*' || capability === needed) return true;
    if (capability.endsWith(':*') && needed.startsWith(capability.slice(0, -1))) return true;
  }
  return false;
}
