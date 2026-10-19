import { getLocale } from "./paraglide/runtime.js";

// Formatting and ordering in the UI language, so that adding a language needs no edits here.
// Dates stay in Japan time (format.ts): that follows the server's users, not the language.

/** A number with the UI language's digits and grouping, e.g. 1,234; ids are not counts and stay raw. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}

const collators = new Map<string, Intl.Collator>();

/** Orders names as the UI language does; the collator is reused because member lists sort thousands. */
export function compareNames(a: string, b: string): number {
  const locale = getLocale();
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale);
    collators.set(locale, collator);
  }
  return collator.compare(a, b);
}
