const BRIDGE_ORIGIN = 'https://jmap.byk.im';
const WEBMAIL_ORIGIN = 'https://webmail.byk.im';
const SESSION_PATH = '/jmap/browser-session';
const RELAY_ASSERTION_PATH = '/jmap/relay-session';
const RELAY_COOKIE_PATH = '/api/imap/v1/session';
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

export async function browserRelayAssertion(fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(`${BRIDGE_ORIGIN}${RELAY_ASSERTION_PATH}`, {
    method: 'POST',
    credentials: 'include',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error('Sign in to Thundermail again to connect IMAP accounts.');
  if (response.status === 403) throw new Error('IMAP account management is reserved for this webmail’s owner.');
  if (!response.ok) throw new Error('The mail relay sign-in service is unavailable. Try again shortly.');
  const { assertion } = await response.json();
  if (typeof assertion !== 'string' || !assertion) throw new Error('The mail relay did not receive a session.');
  return assertion;
}

async function clearRelayCookie(): Promise<boolean> {
  try {
    const response = await fetch(RELAY_COOKIE_PATH, {
      method: 'DELETE', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function createBrowserSession(username: string, password: string): Promise<void> {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  const basic = btoa(String.fromCharCode(...bytes));
  await clearRelayCookie();
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
    const [relayCleared, response] = await Promise.all([
      clearRelayCookie(),
      fetch(`${BRIDGE_ORIGIN}${SESSION_PATH}`, {
        method: 'DELETE',
        credentials: 'include',
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      }),
    ]);
    if (relayCleared && response.ok && browserSessionState() === 'logout-pending') setBrowserSessionState('signed-out');
  } catch {
    // Keep the marker so the next online launch can clear the cookie.
  }
}
