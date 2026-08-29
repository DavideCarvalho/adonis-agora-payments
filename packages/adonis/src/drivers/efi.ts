import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { EfiDriverConfig } from '../define_config.js';
import { publishPaymentDiagnostics, publishRefundDiagnostics } from '../diagnostics.js';
import type {
  ChargeInput,
  CheckoutInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  PaymentsDriver,
  UpdateCustomerInput,
  UpdateSubscriptionInput,
  WebhookVerificationState,
} from '../driver.js';
import { httpRequest, isNotFound } from '../http.js';
import { emitInvoiceIfRequested } from '../invoice/emit_invoice.js';
import type { EmitInvoiceContext } from '../invoice/emit_invoice.js';
import { formatDecimal, fromDecimal } from '../money.js';
import type {
  CheckoutSession,
  Customer,
  Invoice,
  Money,
  Payment,
  Refund,
  Subscription,
  WebhookEvent,
} from '../types.js';
import { requireCredential } from './shared.js';

/** A Pix charge (`cob`) as the Efí/BACEN Pix API returns it. */
interface EfiCob {
  txid: string;
  revisao?: number;
  status: 'ATIVA' | 'CONCLUIDA' | 'REMOVIDA_PELO_USUARIO_RECEBEDOR' | 'REMOVIDA_PELO_PSP';
  calendario?: { criacao?: string; expiracao?: number };
  devedor?: { nome?: string; cpf?: string; cnpj?: string };
  valor: { original: string };
  chave?: string;
  loc?: { id?: number; location?: string; tipoCob?: string };
  location?: string;
  pixCopiaECola?: string;
  solicitacaoPagador?: string;
  pix?: Array<{
    endToEndId: string;
    txid?: string;
    valor: string;
    horario?: string;
    devolucoes?: Array<{
      id: string;
      rtrId?: string;
      valor: string;
      status: string;
      natureza?: string;
    }>;
  }>;
}

/** The `GET /v2/loc/:id/qrcode` response (an Efí extension over the BACEN spec). */
interface EfiLocQrCode {
  qrcode?: string;
  /** A full data URI (`data:image/png;base64,…`), not bare base64. */
  imagemQrcode?: string;
  linkVisualizacao?: string;
}

/** The `PUT /v2/pix/:e2eid/devolucao/:id` response. */
interface EfiDevolucao {
  id: string;
  rtrId?: string;
  valor: string;
  horario?: { solicitacao?: string };
  status: 'EM_PROCESSAMENTO' | 'DEVOLVIDO' | 'NAO_REALIZADO';
}

interface EfiTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/** One received Pix, as Efí posts it to the webhook. */
interface EfiPixNotification {
  endToEndId: string;
  txid?: string;
  chave?: string;
  valor: string;
  horario?: string;
  infoPagador?: string;
  devolucoes?: Array<{
    id: string;
    valor: string;
    status: string;
    /**
     * BACEN's `DevolucaoNatureza`: `ORIGINAL` and `RETIRADA` are a refund the RECEIVER
     * asked for; `MED_OPERACIONAL`, `MED_FRAUDE` and `MED_PIX_AUTOMATICO` are a return
     * executed under the Banco Central's MED — money leaving without the merchant
     * agreeing to it. Optional: the API Pix spec says an absent `natureza` means
     * `ORIGINAL`.
     */
    natureza?: string;
    motivo?: string;
  }>;
}

/**
 * A `devolução` executed under BACEN's MED (Mecanismo Especial de Devolução) rather than
 * asked for by the merchant. The API Pix `natureza` enum has three of them —
 * `MED_OPERACIONAL` (operational failure), `MED_FRAUDE` (founded suspicion of fraud) and
 * `MED_PIX_AUTOMATICO` — and every other value (`ORIGINAL`, `RETIRADA`, or nothing) is a
 * refund the merchant chose to make.
 */
function isMedDevolucao(devolucao: { natureza?: string }): boolean {
  return devolucao.natureza?.startsWith('MED') === true;
}

/** Renew a token this many seconds before it actually expires. */
const TOKEN_RENEWAL_SKEW_SECONDS = 60;
/** What Efí's `/oauth/token` returns today; used only when a response omits `expires_in`. */
const TOKEN_FALLBACK_TTL_SECONDS = 3600;

/**
 * Efí (formerly Gerencianet) driver — the **Pix API** (`pix.api.efipay.com.br`).
 *
 * Efí sells several APIs behind one brand and they do not share an auth model. This driver
 * speaks the **Pix API** only: immediate charges (`cob`), the Pix that settle them and
 * their refunds (`devolução`). The **Cobranças API** (`cobrancas.api.efipay.com.br`) is a
 * different product — boleto, card, carnê and native subscriptions, OAuth **without** a
 * certificate — and none of it is reachable from here. If you need boleto or recurring
 * billing from Efí, that is a second driver, not a config flag.
 *
 * Two consequences worth knowing before you configure it:
 *
 * - **Mutual TLS is mandatory**, including on the token request. A client certificate is a
 *   property of the TLS connection, not a header, so it cannot be handed to `httpRequest`
 *   the way an API key can. The driver builds its own certificate-bearing `fetch` over
 *   `node:https` and passes it through the helper's `fetch` seam — no extra dependency,
 *   but you must supply the `.p12` Efí generated for you, or your own `fetch`.
 * - **The access token expires** (an hour today). It is cached against the `expires_in`
 *   the gateway actually returned, minus a minute, so the cache can never outlive the
 *   token; a 401 also drops it and retries once.
 */
export class EfiDriver implements PaymentsDriver {
  readonly provider = 'efi';
  // Pix only. Not `'undefined'` either: there is no "payer picks a method" on this API.
  readonly supportedMethods = ['pix'] as const;
  readonly capabilities = { refunds: true, invoices: false, subscriptions: false };

  #baseUrl: string;
  #basicAuth: string;
  #pixKey: string;
  #fetch: typeof globalThis.fetch;
  #invoiceCtx: EmitInvoiceContext;
  #expirationSeconds: number;
  /** Cached OAuth token. `expiresAt` is an epoch ms deadline, never a fixed lifetime. */
  #token: { value: string; expiresAt: number } | undefined;
  /** In-flight token request, so concurrent charges don't each mint a token. */
  #tokenInFlight: Promise<string> | undefined;

  constructor(ctx: EmitInvoiceContext, config: EfiDriverConfig = {}) {
    this.#invoiceCtx = ctx;
    const clientId = requireCredential({
      driver: 'efi',
      option: 'clientId',
      env: 'EFI_CLIENT_ID',
      value: config.clientId,
    });
    const clientSecret = requireCredential({
      driver: 'efi',
      option: 'clientSecret',
      env: 'EFI_CLIENT_SECRET',
      value: config.clientSecret,
    });
    // Not a credential, but the same rule applies: the Pix API refuses a `cob` without the
    // key that receives it, and boot is the last honest place to notice.
    this.#pixKey = requireCredential({
      driver: 'efi',
      option: 'pixKey',
      env: 'EFI_PIX_KEY',
      value: config.pixKey,
    });
    this.#basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const sandbox = config.sandbox ?? process.env.NODE_ENV !== 'production';
    this.#baseUrl = sandbox ? 'https://pix-h.api.efipay.com.br' : 'https://pix.api.efipay.com.br';
    this.#expirationSeconds = config.expirationSeconds ?? 3600;
    this.#fetch = config.fetch ?? mtlsFetch(config);
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(_input: CreateCustomerInput): Promise<Customer> {
    throw new Error(
      "[payments] Efí's Pix API has no customer resource — the payer (`devedor`) is sent inline on each charge. " +
        'Pass `customer: { name, taxId }` on the charge and keep the mapping in your own table.',
    );
  }

  async findCustomer(_customerId: string): Promise<Customer | null> {
    throw new Error(
      "[payments] Efí's Pix API has no customer resource to look up — the payer lives on the charge.",
    );
  }

  async updateCustomer(_customerId: string, _input: UpdateCustomerInput): Promise<Customer> {
    throw new Error(
      "[payments] Efí's Pix API has no customer resource to update — the payer is sent with every charge.",
    );
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    if (input.method !== undefined && input.method !== 'pix') {
      throw new Error(
        `[payments] Efí's Pix API only settles Pix; this driver cannot create a "${input.method}" charge. Boleto and card are the Cobranças API, a different Efí product.`,
      );
    }
    const payer = this.#payer(input);
    const body: Record<string, unknown> = {
      calendario: { expiracao: this.#expiration(input) },
      valor: { original: toAmountString(input.amount) },
      chave: this.#pixKey,
      ...(payer !== undefined ? { devedor: payer } : {}),
      ...(input.description !== undefined
        ? { solicitacaoPagador: input.description.slice(0, 140) }
        : {}),
    };

    // The txid is the ONLY id Efí echoes on the webhook, so when the app's reference fits
    // the txid charset it becomes the txid — and the webhook routes itself. When it does
    // not fit, Efí generates one and the app must persist the returned `gatewayId`.
    const reference = input.externalReference ?? input.idempotencyKey;
    const cob =
      reference !== undefined && isValidTxid(reference)
        ? await this.#request<EfiCob>(`/v2/cob/${reference}`, { method: 'PUT', body })
        : await this.#request<EfiCob>('/v2/cob', { method: 'POST', body });

    const payment = this.#mapCob(cob);
    await this.#attachQrCode(payment, cob);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const cob = await this.#request<EfiCob>(`/v2/cob/${gatewayId}`);
      return this.#mapCob(cob);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * `options.idempotencyKey` becomes the **devolução id** — Efí's refund is a `PUT` to
   * `/v2/pix/{e2eid}/devolucao/{id}`, so the id you choose *is* the deduplication: a retry
   * with the same one returns the first refund instead of sending the money twice. Without
   * a key the driver mints a random id, which protects a retry inside one call and nothing
   * across process restarts, so pass one if you retry.
   */
  async refund(
    paymentGatewayId: string,
    amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund> {
    // A Pix refund is made against the settled Pix (its endToEndId), not against the
    // charge — so a txid has to be resolved to the Pix that paid it first.
    const { endToEndId, paidValue } = await this.#resolveSettledPix(paymentGatewayId);
    const value = amount !== undefined ? toAmountString(amount) : paidValue;
    // Efí requires an id for the refund itself (max 35 chars, alphanumeric); it is also
    // the idempotency key on their side, so a retry with the same id is not a second refund.
    const refundId =
      idempotencyKeyAsRefundId(options?.idempotencyKey) ?? randomUUID().replace(/-/g, '');
    const data = await this.#request<EfiDevolucao>(`/v2/pix/${endToEndId}/devolucao/${refundId}`, {
      method: 'PUT',
      body: { valor: value },
    });
    const refund: Refund = {
      id: data.id ?? refundId,
      gatewayId: data.rtrId ?? data.id ?? refundId,
      provider: this.provider,
      amount: { amount: fromDecimal(Number(data.valor ?? value)), currency: 'brl' },
      status:
        data.status === 'DEVOLVIDO'
          ? 'succeeded'
          : data.status === 'NAO_REALIZADO'
            ? 'failed'
            : 'pending',
      createdAt: data.horario?.solicitacao ?? new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    // There is no hosted page: a Pix charge is a BR Code the payer copies or scans, so
    // `url` stays empty rather than pointing at something Efí does not host.
    const body: Record<string, unknown> = {
      calendario: { expiracao: this.#expirationSeconds },
      valor: { original: toAmountString(input.amount) },
      chave: this.#pixKey,
      ...(input.description !== undefined
        ? { solicitacaoPagador: input.description.slice(0, 140) }
        : {}),
    };
    // The txid is the only reference Efí echoes on the webhook, so a checkout reference
    // that fits the txid charset becomes the txid — exactly as on a charge.
    const reference = input.externalReference ?? input.idempotencyKey;
    const cob =
      reference !== undefined && isValidTxid(reference)
        ? await this.#request<EfiCob>(`/v2/cob/${reference}`, { method: 'PUT', body })
        : await this.#request<EfiCob>('/v2/cob', { method: 'POST', body });
    return {
      id: cob.txid,
      gatewayId: cob.txid,
      provider: this.provider,
      url: '',
      status: cob.status === 'CONCLUIDA' ? 'complete' : 'open',
      amount: { amount: input.amount, currency: 'brl' },
      ...(cob.pixCopiaECola !== undefined
        ? { pixCode: cob.pixCopiaECola, pixCopiaECola: cob.pixCopiaECola }
        : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(_input: CreateSubscriptionInput): Promise<Subscription> {
    throw new Error(
      "[payments] Efí's Pix API has no subscriptions. Recurring billing is either the Cobranças API " +
        '(`/v1/subscription`) or Pix Automático (`/v2/rec`) — both different products with different scopes, ' +
        'neither of which this driver speaks.',
    );
  }

  async cancelSubscription(
    _subscriptionGatewayId: string,
    _options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    throw new Error("[payments] Efí's Pix API has no subscriptions to cancel.");
  }

  async updateSubscription(
    _subscriptionGatewayId: string,
    _input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    throw new Error("[payments] Efí's Pix API has no subscriptions to update.");
  }

  async findSubscription(_gatewayId: string): Promise<Subscription | null> {
    throw new Error("[payments] Efí's Pix API has no subscriptions to look up.");
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  /**
   * Throws, and deliberately does not return `[]`. An empty list is indistinguishable from
   * "this customer has no invoices", which is the silent shape this package keeps removing:
   * the caller reads zero rows and concludes the customer never bought anything.
   * `capabilities.invoices` is `false`, so `PaymentsManager` already stops the documented
   * path — this message is for whoever reached the driver directly.
   */
  async listInvoices(_customerId: string): Promise<Invoice[]> {
    // Pix charges are indexed by txid and by date range, never by payer — there is no
    // per-customer list to return, and no invoice concept at all.
    throw new Error(
      "[payments] Efí's Pix API has no invoices to list — a Pix charge (`cob`) is indexed " +
        'by txid and by date range, never by payer, and the API has no invoice resource at ' +
        'all. Configure an `invoice` provider and pass `invoice: true` on the charge to ' +
        'emit a nota fiscal, or list charges yourself with `GET /v2/cob` over a date range.',
    );
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Point Efí's Pix notifications at `url` for the configured key.
   *
   * Efí appends `/pix` to whatever you register unless the URL ends with `?ignorar=`, and
   * it expects your endpoint to present a certificate (mTLS) unless you say otherwise —
   * hence `skipMtls`, which sets `x-skip-mtls-checking`. When you skip it, the only thing
   * left guarding the endpoint is the `hmac` query parameter you put in `url` and the
   * source IP; see the provider docs page.
   */
  async registerPixWebhook(url: string, options: { skipMtls?: boolean } = {}): Promise<void> {
    await this.#request(`/v2/webhook/${encodeURIComponent(this.#pixKey)}`, {
      method: 'PUT',
      body: { webhookUrl: url },
      ...(options.skipMtls === true ? { headers: { 'x-skip-mtls-checking': 'true' } } : {}),
    });
  }

  /**
   * Normalize an Efí Pix notification into one event per Pix in the delivery.
   *
   * **Batches.** The body's `pix` key is an array. Efí's reference shows one entry in every
   * example and never states a maximum, and in practice one notification carries one Pix —
   * but the shape is a list, so this reads all of it and returns one {@link WebhookEvent}
   * per entry. A single entry still returns a single event, not an array of one. Efí retries
   * a non-2xx up to 9 times on a progressive backoff, which is what makes the route's
   * "any failure means a non-2xx" answer actually redeliver a Pix that failed to process.
   */
  /**
   * Whether a delivery to `POST /payments/webhook/:provider` can be authenticated.
   *
   * Efí's Pix callback carries no signature at all: authenticity comes from the mutual-TLS
   * handshake at your edge, or from an `hmac` QUERY parameter this method never sees. There is
   * nothing to configure, so there is nothing for the boot check to demand.
   */
  get webhookVerification(): WebhookVerificationState {
    return 'unsupported';
  }

  parseWebhook(
    rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent | WebhookEvent[] {
    // NOTHING IS VERIFIED HERE, and that is not an oversight. Efí's Pix notification
    // carries no signature header: authenticity is meant to come from the mutual TLS
    // handshake at your edge, or from an `hmac` query parameter — and a query parameter is
    // part of the URL, which this method never sees (the route hands it the body and the
    // headers only). See the Efí provider docs for where to enforce it instead.
    //
    // Note what this means for a batch: with nothing signing the body, there is no per-entry
    // signature to check either, so unlike Adyen there is no per-item verification to get
    // right — the whole delivery is as trusted as the transport that carried it, and no more.
    let payload: { pix?: unknown; evento?: unknown };
    try {
      payload = JSON.parse(rawBody) as { pix?: unknown; evento?: unknown };
    } catch {
      throw new Error('[payments] Efí webhook body is not JSON.');
    }

    if (!('pix' in payload)) {
      // Registering a webhook makes Efí probe the URL with a body that has no `pix`; the
      // registration fails unless the probe gets a 200, so it is passed through as an
      // inert event rather than rejected.
      const name = typeof payload.evento === 'string' ? payload.evento : 'notification';
      return {
        id: `efi-${name}-${createHash('sha256').update(rawBody, 'utf8').digest('hex').slice(0, 24)}`,
        provider: this.provider,
        type: `efi.${name}`,
        createdAt: new Date().toISOString(),
        data: payload as Record<string, unknown>,
        raw: payload as Record<string, unknown>,
      };
    }

    const list = payload.pix;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('[payments] Efí webhook has an empty `pix` array — nothing to process.');
    }

    // One event per Pix, each keyed on its own endToEndId, so the ledger gives each one its
    // own row: a redelivery of the batch re-runs only the entries that have not been
    // processed, and a batch where one entry fails does not re-grant the ones that did not.
    const events = (list as EfiPixNotification[]).map((pix) =>
      this.#mapPixNotification(pix, payload),
    );
    return events.length === 1 ? events[0]! : events;
  }

  /** One entry of the `pix` array → one normalized event. */
  #mapPixNotification(
    pix: EfiPixNotification,
    payload: { pix?: unknown; evento?: unknown },
  ): WebhookEvent {
    // The envelope narrowed to THIS Pix rather than the whole delivery: the ledger stores
    // `raw` per event, and a row holding the whole batch could not say which entry it is
    // about. Still a valid Efí notification body, and identical to the delivery for a
    // single entry.
    const raw = { ...payload, pix: [pix] } as Record<string, unknown>;
    const devolucoes = pix.devolucoes ?? [];
    // A Pix cannot be charged back — but it CAN be taken back. The Banco Central's MED
    // returns money to a payer who reported fraud or an operational failure, and it reaches
    // the merchant as an ordinary `devolução` on this very notification, marked by its
    // `natureza`. Treating it as a refund said the merchant chose to give the money back;
    // it is the closest thing Pix has to a chargeback, so it is normalized as one.
    const med = devolucoes.find(isMedDevolucao);
    const refunded = devolucoes.some((d) => !isMedDevolucao(d) && d.status === 'DEVOLVIDO');
    const data = {
      // The txid is the charge id this library stored as `gatewayId` — and, when the app
      // gave a txid-shaped `externalReference`, it is that reference too.
      gatewayId: pix.txid ?? pix.endToEndId,
      amount: fromDecimal(Number(pix.valor)),
      currency: 'brl',
      ...(pix.txid !== undefined ? { externalReference: pix.txid } : {}),
      metadata: { endToEndId: pix.endToEndId },
    };

    if (med !== undefined && med.status !== 'NAO_REALIZADO') {
      // `DEVOLVIDO` is the money already gone; `EM_PROCESSAMENTO` is the return being
      // executed and is the earliest the merchant hears of it at all — Efí's Pix webhook
      // has no "a MED was opened" notification, so there is no defense window to announce,
      // only notice. A `NAO_REALIZADO` MED took nothing (Efí's own example: insufficient
      // balance) and is deliberately not a dispute event.
      //
      // The event id carries the devolução id and its status: the ledger keys on it, and
      // reusing the Pix's own id would make the DEVOLVIDO that follows an
      // EM_PROCESSAMENTO look like a redelivery and skip it.
      const withdrawn = med.status === 'DEVOLVIDO';
      return {
        id: `${pix.endToEndId}:med:${med.id}:${med.status}`,
        provider: this.provider,
        type: withdrawn ? 'payment.disputed' : 'payment.dispute_warning',
        createdAt: pix.horario ?? new Date().toISOString(),
        data: {
          ...data,
          disputeId: med.id,
          // The `natureza` IS the reason, in BACEN's own vocabulary: `MED_FRAUDE` is a
          // founded suspicion of fraud, `MED_OPERACIONAL` an operational failure.
          ...(med.natureza !== undefined ? { reason: med.natureza } : {}),
          // No `actionableUntil`: the API Pix devolução carries no deadline field, and by
          // the time a MED reaches the receiver as a devolução the analysis is over.
        },
        raw,
      };
    }

    return {
      // The endToEndId is unique per Pix and stable across redeliveries — a real event id.
      id: refunded ? `${pix.endToEndId}:devolvido` : pix.endToEndId,
      provider: this.provider,
      type: refunded ? 'payment.refunded' : 'payment.succeeded',
      createdAt: pix.horario ?? new Date().toISOString(),
      data,
      raw,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCob(cob: EfiCob): Payment {
    const settled = cob.pix?.[0];
    const returned = (settled?.devolucoes ?? []).filter((d) => d.status === 'DEVOLVIDO');
    // A MED return is not a refund the merchant made — see `parseWebhook`, which normalizes
    // the same event to `payment.disputed`. Reading the charge back has to agree with it,
    // or the driver reports one gateway state two different ways.
    const medded = returned.some(isMedDevolucao);
    const result: Payment = {
      id: cob.txid,
      gatewayId: cob.txid,
      provider: this.provider,
      amount: { amount: fromDecimal(Number(cob.valor.original)), currency: 'brl' },
      status: medded
        ? 'disputed'
        : returned.length > 0
          ? 'refunded'
          : cob.status === 'CONCLUIDA'
            ? 'paid'
            : cob.status === 'ATIVA'
              ? 'pending'
              : 'canceled',
      method: 'pix',
      payload: cob as unknown as Record<string, unknown>,
      createdAt: cob.calendario?.criacao ?? new Date().toISOString(),
    };
    if (cob.pixCopiaECola !== undefined) {
      result.pixCode = cob.pixCopiaECola;
      result.pixCopiaECola = cob.pixCopiaECola;
    }
    if (settled?.horario !== undefined) result.paidAt = settled.horario;
    return result;
  }

  /**
   * Fetch the rendered QR image for a charge. Best-effort: the charge already exists and
   * `pixCopiaECola` is what the payer actually needs, so a failure here is not a failure.
   */
  async #attachQrCode(payment: Payment, cob: EfiCob): Promise<void> {
    const locId = cob.loc?.id;
    if (locId === undefined) return;
    try {
      const qr = await this.#request<EfiLocQrCode>(`/v2/loc/${locId}/qrcode`);
      if (qr.qrcode !== undefined && payment.pixCode === undefined) {
        payment.pixCode = qr.qrcode;
        payment.pixCopiaECola = qr.qrcode;
      }
      if (qr.imagemQrcode !== undefined) {
        // Efí returns a full data URI; this field is documented as bare base64.
        const base64 = qr.imagemQrcode.replace(/^data:image\/\w+;base64,/, '');
        payment.pixQrCodeImage = base64;
        payment.pixQrCode = base64;
      }
    } catch {
      // The charge is created and payable — the image is a convenience.
    }
  }

  /** The payer, only when Efí's minimum (name + CPF/CNPJ) is actually available. */
  #payer(input: ChargeInput): Record<string, unknown> | undefined {
    const name = input.customer?.name ?? input.card?.holder?.name;
    const taxId = (input.customer?.taxId ?? input.card?.holder?.cpfCnpj)?.replace(/\D/g, '');
    if (!name || !taxId) return undefined;
    return { nome: name, ...(taxId.length > 11 ? { cnpj: taxId } : { cpf: taxId }) };
  }

  #expiration(input: ChargeInput): number {
    const explicit = input.metadata?.expirationSeconds;
    return explicit !== undefined ? Number(explicit) : this.#expirationSeconds;
  }

  /** The settled Pix behind a txid (or an endToEndId passed straight through). */
  async #resolveSettledPix(gatewayId: string): Promise<{ endToEndId: string; paidValue: string }> {
    if (isEndToEndId(gatewayId)) {
      const value = await this.#request<{ valor?: string }>(`/v2/pix/${gatewayId}`);
      return { endToEndId: gatewayId, paidValue: value.valor ?? '0.00' };
    }
    const cob = await this.#request<EfiCob>(`/v2/cob/${gatewayId}`);
    const settled = cob.pix?.[0];
    if (settled === undefined) {
      throw new Error(
        `[payments] Efí charge ${gatewayId} has not been paid, so there is no Pix to refund.`,
      );
    }
    return { endToEndId: settled.endToEndId, paidValue: settled.valor };
  }

  // ── Auth + transport ─────────────────────────────────────────────────────────────────

  /**
   * A valid access token, minted on demand and cached only for as long as the gateway
   * said it is good for.
   *
   * The deadline comes from the response's own `expires_in`, minus a minute of skew — a
   * cache with a lifetime of its own is how you get a driver that works all afternoon and
   * starts 401-ing an hour into the first deploy that stays up.
   */
  async #accessToken(): Promise<string> {
    const cached = this.#token;
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    // Collapse concurrent misses onto one token request.
    if (this.#tokenInFlight !== undefined) return this.#tokenInFlight;
    const request = this.#mintToken().finally(() => {
      this.#tokenInFlight = undefined;
    });
    this.#tokenInFlight = request;
    return request;
  }

  async #mintToken(): Promise<string> {
    const data = await httpRequest<EfiTokenResponse>('/oauth/token', {
      baseUrl: this.#baseUrl,
      method: 'POST',
      body: { grant_type: 'client_credentials' },
      authHeader: { name: 'Authorization', value: `Basic ${this.#basicAuth}` },
      fetch: this.#fetch,
    });
    if (!data.access_token) {
      throw new Error('[payments] Efí returned no access_token for the client-credentials grant.');
    }
    const ttl = Number(data.expires_in);
    const seconds = Number.isFinite(ttl) && ttl > 0 ? ttl : TOKEN_FALLBACK_TTL_SECONDS;
    const skew = Math.min(TOKEN_RENEWAL_SKEW_SECONDS, Math.floor(seconds / 2));
    this.#token = {
      value: data.access_token,
      expiresAt: Date.now() + (seconds - skew) * 1000,
    };
    return data.access_token;
  }

  async #request<T>(
    path: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    try {
      return await this.#send<T>(path, options, await this.#accessToken());
    } catch (error) {
      // A token can be revoked (or a scope changed) before it expires. One retry with a
      // fresh token; anything else is the caller's problem.
      if (!isUnauthorized(error)) throw error;
      this.#token = undefined;
      return this.#send<T>(path, options, await this.#accessToken());
    }
  }

  #send<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown>; headers?: Record<string, string> },
    token: string,
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      bearerToken: token,
      fetch: this.#fetch,
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────

/**
 * Efí/BACEN money is a decimal string with two places: 1990 centavos → `'19.90'`.
 * {@link formatDecimal} shifts the digits of the integer instead of dividing, so no
 * binary float ever gets a chance to turn `19.90` into `19.89` on the wire.
 */
function toAmountString(amount: Money): string {
  return formatDecimal(amount);
}

/**
 * The caller's idempotency key as Efí's devolução id, or a boot-loud failure.
 *
 * The devolução id IS the idempotency mechanism on this API — a `PUT` to the same id is
 * the same refund — so the key is used verbatim rather than hashed, which keeps it
 * greppable in Efí's dashboard. BACEN constrains it to 1–35 alphanumerics; a key outside
 * that charset cannot be sent, and quietly minting a random id instead would turn the
 * caller's retry guarantee into a second refund.
 */
function idempotencyKeyAsRefundId(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  if (!/^[a-zA-Z0-9]{1,35}$/.test(key)) {
    throw new Error(
      `[payments] Efí deduplicates a refund on the devolução id, and "${key}" cannot be one: BACEN allows 1–35 alphanumeric characters (no dashes, no underscores). Pass an \`idempotencyKey\` in that charset — a UUID works with the dashes stripped.`,
    );
  }
  return key;
}

/** The BACEN txid charset: 26–35 alphanumerics. */
function isValidTxid(value: string): boolean {
  return /^[a-zA-Z0-9]{26,35}$/.test(value);
}

/** An endToEndId looks like `E` + 8-digit ISPB + timestamp + suffix, 32 chars. */
function isEndToEndId(value: string): boolean {
  return /^E\d{8}[0-9A-Za-z]{23}$/.test(value);
}

function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 401
  );
}

/**
 * A `fetch` that presents Efí's client certificate.
 *
 * This is the whole reason `httpRequest` grew a `fetch` option. Node's global `fetch`
 * gives no way to attach a client certificate — TLS identity belongs to the connection,
 * and the only knob for it is a custom agent/dispatcher. Rather than take on `undici` as a
 * dependency just to build one, this wraps `node:https` (which has accepted `pfx` since
 * forever) in the small part of the `fetch` contract `httpRequest` actually uses: a
 * method, string headers, a string body, and a `Response` back.
 */
function mtlsFetch(config: EfiDriverConfig): typeof globalThis.fetch {
  const certificate = config.certificate ?? process.env.EFI_CERTIFICATE;
  if (certificate === undefined) {
    throw new Error(
      "[payments] Efí's Pix API requires mutual TLS and no certificate was configured. " +
        'Generate the .p12 in the Efí dashboard (API → Meus Certificados), then set `EFI_CERTIFICATE` to its path ' +
        'or pass `certificate` (a path or a Buffer) to `payments.efi()`. ' +
        'If you terminate TLS somewhere else, pass your own `fetch` instead.',
    );
  }

  let content: Buffer;
  if (typeof certificate === 'string') {
    try {
      content = readFileSync(certificate);
    } catch (error) {
      throw new Error(
        `[payments] Efí certificate could not be read from "${certificate}": ${
          error instanceof Error ? error.message : String(error)
        }. Pass a readable path, or a Buffer with the certificate's contents.`,
      );
    }
  } else {
    content = Buffer.from(certificate);
  }

  const isPem = content.subarray(0, 64).toString('utf8').includes('-----BEGIN');
  const agent = new HttpsAgent({
    keepAlive: true,
    // Efí hands out a .p12 by default; a converted .pem carries both halves in one file.
    ...(isPem
      ? { cert: content, key: content }
      : { pfx: content, passphrase: config.certificatePassphrase ?? '' }),
  });

  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init?.body === 'string' ? init.body : undefined;
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));

    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        url,
        { method: init?.method ?? 'GET', headers, agent },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const status = response.statusCode ?? 502;
            // 204/205/304 must not carry a body or `Response` throws.
            const payload =
              status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
            resolve(new Response(payload, { status }));
          });
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  };
}
