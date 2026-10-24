import { formatNumber } from "./locale";
import { m } from "./paraglide/messages.js";

/** Grants (permission × subject pairs) one submit of the grant form may make at most. */
export const MAX_GRANTS_PER_SUBMIT = 100;

/**
 * Submit label of the grant form: names the subject and the permission when one of each is chosen,
 * otherwise counts the grants it would make (`count`, the pairs not granted yet).
 */
export function grantSubmitLabel(subjects: readonly string[], permissions: readonly string[], count: number): string {
  const [subject] = subjects;
  const [permission] = permissions;
  if (subject && permission && subjects.length === 1 && permissions.length === 1) {
    return m.grants_submit_target({ target: subject, permission });
  }
  return count > 0 ? m.grants_submit_count({ count: formatNumber(count) }) : m.grants_submit();
}
