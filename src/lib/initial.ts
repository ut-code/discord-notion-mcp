const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** First user-perceived character of a name (whole emoji / ZWJ sequences), upper-cased, for avatar and logo tiles. */
export function initialOf(name: string): string {
  const [first] = graphemes.segment(name.trim());
  return first?.segment.toUpperCase() ?? "?";
}
