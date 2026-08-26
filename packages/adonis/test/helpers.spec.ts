import { describe, expect, it, vi } from 'vitest';
import { headerValue, httpRequest, isNotFound } from '../src/http.js';
import { fromDecimal, toDecimal } from '../src/money.js';

describe('money', () => {
  it('converts cents to decimal and back', () => {
    expect(toDecimal(1990)).toBe(19.9);
    expect(fromDecimal(19.9)).toBe(1990);
    expect(fromDecimal(0.1)).toBe(10);
  });
});

describe('http helpers', () => {
  it('reads a header value handling arrays and case', () => {
    expect(headerValue({ 'x-token': ['a', 'b'] }, 'x-token')).toBe('a');
    expect(headerValue({ 'X-Token': 'v' }, 'x-token')).toBe('v');
    expect(headerValue({}, 'missing')).toBeUndefined();
  });

  it('detects 404 errors', () => {
    expect(isNotFound(Object.assign(new Error('nope'), { status: 404 }))).toBe(true);
    expect(isNotFound(Object.assign(new Error('boom'), { status: 500 }))).toBe(false);
    expect(isNotFound(new Error('no status'))).toBe(false);
  });

  it('performs a fetch with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await httpRequest<{ id: string }>('/things', {
        baseUrl: 'https://api.test',
        bearerToken: 'tok',
        body: { a: 1 },
      });
      expect(result).toEqual({ id: 'x' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe('https://api.test/things');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      expect(init.body).toBe('{"a":1}');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
