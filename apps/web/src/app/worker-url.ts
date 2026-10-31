/** Worker link always uses the UI origin (Vercel), not the API host on Render. */
export function buildWorkerUrl(promiseId: string, shareToken: string): string {
  const origin =
    typeof globalThis !== "undefined" && "location" in globalThis
      ? String((globalThis as Window & typeof globalThis).location.origin)
      : "";
  const path = `/w/${promiseId}/${shareToken}`;
  if (!origin || origin === "null") return path;
  return `${origin.replace(/\/$/, "")}${path}`;
}

/** Fix links stored when APP_BASE_URL was still localhost. */
export function normalizeWorkerUrl(stored: string, promiseId: string, shareToken: string | null): string {
  if (shareToken) return buildWorkerUrl(promiseId, shareToken);
  const match = stored.match(/\/w\/([^/]+)\/([^/?#]+)/);
  if (match?.[1] === promiseId && match[2]) return buildWorkerUrl(promiseId, match[2]);
  return stored;
}
