import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeByToken,
  type ConsoleAuthorizer,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from '../../src/dashboard/console_authorize.js';

/** A ctx double whose container builds a class with a fixed dependency, recording each build. */
function fakeCtx(made: unknown[] = []): HttpContext {
  return {
    containerResolver: {
      make: async (Class: new (dep: string) => unknown) => {
        made.push(Class);
        return new Class('from-container');
      },
    },
  } as unknown as HttpContext;
}

describe('normalizeConsoleAuthorizeResult', () => {
  it('allows true and { allowed: true }', () => {
    expect(normalizeConsoleAuthorizeResult(true)).toEqual({ allowed: true });
    expect(normalizeConsoleAuthorizeResult({ allowed: true })).toEqual({ allowed: true });
  });

  it('maps denials to 403, and reason unauthenticated to 401', () => {
    expect(normalizeConsoleAuthorizeResult(false)).toMatchObject({ allowed: false, status: 403 });
    expect(normalizeConsoleAuthorizeResult({ allowed: false })).toMatchObject({ status: 403 });
    expect(normalizeConsoleAuthorizeResult({ allowed: false, reason: 'forbidden' })).toMatchObject({
      status: 403,
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: false, reason: 'unauthenticated' })).toEqual({
      allowed: false,
      status: 401,
      reason: 'unauthenticated',
    });
  });

  it('maps { redirectTo } to a 302 decision', () => {
    expect(normalizeConsoleAuthorizeResult({ redirectTo: '/login' })).toEqual({
      allowed: false,
      status: 302,
      redirectTo: '/login',
    });
  });

  it('fails closed on anything malformed', () => {
    for (const value of [undefined, null, 1, 'yes', {}, { allowed: 'true' }, { redirectTo: '' }]) {
      expect(normalizeConsoleAuthorizeResult(value)).toMatchObject({ allowed: false, status: 403 });
    }
  });
});

describe('resolveConsoleAuthorize', () => {
  it('calls an inline function with ctx', async () => {
    const ctx = fakeCtx();
    const fn = vi.fn(() => ({ allowed: false as const, reason: 'unauthenticated' as const }));
    expect(await resolveConsoleAuthorize(fn)(ctx)).toMatchObject({ status: 401 });
    expect(fn).toHaveBeenCalledWith(ctx);
  });

  it('builds a class through the container (DI) and calls its authorize', async () => {
    class Access implements ConsoleAuthorizer {
      constructor(private dep: string) {}
      authorize() {
        return this.dep === 'from-container';
      }
    }
    const made: unknown[] = [];
    expect(await resolveConsoleAuthorize(Access)(fakeCtx(made))).toEqual({ allowed: true });
    expect(made).toEqual([Access]);
  });

  it('builds a class with `new` when the ctx has no container resolver', async () => {
    class Access implements ConsoleAuthorizer {
      authorize() {
        return { redirectTo: '/login' };
      }
    }
    expect(await resolveConsoleAuthorize(Access)({} as HttpContext)).toMatchObject({
      status: 302,
      redirectTo: '/login',
    });
  });

  it('resolves a lazy import once and builds its default class per request', async () => {
    class Access implements ConsoleAuthorizer {
      constructor(private dep: string) {}
      async authorize() {
        return this.dep === 'from-container' ? { allowed: true as const } : false;
      }
    }
    const importer = vi.fn(async () => ({ default: Access }));
    const guard = resolveConsoleAuthorize(importer);
    const made: unknown[] = [];
    expect(await guard(fakeCtx(made))).toEqual({ allowed: true });
    expect(await guard(fakeCtx(made))).toEqual({ allowed: true });
    expect(importer).toHaveBeenCalledTimes(1);
    expect(made).toEqual([Access, Access]);
  });

  it('treats a module whose default is not an authorizer as a (denied) result', async () => {
    expect(
      await resolveConsoleAuthorize(async () => ({ default: 'nope' }) as never)(fakeCtx()),
    ).toMatchObject({ allowed: false, status: 403 });
  });

  it('turns a throw into a 403 carrying the error — function, class, lazy import', async () => {
    const boom = new Error('auth backend down');
    class Throws implements ConsoleAuthorizer {
      authorize(): boolean {
        throw boom;
      }
    }
    const forms = [
      () => {
        throw boom;
      },
      Throws,
      async () => ({ default: Throws }),
      async () => {
        throw boom;
      },
    ];
    for (const form of forms) {
      expect(await resolveConsoleAuthorize(form)(fakeCtx())).toEqual({
        allowed: false,
        status: 403,
        reason: 'forbidden',
        error: boom,
      });
    }
  });

  it('denies when the container cannot build the class', async () => {
    class Access implements ConsoleAuthorizer {
      authorize() {
        return true;
      }
    }
    const ctx = {
      containerResolver: {
        make: async () => {
          throw new Error('cannot resolve dependency');
        },
      },
    } as unknown as HttpContext;
    expect(await resolveConsoleAuthorize(Access)(ctx)).toMatchObject({ status: 403 });
  });
});

describe('authorizeByToken', () => {
  const ctxWith = (headers: Record<string, string>) =>
    ({
      request: { header: (name: string) => headers[name.toLowerCase()] },
    }) as unknown as HttpContext;

  it('allows a matching Authorization: Bearer header', async () => {
    const authorize = authorizeByToken({ token: 'secret' }) as (ctx: HttpContext) => unknown;
    expect(await authorize(ctxWith({ authorization: 'Bearer secret' }))).toEqual({ allowed: true });
    expect(await authorize(ctxWith({ authorization: 'bearer secret' }))).toEqual({ allowed: true });
  });

  it('answers unauthenticated for a wrong, shorter or missing token', async () => {
    const authorize = authorizeByToken({ token: 'secret' }) as (ctx: HttpContext) => unknown;
    const denied = { allowed: false, reason: 'unauthenticated' };
    expect(await authorize(ctxWith({ authorization: 'Bearer nope' }))).toEqual(denied);
    expect(await authorize(ctxWith({ authorization: 'Bearer s' }))).toEqual(denied);
    expect(await authorize(ctxWith({ authorization: 'Basic secret' }))).toEqual(denied);
    expect(await authorize(ctxWith({}))).toEqual(denied);
  });

  it('reads the header only: no query string, no custom header', async () => {
    const authorize = authorizeByToken({ token: 'secret' }) as (ctx: HttpContext) => unknown;
    const ctx = {
      request: {
        header: (name: string) => (name === 'x-payments-token' ? 'secret' : undefined),
        qs: () => ({ token: 'secret' }),
      },
    } as unknown as HttpContext;
    expect(await authorize(ctx)).toEqual({ allowed: false, reason: 'unauthenticated' });
  });

  it('throws at config time for an empty or undefined token', () => {
    expect(() => authorizeByToken({ token: undefined })).toThrow(/non-empty/);
    expect(() => authorizeByToken({ token: '' })).toThrow(/non-empty/);
  });

  it('normalizes to a 401 through the resolver', async () => {
    const guard = resolveConsoleAuthorize(authorizeByToken({ token: 'secret' }));
    expect(await guard(ctxWith({}))).toMatchObject({ allowed: false, status: 401 });
    expect(await guard(ctxWith({ authorization: 'Bearer secret' }))).toEqual({ allowed: true });
  });
});
