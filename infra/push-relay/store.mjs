import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const retentionMs = 24 * 60 * 60 * 1000;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1 || !state.subscriptions || !state.deliveries) {
      throw new Error('Unsupported push relay state.');
    }
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, subscriptions: {}, deliveries: {} };
  }
}

async function writeState(path, state) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function createPushStore({ path, send, now = Date.now }) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let state = await readState(path);
  let writer = Promise.resolve();

  function commit(update) {
    const pending = writer.then(async () => {
      const next = structuredClone(state);
      const result = await update(next);
      await writeState(path, next);
      state = next;
      return result;
    });
    writer = pending.catch(() => {});
    return pending;
  }

  return {
    add(subscription) {
      return commit((next) => {
        next.subscriptions[digest(subscription.endpoint)] = subscription;
      });
    },

    remove(endpoint) {
      return commit((next) => {
        delete next.subscriptions[digest(endpoint)];
      });
    },

    has(endpoint) {
      return writer.then(() => Object.hasOwn(state.subscriptions, digest(endpoint)));
    },

    deliver({ account, event }) {
      return commit(async (next) => {
        const time = now();
        const id = digest(JSON.stringify([account, event]));
        for (const [key, delivery] of Object.entries(next.deliveries)) {
          if (delivery.createdAt < time - retentionMs) delete next.deliveries[key];
        }

        const delivery = next.deliveries[id] ??= {
          createdAt: time,
          pending: Object.keys(next.subscriptions),
        };
        const tag = `stormbox-${digest(account).slice(0, 20)}`;
        const results = await Promise.all(delivery.pending.map(async (recipient) => {
          const subscription = next.subscriptions[recipient];
          if (!subscription) return null;
          try {
            await send(subscription, { tag });
            return null;
          } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
              delete next.subscriptions[recipient];
              return null;
            }
            return recipient;
          }
        }));

        delivery.pending = results.filter(Boolean);
        return delivery.pending.length === 0;
      });
    },
  };
}
