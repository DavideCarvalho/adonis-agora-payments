import { describe, expect, it, vi } from 'vitest';

const createClientMock = vi.hoisted(() => ({
  create: vi.fn(),
  subscription: { create: vi.fn(), get: vi.fn() },
  charge: { create: vi.fn() },
  customer: { create: vi.fn() },
  subAccount: { create: vi.fn(), get: vi.fn(), list: vi.fn() },
}));

vi.mock('@woovi/node-sdk', () => ({
  createClient: () => createClientMock,
}));

import { WooviDriver } from '../src/drivers/woovi.js';

describe('WooviDriver', () => {
  it('maps PIX_AUTOMATIC_APPROVED to subscription.created', () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const raw = JSON.stringify({
      event: 'PIX_AUTOMATIC_APPROVED',
      correlationID: '6f4131ea',
      value: 100,
      status: 'ACTIVE',
      globalID: 'UGF5bWVudFN1YnNjcmlwdGlvbjox',
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('subscription.created');
    expect(event.id).toBe('UGF5bWVudFN1YnNjcmlwdGlvbjox');

    // `data` is the NORMALIZED shape the processor's built-in sync consumes, not Woovi's
    // raw body — handing over the raw body is what made every Woovi webhook fail the shape
    // guard. Woovi's `correlationID` is the app's own reference, so it survives as
    // `externalReference`; the untouched original is still on `event.raw`.
    expect(event.data).toMatchObject({
      gatewayId: 'UGF5bWVudFN1YnNjcmlwdGlvbjox',
      externalReference: '6f4131ea',
    });
    expect(event.raw).toMatchObject({ correlationID: '6f4131ea' });
  });

  it('maps PIX_AUTOMATIC_COBR_COMPLETED to payment.succeeded', () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const raw = JSON.stringify({
      event: 'PIX_AUTOMATIC_COBR_COMPLETED',
      installmentNumber: 1,
      value: 100,
      status: 'COMPLETED',
      globalID: 'UGF5bWVudFN1YnNjcmlwdGlvbkluc3RhbGxtZW50OjE=',
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.succeeded');
  });

  it('maps CHARGE_COMPLETED to payment.succeeded', () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const raw = JSON.stringify({ event: 'CHARGE_COMPLETED', id: 'charge_1' });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.succeeded');
  });

  /**
   * OpenPix documents `value` as "o valor em centavos da cobrança Pix" — the same integer
   * minor unit this package uses. The driver converted with `toDecimal`/`fromDecimal`
   * anyway, so a R$19,90 charge went out as `value: 19.9` and the gateway created a **20
   * centavo** charge. The unit is pinned in both directions here because the old tests
   * asserted the converted figure and agreed with the bug.
   */
  it('sends centavos to the gateway, unconverted', async () => {
    createClientMock.charge.create.mockResolvedValue({
      charge: { globalID: 'Q2hhcmdlOjE=', correlationID: 'order_1', value: 1990, status: 'ACTIVE' },
    });
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    await driver.charge({ amount: 1990, externalReference: 'order_1' });

    expect(createClientMock.charge.create.mock.calls[0]![0]).toMatchObject({ value: 1990 });
  });

  it('reads centavos back from the gateway, unconverted', () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const event = driver.parseWebhook(
      JSON.stringify({
        event: 'OPENPIX:CHARGE_COMPLETED',
        charge: { globalID: 'Q2hhcmdlOjE=', correlationID: 'order_1', value: 1990 },
        pix: { endToEndId: 'E1', value: 1990 },
      }),
      {},
    );
    // 1990 centavos = R$19,90. Dividing here would report a R$19,90 payment as 20 centavos.
    expect(event.data).toMatchObject({ amount: 1990, currency: 'brl' });
  });

  it('maps the OPENPIX:-prefixed event Woovi actually sends', () => {
    // Woovi's published payload is `"event": "OPENPIX:CHARGE_COMPLETED"`. The map was
    // written against the bare name, so a real webhook matched nothing and the payment was
    // never synced. Both forms work now.
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const raw = JSON.stringify({
      event: 'OPENPIX:CHARGE_COMPLETED',
      charge: { globalID: 'Q2hhcmdlOjE=', correlationID: 'order_1', value: 1990 },
      pix: { endToEndId: 'E1234', value: 1990 },
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.succeeded');
    // The endToEndId travels as metadata: it is the only key a MED dispute arrives under,
    // and the dispute payload never names the charge.
    expect(event.data).toMatchObject({
      gatewayId: 'Q2hhcmdlOjE=',
      externalReference: 'order_1',
      metadata: { endToEndId: 'E1234' },
    });
  });

  // ── Disputes (Pix MED) ─────────────────────────────────────────────────────────────

  it('maps OPENPIX:DISPUTE_CREATED to a warning, never to payment.disputed', () => {
    // A MED claim under analysis: Woovi BLOCKS the balance while the bank decides, and a
    // block is not a withdrawal — calling it `payment.disputed` would move a paid row over
    // money still in the account, and the row would be wrong if the dispute is rejected.
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const event = driver.parseWebhook(
      JSON.stringify({
        event: 'OPENPIX:DISPUTE_CREATED',
        dispute: {
          status: 'OPENED',
          id: 'dispute_1',
          endToEndId: 'E3524a995bbd54034b6d07c1c36014557',
          value: 1000,
          disputeReason: 'Golpe',
        },
      }),
      {},
    );
    expect(event.type).toBe('payment.dispute_warning');
    expect(event.type).not.toBe('payment.disputed');
    expect(event.data).toMatchObject({
      // The Pix's endToEndId — the dispute payload names nothing else.
      gatewayId: 'E3524a995bbd54034b6d07c1c36014557',
      disputeId: 'dispute_1',
      reason: 'Golpe',
    });
    // Woovi's three days to answer are policy, not a payload field, and this driver does
    // not invent the date.
    expect(event.data).not.toHaveProperty('actionableUntil');
  });

  it.each([
    ['OPENPIX:DISPUTE_ACCEPTED', 'ACCEPTED', 'lost'],
    ['OPENPIX:DISPUTE_REJECTED', 'REJECTED', 'won'],
    ['OPENPIX:DISPUTE_CANCELED', 'CANCELED', 'canceled'],
  ])('closes the dispute on %s with outcome %s', (name, status, outcome) => {
    // Accepted means the claim was upheld and the end customer was refunded — the merchant
    // lost. Rejected means the company proved the transaction legitimate and keeps the
    // money. Canceled is the customer or the bank withdrawing the claim.
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const event = driver.parseWebhook(
      JSON.stringify({
        event: name,
        dispute: { status, id: 'dispute_1', endToEndId: 'E1', value: 1000 },
      }),
      {},
    );
    expect(event.type, name).toBe('payment.dispute_closed');
    expect(event.data, name).toMatchObject({ gatewayId: 'E1', disputeId: 'dispute_1', outcome });
  });

  it('leaves a dispute it cannot key as an unrecognized event instead of a broken one', () => {
    // `payment.dispute_*` with no `gatewayId` makes the processor throw, and a throw inside
    // the webhook route is a 500 Woovi retries forever. An unnameable dispute keeps its own
    // name and reaches a registered handler with the raw body.
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const event = driver.parseWebhook(JSON.stringify({ event: 'OPENPIX:DISPUTE_CREATED' }), {});
    expect(event.type).toBe('openpix:dispute_created');
  });

  it('rejects a webhook with a mismatched app id', () => {
    process.env.WOOVI_APP_ID = 'app-real';
    try {
      const driver = new WooviDriver({ config: () => ({}) }, { appId: 'app-real' });
      const raw = JSON.stringify({ event: 'CHARGE_COMPLETED' });
      expect(() => driver.parseWebhook(raw, { app_id: 'app-other' })).toThrow(/app id/);
    } finally {
      process.env.WOOVI_APP_ID = undefined;
    }
  });

  it('creates a Pix Automático subscription with the payer customer and pay-on-approval', async () => {
    createClientMock.subscription.create.mockResolvedValue({
      subscription: {
        globalID: 'UGF5bWVudFN1YnNjcmlwdGlvbjox',
        status: 'ACTIVE',
        value: 4990,
        dayGenerateCharge: 1,
      },
    });
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    const subscription = await driver.createSubscription({
      customerId: 'cus_1',
      planId: 'tier:pro',
      amount: 4990,
      cycle: 'MONTHLY',
      startDate: '2026-09-15',
      customer: { name: 'Jane Doe', email: 'jane@example.com', taxId: '123.456.789-00' },
    });

    const payload = createClientMock.subscription.create.mock.calls.at(-1)![0];
    expect(payload).toMatchObject({
      customer: { name: 'Jane Doe', email: 'jane@example.com', taxID: '12345678900' },
      // Centavos, not reais. R$49,90 is 4990 — sending 49.9 created a 50 centavo
      // subscription at the gateway.
      value: 4990,
      // `chargeType: 'DYNAMIC'` used to be asserted here, and it was the tell: `chargeType`
      // belongs to the ORDINARY subscription product. Pay-on-approval is journey 3 of Pix
      // Automático, selected by `pixRecurringOptions.journey` under `type: 'PIX_RECURRING'`.
      type: 'PIX_RECURRING',
      pixRecurringOptions: { journey: 'PAYMENT_ON_APPROVAL' },
      frequency: 'MONTHLY',
    });
    expect(payload).not.toHaveProperty('chargeType');
    expect(payload.dayGenerateCharge).toBeGreaterThanOrEqual(1);
    expect(subscription.gatewayId).toBe('UGF5bWVudFN1YnNjcmlwdGlvbjox');
  });

  it('throws a clear error when a Woovi subscription lacks the payer name/taxId', async () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    await expect(driver.createSubscription({ customerId: 'cus_1', amount: 4990 })).rejects.toThrow(
      /name \+ taxId/,
    );
  });

  it('refuses to update a subscription instead of reporting a change the gateway never saw', async () => {
    createClientMock.subscription.get.mockClear();
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    await expect(driver.updateSubscription('sub_1', { amount: 9990 })).rejects.toThrow(
      /does not support updating a subscription/,
    );
    expect(createClientMock.subscription.get).not.toHaveBeenCalled();
  });

  it('refuses to cancel a subscription instead of canceling it only locally', async () => {
    createClientMock.subscription.get.mockClear();
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    // This used to fetch, flip status to INACTIVE on the local copy, publish
    // `subscription.canceled`, and return it — so the billing row went to canceled, the app
    // stopped entitling the customer, and Woovi carried on charging them.
    await expect(driver.cancelSubscription('sub_1')).rejects.toThrow(
      /does not support canceling a subscription/,
    );
    expect(
      createClientMock.subscription.get,
      'a refusal must not even reach the gateway',
    ).not.toHaveBeenCalled();
  });

  it('creates and lists subaccounts (OpenPix for Platforms)', async () => {
    createClientMock.subAccount = {
      create: vi.fn().mockResolvedValue({
        SubAccount: { name: 'Partner', pixKey: 'partner@example.com', balance: 0 },
      }),
      get: vi.fn(),
      list: vi.fn().mockResolvedValue({
        subAccounts: [{ name: 'Partner', pixKey: 'partner@example.com', balance: 0 }],
      }),
    };
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    const created = await driver.createSubAccount({
      pixKey: 'partner@example.com',
      name: 'Partner',
    });
    expect(created).toEqual({ name: 'Partner', pixKey: 'partner@example.com', balance: 0 });
    expect(createClientMock.subAccount.create).toHaveBeenCalledWith({
      pixKey: 'partner@example.com',
      name: 'Partner',
    });

    const list = await driver.listSubAccounts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Partner' });
  });

  /**
   * The bug this pins: the driver documents itself as Pix Automático and translates the
   * `PIX_AUTOMATIC_*` webhooks, but the body it sent had neither `type: 'PIX_RECURRING'` nor
   * `pixRecurringOptions` — so the same endpoint created an ORDINARY subscription that mails
   * a link every cycle. Those webhooks only fire for `PIX_RECURRING`, so every event the
   * driver knew how to handle was one the gateway had no reason to send, and the recurring
   * debit never happened. Nothing failed loudly; the subscription simply sat there.
   */
  it('creates a Pix Automático subscription, not the link-per-cycle kind', async () => {
    createClientMock.subscription.create.mockResolvedValue({
      subscription: { globalID: 'UGF5bWVudFN1YnNjcmlwdGlvbjox', value: 9900, status: 'ACTIVE' },
    });
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    await driver.createSubscription({
      customerId: 'cus_1',
      planId: 'tier:pro',
      amount: 9900,
      cycle: 'MONTHLY',
      description: 'Assinatura Pro',
      externalReference: 'sub:abc',
      customer: {
        name: 'Fulana',
        email: 'fulana@example.com',
        taxId: '249.715.637-92',
        address: { zipcode: '04556300', street: 'Rua SP', number: '3432', city: 'Sao Paulo' },
      },
    });

    const body = createClientMock.subscription.create.mock.calls.at(-1)![0];
    expect(body).toMatchObject({
      type: 'PIX_RECURRING',
      frequency: 'MONTHLY',
      pixRecurringOptions: { journey: 'PAYMENT_ON_APPROVAL', retryPolicy: 'NON_PERMITED' },
    });
    // The API accepts `correlationID` and echoes it on every `PIX_AUTOMATIC_COBR_*` webhook.
    // The SDK's `CreatePayload` type just does not declare it, so it used to be dropped — and
    // an app that routes webhooks by its own reference could not recognise its own renewals.
    expect(body).toMatchObject({ correlationID: 'sub:abc' });
    // `PIX_RECURRING` is a bank mandate: it carries the payer's address or it is refused.
    expect(body.customer).toMatchObject({
      taxID: '24971563792',
      address: { zipcode: '04556300' },
    });
  });

  /**
   * Same field name, two vocabularies. The ordinary subscription product spells these
   * `TRIMONTHLY` / `SEMIANUALY` / `ANNUALY` (the last two really are a letter short at the
   * gateway); `PIX_RECURRING` uses the ordinary spellings. Sending the old map under
   * `PIX_RECURRING` is a rejected enum.
   */
  it('spells frequency the way PIX_RECURRING expects', async () => {
    createClientMock.subscription.create.mockResolvedValue({ subscription: { globalID: 'x' } });
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    for (const [cycle, expected] of [
      ['QUARTERLY', 'QUARTERLY'],
      ['SEMIANNUALLY', 'SEMIANNUALLY'],
      ['YEARLY', 'ANNUALLY'],
    ] as const) {
      createClientMock.subscription.create.mockClear();
      await driver.createSubscription({
        customerId: 'cus_1',
        planId: 'p',
        amount: 100,
        cycle,
        customer: { name: 'F', taxId: '24971563792' },
      });
      expect(createClientMock.subscription.create.mock.calls.at(-1)![0]).toMatchObject({
        frequency: expected,
      });
    }
  });

  /** `comment` is the contract text in the payer's bank app and the gateway caps it at 30. */
  it('truncates the adoption-contract comment instead of failing the subscription', async () => {
    createClientMock.subscription.create.mockResolvedValue({ subscription: { globalID: 'x' } });
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    await driver.createSubscription({
      customerId: 'cus_1',
      planId: 'p',
      amount: 100,
      description: 'Assinatura Entre Textos - Plano Profissional + mentor dedicado',
      customer: { name: 'F', taxId: '24971563792' },
    });

    const body = createClientMock.subscription.create.mock.calls.at(-1)![0] as {
      comment: string;
      name: string;
    };
    expect(body.comment).toHaveLength(30);
    // Only `comment` is capped — `name` keeps the full label.
    expect(body.name).toBe('Assinatura Entre Textos - Plano Profissional + mentor dedicado');
  });

  /** The escape hatch for the ordinary product, so this is not a one-way door. */
  it('still creates the plain subscription with metadata.pixAutomatic false', async () => {
    createClientMock.subscription.create.mockResolvedValue({ subscription: { globalID: 'x' } });
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    await driver.createSubscription({
      customerId: 'cus_1',
      planId: 'p',
      amount: 100,
      cycle: 'QUARTERLY',
      customer: { name: 'F', taxId: '24971563792' },
      metadata: { pixAutomatic: false },
    });

    const body = createClientMock.subscription.create.mock.calls.at(-1)![0];
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('pixRecurringOptions');
    expect(body).toMatchObject({ chargeType: 'DYNAMIC', frequency: 'TRIMONTHLY' });
  });
});
