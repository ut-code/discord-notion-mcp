/** Submit label of the grant form, e.g. "@Staff に Discord 読み取りを付与". */
export function grantSubmitLabel(permissionLabel: string, target: string | null | undefined): string {
  return target ? `${target} に ${permissionLabel}を付与` : "付与する";
}
