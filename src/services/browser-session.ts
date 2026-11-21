const BRIDGE_ORIGIN = 'https://jmap.byk.im';
const WEBMAIL_ORIGIN = 'https://webmail.byk.im';
const SESSION_PATH = '/jmap/browser-session';
const SESSION_STATE_KEY = 'stormbox.bykBrowserSession';

type BrowserSessionState = 'remembered' | 'signed-out' | 'logout-pending';

export function browserSessionEnabled(serverUrl: string, appOrigin = globalThis.location?.origin): boolean {
  return appOrigin === WEBMAIL_ORIGIN && serverUrl.replace(/\/$/, '') === BRIDGE_ORIGIN;
}

export function browserSessionState(): BrowserSessionState | null {
  try {
    const state = globalThis.localStorage?.getItem(SESSION_STATE_KEY);
    return state === 'remembered' || state === 'signed-out' || state === 'logout-pending' ? state : null;
  } catch {
    return null;
  }
}

function setBrowserSessionState(state: BrowserSessionState): void {
  try {
    globalThis.localStorage?.setItem(SESSION_STATE_KEY, state);
  } catch {
    // The browser may disable local storage. The cookie remains the credential.
  }
}

export function expireBrowserSession(): void {
  if (browserSessionState() === 'remembered') setBrowserSessionState('signed-out');
}

export async function createBrowserSession(username: string, password: string): Promise<void> {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  const basic = btoa(String.fromCharCode(...bytes));
  const response = await fetch(`${BRIDGE_ORIGIN}${SESSION_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
    credentials: 'include',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error('The username or app password was not accepted.');
  if (!response.ok) throw new Error('The sign-in service is unavailable. Please try again later.');
  setBrowserSessionState('remembered');
}

export async function clearBrowserSession(): Promise<void> {
  setBrowserSessionState('logout-pending');
  if (globalThis.navigator?.onLine === false) return;
  try {
    const response = await fetch(`${BRIDGE_ORIGIN}${SESSION_PATH}`, {
      method: 'DELETE',
      credentials: 'include',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok && browserSessionState() === 'logout-pending') setBrowserSessionState('signed-out');
  } catch {
    // Keep the marker so the next online launch can clear the cookie.
  }
}
