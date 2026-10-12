/** First character of a name, upper-cased, for avatar and logo tiles. */
export function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}
