import type { CreateCustomerInput, PaymentsDriver } from './driver.js';
import type { Customer } from './types.js';

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
 */
export async function ensureCustomer(
  driver: PaymentsDriver,
  existingId: string | null | undefined,
  input: CreateCustomerInput,
): Promise<Customer> {
  if (existingId) return { id: existingId };
  return driver.createCustomer(input);
}