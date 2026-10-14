import { m } from "./paraglide/messages.js";

/** Submit label of the grant form, naming the target and permission once a target is chosen. */
export function grantSubmitLabel(permissionLabel: string, target: string | null | undefined): string {
  return target ? m.grants_submit_target({ target, permission: permissionLabel }) : m.grants_submit();
}
