import type { TriageClassification } from './smart-sort';

export interface BrowserTriageProgress {
  phase: 'preparing' | 'ranking';
  completed?: number;
  total?: number;
  percentage?: number;
}

export interface BrowserModelInput {
  key: string;
  text: string;
  directRecipient: boolean;
}

export type BrowserModelResult = [string, TriageClassification];

export type BrowserModelResponse =
  | { type: 'progress'; progress: BrowserTriageProgress }
  | { type: 'done'; results: BrowserModelResult[] }
  | { type: 'error'; message: string };

export function scoreE5Similarity(
  importantSimilarity: number,
  updateSimilarity: number,
  directRecipient: boolean,
): TriageClassification {
  const probability = 1 / (1 + Math.exp(-(importantSimilarity - updateSimilarity) * 12));
  const score = Math.round(probability * 100 + (directRecipient ? 7 : 0));
  const baseScore = Number.isFinite(score) ? Math.max(35, Math.min(79, score)) : 48;
  return {
    disposition: 'uncertain', baseScore,
    reason: baseScore >= 60 ? 'May need a response' : 'May need your attention',
  };
}
