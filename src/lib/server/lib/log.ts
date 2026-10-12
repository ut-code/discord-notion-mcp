export type LogEntry = { event: string } & Record<string, unknown>;

export type LogSink = (entry: LogEntry) => void;

function line(entry: LogEntry): string {
  return JSON.stringify({ ts: new Date().toISOString(), ...entry });
}

/** One JSON line per event on stdout. */
export function logEvent(entry: LogEntry): void {
  console.log(line(entry));
}

/** One JSON line per error on stderr. */
export function logError(entry: LogEntry): void {
  console.error(line(entry));
}
