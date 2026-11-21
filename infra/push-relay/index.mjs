import webPush from 'web-push';
import { createPushRelay } from './relay.mjs';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before starting the push relay.`);
  return value;
}

const browserToken = required('RELAY_ACCESS_TOKEN');
const ingestToken = required('PUSH_RELAY_TOKEN');
if (browserToken === ingestToken) throw new Error('Use a separate PUSH_RELAY_TOKEN.');
const publicOrigin = new URL(required('RELAY_PUBLIC_ORIGIN'));
if (!['http:', 'https:'].includes(publicOrigin.protocol)) {
  throw new Error('RELAY_PUBLIC_ORIGIN must be an HTTP or HTTPS origin.');
}
const publicKey = required('WEB_PUSH_VAPID_PUBLIC_KEY');
webPush.setVapidDetails(
  required('WEB_PUSH_VAPID_SUBJECT'),
  publicKey,
  required('WEB_PUSH_VAPID_PRIVATE_KEY'),
);

const server = await createPushRelay({
  browserToken,
  ingestToken,
  publicOrigin: publicOrigin.origin,
  publicKey,
  statePath: process.env.WEB_PUSH_STATE_PATH ?? './data/state.json',
  extraPushHosts: (process.env.WEB_PUSH_EXTRA_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
}, (subscription, payload) => webPush.sendNotification(subscription, JSON.stringify(payload), {
  TTL: 60 * 60,
  timeout: 5000,
  topic: payload.tag,
}));

const host = process.env.WEB_PUSH_HOST ?? '127.0.0.1';
const port = Number(process.env.WEB_PUSH_PORT ?? 8789);
server.listen(port, host, () => {
  console.log(`Stormbox push relay listening on ${host}:${server.address().port}`);
});
