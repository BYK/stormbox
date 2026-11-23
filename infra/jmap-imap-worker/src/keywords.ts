const SYSTEM_FLAGS: Record<string, string> = { $seen: '\\Seen', $flagged: '\\Flagged' };

export function isTagKeyword(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value) && !/[(){\]%*"\\]/.test(value)
    && !/^\$(?:seen|flagged|junk|notjunk|draft|answered|forwarded|deleted|recent|phishing|notphishing)$/i.test(value);
}

export function imapFlag(keyword: string): string | undefined {
  if (Object.hasOwn(SYSTEM_FLAGS, keyword)) return SYSTEM_FLAGS[keyword];
  return isTagKeyword(keyword) ? keyword : undefined;
}

export function jmapKeywords({ seen, flagged, keywords }: { seen: boolean; flagged: boolean; keywords: string[] }): Record<string, true> {
  return Object.fromEntries([
    ...(seen ? ['$seen'] : []), ...(flagged ? ['$flagged'] : []),
    ...keywords.filter(isTagKeyword).map((keyword) => keyword.toLowerCase()),
  ].map((keyword) => [keyword, true]));
}

export interface KeywordChange {
  keyword: string;
  add: boolean;
}

export interface KeywordUpdate extends KeywordChange {
  id: string;
}

export type KeywordError = 'notFound' | 'forbidden';

export interface KeywordResults {
  oldState: string;
  newState: string;
  updated: string[];
  notUpdated: Record<string, KeywordError>;
}

export type KeywordWriteOutcome = KeywordResults | { error: 'serverPartialFail' | 'serverUnavailable' } | null;
