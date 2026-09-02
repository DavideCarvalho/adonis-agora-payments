/** Who owns the recurrence: the gateway, or this library. */
export type SubscriptionMode = 'gateway' | 'managed';

/**
 * Where subscriptions are driven from.
 *
 * Three levels because the honest answer differs per application AND per gateway inside one
 * application. Plenty of teams want the gateway to own everything — the Stripe dashboard is
 * the product, and nobody wants to rebuild dunning. Others want the plan, the price and the
 * cancel button to live in their own app, and a gateway that only knows how to take money.
 * Forcing either choice on the other is what makes a billing library something people rip
 * out.
 *
 * It also stops being a preference the moment a gateway cannot do the job: Woovi/OpenPix
 * cannot cancel or update a subscription at all, so `'managed'` is the only way to offer a
 * cancel button — while the same app's card subscriptions can stay on Asaas, which does it
 * fine. That is why the per-provider level exists and is not redundant with the global one.
 */
export interface SubscriptionsConfig {
  /** Default for every provider. Defaults to `'gateway'` — today's behaviour. */
  mode?: SubscriptionMode;
  /** Per-provider override, keyed by the name used in `providers`. */
  providers?: Record<string, SubscriptionMode>;
}

/**
 * The mode for one call: `managed` on the call, else the provider's setting, else the global
 * default, else `'gateway'`.
 *
 * Narrowest wins, and the default is the old behaviour so upgrading changes nothing until
 * someone asks it to.
 */
export function resolveSubscriptionMode(
  config: SubscriptionsConfig | undefined,
  provider: string,
  managedOnCall?: boolean,
): SubscriptionMode {
  if (managedOnCall !== undefined) return managedOnCall ? 'managed' : 'gateway';
  return config?.providers?.[provider] ?? config?.mode ?? 'gateway';
}
