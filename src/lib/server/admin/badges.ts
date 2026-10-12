/** A small label rendered as a badge; the tone picks its colors. */
export interface BadgeView {
  label: string;
  tone: "outline" | "secondary" | "success" | "destructive" | "warn" | "dark";
  /** Tooltip. */
  title?: string;
}
