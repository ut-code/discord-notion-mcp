/** Form action URL (`?/name`) that keeps the page's other query parameters. */
export function actionUrl(url: URL, name: string): string {
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) if (key.startsWith("/")) params.delete(key);
  const query = params.toString();
  return query ? `?${query}&/${name}` : `?/${name}`;
}
