import { readFile } from "node:fs/promises";
import path from "node:path";

export class ApiClient {
  private payerToken = process.env.PP_ACCESS_TOKEN?.trim() ?? "";

  constructor(private readonly baseUrl: string) {}

  setPayerToken(token: string): void {
    this.payerToken = token;
  }

  getPayerToken(): string {
    return this.payerToken;
  }

  async login(email: string): Promise<unknown> {
    const body = await this.request("POST", "/auth/login", { json: { email } });
    if (body && typeof body === "object" && "token" in body && typeof body.token === "string") {
      this.payerToken = body.token;
    }
    return body;
  }

  async listPromises(): Promise<unknown> {
    return this.request("GET", "/promises", { payer: true });
  }

  async getPromise(id: string, shareToken?: string): Promise<unknown> {
    return this.request("GET", `/promises/${id}`, { payer: !shareToken, shareToken });
  }

  async createPromise(body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/promises", { payer: true, json: body, idempotency: true });
  }

  async confirmChecklist(
    id: string,
    input: { items: unknown[]; pass_threshold?: number; confirm?: boolean; deadline_at?: string },
  ): Promise<unknown> {
    return this.request("PUT", `/promises/${id}/checklist`, {
      payer: true,
      json: input,
      idempotency: true,
    });
  }

  async createFundingOrder(id: string): Promise<unknown> {
    return this.request("POST", `/promises/${id}/fund`, { payer: true, idempotency: true });
  }

  async listVerifications(id: string, shareToken?: string): Promise<unknown> {
    return this.request("GET", `/promises/${id}/verifications`, { payer: !shareToken, shareToken });
  }

  async issueChallenge(id: string, shareToken: string): Promise<unknown> {
    return this.request("POST", `/promises/${id}/challenge`, { shareToken, idempotency: true });
  }

  async submitProof(id: string, shareToken: string, imagePath: string): Promise<unknown> {
    const resolved = path.resolve(imagePath);
    const buffer = await readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), path.basename(resolved));
    const headers: Record<string, string> = { "x-share-token": shareToken };
    if (this.payerToken) headers.Authorization = `Bearer ${this.payerToken}`;
    headers["Idempotency-Key"] = crypto.randomUUID();
    const response = await fetch(`${this.baseUrl}/promises/${id}/submissions`, {
      method: "POST",
      headers,
      body: form,
    });
    return readResponse(response);
  }

  async health(): Promise<unknown> {
    return this.request("GET", "/health");
  }

  private async request(
    method: string,
    pathname: string,
    opts: { payer?: boolean; shareToken?: string; json?: unknown; idempotency?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.payer) {
      if (!this.payerToken) throw new Error("Not signed in. Call pp_login or set PP_ACCESS_TOKEN.");
      headers.Authorization = `Bearer ${this.payerToken}`;
    }
    if (opts.shareToken) headers["x-share-token"] = opts.shareToken;
    if (opts.idempotency) headers["Idempotency-Key"] = crypto.randomUUID();
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    });
    return readResponse(response);
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    let detail = text;
    if (body && typeof body === "object") {
      const err = body as { message?: string; error?: { message?: string } };
      detail = err.error?.message ?? err.message ?? text;
    }
    throw new Error(`${response.status}: ${detail}`);
  }
  return body;
}
