import { PaymentsManager } from '../payments_manager.js';

/**
 * Lazy singleton accessor for the payments manager. Set by the provider when it builds
 * the manager; importing this module never triggers the app boot (media/authkit pattern).
 */
let payments: PaymentsManager | undefined;

export function getPayments(): PaymentsManager {
  if (!payments) {
    throw new Error(
      '[payments] PaymentsManager is not ready yet. Make sure the PaymentsProvider is registered and the app has booted.',
    );
  }
  return payments;
}

/** Set by the provider once the manager is built. */
export function setPayments(manager: PaymentsManager): void {
  payments = manager;
}

export default getPayments;
