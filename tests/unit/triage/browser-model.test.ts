import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTriageMessageKey, createBrowserTriageRanker } from '../../../src/triage/browser-model';
import { scoreE5Similarity, type BrowserModelInput, type BrowserModelResponse } from '../../../src/triage/browser-model-shared';
import type { TriageMessage } from '../../../src/triage/smart-sort';

class TestWorker extends EventTarget {
  static workers: TestWorker[] = [];
  batches: BrowserModelInput[][] = [];
  terminated = false;
  constructor() {
    super();
    TestWorker.workers.push(this);
  }
  postMessage(batch: BrowserModelInput[]) {
    this.batches.push(batch);
  }
  reply(response: BrowserModelResponse) {
    this.dispatchEvent(new MessageEvent('message', { data: response }));
  }
  terminate() { this.terminated = true; }
}

function mail(id: number, subject: string): TriageMessage {
  return { accountId: 1, id, receivedAt: id, subject };
}

function complete(worker: TestWorker) {
  const batch = worker.batches.at(-1) ?? [];
  worker.reply({ type: 'done', results: batch.map(({ key }) => [key, scoreE5Similarity(0.71, 0.7, true)]) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  TestWorker.workers = [];
});

describe('optional browser ranking', () => {
  it('does not launch the worker unless classifying ambiguous mail', async () => {
    vi.stubGlobal('Worker', TestWorker);
    const ranker = createBrowserTriageRanker();
    const result = await ranker.classify([mail(1, 'Action required'), mail(2, 'Weekly newsletter')]);
    expect(TestWorker.workers).toHaveLength(0);
    expect(result.size).toBe(0);
  });

  it('ranks at most 64 new messages and retries a changed excerpt without rescoring cached peers', async () => {
    vi.stubGlobal('Worker', TestWorker);
    const ranker = createBrowserTriageRanker();
    const messages = Array.from({ length: 70 }, (_, index) => mail(index + 1, 'Meeting last week'));
    const first = ranker.classify(messages);
    const [worker] = TestWorker.workers;
    expect(worker.batches[0]).toHaveLength(64);
    complete(worker);
    const cachedMessages = messages.slice(6);
    const ranked = await first;
    expect(ranked.has(browserTriageMessageKey(messages[0]))).toBe(false);
    expect(await ranker.classify(cachedMessages)).toEqual(ranked);
    expect(worker.batches).toHaveLength(1);
    const changed = ranker.classify([...cachedMessages.slice(0, -1), { ...cachedMessages.at(-1), preview: 'New excerpt' }]);
    expect(worker.batches[1]).toHaveLength(1);
    complete(worker);
    expect(await changed).toEqual(ranked);
    ranker.dispose();
  });

  it('releases a failed worker and rejects when disposed during a retry', async () => {
    vi.stubGlobal('Worker', TestWorker);
    const ranker = createBrowserTriageRanker();
    const messages = [mail(1, 'Meeting last week')];
    const first = ranker.classify(messages);
    const [failed] = TestWorker.workers;
    failed.reply({ type: 'error', message: 'Unavailable' });
    await expect(first).rejects.toThrow('Unavailable');
    expect(failed.terminated).toBe(true);
    const second = ranker.classify(messages);
    const pending = expect(second).rejects.toThrow('stopped');
    ranker.dispose();
    expect(TestWorker.workers[1].terminated).toBe(true);
    await pending;
  });

  it('uses the anchor sigmoid but keeps low scores in Needs attention', () => {
    expect(scoreE5Similarity(0.7, 0.7, true)).toMatchObject({ disposition: 'uncertain', baseScore: 57 });
    expect(scoreE5Similarity(0.4, 0.8, false)).toMatchObject({ disposition: 'uncertain', baseScore: 35 });
    expect(scoreE5Similarity(0.8, 0.4, false)).toMatchObject({ disposition: 'uncertain', baseScore: 79 });
  });
});
