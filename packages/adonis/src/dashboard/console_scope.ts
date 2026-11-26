/**
 * Names `@adonis-agora/payments` gives the scope fields of the shared console access contract
 * (`console_authorize.ts`, kept byte-identical across the libs, so payments' extras live here).
 */

/** The organizations (tenants) a console viewer may see: every one (`'*'`), or these ids. */
export type ConsoleTenants = '*' | string[];

/** The federated apps a console viewer may pick: every one (`'*'`), or these keys. */
export type ConsoleApps = '*' | string[];
