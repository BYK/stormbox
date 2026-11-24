import type { BundleState } from './smart-sort';

export type BundleStates = Record<string, BundleState>;

export function matchingBundleStates(states: BundleStates, aliases: readonly string[]): BundleStates {
  const matching = new Set(aliases);
  return Object.fromEntries(Object.entries(states).filter(([id, state]) =>
    matching.has(id) || state.aliases.some((alias) => matching.has(alias))));
}

export function replaceBundleStates(states: BundleStates, aliases: readonly string[], replacements: BundleStates): BundleStates {
  const previous = matchingBundleStates(states, aliases);
  return {
    ...Object.fromEntries(Object.entries(states).filter(([id]) => !Object.hasOwn(previous, id))),
    ...replacements,
  };
}

export function equalBundleStates(left: BundleStates, right: BundleStates): boolean {
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length
    && entries.every(([id, state]) => Object.hasOwn(right, id) && JSON.stringify(state) === JSON.stringify(right[id]));
}
