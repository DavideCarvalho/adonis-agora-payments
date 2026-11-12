import {
  currentTenantOwner,
  type PaymentsTenancyOption,
  resolvePaymentsTenancy,
} from './agora/tenancy.js';
import type { BillingStore } from './billing/billing_store.js';
import type { CreateCustomerInput, PaymentsDriver } from './driver.js';
import { findPayments } from './services/main.js';
import type { Customer } from './types.js';

/** Recording options for {@link ensureCustomer}. */
export interface EnsureCustomerOptions {
  /**
   * Record the mapping in `billing_customers`.
   *
   * This is the only thing that writes that table, and it is opt-in: the library cannot
   * know which of your rows owns a gateway customer, and guessing would produce a mapping
   * nobody can trust. `@inject()` the store and pass it — see the billing docs.
   */
  store?: BillingStore;
  /**
   * The app-side row this customer belongs to, e.g. `{ type: 'User', id: user.id }`.
   *
   * Without it the row still records the gateway id and provider (enough for
   * `payments:sync --all` to reconcile over), but nothing maps it back to your data.
   *
   * With tenancy on and no `owner`, the customer belongs to the active organization
   * (`{ type: ownerType(tenant), id: tenant.id }`). An explicit `owner` always wins.
   */
  owner?: { type: string; id: string | number };
  /**
   * The tenancy option to apply when `owner` is absent. Default: the app's `config/payments.ts`
   * `tenancy` (`'inherit'` when payments has not booted).
   */
  tenancy?: PaymentsTenancyOption;
}

/**
 * Get-or-create a gateway customer: when the app already stores a gateway customer id,
 * return it as-is; otherwise create the customer at the gateway and return the created
 * record (so the caller persists the new id).
 *
 * The app owns the mapping between its users and gateway customer ids — this helper only
 * does the "reuse or create" branch every payments flow needs:
 *
 * ```ts
 * const customer = await ensureCustomer(driver, user.asaasCustomerId, {
 *   name: user.fullName,
 *   email: user.email,
 *   taxId: user.cpfCnpj ?? undefined,
 *   metadata: { phone: user.phone },
 * })
 * user.asaasCustomerId = customer.id
 * await user.save()
 * ```
 *
 * Pass a `store` to also record the mapping in `billing_customers` — on the reuse branch
 * too, so an id your app has held since before it recorded anything gets backfilled the
 * next time this runs:
 *
 * ```ts
 * const customer = await ensureCustomer(driver, user.asaasCustomerId, input, {
 *   store: this.store,
 *   owner: { type: 'User', id: user.id },
 * })
 * ```
 */
export async function ensureCustomer(
  driver: PaymentsDriver,
  existingId: string | null | undefined,
  input: CreateCustomerInput,
  options: EnsureCustomerOptions = {},
): Promise<Customer> {
  // Resolved BEFORE the gateway call: a `required` tenancy with no organization throws here,
  // not after a gateway customer nobody will ever map was created.
  const owner = options.store
    ? (options.owner ??
      currentTenantOwner(
        options.tenancy !== undefined
          ? resolvePaymentsTenancy(options.tenancy)
          : (findPayments()?.tenancy() ?? resolvePaymentsTenancy('inherit')),
      ) ??
      undefined)
    : undefined;

  const customer: Customer = existingId ? { id: existingId } : await driver.createCustomer(input);

  if (options.store) {
    await options.store.saveCustomer({
      gatewayId: customer.id,
      provider: driver.provider,
      ...(owner !== undefined ? { ownerType: owner.type, ownerId: String(owner.id) } : {}),
      // Only what the caller actually supplied: the store leaves absent fields alone rather
      // than blanking what a better-informed earlier call recorded.
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
  }

  return customer;
}
