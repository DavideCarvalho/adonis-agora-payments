import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PaymentsProvider from '../providers/payments_provider.js';
import { CARD_SCRIPT } from '../src/account_console/card_script.js';
import { issueCardTicket, verifyCardTicket } from '../src/account_console/card_ticket.js';
import type {
  AccountActionResult,
  AccountExtension,
  AccountExtensionContext,
  AccountPage,
  Block,
} from '../src/account_console/contract.js';
import {
  type PaymentsAccountConsoleOptions,
  paymentsAccountExtension,
} from '../src/account_console/extension.js';
import {
  handleCardTokenize,
  resetCardTokenizeAttempts,
} from '../src/account_console/tokenize_endpoint.js';
import type { BillingStore } from '../src/billing/billing_store.js';
import type { PaymentsConfig } from '../src/define_config.js';
import type {
  CardSetupInput,
  CardSetupSession,
  CardUpdateUrlInput,
  SaveCardInput,
  SavedCard,
  TokenizeCardInput,
} from '../src/driver.js';
import { PaymentsManager } from '../src/payments_manager.js';
import { resetPayments, setWebhookDispatcher } from '../src/services/main.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { TokenizedCard } from '../src/types.js';

const SECRET = 'test-secret-key-0123456789';
const TENANCY = Symbol.for('@agora/context:tenancy');

class CardDriver extends FakePaymentsDriver {
  saved: SaveCardInput[] = [];
  setups: CardSetupInput[] = [];
  async cardSetup(input: CardSetupInput): Promise<CardSetupSession> {
    this.setups.push(input);
    return { scripts: [{ src: 'https://js.stripe.com/v3/' }], props: { publishableKey: 'pk_1' } };
  }
  async saveCard(input: SaveCardInput): Promise<SavedCard> {
    this.saved.push(input);
    return { paymentMethodId: `pm_for_${input.token}`, brand: 'visa', last4: '4242' };
  }
}

class PortalDriver extends FakePaymentsDriver {
  async cardUpdateUrl(input: CardUpdateUrlInput): Promise<string> {
    return `https://billing.example/portal/${input.customerId}`;
  }
}

class AsaasLike extends CardDriver {
  tokenized: TokenizeCardInput[] = [];
  constructor() {
    super({ provider: 'asaas' });
  }
  async tokenizeCard(input: TokenizeCardInput): Promise<TokenizedCard> {
    this.tokenized.push(input);
    return { token: 'cc_tok_1', last4: input.card.number.slice(-4), brand: 'VISA' };
  }
}

function ctxFor(
  accountId: string,
  overrides: Partial<AccountExtensionContext> = {},
): AccountExtensionContext {
  return {
    account: { id: accountId, email: `${accountId}@x.test`, name: 'Ana', roles: [] },
    activeOrg: null,
    subject: { type: 'User', id: accountId },
    impersonatedBy: null,
    locale: 'en',
    query: {},
    url: (pageId, query) =>
      `/account/${pageId}${query ? `?${new URLSearchParams(query).toString()}` : ''}`,
    make: async () => undefined,
    now: () => new Date('2026-11-12T00:00:00Z'),
    ...overrides,
  };
}

async function setup(
  options: PaymentsAccountConsoleOptions = {},
  driver: FakePaymentsDriver = new CardDriver({ provider: 'fake' }),
) {
  const store = new InMemoryBillingStore() as unknown as BillingStore;
  const name = driver.provider;
  const manager = new PaymentsManager({
    drivers: new Map([[name, driver]]),
    store: () => store,
  });
  await store.saveCustomer({
    gatewayId: 'cus_ana',
    provider: name,
    ownerType: 'User',
    ownerId: 'ana',
  });
  await store.saveCustomer({
    gatewayId: 'cus_bob',
    provider: name,
    ownerType: 'User',
    ownerId: 'bob',
  });
  const managed = await store.createManagedSubscription({
    provider: name,
    customerId: 'cus_ana',
    status: 'active',
    planId: 'basic',
    amount: 1000,
    currency: 'brl',
    cycle: 'MONTHLY',
    currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    nextChargeAt: new Date('2026-12-01T00:00:00Z'),
    paymentMethodId: 'pm_old',
  });
  const bobs = await store.createManagedSubscription({
    provider: name,
    customerId: 'cus_bob',
    status: 'active',
    planId: 'basic',
    amount: 1000,
    currency: 'brl',
    cycle: 'MONTHLY',
    currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    nextChargeAt: new Date('2026-12-01T00:00:00Z'),
  });
  const extension = paymentsAccountExtension({
    manager: async () => manager,
    store: () => store,
    options: {
      plans: [
        { id: 'basic', label: 'Basic', amount: 1000, currency: 'BRL' },
        { id: 'pro', label: 'Pro', amount: 3000, currency: 'BRL', description: 'Pro plan' },
      ],
      ...options,
    },
    secret: SECRET,
  });
  const page = (id: string) => extension.pages.find((p) => p.id === id) as AccountPage;
  const customers = await store.listCustomers({});
  const anaCustomer = customers.find((c) => c.gatewayId === 'cus_ana')!;
  const bobCustomer = customers.find((c) => c.gatewayId === 'cus_bob')!;
  return { store, manager, extension, page, managed, bobs, driver, anaCustomer, bobCustomer };
}

const run = (
  page: AccountPage,
  action: string,
  ctx: AccountExtensionContext,
  target: string | null,
  fields: Record<string, string> = {},
): Promise<AccountActionResult> => page.actions![action]!.handle(ctx, { target, fields });

const blocksOf = async (page: AccountPage, ctx: AccountExtensionContext) =>
  (await page.load(ctx)).blocks as Block[];

describe('payments account console — pages', () => {
  it('registers billing, payment method and invoices with flat segments', async () => {
    const { extension } = await setup();
    expect(extension.id).toBe('payments');
    expect(extension.pages.map((p) => [p.id, p.segment])).toEqual([
      ['payments.subscription', 'billing'],
      ['payments.card', 'payment-method'],
      ['payments.invoices', 'invoices'],
    ]);
    expect(extension.scriptOrigins).toContain('https://js.stripe.com');
    for (const [locale, catalog] of Object.entries(extension.messages!)) {
      expect(locale === 'en' || locale === 'pt-BR').toBe(true);
      for (const key of Object.keys(catalog)) expect(key.startsWith('payments.')).toBe(true);
    }
    expect(Object.keys(extension.messages!['pt-BR']!).sort()).toEqual(
      Object.keys(extension.messages!.en!).sort(),
    );
  });

  it('hides the pages from an account with no customer', async () => {
    const { page } = await setup();
    expect(await page('payments.subscription').visible!(ctxFor('carla'))).toBe(false);
    expect(await page('payments.subscription').visible!(ctxFor('ana'))).toBe(true);
  });

  it('shows the subscription with its actions, all on by default', async () => {
    const { page, managed, anaCustomer } = await setup();
    const blocks = await blocksOf(page('payments.subscription'), ctxFor('ana'));
    const card = blocks.find((b) => b.kind === 'keyValue') as Extract<Block, { kind: 'keyValue' }>;
    expect(card.rows[0]!.value).toEqual({ type: 'text', text: 'Basic' });
    expect(card.rows[1]!.value).toEqual({ type: 'money', amount: 1000, currency: 'BRL' });
    expect(card.actions).toEqual([
      { action: 'cancel', target: managed.id },
      { action: 'changePlan', target: managed.id },
      { action: 'updateMethod', target: anaCustomer.id },
    ]);
    expect(blocks.at(-1)).toMatchObject({ kind: 'link', href: '/account/payments.invoices' });
  });

  it('confirm + sudo on everything that moves money', async () => {
    const { page } = await setup();
    const actions = page('payments.subscription').actions!;
    expect(actions.cancel).toMatchObject({ sudo: true, tone: 'danger' });
    expect(actions.cancel!.confirm).toBeDefined();
    expect(actions.resume).toMatchObject({ sudo: true });
    expect(actions.resume!.confirm).toBeDefined();
    expect(actions.changePlan).toMatchObject({ sudo: true });
    expect(actions.changePlan!.confirm).toBeDefined();
    expect(actions.updateMethod).toMatchObject({ sudo: true });
    expect(page('payments.card').actions!.saveCard).toMatchObject({ sudo: true });
  });

  it('lets the app turn single actions and pages off', async () => {
    const { extension } = await setup({
      actions: { cancel: false, updateMethod: false },
      pages: { invoices: false },
    });
    const billing = extension.pages.find((p) => p.id === 'payments.subscription')!;
    expect(Object.keys(billing.actions!)).toEqual(['resume', 'changePlan']);
    expect(extension.pages.map((p) => p.id)).toEqual(['payments.subscription']);
  });

  it('offers no plan change with fewer than two plans', async () => {
    const { page } = await setup({
      plans: [{ id: 'basic', label: 'B', amount: 1, currency: 'BRL' }],
    });
    expect(page('payments.subscription').actions!.changePlan).toBeUndefined();
  });
});

describe('payments account console — actions', () => {
  it('cancels at period end and resumes a managed subscription', async () => {
    const { page, managed, store } = await setup();
    const billing = page('payments.subscription');
    expect(await run(billing, 'cancel', ctxFor('ana'), managed.id)).toMatchObject({ ok: true });
    expect((await store.findSubscriptionById(managed.id))!.cancelAtPeriodEnd).toBe(true);
    const blocks = await blocksOf(billing, ctxFor('ana'));
    expect(blocks[0]).toMatchObject({ kind: 'notice', tone: 'warning' });
    const card = blocks.find((b) => b.kind === 'keyValue') as Extract<Block, { kind: 'keyValue' }>;
    expect(card.actions).toEqual([
      { action: 'resume', target: managed.id },
      { action: 'updateMethod', target: expect.any(String) },
    ]);
    expect(await run(billing, 'resume', ctxFor('ana'), managed.id)).toMatchObject({ ok: true });
    expect((await store.findSubscriptionById(managed.id))!.cancelAtPeriodEnd).toBe(false);
    const audit = await store.listAuditEvents({});
    expect(audit.map((e) => [e.action, e.actor])).toEqual(
      expect.arrayContaining([
        ['account.subscription_canceled', 'account:ana'],
        ['account.subscription_resumed', 'account:ana'],
      ]),
    );
  });

  it("answers 404 for another account's subscription (IDOR)", async () => {
    const { page, bobs, store } = await setup();
    const billing = page('payments.subscription');
    for (const action of ['cancel', 'resume', 'changePlan']) {
      expect(await run(billing, action, ctxFor('ana'), bobs.id, { plan: 'pro' })).toMatchObject({
        ok: false,
        status: 404,
      });
    }
    expect((await store.findSubscriptionById(bobs.id))!.cancelAtPeriodEnd).toBeFalsy();
    expect(await run(billing, 'cancel', ctxFor('ana'), null)).toMatchObject({ status: 404 });
  });

  it('cancels a gateway-owned subscription at the gateway, at period end', async () => {
    const driver = new CardDriver({ provider: 'fake' });
    const { page, store } = await setup({}, driver);
    const row = await store.saveSubscription({
      gatewayId: 'sub_gw',
      provider: 'fake',
      customerId: 'cus_ana',
      status: 'active',
      planId: 'basic',
    });
    expect(await run(page('payments.subscription'), 'cancel', ctxFor('ana'), row.id)).toMatchObject(
      {
        ok: true,
      },
    );
    expect(driver.cancelSubscriptionCalls).toEqual([
      { id: 'sub_gw', options: { atPeriodEnd: true } },
    ]);
  });

  it('changes the plan of a managed subscription', async () => {
    const { page, managed, store } = await setup();
    const billing = page('payments.subscription');
    expect(
      await run(billing, 'changePlan', ctxFor('ana'), managed.id, { plan: 'basic' }),
    ).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(
      await run(billing, 'changePlan', ctxFor('ana'), managed.id, { plan: 'nope' }),
    ).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      await run(billing, 'changePlan', ctxFor('ana'), managed.id, { plan: 'pro' }),
    ).toMatchObject({
      ok: true,
    });
    const row = (await store.findSubscriptionById(managed.id)) as unknown as {
      amount: number;
      planId: string;
      description: string;
    };
    expect([row.amount, row.planId, row.description]).toEqual([3000, 'pro', 'Pro plan']);
  });

  it('hands a plan change to the app hook when there is one', async () => {
    const calls: string[] = [];
    const { page, managed } = await setup({
      changePlan: async ({ subscription, plan, owner }) => {
        calls.push(`${subscription.id}:${plan.id}:${owner.type}:${owner.id}`);
      },
    });
    await run(page('payments.subscription'), 'changePlan', ctxFor('ana'), managed.id, {
      plan: 'pro',
    });
    expect(calls).toEqual([`${managed.id}:pro:User:ana`]);
  });

  it('turns a gateway refusal into a translated error, never the gateway text', async () => {
    const driver = new CardDriver({ provider: 'fake' });
    driver.cancelSubscription = async () => {
      throw new Error('secret gateway detail');
    };
    const { page, store } = await setup({}, driver);
    const row = await store.saveSubscription({
      gatewayId: 'sub_gw',
      provider: 'fake',
      customerId: 'cus_ana',
      status: 'active',
      planId: 'basic',
    });
    expect(await run(page('payments.subscription'), 'cancel', ctxFor('ana'), row.id)).toEqual({
      ok: false,
      status: 409,
      error: { key: 'payments.action.failed' },
    });
  });
});

describe('payments account console — organizations', () => {
  const slot = (enabled: boolean) => ({
    version: 1,
    tenancy: () => ({ enabled, kinds: ['organization'] }),
    tenantFilter: () => ({ mode: 'tenantless' }),
  });
  beforeEach(() => {
    (globalThis as Record<symbol, unknown>)[TENANCY] = slot(true);
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[TENANCY];
  });

  async function orgSetup() {
    const ctx = await setup();
    await ctx.store.saveCustomer({
      gatewayId: 'cus_org',
      provider: 'fake',
      ownerType: 'organization',
      ownerId: 'org_1',
    });
    await ctx.store.createManagedSubscription({
      provider: 'fake',
      customerId: 'cus_org',
      status: 'active',
      planId: 'pro',
      amount: 3000,
      currency: 'brl',
      cycle: 'MONTHLY',
      currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
      nextChargeAt: new Date('2026-12-01T00:00:00Z'),
    });
    return ctx;
  }

  it('bills the active organization, for its admins, instead of the user', async () => {
    const { page } = await orgSetup();
    const admin = ctxFor('ana', {
      activeOrg: { id: 'org_1', slug: 'acme', role: 'admin' },
      tenant: { id: 'org_1', kind: 'organization', source: 'authkit', role: 'admin' },
    });
    const blocks = await blocksOf(page('payments.subscription'), admin);
    const card = blocks.find((b) => b.kind === 'keyValue') as Extract<Block, { kind: 'keyValue' }>;
    expect(card.rows[0]!.value).toEqual({ type: 'text', text: 'Pro' });
  });

  it('shows a member a notice and refuses their actions', async () => {
    const { page, managed } = await orgSetup();
    const member = ctxFor('ana', { activeOrg: { id: 'org_1', slug: 'acme', role: 'member' } });
    const blocks = await blocksOf(page('payments.subscription'), member);
    expect(blocks).toEqual([
      { kind: 'notice', tone: 'info', text: { key: 'payments.billing.org_only' } },
    ]);
    expect(await run(page('payments.subscription'), 'cancel', member, managed.id)).toMatchObject({
      status: 404,
    });
  });
});

describe('payments account console — card', () => {
  it('renders the gateway component and saves the card in place', async () => {
    const driver = new CardDriver({ provider: 'fake' });
    const { page, managed, store, anaCustomer } = await setup({}, driver);
    const billing = page('payments.subscription');
    expect(await run(billing, 'updateMethod', ctxFor('ana'), anaCustomer.id)).toEqual({
      ok: true,
      redirectTo: { page: 'payments.card' },
    });
    const card = page('payments.card');
    expect(card.nav).toBe(false);
    const blocks = await blocksOf(card, ctxFor('ana'));
    const component = blocks.find((b) => b.kind === 'component') as Extract<
      Block,
      { kind: 'component' }
    >;
    expect(component.provider).toBe('payments-card');
    expect(component.scripts).toEqual([
      { src: 'https://js.stripe.com/v3/' },
      { src: '/payments/account/card.js' },
    ]);
    expect(component.props).toMatchObject({
      gateway: 'fake',
      publishableKey: 'pk_1',
      target: anaCustomer.id,
    });
    expect(component.submit).toEqual({ action: 'saveCard', target: anaCustomer.id });

    const saved = await run(card, 'saveCard', ctxFor('ana'), `${anaCustomer.id}~seti_1`);
    expect(saved).toMatchObject({ ok: true, redirectTo: { page: 'payments.subscription' } });
    expect(driver.saved).toEqual([
      { customerId: 'cus_ana', token: 'seti_1', subscriptionGatewayIds: [] },
    ]);
    const row = (await store.findSubscriptionById(managed.id)) as unknown as {
      paymentMethodId: string;
    };
    expect(row.paymentMethodId).toBe('pm_for_seti_1');
  });

  it("refuses another account's customer and a malformed target", async () => {
    const { page, bobCustomer } = await setup();
    const card = page('payments.card');
    expect(await run(card, 'saveCard', ctxFor('ana'), `${bobCustomer.id}~seti_1`)).toMatchObject({
      status: 404,
    });
    expect(await run(card, 'saveCard', ctxFor('ana'), 'garbage')).toMatchObject({ status: 404 });
    expect(
      await run(page('payments.subscription'), 'updateMethod', ctxFor('ana'), bobCustomer.id),
    ).toMatchObject({ status: 404 });
  });

  it('redirects to the gateway page for gateways without a component', async () => {
    const { page, anaCustomer } = await setup({}, new PortalDriver({ provider: 'fake' }));
    expect(await page('payments.card').visible!(ctxFor('ana'))).toBe(false);
    expect(
      await run(page('payments.subscription'), 'updateMethod', ctxFor('ana'), anaCustomer.id),
    ).toEqual({ ok: true, redirectTo: { external: 'https://billing.example/portal/cus_ana' } });
  });

  it('offers no card update when the gateway has neither', async () => {
    const { page } = await setup({}, new FakePaymentsDriver({ provider: 'fake' }));
    const blocks = await blocksOf(page('payments.subscription'), ctxFor('ana'));
    const card = blocks.find((b) => b.kind === 'keyValue') as Extract<Block, { kind: 'keyValue' }>;
    expect(card.actions!.map((a) => a.action)).not.toContain('updateMethod');
  });

  it('tokenizes server-side for Asaas and only ever sends a sealed token through the page', async () => {
    resetCardTokenizeAttempts();
    const driver = new AsaasLike();
    const { page, anaCustomer } = await setup({}, driver);
    const blocks = await blocksOf(page('payments.card'), ctxFor('ana'));
    const component = blocks.find((b) => b.kind === 'component') as Extract<
      Block,
      { kind: 'component' }
    >;
    expect(component.props).toMatchObject({
      gateway: 'asaas',
      tokenizeUrl: '/payments/account/card/tokenize',
      sameOrigin: true,
    });
    const ticket = component.props!.ticket as string;
    const response = await handleCardTokenize(
      {
        header: (name) => (name === 'x-payments-card-ticket' ? ticket : null),
        ip: '203.0.113.9',
        body: {
          number: '4111 1111 1111 1111',
          holderName: 'Ana',
          expiry: '12/30',
          cvc: '123',
          holder: {
            email: 'ana@x.test',
            cpfCnpj: '123.456.789-09',
            postalCode: '01001-000',
            addressNumber: '10',
            phone: '(11) 99999-9999',
          },
        },
      },
      { driver: async () => driver, secret: SECRET },
    );
    expect(response.status).toBe(200);
    const sealed = (response.body as { token: string }).token;
    expect(sealed).not.toContain('cc_tok_1');
    expect(driver.tokenized[0]).toMatchObject({
      customerId: 'cus_ana',
      card: { number: '4111111111111111', expiryMonth: '12', expiryYear: '2030' },
      remoteIp: '203.0.113.9',
    });
    expect(
      await run(page('payments.card'), 'saveCard', ctxFor('ana'), `${anaCustomer.id}~${sealed}`),
    ).toMatchObject({ ok: true });
    expect(driver.saved[0]).toMatchObject({ token: 'cc_tok_1', remoteIp: '203.0.113.9' });
    // A tampered seal opens to nothing.
    const tampered = `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}`;
    expect(
      await run(page('payments.card'), 'saveCard', ctxFor('ana'), `${anaCustomer.id}~${tampered}`),
    ).toMatchObject({ ok: false });
  });

  it('refuses forged, expired and over-used tickets', async () => {
    resetCardTokenizeAttempts();
    const driver = new AsaasLike();
    const ticket = issueCardTicket(SECRET, {
      customerId: 'c',
      provider: 'asaas',
      expiresAt: 2_000,
    });
    expect(verifyCardTicket(SECRET, ticket, 1_000)).toMatchObject({ customerId: 'c' });
    expect(verifyCardTicket(SECRET, ticket, 3_000)).toBeNull();
    expect(verifyCardTicket('other', ticket, 1_000)).toBeNull();
    const call = () =>
      handleCardTokenize(
        { header: () => ticket, ip: '1.1.1.1', body: {} },
        { driver: async () => driver, secret: SECRET, now: () => 1_000 },
      );
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await call()).status);
    expect(statuses).toEqual([422, 422, 422, 422, 422, 429]);
    expect(driver.tokenized).toEqual([]);
  });

  it('caps attempts per customer, so a fresh ticket does not reset the budget', async () => {
    resetCardTokenizeAttempts();
    const driver = new AsaasLike();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const ticket = issueCardTicket(SECRET, {
        customerId: 'c',
        provider: 'asaas',
        expiresAt: 9_999_000 + i,
      });
      const response = await handleCardTokenize(
        { header: () => ticket, ip: `10.0.0.${i}`, body: {} },
        { driver: async () => driver, secret: SECRET, now: () => 1_000 },
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('offers the in-place form only when the gateway can move every running subscription', async () => {
    class ManagedOnly extends CardDriver {
      constructor() {
        super({
          provider: 'fake',
          capabilities: { cardUpdate: { managed: true, gateway: false } },
        });
      }
    }
    class GatewayOnly extends PortalDriver {
      saveCard = CardDriver.prototype.saveCard;
      cardSetup = CardDriver.prototype.cardSetup;
      saved: SaveCardInput[] = [];
      setups: CardSetupInput[] = [];
      constructor() {
        super({
          provider: 'fake',
          capabilities: { cardUpdate: { managed: false, gateway: true } },
        });
      }
    }
    const managedOnly = await setup({}, new ManagedOnly());
    expect(await managedOnly.page('payments.card').visible!(ctxFor('ana'))).toBe(true);
    await managedOnly.store.saveSubscription({
      gatewayId: 'sub_gw',
      provider: 'fake',
      customerId: 'cus_ana',
      status: 'active',
      planId: 'basic',
    });
    expect(await managedOnly.page('payments.card').visible!(ctxFor('ana'))).toBe(false);

    // Only managed subscriptions, on a gateway that moves gateway ones only: its own page instead.
    const gatewayOnly = await setup({}, new GatewayOnly());
    expect(await gatewayOnly.page('payments.card').visible!(ctxFor('ana'))).toBe(false);
    expect(
      await run(
        gatewayOnly.page('payments.subscription'),
        'updateMethod',
        ctxFor('ana'),
        gatewayOnly.anaCustomer.id,
      ),
    ).toEqual({ ok: true, redirectTo: { external: 'https://billing.example/portal/cus_ana' } });
  });

  it('ships a card script that parses and knows every gateway with a component', () => {
    expect(() => new Function(CARD_SCRIPT)).not.toThrow();
    for (const gateway of ['stripe', 'asaas', 'pagarme', 'mercadopago', 'square', 'paypal']) {
      expect(CARD_SCRIPT).toContain(`mounters['${gateway}']`);
    }
  });
});

describe('payments account console — invoices', () => {
  it('lists payments and gateway invoices, and downloads only the account’s own', async () => {
    const driver = new CardDriver({ provider: 'fake' });
    driver.invoices = [
      {
        id: 'in_1',
        gatewayId: 'in_1',
        provider: 'fake',
        customerId: 'cus_ana',
        status: 'paid',
        amount: { amount: 1000, currency: 'brl' },
        createdAt: '2026-11-01T00:00:00Z',
        hostedPdfUrl: 'https://files.example/in_1.pdf',
        payload: {},
      },
    ];
    const { page, store, anaCustomer, bobCustomer } = await setup(
      { invoiceUrl: (p) => `https://nfse.example/${p.gatewayId}` },
      driver,
    );
    await store.savePayment({
      gatewayId: 'pay_ana',
      provider: 'fake',
      status: 'paid',
      amount: 1000,
      currency: 'brl',
      customerId: 'cus_ana',
      paidAt: new Date('2026-11-01T00:00:00Z'),
    });
    await store.savePayment({
      gatewayId: 'pay_bob',
      provider: 'fake',
      status: 'paid',
      amount: 1000,
      currency: 'brl',
      customerId: 'cus_bob',
    });
    const invoices = page('payments.invoices');
    const view = await invoices.load(ctxFor('ana'));
    expect(view.tabs!.map((t) => t.id)).toEqual([
      `payments-${anaCustomer.id}`,
      `invoices-${anaCustomer.id}`,
    ]);
    const table = view.blocks[0] as Extract<Block, { kind: 'table' }>;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.actions).toEqual([{ action: 'download', target: 'payment~pay_ana' }]);
    expect(await run(invoices, 'download', ctxFor('ana'), 'payment~pay_ana')).toEqual({
      ok: true,
      redirectTo: { external: 'https://nfse.example/pay_ana' },
    });
    expect(await run(invoices, 'download', ctxFor('ana'), 'payment~pay_bob')).toMatchObject({
      status: 404,
    });

    const gatewayView = await invoices.load(
      ctxFor('ana', { query: { tab: `invoices-${anaCustomer.id}` } }),
    );
    const gatewayTable = gatewayView.blocks[0] as Extract<Block, { kind: 'table' }>;
    expect(gatewayTable.rows[0]!.actions).toEqual([
      { action: 'download', target: `invoice~${anaCustomer.id}~in_1` },
    ]);
    expect(
      await run(invoices, 'download', ctxFor('ana'), `invoice~${anaCustomer.id}~in_1`),
    ).toEqual({ ok: true, redirectTo: { external: 'https://files.example/in_1.pdf' } });
    expect(
      await run(invoices, 'download', ctxFor('ana'), `invoice~${bobCustomer.id}~in_1`),
    ).toMatchObject({ status: 404 });
  });
});

describe('payments account console — registration', () => {
  afterEach(() => {
    resetPayments();
    setWebhookDispatcher(undefined);
  });

  function fakeApp(
    config: PaymentsConfig,
    registry?: { register(e: AccountExtension): void; contract: number },
  ) {
    const bindings = new Map<unknown, () => unknown>();
    if (registry) bindings.set('authkit.accountExtensions', () => registry);
    const routes: string[] = [];
    return {
      routes,
      app: {
        config: { get: (key: string) => (key === 'payments' ? config : undefined) },
        booted: async (callback: () => Promise<void>) => callback(),
        makePath: (...parts: string[]) => `/nonexistent/${parts.join('/')}`,
        container: {
          singleton: (token: unknown, factory: () => unknown) => {
            let built: { value: unknown } | undefined;
            bindings.set(token, async () => {
              if (!built) built = { value: await factory() };
              return built.value;
            });
          },
          alias: () => {},
          hasBinding: (token: unknown) => bindings.has(token),
          make: async (token: unknown) => {
            if (token === 'router') {
              const add = (path: string) => {
                routes.push(path);
                return { as: () => {} };
              };
              return { post: add, get: add, route: add };
            }
            const factory = bindings.get(token);
            if (!factory) throw new Error(`nothing bound for ${String(token)}`);
            return factory();
          },
        },
      } as unknown as ApplicationService,
    };
  }

  const config: PaymentsConfig = {
    providers: { fake: async () => new FakePaymentsDriver({ provider: 'fake' }) },
    billing: { store: () => new InMemoryBillingStore() },
  };

  it('registers when authkit’s registry is bound, and mounts the card routes', async () => {
    const registered: AccountExtension[] = [];
    const { app, routes } = fakeApp(config, { contract: 1, register: (e) => registered.push(e) });
    const provider = new PaymentsProvider(app);
    provider.register();
    await provider.boot();
    expect(registered.map((e) => e.id)).toEqual(['payments']);
    expect(routes).toEqual(
      expect.arrayContaining(['/payments/account/card.js', '/payments/account/card/tokenize']),
    );
  });

  it('does nothing without authkit, or with accountConsole: false', async () => {
    const alone = fakeApp(config);
    const provider = new PaymentsProvider(alone.app);
    provider.register();
    await provider.boot();
    expect(alone.routes).not.toContain('/payments/account/card.js');

    const registered: AccountExtension[] = [];
    const off = fakeApp(
      { ...config, accountConsole: false },
      { contract: 1, register: (e) => registered.push(e) },
    );
    const second = new PaymentsProvider(off.app);
    second.register();
    await second.boot();
    expect(registered).toEqual([]);
    expect(off.routes).not.toContain('/payments/account/card.js');
  });

  it('never imports authkit at runtime', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'account_console');
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/from '@adonis-agora\/authkit/);
    }
    const provider = readFileSync(
      join(import.meta.dirname, '..', 'providers', 'payments_provider.ts'),
      'utf8',
    );
    expect(provider).not.toMatch(/from '@adonis-agora\/authkit/);
  });
});
