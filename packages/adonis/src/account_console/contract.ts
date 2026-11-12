/**
 * The authkit account console extension contract (version 1), declared STRUCTURALLY here: payments
 * never imports `@adonis-agora/authkit-server` (or authkit-client). authkit binds a registry at
 * `'authkit.accountExtensions'`; payments registers its pages into it when it is there.
 *
 * Only the members payments uses are declared; authkit's own types are a superset.
 */

/** The container binding authkit's registry lives at. */
export const ACCOUNT_EXTENSIONS_BINDING = 'authkit.accountExtensions';

/** A message key (looked up in the merged catalog) or literal text. Always escaped by authkit. */
export type Text = string | { key: string; params?: Record<string, string | number> };

export interface AccountExtension {
  readonly id: string;
  readonly contract: 1;
  messages?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** https origins `component` blocks may load scripts from. */
  scriptOrigins?: readonly string[];
  pages: readonly AccountPage[];
}

export interface AccountPage {
  id: string;
  segment: string;
  title: Text;
  nav?: { label?: Text; order?: number; group?: 'account' | 'billing' | 'ai' | 'content' } | false;
  visible?(ctx: AccountExtensionContext): boolean | Promise<boolean>;
  load(ctx: AccountExtensionContext): Promise<AccountPageView>;
  actions?: Readonly<Record<string, AccountAction>>;
}

/** One level of a tenant chain (outermost first). */
export interface AccountTenantLevel {
  id: string;
  kind: string;
  slug?: string;
  role?: string;
}

/** The tenant of the request, in the shape `@adonis-agora/context` uses. */
export interface AccountTenantRef extends AccountTenantLevel {
  source: string;
  chain?: readonly AccountTenantLevel[];
}

export interface AccountExtensionContext {
  account: { id: string; email: string | null; name: string | null; roles: readonly string[] };
  activeOrg: { id: string; slug: string; role: string } | null;
  /** The tenant of the request (the active organization). Optional: an older authkit omits it. */
  tenant?: AccountTenantRef | null;
  /**
   * The app user authkit's account mapping hook resolved for this account. Optional: an older
   * authkit does not send it.
   */
  subject?: { type?: string; id: string } | null;
  impersonatedBy: string | null;
  locale: string;
  query: { cursor?: string; tab?: string };
  url(pageId: string, query?: Record<string, string>): string;
  make(binding: string): Promise<unknown>;
  now(): Date;
}

export interface AccountPageView {
  blocks: readonly Block[];
  tabs?: ReadonlyArray<{ id: string; label: Text }>;
}

export type Value =
  | { type: 'text'; text: Text }
  | { type: 'money'; amount: number; currency: string }
  | { type: 'date'; at: Date | string; style?: 'date' | 'datetime' | 'relative' }
  | { type: 'badge'; text: Text; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
  | { type: 'number'; value: number; unit?: Text };

export interface ActionRef {
  action: string;
  target?: string;
}

export type Block =
  | { kind: 'notice'; tone: 'info' | 'success' | 'warning' | 'danger'; text: Text }
  | {
      kind: 'keyValue';
      title?: Text;
      rows: ReadonlyArray<{ label: Text; value: Value }>;
      actions?: ActionRef[];
    }
  | {
      kind: 'table';
      title?: Text;
      empty: Text;
      columns: ReadonlyArray<{ id: string; label: Text }>;
      rows: ReadonlyArray<{ cells: Record<string, Value>; actions?: ActionRef[] }>;
      nextCursor?: string | null;
    }
  | { kind: 'actions'; items: ActionRef[] }
  | { kind: 'link'; label: Text; href: string; external?: boolean }
  | {
      kind: 'component';
      provider: string;
      scripts: ReadonlyArray<{ src: string; integrity?: string; module?: boolean }>;
      props?: Record<string, unknown>;
      submit?: ActionRef;
      fallback?: { label: Text; href: string; external?: boolean };
    };

export interface AccountAction {
  label: Text;
  tone?: 'default' | 'danger';
  confirm?: Text;
  sudo?: boolean;
  fields?: ReadonlyArray<{
    name: string;
    label: Text;
    kind: 'text' | 'select' | 'textarea';
    options?: ReadonlyArray<{ value: string; label: Text }>;
    required?: boolean;
    maxLength?: number;
  }>;
  handle(
    ctx: AccountExtensionContext,
    input: { target: string | null; fields: Record<string, string> },
  ): Promise<AccountActionResult>;
}

export type AccountActionResult =
  | { ok: true; flash?: Text; redirectTo?: { page: string } | { external: string } }
  | { ok: false; error: Text; status?: 400 | 403 | 404 | 409 };

/** The registry authkit binds. */
export interface AccountExtensionRegistry {
  readonly contract: number;
  readonly blockKinds?: readonly string[];
  register(extension: AccountExtension): void;
}
