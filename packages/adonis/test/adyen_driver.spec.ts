import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdyenDriverConfig } from '../src/drivers/adyen.js';
import { AdyenDriver } from '../src/drivers/adyen.js';

/**
 * The HMAC key and the REPORT_AVAILABLE signature below are Adyen's own published test
 * vector (adyen-node-api-library `hmacValidator.spec.ts`). Keeping the *expected*
 * signature as a constant rather than recomputing it in the test is the point: it pins
 * the exact signing string ("pspReference:originalReference:merchantAccount:reference:
 * 1000:EUR:REPORT_AVAILABLE:true"), the hex-decoded key and the base64 digest against
 * Adyen, not against this repo's own idea of them.
 */
const HMAC_KEY = 'DFB1EB5485895CFA84146406857104ABB4CBCABDC8AAF103A624C8F6A3EAAB00';
const ADYEN_PUBLISHED_SIGNATURE = 'ZNBPtI+oDyyRrLyD1XirkKnQgIAlFc07Vj27TeHsDRE=';
/** Signed with the same key/algorithm, for a real payment notification. */
const AUTHORISATION_SIGNATURE = '6WwF9K18RVufbN//tH/feSJRSQKUldg6cOL1QMHzR14=';
const REFUND_SIGNATURE = 'L4eixkbRGomIjfv/lUwPflrcVf+V0GUADU5NArrRkrQ=';
/**
 * Same key, over a merchantReference that contains the delimiter itself
 * ("8836158720123456::TestMerchant:order:local:1:1990:EUR:AUTHORISATION:true"). Adyen's
 * libraries do NOT escape the colon for standard webhooks — the `\:` rule belongs to the
 * classic HPP dictionary signature — so a driver that "helpfully" escapes signs something
 * else and rejects a genuine notification.
 */
const COLON_REFERENCE_SIGNATURE = 'yuLSQfbPL/bHoA3DQeTlnJ5H3fViCEqlk8rldvw7rMA=';

function makeDriver(overrides: Partial<AdyenDriverConfig> = {}) {
  return new AdyenDriver({ config: () => ({}) }, {
    apiKey: 'test-key',
    merchantAccount: 'TestMerchant',
    currency: 'eur',
    environment: 'test',
    ...overrides,
  } as AdyenDriverConfig);
}

function notification(item: Record<string, unknown>) {
  return JSON.stringify({ live: 'false', notificationItems: [{ NotificationRequestItem: item }] });
}

const publishedItem = {
  pspReference: 'pspReference',
  originalReference: 'originalReference',
  merchantAccountCode: 'merchantAccount',
  merchantReference: 'reference',
  amount: { currency: 'EUR', value: 1000 },
  eventCode: 'REPORT_AVAILABLE',
  eventDate: '2019-09-21T11:45:24.637Z',
  success: 'true',
};

const authorisationItem = {
  pspReference: '8836158720123456',
  merchantAccountCode: 'TestMerchant',
  merchantReference: 'order_local_1',
  amount: { currency: 'EUR', value: 1990 },
  eventCode: 'AUTHORISATION',
  eventDate: '2026-08-27T10:00:00Z',
  success: 'true',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdyenDriver — boot', () => {
  it('refuses to boot without an API key', () => {
    const key = process.env.ADYEN_API_KEY;
    process.env.ADYEN_API_KEY = '';
    try {
      expect(() => makeDriver({ apiKey: undefined })).toThrow(/requires apiKey/);
    } finally {
      if (key === undefined) process.env.ADYEN_API_KEY = undefined;
      else process.env.ADYEN_API_KEY = key;
    }
  });

  it('refuses to boot without a merchant account', () => {
    expect(() => makeDriver({ merchantAccount: undefined })).toThrow(/requires merchantAccount/);
  });

  it('refuses to boot without a currency — a multi-currency gateway has no safe default', () => {
    expect(() => makeDriver({ currency: undefined })).toThrow(/no currency configured/);
  });

  it('refuses to boot live without the account URL prefix', () => {
    expect(() => makeDriver({ environment: 'live' })).toThrow(/requires liveUrlPrefix/);
  });

  it('builds the per-customer live host from the prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pspReference: 'psp_1', resultCode: 'Authorised' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver({ environment: 'live', liveUrlPrefix: 'abc123-Company' });
    await driver.charge({
      amount: 1990,
      paymentMethodId: 'tok_1',
      externalReference: 'order_local_1',
    });
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(String(url)).toBe(
      'https://abc123-Company-checkout-live.adyenpayments.com/checkout/v71/payments',
    );
  });
});

describe('AdyenDriver — charge', () => {
  it('sends the amount as an integer in minor units and maps the payment back', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        pspReference: '8836158720123456',
        resultCode: 'Authorised',
        merchantReference: 'order_local_1',
        amount: { currency: 'EUR', value: 1990 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver();

    const payment = await driver.charge({
      customerId: 'shopper_1',
      amount: 1990,
      paymentMethodId: 'tok_1',
      externalReference: 'order_local_1',
    });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://checkout-test.adyen.com/v71/payments');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key');
    // Adyen already speaks minor units: 1990 must arrive as 1990, never 19.90.
    expect(JSON.parse(String(init.body))).toMatchObject({
      merchantAccount: 'TestMerchant',
      amount: { value: 1990, currency: 'EUR' },
      reference: 'order_local_1',
      paymentMethod: { type: 'scheme', storedPaymentMethodId: 'tok_1' },
      shopperReference: 'shopper_1',
    });
    expect(payment).toMatchObject({
      gatewayId: '8836158720123456',
      provider: 'adyen',
      status: 'paid',
      method: 'card',
      amount: { amount: 1990, currency: 'eur' },
      customerId: 'shopper_1',
    });
  });

  it('maps a Refused result onto a failed payment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          pspReference: 'psp_2',
          resultCode: 'Refused',
          refusalReason: 'Not enough balance',
        }),
      }),
    );
    const payment = await makeDriver().charge({
      amount: 500,
      paymentMethodId: 'tok_1',
      externalReference: 'order_local_2',
    });
    expect(payment.status).toBe('failed');
  });

  it('refuses a charge with no payment method instead of sending a request Adyen rejects', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      makeDriver().charge({ amount: 1990, externalReference: 'order_local_1' }),
    ).rejects.toThrow(/needs a payment method/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a charge with no externalReference — the webhook would have nothing to route on', async () => {
    await expect(makeDriver().charge({ amount: 1990, paymentMethodId: 'tok_1' })).rejects.toThrow(
      /requires `externalReference`/,
    );
  });

  it('sends the idempotency key as the request header Adyen deduplicates on', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pspReference: 'psp_1', resultCode: 'Authorised' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await makeDriver().charge({
      amount: 1990,
      paymentMethodId: 'tok_1',
      externalReference: 'order_local_1',
      idempotencyKey: 'idem_1',
    });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    // The header is the whole mechanism: Adyen never echoes the key back on the response,
    // so a copy in `metadata` would deduplicate nothing.
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem_1');
  });

  it('sends no idempotency header when the charge carries no key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pspReference: 'psp_1', resultCode: 'Authorised' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await makeDriver().charge({
      amount: 1990,
      paymentMethodId: 'tok_1',
      externalReference: 'order_local_1',
    });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });

  it('refuses a percent-based split it cannot express', async () => {
    await expect(
      makeDriver().charge({
        amount: 1990,
        paymentMethodId: 'tok_1',
        externalReference: 'order_local_1',
        split: [{ walletId: 'wal_1', percentualValue: 70 }],
      }),
    ).rejects.toThrow(/splits with absolute amounts/);
  });
});

describe('AdyenDriver — unsupported operations', () => {
  it('refuses every customer operation: Adyen has no customer resource', async () => {
    const driver = makeDriver();
    await expect(driver.createCustomer({ email: 'a@b.com' })).rejects.toThrow(
      /no customer resource to create/,
    );
    await expect(driver.findCustomer('shopper_1')).rejects.toThrow(
      /no customer resource to look up/,
    );
    await expect(driver.updateCustomer('shopper_1', { name: 'A' })).rejects.toThrow(
      /no customer resource to update/,
    );
  });

  it('refuses findPayment: Checkout v71 has no read-back endpoint', async () => {
    await expect(makeDriver().findPayment('psp_1')).rejects.toThrow(
      /no endpoint that reads a payment back/,
    );
  });

  it('refuses a refund with no amount instead of inventing one', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeDriver().refund('psp_1')).rejects.toThrow(/requires the refund amount/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses every subscription operation instead of reporting a change Adyen never saw', async () => {
    const driver = makeDriver();
    await expect(driver.createSubscription({ customerId: 'c', planId: 'p' })).rejects.toThrow(
      /no subscription resource/,
    );
    await expect(driver.cancelSubscription('sub_1')).rejects.toThrow(/no subscription to cancel/);
    await expect(driver.updateSubscription('sub_1', { amount: 999 })).rejects.toThrow(
      /no subscription to update/,
    );
    await expect(driver.findSubscription('sub_1')).rejects.toThrow(
      /no subscription resource to look up/,
    );
  });

  it('refuses listInvoices: Checkout has no invoice resource', async () => {
    await expect(makeDriver().listInvoices('shopper_1')).rejects.toThrow(/no invoice resource/);
  });

  it('refuses a subscription checkout', async () => {
    await expect(
      makeDriver().createCheckout({
        amount: 1990,
        successUrl: 'https://example.org/ok',
        planId: 'plan_pro',
        externalReference: 'order_local_1',
      }),
    ).rejects.toThrow(/no subscription checkout/);
  });
});

describe('AdyenDriver — checkout', () => {
  it('sends externalReference as the payment link reference and reads it back off the webhook', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'PL61C13AD0AC0E3A29',
        url: 'https://test.adyen.link/PL61C13AD0AC0E3A29',
        status: 'active',
        amount: { currency: 'EUR', value: 1990 },
        reference: 'link_local_1',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver({ hmacKey: HMAC_KEY });

    const session = await driver.createCheckout({
      amount: 1990,
      successUrl: 'https://example.org/ok',
      externalReference: 'link_local_1',
      idempotencyKey: 'idem_link_1',
    });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://checkout-test.adyen.com/v71/paymentLinks');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem_link_1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      merchantAccount: 'TestMerchant',
      amount: { value: 1990, currency: 'EUR' },
      reference: 'link_local_1',
      returnUrl: 'https://example.org/ok',
    });
    expect(session).toMatchObject({
      gatewayId: 'PL61C13AD0AC0E3A29',
      url: 'https://test.adyen.link/PL61C13AD0AC0E3A29',
      status: 'open',
    });

    // …and the reference comes back as merchantReference when the link is paid.
    const event = driver.parseWebhook(
      notification({
        pspReference: '8836158720123499',
        merchantAccountCode: 'TestMerchant',
        merchantReference: 'link_local_1',
        amount: { currency: 'EUR', value: 1990 },
        eventCode: 'AUTHORISATION',
        success: 'true',
        additionalData: { hmacSignature: 'Ik8UJXNkOFCnISnKGxEl6qszsUckRft6cXL5YKCNZTg=' },
      }),
      {},
    );
    expect((event.data as { externalReference: string }).externalReference).toBe('link_local_1');
  });

  it('refuses a payment link with no externalReference', async () => {
    await expect(
      makeDriver().createCheckout({ amount: 1990, successUrl: 'https://example.org/ok' }),
    ).rejects.toThrow(/requires `externalReference`/);
  });
});

describe('AdyenDriver — refund', () => {
  it('posts the amount in minor units and reports the async outcome as pending', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        pspReference: 'psp_refund_1',
        paymentPspReference: '8836158720123456',
        amount: { currency: 'EUR', value: 1990 },
        status: 'received',
        merchantAccount: 'TestMerchant',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const refund = await makeDriver().refund('8836158720123456', 1990);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(
      'https://checkout-test.adyen.com/v71/payments/8836158720123456/refunds',
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      merchantAccount: 'TestMerchant',
      amount: { value: 1990, currency: 'EUR' },
    });
    expect(refund).toMatchObject({ status: 'pending', amount: { amount: 1990, currency: 'eur' } });
  });
});

describe('AdyenDriver — webhooks', () => {
  it("accepts Adyen's own published HMAC test vector", () => {
    const driver = makeDriver({ hmacKey: HMAC_KEY });
    const raw = notification({
      ...publishedItem,
      additionalData: { hmacSignature: ADYEN_PUBLISHED_SIGNATURE },
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.provider).toBe('adyen');
    expect(event.id).toBe('adyen:REPORT_AVAILABLE:pspReference');
  });

  it('rejects a body whose signed field was tampered with', () => {
    const driver = makeDriver({ hmacKey: HMAC_KEY });
    const raw = notification({
      ...publishedItem,
      // Signed field: flipping it must invalidate Adyen's published signature.
      merchantReference: 'reference-tampered',
      additionalData: { hmacSignature: ADYEN_PUBLISHED_SIGNATURE },
    });
    expect(() => driver.parseWebhook(raw, {})).toThrow(/Invalid Adyen webhook HMAC signature/);
  });

  it('rejects a forged signature', () => {
    const driver = makeDriver({ hmacKey: HMAC_KEY });
    const raw = notification({
      ...publishedItem,
      additionalData: { hmacSignature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    });
    expect(() => driver.parseWebhook(raw, {})).toThrow(/Invalid Adyen webhook HMAC signature/);
  });

  it('rejects a notification with no signature at all when an HMAC key is configured', () => {
    const driver = makeDriver({ hmacKey: HMAC_KEY });
    expect(() => driver.parseWebhook(notification(publishedItem), {})).toThrow(
      /Missing hmacSignature/,
    );
  });

  it('normalizes AUTHORISATION onto payment.succeeded with merchantReference as externalReference', () => {
    const driver = makeDriver({ hmacKey: HMAC_KEY });
    const raw = notification({
      ...authorisationItem,
      additionalData: { hmacSignature: AUTHORISATION_SIGNATURE },
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.succeeded');
    expect(event.id).toBe('adyen:AUTHORISATION:8836158720123456');
    expect(event.createdAt).toBe('2026-08-27T10:00:00Z');
    expect(event.data).toMatchObject({
      gatewayId: '8836158720123456',
      amount: 1990,
      currency: 'eur',
      externalReference: 'order_local_1',
    });
  });

  it('maps an unsuccessful AUTHORISATION onto payment.failed', () => {
    const driver = makeDriver();
    const event = driver.parseWebhook(notification({ ...authorisationItem, success: 'false' }), {});
    expect(event.type).toBe('payment.failed');
  });

  it('routes a REFUND onto the original payment, not the modification reference', () => {
    const driver = makeDriver({ hmacKey: HMAC_KEY });
    const raw = notification({
      pspReference: '9916158720123456',
      originalReference: '8836158720123456',
      merchantAccountCode: 'TestMerchant',
      merchantReference: 'order_local_1',
      amount: { currency: 'EUR', value: 1990 },
      eventCode: 'REFUND',
      success: 'true',
      additionalData: { hmacSignature: REFUND_SIGNATURE },
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.refunded');
    expect((event.data as { gatewayId: string }).gatewayId).toBe('8836158720123456');
  });

  it('does not escape a colon inside a signed field, the way Adyen does not', () => {
    const driver = makeDriver({ hmacKey: HMAC_KEY });
    const raw = notification({
      ...authorisationItem,
      merchantReference: 'order:local:1',
      additionalData: { hmacSignature: COLON_REFERENCE_SIGNATURE },
    });
    const event = driver.parseWebhook(raw, {});
    expect((event.data as { externalReference: string }).externalReference).toBe('order:local:1');
  });

  it('refuses a batched notification instead of processing one item and dropping the rest', () => {
    const driver = makeDriver();
    const raw = JSON.stringify({
      live: 'false',
      notificationItems: [
        { NotificationRequestItem: authorisationItem },
        { NotificationRequestItem: { ...authorisationItem, eventCode: 'CAPTURE' } },
      ],
    });
    expect(() => driver.parseWebhook(raw, {})).toThrow(/2 notification items/);
  });

  it('skips verification when no HMAC key is configured, so local development works', () => {
    const driver = makeDriver();
    const event = driver.parseWebhook(notification(authorisationItem), {});
    expect(event.type).toBe('payment.succeeded');
  });
});

describe('AdyenDriver — disputes', () => {
  /** A chargeback notification item; Adyen names the disputed payment in originalReference. */
  const chargebackItem = (eventCode: string) => ({
    pspReference: '9916158720123456',
    originalReference: '8836158720123456',
    merchantAccountCode: 'TestMerchant',
    merchantReference: 'order_local_1',
    amount: { currency: 'EUR', value: 1990 },
    eventCode,
    success: 'true',
  });

  it('maps NOTIFICATION_OF_CHARGEBACK onto payment.disputed', () => {
    const event = makeDriver().parseWebhook(
      notification(chargebackItem('NOTIFICATION_OF_CHARGEBACK')),
      {},
    );
    expect(event.type).toBe('payment.disputed');
    // The row that has to stop saying `paid` is the PAYMENT's, not the notification's.
    expect(event.data).toMatchObject({
      gatewayId: '8836158720123456',
      amount: 1990,
      currency: 'eur',
      externalReference: 'order_local_1',
    });
  });

  it('maps a bare CHARGEBACK onto payment.disputed too', () => {
    // An ACH return goes straight to CHARGEBACK with no notification of chargeback and
    // cannot be defended at all — mapping only the notification would miss exactly the
    // disputes nobody can fight.
    const event = makeDriver().parseWebhook(notification(chargebackItem('CHARGEBACK')), {});
    expect(event.type).toBe('payment.disputed');
  });

  it('leaves the resolution and the pre-dispute warnings as payment.updated', () => {
    for (const eventCode of [
      'CHARGEBACK_REVERSED',
      'SECOND_CHARGEBACK',
      'PREARBITRATION_WON',
      'PREARBITRATION_LOST',
      'DISPUTE_DEFENSE_PERIOD_ENDED',
      // No money moves on either of these; calling them a chargeback would take a live
      // payment away over a question.
      'REQUEST_FOR_INFORMATION',
      'NOTIFICATION_OF_FRAUD',
    ]) {
      const event = makeDriver().parseWebhook(notification(chargebackItem(eventCode)), {});
      expect(event.type, eventCode).toBe('payment.updated');
    }
  });
});

describe('AdyenDriver — capture mode', () => {
  it('reads Authorised as paid on an automatic-capture account', async () => {
    // Adyen's default: the capture follows on its own and sends no CAPTURE webhook, so the
    // authorization is the last word the driver ever gets about that money.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        pspReference: '8836158720123456',
        resultCode: 'Authorised',
        amount: { value: 1990, currency: 'EUR' },
      }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
    const payment = await makeDriver().charge({
      amount: 1990,
      paymentMethodId: 'tok_1',
      externalReference: 'order_local_1',
    });
    expect(payment.status).toBe('paid');
  });

  it('reads Authorised as authorized on a manual-capture account', async () => {
    // Here it is a hold that expires unless something captures it — reporting `paid` would
    // grant access against money that has not moved and may never.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        pspReference: '8836158720123456',
        resultCode: 'Authorised',
        amount: { value: 1990, currency: 'EUR' },
      }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
    const payment = await makeDriver({ captureMode: 'manual' }).charge({
      amount: 1990,
      paymentMethodId: 'tok_1',
      externalReference: 'order_local_1',
    });
    expect(payment.status).toBe('authorized');
  });

  it('makes CAPTURE the money event when capture is manual, and AUTHORISATION only an update', () => {
    const driver = makeDriver({ captureMode: 'manual' });
    expect(driver.parseWebhook(notification(authorisationItem), {}).type).toBe('payment.updated');
    expect(
      driver.parseWebhook(notification({ ...authorisationItem, eventCode: 'CAPTURE' }), {}).type,
    ).toBe('payment.succeeded');
  });

  it('keeps AUTHORISATION as the money event when capture is automatic', () => {
    // Automatic capture sends no CAPTURE webhook, so downgrading AUTHORISATION would leave
    // every payment on such an account unsettled forever.
    expect(makeDriver().parseWebhook(notification(authorisationItem), {}).type).toBe(
      'payment.succeeded',
    );
  });
});

describe('AdyenDriver — refund idempotency and methods', () => {
  it('sends the Idempotency-Key header on a refund', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        pspReference: '9916158720123456',
        paymentPspReference: '8836158720123456',
        amount: { value: 1990, currency: 'EUR' },
        status: 'received',
        merchantAccount: 'TestMerchant',
      }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    await makeDriver().refund('8836158720123456', 1990, { idempotencyKey: 'refund-1' });

    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    // Without it a retried refund job refunds the payment twice.
    expect(headers['Idempotency-Key']).toBe('refund-1');
  });

  it('refuses a key longer than Adyen accepts instead of letting the gateway 422', async () => {
    await expect(
      makeDriver().refund('8836158720123456', 1990, { idempotencyKey: 'x'.repeat(65) }),
    ).rejects.toThrow(/64 characters/);
  });

  it('names the instrument by category instead of calling everything a card', async () => {
    for (const [paymentMethod, method] of [
      ['visa', 'card'],
      ['maestro', 'debit_card'],
      ['sepadirectdebit', 'bank_debit'],
      ['ideal', 'bank_transfer'],
      ['paypal', 'wallet'],
      ['klarna_account', 'bnpl'],
    ] as const) {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          pspReference: '8836158720123456',
          resultCode: 'Authorised',
          amount: { value: 1990, currency: 'EUR' },
          additionalData: { paymentMethod },
        }),
        text: async () => '',
      });
      vi.stubGlobal('fetch', fetchMock);
      const payment = await makeDriver().charge({
        amount: 1990,
        paymentMethodId: 'tok_1',
        externalReference: 'order_local_1',
      });
      expect(payment.method, paymentMethod).toBe(method);
    }
  });
});
