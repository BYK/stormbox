import type { BrowserModelInput, BrowserModelResponse, BrowserModelResult, BrowserTriageProgress } from './browser-model-shared';
import { classifyTriageMessage, triageExcerpt, type TriageClassification, type TriageMessage } from './smart-sort';

export type { BrowserTriageProgress } from './browser-model-shared';

const MAX_MESSAGES_PER_PASS = 64;
const MAX_CACHED_MESSAGES = 256;
const MAX_RUN_MS = 5 * 60 * 1000;

interface CachedClassification { input: BrowserModelInput; classification: TriageClassification }

export function browserTriageMessageKey(message: Pick<TriageMessage, 'accountId' | 'id'>): string {
  return JSON.stringify([String(message.accountId), String(message.id)]);
}

function modelInput(message: TriageMessage): BrowserModelInput {
  const subject = (message.subject ?? '').slice(0, 500);
  const sender = (message.sender ?? '').slice(0, 200);
  return {
    key: browserTriageMessageKey(message),
    text: `query: Subject: ${subject}\nFrom: ${sender}\nMessage: ${triageExcerpt(message)}`,
    directRecipient: Boolean(message.directRecipient),
  };
}

export function createBrowserTriageRanker() {
  const cache = new Map<string, CachedClassification>();
  let worker: Worker | undefined;
  let active: Promise<BrowserModelResult[]> | undefined;
  let abortActive: (() => void) | undefined;
  let disposed = false;

  function run(inputs: BrowserModelInput[], onProgress?: (progress: BrowserTriageProgress) => void) {
    const current = worker ??= new Worker(new URL('./triage-model-worker.ts', import.meta.url), { type: 'module' });
    return new Promise<BrowserModelResult[]>((resolve, reject) => {
      const onMessage = (event: MessageEvent<BrowserModelResponse>) => {
        if (event.data.type === 'progress') onProgress?.(event.data.progress);
        else if (event.data.type === 'error') fail(event.data.message);
        else { cleanUp(); resolve(event.data.results); }
      };
      const onError = () => fail('The E5 worker could not start');
      const timeout = setTimeout(() => fail('The E5 worker timed out'), MAX_RUN_MS);
      function cleanUp() {
        clearTimeout(timeout);
        current.removeEventListener('message', onMessage);
        current.removeEventListener('error', onError);
        current.removeEventListener('messageerror', onError);
        abortActive = undefined;
      }
      function fail(message: string) {
        cleanUp();
        current.terminate();
        worker = undefined;
        reject(new Error(message));
      }
      abortActive = () => fail('The E5 worker was stopped');
      current.addEventListener('message', onMessage);
      current.addEventListener('error', onError);
      current.addEventListener('messageerror', onError);
      try { current.postMessage(inputs); }
      catch { fail('Could not send mail to the local E5 worker'); }
    });
  }

  return {
    async classify(
      messages: readonly TriageMessage[], onProgress?: (progress: BrowserTriageProgress) => void,
    ): Promise<Map<string, TriageClassification>> {
      while (active) await active;
      if (disposed) throw new Error('The E5 worker was stopped');

      const result = new Map<string, TriageClassification>();
      const missing: BrowserModelInput[] = [];
      const newest = messages.filter((message) => !message.classification
        && classifyTriageMessage(message).disposition === 'uncertain')
        .sort((left, right) => right.receivedAt - left.receivedAt);
      for (const message of newest) {
        const input = modelInput(message);
        const previous = cache.get(input.key);
        if (previous?.input.text === input.text && previous.input.directRecipient === input.directRecipient) {
          cache.delete(input.key);
          cache.set(input.key, previous);
          result.set(input.key, previous.classification);
        } else if (missing.length < MAX_MESSAGES_PER_PASS) missing.push(input);
      }
      if (!missing.length) return result;

      active = run(missing, onProgress);
      try {
        const inputs = new Map(missing.map((input) => [input.key, input]));
        for (const [key, classification] of await active) {
          const input = inputs.get(key);
          if (!input) continue;
          cache.delete(key);
          cache.set(key, { input, classification });
          result.set(key, classification);
        }
      } finally { active = undefined; }
      while (cache.size > MAX_CACHED_MESSAGES) cache.delete(cache.keys().next().value);
      return result;
    },
    dispose() {
      disposed = true;
      abortActive?.();
      worker?.terminate();
      worker = undefined;
      cache.clear();
    },
  };
}
