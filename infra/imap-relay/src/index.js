import * as imap from './imap.js';
import { loadConfig } from './config.js';
import { createRelayServer } from './http.js';
import { openRelayState, sendMessage } from './smtp.js';
import { watchMailboxes } from './push.js';

async function start() {
  const config = await loadConfig();
  const state = await openRelayState(config.stateDir);
  const server = createRelayServer(config, {
    ...imap,
    sendMessage: (account, message) => sendMessage(state, account, message),
  });
  server.maxConnections = 64;
  server.once('error', () => {
    console.error('IMAP relay could not listen. Check the bind address and port.');
    process.exitCode = 1;
  });
  server.listen(config.listenerPort, config.listenerHost, () => {
    console.log('Stormbox IMAP relay is listening.');
    const stopWatching = config.push && watchMailboxes(config.accounts, config.push, state, imap.watchSnapshot);
    const shutdown = () => {
      stopWatching?.();
      server.close(() => state.close());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

start().catch(() => {
  console.error('IMAP relay could not start. Check the relay configuration and state path.');
  process.exitCode = 1;
});
