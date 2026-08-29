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

  it('creates a Pix Automático subscription with the payer customer and pay-on-approval (DYNAMIC)', async () => {
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
      amount: 4990,
      cycle: 'MONTHLY',
      startDate: '2026-09-15',
      customer: { name: 'Jane Doe', email: 'jane@example.com', taxId: '123.456.789-00' },
    });

    const payload = createClientMock.subscription.create.mock.calls[0]![0];
    expect(payload).toMatchObject({
      customer: { name: 'Jane Doe', email: 'jane@example.com', taxID: '12345678900' },
      // Centavos, not reais. R$49,90 is 4990 — sending 49.9 created a 50 centavo
      // subscription at the gateway.
      value: 4990,
      chargeType: 'DYNAMIC',
      frequency: 'MONTHLY',
    });
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
});
