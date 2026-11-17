import type { BillingStore } from '../billing/billing_store.js';
import type { PaymentsConfig, PaymentsTopology } from '../define_config.js';
import type { PaymentsManager } from '../payments_manager.js';
import type { PaymentMethodName } from '../types.js';
import { createPaymentsControlPlane, type PaymentsControlPlane } from './control_plane.js';
import { lucidTenantLedger } from './lucid_ledger.js';
import { isHubUnavailable } from './protocol.js';
import {
  createHubClient,
  type HubClient,
  type HubProviderDeclaration,
  RemoteDriver,
} from './tenant.js';
import { type HubTransport, httpHubTransport } from './transports.js';

/** The topology of a config, checked: a half-configured topology fails the boot, not a payment. */
export function resolveTopology(config: PaymentsConfig): PaymentsTopology {
  const topology = config.topology ?? 'standalone';
  if (topology === 'control-plane') {
    if (!config.controlPlane?.verifyTenant) {
      throw new Error(
        "[payments] topology 'control-plane' needs `controlPlane.verifyTenant` (e.g. authkitTenantVerifier({ audience: 'urn:agora:payments' })).",
      );
    }
    return topology;
  }
  if (topology === 'tenant') {
    const tenant = config.tenant;
    if (!tenant?.partition || !tenant.token || !tenant.providers) {
      throw new Error(
        "[payments] topology 'tenant' needs `tenant.partition`, `tenant.token` and `tenant.providers`.",
      );
    }
    if (tenant.url === undefined && tenant.transport === undefined) {
      throw new Error("[payments] topology 'tenant' needs `tenant.url` or `tenant.transport`.");
    }
    const names = Array.isArray(tenant.providers)
      ? tenant.providers
      : Object.keys(tenant.providers);
    if (names.length === 0) {
      throw new Error('[payments] `tenant.providers` lists no control plane provider.');
    }
    // Credentials on a tenant mean someone forgot to remove them, or forgot to flip the topology.
    const local = Object.entries(config.providers ?? {}).filter(
      ([, factory]) => factory !== undefined,
    );
    if (local.length > 0) {
      throw new Error(
        `[payments] topology 'tenant' runs every gateway call on the control plane, but config.providers still builds ${local
          .map(([name]) => `"${name}"`)
          .join(', ')}. Remove them (the credentials belong to the control plane).`,
      );
    }
    return topology;
  }
  if (topology !== 'standalone') {
    throw new Error(`[payments] unknown topology "${String(topology)}"`);
  }
  return topology;
}

/** A transport that falls back to another one when the first cannot deliver. */
export function fallbackTransport(primary: HubTransport, secondary: HubTransport): HubTransport {
  return {
    name: `${primary.name}+${secondary.name}`,
    async request(message, timeoutMs) {
      try {
        return await primary.request(message, timeoutMs);
      } catch (error) {
        // Same id on the second try: the control plane replays a call it already ran.
        if (isHubUnavailable(error)) return secondary.request(message, timeoutMs);
        throw error;
      }
    },
    ...(primary.wait ? { wait: primary.wait.bind(primary) } : {}),
  };
}

export interface TenantRuntime {
  client: HubClient;
  transport: HubTransport;
  drivers: Map<string, RemoteDriver>;
}

/** The tenant's client and its remote drivers (no network yet: `describe` runs later). */
export function buildTenantRuntime(config: PaymentsConfig): TenantRuntime {
  const tenant = config.tenant;
  if (!tenant) throw new Error('[payments] topology tenant without `tenant`');
  const http = tenant.url !== undefined ? httpHubTransport({ url: tenant.url }) : undefined;
  const transport =
    tenant.transport && http
      ? fallbackTransport(tenant.transport, http)
      : (tenant.transport ?? (http as HubTransport));
  const client = createHubClient({
    transport,
    token: tenant.token,
    partition: tenant.partition,
    ...(tenant.timeoutMs !== undefined ? { timeoutMs: tenant.timeoutMs } : {}),
  });
  const declarations: Record<string, HubProviderDeclaration> = Array.isArray(tenant.providers)
    ? Object.fromEntries((tenant.providers as readonly string[]).map((name) => [name, {}]))
    : (tenant.providers as Record<string, HubProviderDeclaration>);
  const drivers = new Map<string, RemoteDriver>();
  for (const [name, declaration] of Object.entries(declarations)) {
    const routed = Object.entries(config.methods ?? {})
      .filter(([, provider]) => provider === name)
      .map(([method]) => method as PaymentMethodName);
    drivers.set(name, new RemoteDriver(name, client, declaration, routed));
  }
  return { client, transport, drivers };
}

/** The control plane, over the app's manager, billing store and ledger. */
export function buildControlPlane(
  config: PaymentsConfig,
  deps: {
    manager: () => Promise<PaymentsManager>;
    store: () => BillingStore | undefined;
    notify?: (partition: string) => Promise<void>;
    logger?: { warn(message: string): void };
  },
): PaymentsControlPlane {
  const options = config.controlPlane;
  if (!options) throw new Error('[payments] topology control-plane without `controlPlane`');
  return createPaymentsControlPlane({
    manager: deps.manager,
    store: deps.store,
    verifyTenant: options.verifyTenant,
    ledger:
      options.ledger ??
      lucidTenantLedger({
        connection: config.billing?.connection,
        schema: config.billing?.schema,
        autoCreateSchema: config.billing?.autoCreateSchema !== false,
      }),
    ...(options.accountOwnerType !== undefined
      ? { accountOwnerType: options.accountOwnerType }
      : {}),
    ...(options.apps !== undefined ? { apps: options.apps } : {}),
    ...(options.adoptUnclaimed !== undefined ? { adoptUnclaimed: options.adoptUnclaimed } : {}),
    ...(deps.notify ? { notify: deps.notify } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

/** `controlPlane.path`, normalized (`'/_payments'`). */
export function controlPlanePath(config: PaymentsConfig): string {
  const path = config.controlPlane?.path ?? '/_payments';
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}
