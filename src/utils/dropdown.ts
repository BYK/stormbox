export function closeContainingDropdown(
  source: Event | Element | null | undefined,
  restoreFocus = false,
): void {
  const element = source instanceof Event ? source.currentTarget : source;
  if (!(element instanceof Element)) return;
  const details = element.closest('details');
  if (!(details instanceof HTMLDetailsElement)) return;
  details.open = false;
  if (restoreFocus) details.querySelector('summary')?.focus({ preventScroll: true });
}
