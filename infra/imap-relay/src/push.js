export function watchMailboxes(accounts, config, state, snapshot, notify = fetch) {
  const abort = new AbortController();

  async function poll() {
    for (const account of accounts.values()) {
      if (abort.signal.aborted) break;
      try {
        const { next, messages } = await snapshot(account, state.readInboxPosition(account.id));
        for (const event of messages) {
          if (abort.signal.aborted) break;
          const response = await notify(new URL('/internal/new-mail', config.origin), {
            method: 'POST',
            redirect: 'error',
            headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ account: account.id, event }),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
          });
          const accepted = response.ok;
          await response.body?.cancel();
          if (!accepted) throw new Error('Push event failed');
        }
        if (!abort.signal.aborted) state.writeInboxPosition(account.id, next);
      } catch {
        if (!abort.signal.aborted) console.warn('An IMAP notification check failed.');
      }
    }
    if (!abort.signal.aborted) timer = setTimeout(poll, config.intervalMs);
  }

  let timer = setTimeout(poll, 0);
  return () => {
    abort.abort();
    clearTimeout(timer);
  };
}
