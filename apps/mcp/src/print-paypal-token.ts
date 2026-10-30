/**
 * Prints a short-lived PayPal sandbox access token for @paypal/mcp (stdio config).
 * Reads PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from the environment or repo .env.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadRootEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "../../..");
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadRootEnv();
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  const mode = (process.env.PAYPAL_MODE ?? "sandbox").toLowerCase();
  if (!clientId || !clientSecret) {
    console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.");
    process.exit(1);
  }
  const base = mode === "live" || mode === "production" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) {
    console.error("Token request failed:", body.error_description ?? response.status);
    process.exit(1);
  }
  console.log(body.access_token);
  console.error(`Token expires in ~${body.expires_in ?? "?"}s. Use PAYPAL_ENVIRONMENT=${mode === "live" || mode === "production" ? "PRODUCTION" : "SANDBOX"}.`);
}

main();
