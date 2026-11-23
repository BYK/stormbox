import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const worker = readFileSync(new URL('../../../public/stormbox-sw.js', import.meta.url), 'utf8');
const origin = 'https://mail.example.test/';

function setup() {
  const listeners = new Map<string, (event: unknown) => void>();
  const shell = new Response('saved inbox shell');
  const fetch = vi.fn<typeof globalThis.fetch>();
  const match = vi.fn().mockResolvedValue(shell);
  runInNewContext(worker, {
    URL, Response, fetch, importScripts() {},
    caches: { open: async () => ({ match }) },
    self: {
      registration: { scope: origin },
      stormboxPrecache: { version: 'test', files: ['index.html'], optionalFiles: [] },
      addEventListener: (name: string, handler: (event: unknown) => void) => { listeners.set(name, handler); },
    },
  });

  function navigate(path: string, cache: RequestCache = 'default') {
    let result: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request: { method: 'GET', headers: new Headers(), url: new URL(path, origin).href, mode: 'navigate', cache },
      respondWith: (response: Promise<Response>) => { result = response; },
    });
    return result;
  }
  return { shell, fetch, match, navigate };
}

describe('installed Stormbox navigation', () => {
  it('opens the saved shell immediately, including notification links', async () => {
    const { shell, navigate, fetch, match } = setup();
    await expect(navigate('/?view=attention')).resolves.toBe(shell);
    expect(match).toHaveBeenCalledWith(`${origin}index.html`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets auth callbacks pass through and falls back to the saved shell on failed reload', async () => {
    const { shell, navigate, fetch, match } = setup();
    expect(navigate('/?state=callback&code=login')).toBeUndefined();
    expect(match).not.toHaveBeenCalled();
    fetch.mockRejectedValue(new Error('offline'));
    await expect(navigate('/', 'reload')).resolves.toBe(shell);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
