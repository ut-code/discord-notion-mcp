import { isRecord } from "$lib/guards";
import { m } from "$lib/paraglide/messages.js";
import type { SubjectOption } from "$lib/server/dashboard/grants";

const DEBOUNCE_MS = 250;

const isNullableString = (value: unknown) => value === null || typeof value === "string";

function isMemberOption(value: unknown): value is SubjectOption {
  return (
    isRecord(value) &&
    value.type === "user" &&
    typeof value.key === "string" &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    isNullableString(value.secondLine) &&
    isNullableString(value.color) &&
    isNullableString(value.avatarUrl) &&
    Array.isArray(value.granted) &&
    value.granted.every((permission) => typeof permission === "string") &&
    isRecord(value.notices) &&
    Object.values(value.notices).every((notice) => typeof notice === "string")
  );
}

/** The endpoint's JSON; a malformed member list counts as a failed search. */
function parseBody(body: unknown): { members?: SubjectOption[]; error?: string } {
  if (!isRecord(body)) return {};
  return {
    members: Array.isArray(body.members) && body.members.every(isMemberOption) ? body.members : undefined,
    error: typeof body.error === "string" ? body.error : undefined,
  };
}

/**
 * Search-as-you-type against the members endpoint: debounced, aborts the request of a
 * superseded query, ignores stale responses and caches results per query for the page's life.
 */
export class MemberLookup {
  /** Results of the latest settled query; kept while the next one loads. */
  members = $state<SubjectOption[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo read in methods, never rendered
  private readonly cache = new Map<string, SubjectOption[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | null = null;
  /** The query on screen; null after a failure so typing the same query again retries it. */
  private latest: string | null = "";

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
      const body = parseBody(await response.json());
      if (key !== this.latest) return;
      if (response.ok && body.members) {
        this.cache.set(key, body.members);
        this.members = body.members;
      } else {
        this.fail(body.error ?? m.grants_member_search_failed());
      }
    } catch (error) {
      if (controller.signal.aborted || key !== this.latest) return;
      this.fail(m.grants_member_search_failed());
      console.error(error);
    }
    this.loading = false;
  }

  private fail(message: string): void {
    this.members = [];
    this.error = message;
    this.latest = null;
  }
}
