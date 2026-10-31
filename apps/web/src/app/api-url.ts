import { environment } from "../environments/environment";

/** Prefix for REST, SSE, and fetch calls (/api/...). */
export function apiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = environment.apiBaseUrl.replace(/\/$/, "");
  return `${base}${normalized}`;
}
