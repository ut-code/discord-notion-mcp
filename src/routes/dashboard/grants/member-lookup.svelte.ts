import type { CandidateView } from "$lib/server/dashboard/grants";

const DEBOUNCE_MS = 250;
const FAILED = "メンバー検索に失敗しました。";

/**
 * Search-as-you-type against the members endpoint: debounced, aborts the request of a
 * superseded query, ignores stale responses and caches results per query for the page's life.
 */
export class MemberLookup {
  /** Results of the latest settled query; kept while the next one loads. */
  members = $state<CandidateView[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  private readonly cache = new Map<string, CandidateView[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | null = null;
  private latest = "";

  constructor(private readonly endpoint: string) {}

  search(query: string): void {
    const key = query.trim().toLowerCase();
    if (key === this.latest) return;
    this.latest = key;
    this.cancel();
    this.error = null;
    if (!key) {
      this.members = [];
      this.loading = false;
      return;
    }
    const hit = this.cache.get(key);
    if (hit) {
      this.members = hit;
      this.loading = false;
      return;
    }
    this.loading = true;
    this.timer = setTimeout(() => void this.load(key), DEBOUNCE_MS);
  }

  /** Stops pending work, e.g. when the picker is destroyed. */
  cancel(): void {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
  }

  private async load(key: string): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await fetch(`${this.endpoint}?q=${encodeURIComponent(key)}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (response.status === 401) {
        // Session ended: reloading goes through the sign-in redirect back to this page.
        location.reload();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { members?: CandidateView[]; error?: string };
      if (key !== this.latest) return;
      if (response.ok && body.members) {
        this.cache.set(key, body.members);
        this.members = body.members;
      } else {
        this.members = [];
        this.error = body.error ?? FAILED;
      }
    } catch (error) {
      if (controller.signal.aborted || key !== this.latest) return;
      this.members = [];
      this.error = FAILED;
      console.error(error);
    }
    this.loading = false;
  }
}
