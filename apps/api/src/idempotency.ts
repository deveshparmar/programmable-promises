import { createHash } from "node:crypto";
import type { Request } from "express";
import { pool } from "./db.js";
import { HttpError } from "./errors.js";

interface StoredResponse {
  status: number;
  body: unknown;
}

export async function idempotent(
  req: Request,
  scope: string,
  exec: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const key = req.header("idempotency-key")?.trim();
  if (!key || key.length > 200) {
    throw new HttpError(400, "MISSING_IDEMPOTENCY_KEY", "Send an Idempotency-Key header.");
  }
  const existing = await pool.query(
    "SELECT status_code, response_body, created_at FROM idempotency_keys WHERE key = $1 AND scope = $2",
    [key, scope],
  );
  const row = existing.rows[0] as { status_code: number; response_body: unknown; created_at: Date } | undefined;
  if (row?.status_code) return { status: row.status_code, body: row.response_body };
  if (row && Date.now() - new Date(row.created_at).getTime() < 120_000) {
    throw new HttpError(409, "IDEMPOTENCY_IN_PROGRESS", "That request is already running.");
  }
  if (row) {
    await pool.query("DELETE FROM idempotency_keys WHERE key = $1 AND scope = $2 AND status_code = 0", [key, scope]);
  }
  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (key, scope, response_hash, response_body, status_code)
     VALUES ($1, $2, 'pending', '{}'::jsonb, 0)
     ON CONFLICT DO NOTHING`,
    [key, scope],
  );
  if (!inserted.rowCount) {
    throw new HttpError(409, "IDEMPOTENCY_IN_PROGRESS", "That request is already running.");
  }
  try {
    const result = await exec();
    const encoded = JSON.stringify(result.body);
    await pool.query(
      `UPDATE idempotency_keys
       SET status_code = $3, response_body = $4::jsonb, response_hash = $5
       WHERE key = $1 AND scope = $2`,
      [key, scope, result.status, encoded, createHash("sha256").update(encoded).digest("hex")],
    );
    return result;
  } catch (error) {
    await pool.query("DELETE FROM idempotency_keys WHERE key = $1 AND scope = $2 AND status_code = 0", [key, scope]);
    throw error;
  }
}
