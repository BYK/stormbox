import { AutoModel, AutoTokenizer, cos_sim, env, mean_pooling, type ProgressCallback, type Tensor } from '@huggingface/transformers';
import wasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import wasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import {
  scoreE5Similarity, type BrowserModelInput, type BrowserModelResponse, type BrowserModelResult,
} from './browser-model-shared';

const MODEL = 'Xenova/multilingual-e5-small';
const REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const BATCH_SIZE = 4;
const IMPORTANT = 'query: An important or urgent email addressed to me that needs a response, decision, approval, payment, or concrete action soon and has meaningful consequences.';
const UPDATE = 'query: A low-priority automated newsletter, marketing promotion, routine notification, social update, digest, advertisement, or informational message requiring no response.';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (response: BrowserModelResponse) => scope.postMessage(response);

env.allowLocalModels = false;
// The tokenizer registry does not forward the requested revision when probing its files.
env.remotePathTemplate = `{model}/resolve/${REVISION}/`;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL(wasmFactoryUrl, scope.location.href).href,
    wasm: new URL(wasmBinaryUrl, scope.location.href).href,
  };
}

async function prepare(progress: ProgressCallback) {
  const options = { revision: REVISION, progress_callback: progress };
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL, options);
  const model = await AutoModel.from_pretrained(MODEL, { ...options, dtype: 'q8', device: 'wasm' });
  async function embed(text: string[]) {
    const inputs = tokenizer(text, { padding: true, truncation: true, max_length: 256 });
    const outputs = await model(inputs);
    const pooled = mean_pooling(outputs.last_hidden_state as Tensor, inputs.attention_mask).normalize(2, 1);
    return pooled.tolist() as number[][];
  }
  const [important, update] = await embed([IMPORTANT, UPDATE]);
  return { embed, important, update };
}

let ready: ReturnType<typeof prepare> | undefined;
scope.onmessage = async (event: MessageEvent<BrowserModelInput[]>) => {
  try {
    if (!ready) {
      send({ type: 'progress', progress: { phase: 'preparing' } });
      ready = prepare((info) => {
        if (info.status === 'progress' && info.file.endsWith('.onnx') && Number.isFinite(info.progress)) {
          send({ type: 'progress', progress: { phase: 'preparing', percentage: info.progress } });
        }
      });
    }
    const { embed, important, update } = await ready;
    const inputs = event.data;
    const results: BrowserModelResult[] = [];
    send({ type: 'progress', progress: { phase: 'ranking', completed: 0, total: inputs.length } });
    for (let offset = 0; offset < inputs.length; offset += BATCH_SIZE) {
      const batch = inputs.slice(offset, offset + BATCH_SIZE);
      const embeddings = await embed(batch.map((item) => item.text));
      for (const [index, item] of batch.entries()) {
        const vector = embeddings[index];
        results.push([item.key, scoreE5Similarity(cos_sim(vector, important), cos_sim(vector, update), item.directRecipient)]);
      }
      send({ type: 'progress', progress: { phase: 'ranking', completed: results.length, total: inputs.length } });
    }
    send({ type: 'done', results });
  } catch (error) {
    ready = undefined;
    const detail = error instanceof Error ? error.message.slice(0, 160) : '';
    send({ type: 'error', message: detail ? `E5 could not run locally. ${detail}` : 'E5 could not run locally' });
  }
};
