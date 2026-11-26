import type { ApplicationService } from '@adonisjs/core/types';
import type { PaymentsDashboardConfig } from '../dashboard/define_config.js';
import type { PaymentsConfig } from '../define_config.js';
import {
  type AnsweringAuth,
  type AuthkitClientLike,
  answeringAuthError,
  type CryptoRuntimeLike,
  createKeyHint,
  detectAuthkitClient,
  detectCryptoRuntime,
  publishesAppKey,
  resolveAnsweringAuth,
  resolveSendingAuth,
  type SendingAuth,
  sendingAuthError,
} from '../federation/auto_auth.js';
import {
  appKeyOf,
  consoleCommandKeys,
  parseConsolePublicKey,
  resolveConsoleCommands,
} from '../federation/console.js';
import { classifyConsoleKeyError, probeConsoleKey } from '../federation/console_key_check.js';
import {
  CONSOLE_CRYPTO_KEY,
  type ConsoleCipher,
  type ConsoleCryptoOption,
  RedisConsoleChannel,
} from '../federation/redis_channel.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/payments/federated-console';

/** Both sides of the federated console's channel, as this app resolves them. */
interface ResolvedSides {
  answering?: { prefix: string; partition: string; actionsOn: boolean; auth: AnsweringAuth };
  sending: Array<{ key: string; actions: boolean; partition: string; auth: SendingAuth | null }>;
  crypto?: CryptoRuntimeLike;
}

async function resolveSides(app: ApplicationService): Promise<ResolvedSides> {
  const container = app.container as unknown as {
    hasBinding(binding: string): boolean;
    make(binding: string): Promise<unknown>;
  };
  let crypto: CryptoRuntimeLike | undefined;
  let authkit: AuthkitClientLike | undefined;
  try {
    crypto = await detectCryptoRuntime(container);
  } catch {
    crypto = undefined;
  }
  try {
    authkit = await detectAuthkitClient(container);
  } catch {
    authkit = undefined;
  }
  const sides: ResolvedSides = { sending: [], ...(crypto ? { crypto } : {}) };

  const payments = app.config.get<PaymentsConfig | undefined>('payments', undefined);
  if (payments?.consoleCommands && payments.topology !== 'tenant') {
    // The prefix only names the channel; the package name is the provider's default.
    const option = resolveConsoleCommands(payments.consoleCommands, 'app');
    if (option) {
      const appKey = await appKeyOf(app);
      sides.answering = {
        prefix: option.prefix,
        actionsOn: option.actions.size > 0,
        partition: option.partition,
        auth: resolveAnsweringAuth({
          option,
          crypto,
          authkit,
          controlPlaneVerifyTenant:
            payments.topology === 'control-plane' ? payments.controlPlane?.verifyTenant : undefined,
          keys: () =>
            appKey !== undefined && appKey.length >= 16
              ? consoleCommandKeys(appKey, option.prefix)
              : undefined,
        }),
      };
    }
  }

  const dashboard = app.config.get<PaymentsDashboardConfig | undefined>(
    'payments_dashboard',
    undefined,
  );
  for (const [key, entry] of Object.entries(dashboard?.apps ?? {})) {
    const partition = entry.partition ?? key;
    const plane = entry.controlPlane;
    if (plane instanceof RedisConsoleChannel) {
      sides.sending.push({ key, actions: entry.actions !== false, partition, auth: null });
      continue;
    }
    const publicKey =
      plane.publicKey !== undefined ? parseConsolePublicKey(plane.publicKey) : undefined;
    sides.sending.push({
      key,
      actions: entry.actions !== false,
      partition,
      auth: resolveSendingAuth({
        plane: {
          ...(plane.secret !== undefined ? { secret: plane.secret } : {}),
          ...(plane.crypto !== undefined ? { crypto: plane.crypto } : {}),
          ...(plane.token !== undefined ? { token: plane.token } : {}),
          ...(publicKey ? { publicKey } : {}),
        },
        partition,
        crypto,
        authkit,
      }),
    });
  }
  return sides;
}

/** `payments.console-commands`: the mode each side resolved; an error when one has none. */
export async function checkConsoleCommands(app: ApplicationService): Promise<AgoraDoctorResult[]> {
  const sides = await resolveSides(app);
  const results: AgoraDoctorResult[] = [];
  if (sides.answering) {
    const { auth } = sides.answering;
    results.push(
      auth.modes.length === 0
        ? {
            status: 'error',
            message: answeringAuthError(auth.notes).message,
            fix: "Install @adonis-agora/crypto (automatic), or configure authkit-client's `service` (automatic), or set consoleCommands.secret, or consoleCommands.verifyTenant.",
            docs: `${DOCS}#authenticating-the-console`,
          }
        : {
            status: 'ok',
            // The same sentence as the boot log.
            message: `[@adonis-agora/payments] console commands: ${auth.modes.join(' + ')}; ${
              sides.answering.actionsOn
                ? 'actions on'
                : 'actions off (set consoleCommands.actions to let the console act)'
            }`,
          },
    );
    // §13e: shown here, never logged at boot.
    if (auth.keys && !publishesAppKey(auth)) {
      results.push({
        status: 'ok',
        message:
          "console commands: this app's token key is not published: crypto is enough to reach it.",
      });
    }
  }
  for (const app of sides.sending) {
    if (app.auth === null) {
      results.push({
        status: 'ok',
        message: `[@adonis-agora/payments] console commands to "${app.key}": the channel given in config`,
      });
    } else if (app.auth.mode !== undefined) {
      results.push({
        status: 'ok',
        message: `[@adonis-agora/payments] console commands to "${app.key}": ${app.auth.mode}`,
      });
    } else if (!app.actions) {
      results.push({
        status: 'ok',
        message: `[@adonis-agora/payments] console commands to "${app.key}": none (browse-only, actions: false)`,
      });
    } else {
      results.push({
        status: 'error',
        message: sendingAuthError(app.key, app.auth.notes).message,
        fix: 'Install @adonis-agora/crypto (automatic), or set controlPlane.secret, or controlPlane.token + publicKey; or actions: false.',
        docs: `${DOCS}#authenticating-the-console`,
      });
    }
  }
  if (results.length === 0) {
    return [{ status: 'skip', message: 'No consoleCommands and no federated apps.' }];
  }
  return results;
}

async function cipherOf(crypto: ConsoleCryptoOption): Promise<ConsoleCipher> {
  const source = crypto.cipher;
  return typeof source === 'function' ? await source() : source;
}

const PROBE_AAD = 'agora:doctor:payments:console-commands';

/**
 * `payments.console-commands-key` (deep): in crypto mode, this process can use the key. The owning
 * app encrypts and decrypts a probe (when its grant only allows decrypt, it checks the key exists);
 * the console seals one for each app.
 */
export async function checkConsoleCommandsKey(
  app: ApplicationService,
): Promise<AgoraDoctorResult[]> {
  const sides = await resolveSides(app);
  const results: AgoraDoctorResult[] = [];
  const answering = sides.answering;
  if (answering?.auth.crypto) {
    const { crypto } = answering.auth;
    const key = crypto.key ?? CONSOLE_CRYPTO_KEY;
    try {
      const cipher = await cipherOf(crypto);
      let checked = false;
      let missing = false;
      try {
        const { ciphertext } = await cipher.encrypt({
          key,
          plaintext: 'probe',
          aad: PROBE_AAD,
          context: PROBE_AAD,
        });
        const { plaintext } = await cipher.decrypt({
          key,
          ciphertext,
          aad: PROBE_AAD,
          context: PROBE_AAD,
        });
        if (plaintext !== 'probe') throw new Error('the probe did not decrypt to itself');
        checked = true;
      } catch (error) {
        // An app on a crypto tenant may decrypt its own console keys (no grant needed) but usually
        // not encrypt with them: a dummy decrypt, classified like at boot, says how the key stands.
        const tenant = answering.auth.cryptoSource === 'auto' && !sides.crypto?.service;
        if (!tenant && classifyConsoleKeyError(error) !== 'refused') throw error;
        // §13f: crypto's `hasKey` when the server has it (no failed-decrypt audit row), else
        // the dummy decrypt.
        const outcome = sides.crypto
          ? await probeConsoleKey(sides.crypto, key)
          : await probeConsoleKey(
              { operations: cipher as unknown as CryptoRuntimeLike['operations'] },
              key,
            );
        if (outcome !== 'usable' && !(tenant && outcome === 'missing')) {
          throw new Error(`the key ${key} does not exist`);
        }
        if (outcome === 'missing') missing = true;
      }
      results.push({
        status: 'ok',
        message: missing
          ? `The console key ${key} does not exist yet; the crypto server creates it on the console's first command (with sealProvisioning off: \`${createKeyHint(key, sides.crypto?.partition ?? answering.partition)}\`).`
          : checked
            ? `The console key ${key} encrypts and decrypts here.`
            : `The console key ${key} exists (this app may decrypt only).`,
      });
    } catch (error) {
      results.push({
        status: 'error',
        message: `consoleCommands cannot use the crypto key ${key}: ${error instanceof Error ? error.message : String(error)}`,
        fix: `Create it on the crypto server (\`${createKeyHint(key, sides.crypto?.partition ?? answering.partition)}\`). This app needs no grant to decrypt its own console keys on an up-to-date crypto server.`,
        docs: `${DOCS}#authenticating-the-console`,
      });
    }
  }
  for (const target of sides.sending) {
    const crypto = target.auth?.crypto;
    if (!crypto) continue;
    const key = crypto.key ?? CONSOLE_CRYPTO_KEY;
    try {
      await target.auth?.ensureKey?.();
      const cipher = await cipherOf(crypto);
      await cipher.encrypt({ key, plaintext: 'probe', aad: PROBE_AAD, context: PROBE_AAD });
      results.push({ status: 'ok', message: `apps["${target.key}"]: seals with ${key}.` });
    } catch (error) {
      results.push({
        status: 'error',
        message: `apps["${target.key}"] cannot seal with ${key} of "${target.partition}": ${error instanceof Error ? error.message : String(error)}`,
        fix:
          sides.crypto?.service !== undefined
            ? `Check that "${target.partition}" is that app's crypto partition (apps.${target.key}.partition).`
            : "Grant this console's crypto client `crypto:seal:console-*`.",
        docs: `${DOCS}#authenticating-the-console`,
      });
    }
  }
  if (results.length === 0) return [{ status: 'skip', message: 'No crypto mode in use.' }];
  return results;
}

/** The doctor checks of the federated console's channel. */
export function consoleCommandsDoctorChecks(): AgoraDoctorCheck[] {
  return [
    {
      id: 'payments.console-commands',
      lib: 'payments',
      title: 'Console commands are authenticated',
      run: (app) => checkConsoleCommands(app),
    },
    {
      id: 'payments.console-commands-key',
      lib: 'payments',
      title: 'Console commands key is usable',
      cost: 'deep',
      run: (app) => checkConsoleCommandsKey(app),
    },
  ];
}
