// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSwitcherConfig, resetSwitcherCache } from '../client/console-switcher';
import { ConsoleSwitcher } from './ConsoleSwitcher';

const config = { endpoint: '/payments/api/consoles', others: 3 };
const brand = <span>payments brand</span>;
const current = { title: 'Payments', package: '@adonis-agora/payments' };

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSwitcherCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    fn();
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const consoles = {
  version: 1,
  current: 'payments',
  consoles: [
    {
      id: 'telescope',
      title: 'Telescope',
      package: '@adonis-agora/telescope',
      icon: 'telescope',
      href: '/telescope',
    },
    { id: 'media', title: 'Media', icon: 'media', href: '/media/dashboard' },
    { id: 'odd', title: 'Odd', icon: 'nope', href: '/odd' },
    { id: 'evil', title: 'Evil', icon: 'generic', href: '//evil.example' },
    { id: 'evil2', title: 'Evil 2', icon: 'generic', href: 'javascript:alert(1)' },
  ],
};

describe('ConsoleSwitcher', () => {
  it('renders the plain brand and makes no request without config', () => {
    render(<ConsoleSwitcher brand={brand} current={current} config={undefined} />);
    expect(screen.getByText('payments brand')).toBeTruthy();
    expect(document.querySelector('[data-agora-switcher]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the heading an h1, with the button inside it when there is a list', async () => {
    const { unmount } = render(
      <ConsoleSwitcher brand={brand} current={current} config={undefined} />,
    );
    expect(document.querySelector('h1')?.textContent).toBe('payments brand');
    unmount();
    fetchMock.mockReturnValue(respond(consoles));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    const button = await screen.findByRole('button', { name: /switch console/ });
    expect(button.parentElement?.tagName).toBe('H1');
  });

  it('stays a plain brand when the list is empty', async () => {
    fetchMock.mockReturnValue(respond({ version: 1, current: 'payments', consoles: [] }));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-agora-switcher]')).toBeNull();
  });

  it('lists the current console first (not a link), then the others; drops unsafe hrefs', async () => {
    fetchMock.mockReturnValue(respond(consoles));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    const button = await screen.findByRole('button', { name: /switch console/ });
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitem');
    expect(items[0]?.tagName).toBe('DIV');
    expect(items[0]?.getAttribute('aria-current')).toBe('page');
    expect(items[0]?.textContent).toContain('Payments');
    const links = items.filter((el) => el.tagName === 'A');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/telescope',
      '/media/dashboard',
      '/odd',
    ]);
    expect(links[0]?.textContent).toContain('@adonis-agora/telescope');
    // An unknown icon renders the generic one.
    expect(links[2]?.querySelector('svg')?.getAttribute('data-icon')).toBe('generic');
  });

  it('opens from the keyboard, moves with arrows/Home/End, Esc restores focus', async () => {
    fetchMock.mockReturnValue(respond(consoles));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    const button = await screen.findByRole('button', { name: /switch console/ });
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on a click outside', async () => {
    fetchMock.mockReturnValue(respond(consoles));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    fireEvent.click(await screen.findByRole('button', { name: /switch console/ }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Cmd-K searches every console and groups the hits', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/search?q=')
        ? respond({
            version: 1,
            q: 'ord',
            results: [
              {
                id: 'payments',
                title: 'Payments',
                icon: 'payments',
                hits: [
                  { title: 'pi_123', subtitle: 'paid', href: '/payments#/p/pi_123' },
                  { title: 'bad', href: 'https://evil.example' },
                ],
              },
            ],
          })
        : respond(consoles),
    );
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    await screen.findByRole('button', { name: /switch console/ });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByRole('textbox', { name: 'Search all consoles' });
    expect(document.activeElement).toBe(input);
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: 'ord' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByText('pi_123')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/payments/api/consoles/search?q=ord',
      expect.anything(),
    );
    expect(screen.queryByText('bad')).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('readSwitcherConfig', () => {
  function block(json: string) {
    document.body.innerHTML = `<script type="application/json" id="cfg">${json}</script>`;
  }

  it('reads a valid field', () => {
    block('{"api":"/payments/api","switcher":{"endpoint":"/payments/api/consoles","others":2}}');
    expect(readSwitcherConfig('cfg')).toEqual({
      endpoint: '/payments/api/consoles',
      others: 2,
    });
  });

  it('ignores an absent, empty or unsafe field', () => {
    block('{"api":"/payments/api"}');
    expect(readSwitcherConfig('cfg')).toBeUndefined();
    block('{"switcher":{"endpoint":"/x","others":0}}');
    expect(readSwitcherConfig('cfg')).toBeUndefined();
    block('{"switcher":{"endpoint":"//evil.example/x","others":2}}');
    expect(readSwitcherConfig('cfg')).toBeUndefined();
    block('not json');
    expect(readSwitcherConfig('cfg')).toBeUndefined();
  });
});
