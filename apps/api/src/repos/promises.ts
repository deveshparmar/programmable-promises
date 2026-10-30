import type { PromiseStatus } from "@pp/shared";
import { pool, type DbClient } from "../db.js";
import { HttpError } from "../errors.js";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface PromiseRow {
  id: string;
  payer_id: string;
  worker_email: string;
  title: string;
  description: string;
  amount_minor: number;
  currency: string;
  status: PromiseStatus;
  deadline_at: Date;
  share_token_hash: string;
  checklist_version: number;
  pending_challenge_code: string | null;
  paypal_order_id: string | null;
  paypal_authorization_id: string | null;
  paypal_capture_id: string | null;
  paypal_payout_batch_id: string | null;
  pass_threshold: number;
  status_detail: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChecklistItemRow {
  id: string;
  promise_id: string;
  position: number;
  text: string;
  weight: number;
  required: boolean;
}

const PROMISE_COLUMNS = `id, payer_id, worker_email, title, description, amount_minor, currency, status,
  deadline_at, share_token_hash, checklist_version, pending_challenge_code, paypal_order_id,
  paypal_authorization_id, paypal_capture_id, paypal_payout_batch_id, pass_threshold, status_detail,
  created_at, updated_at`;

function asPromise(row: PromiseRow): PromiseRow {
  return { ...row, status: row.status, deadline_at: new Date(row.deadline_at), created_at: new Date(row.created_at), updated_at: new Date(row.updated_at) };
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const result = await pool.query<UserRow>("SELECT id, email, name, role FROM users WHERE email = $1", [email]);
  return result.rows[0];
}

export async function findOrCreatePayer(email: string, name: string): Promise<UserRow> {
  const existing = await findUserByEmail(email);
  if (existing) return existing;
  const result = await pool.query<UserRow>(
    `INSERT INTO users (email, name, role) VALUES ($1, $2, 'payer')
     ON CONFLICT (email) DO UPDATE SET email = users.email
     RETURNING id, email, name, role`,
    [email, name],
  );
  return result.rows[0];
}

export async function findUserById(id: string): Promise<UserRow | undefined> {
  const result = await pool.query<UserRow>("SELECT id, email, name, role FROM users WHERE id = $1", [id]);
  return result.rows[0];
}

export async function findPromiseById(id: string, client: DbClient | typeof pool = pool): Promise<PromiseRow | undefined> {
  const result = await client.query<PromiseRow>(`SELECT ${PROMISE_COLUMNS} FROM promises WHERE id = $1`, [id]);
  return result.rows[0] ? asPromise(result.rows[0]) : undefined;
}

export async function listPromises(payerId: string): Promise<PromiseRow[]> {
  const result = await pool.query<PromiseRow>(
    `SELECT ${PROMISE_COLUMNS} FROM promises WHERE payer_id = $1 ORDER BY created_at DESC`,
    [payerId],
  );
  return result.rows.map(asPromise);
}

export async function countPromises(payerId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM promises WHERE payer_id = $1",
    [payerId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function listPromisesPage(payerId: string, limit: number, offset: number): Promise<PromiseRow[]> {
  const result = await pool.query<PromiseRow>(
    `SELECT ${PROMISE_COLUMNS} FROM promises WHERE payer_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [payerId, limit, offset],
  );
  return result.rows.map(asPromise);
}

export async function insertPromise(
  client: DbClient,
  input: {
    payerId: string;
    workerEmail: string;
    title: string;
    description: string;
    amountMinor: number;
    deadline: Date;
    shareTokenHash: string;
  },
): Promise<PromiseRow> {
  const result = await client.query<PromiseRow>(
    `INSERT INTO promises (payer_id, worker_email, title, description, amount_minor, status, deadline_at, share_token_hash)
     VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7)
     RETURNING ${PROMISE_COLUMNS}`,
    [input.payerId, input.workerEmail, input.title, input.description, input.amountMinor, input.deadline, input.shareTokenHash],
  );
  return asPromise(result.rows[0]);
}

export async function transitionStatus(
  client: DbClient,
  id: string,
  from: PromiseStatus,
  to: PromiseStatus,
  detail?: string | null,
): Promise<PromiseRow> {
  const result = await client.query<PromiseRow>(
    `UPDATE promises
     SET status = $2, status_detail = $3, updated_at = now()
     WHERE id = $1 AND status = $4
     RETURNING ${PROMISE_COLUMNS}`,
    [id, to, detail ?? null, from],
  );
  if (!result.rows[0]) {
    throw new HttpError(409, "STATE_CONFLICT", "That promise changed. Refresh and try again.");
  }
  return asPromise(result.rows[0]);
}

export async function patchPromise(
  client: DbClient,
  id: string,
  patch: Partial<{
    title: string;
    pass_threshold: number;
    checklist_version: number;
    pending_challenge_code: string | null;
    paypal_order_id: string | null;
    paypal_authorization_id: string | null;
    paypal_capture_id: string | null;
    paypal_payout_batch_id: string | null;
    deadline_at: Date;
    status_detail: string | null;
  }>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([column], index) => `${column} = $${index + 2}`);
  await client.query(
    `UPDATE promises SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    [id, ...entries.map(([, value]) => value)],
  );
}

export async function listChecklist(promiseId: string, client: DbClient | typeof pool = pool): Promise<ChecklistItemRow[]> {
  const result = await client.query<ChecklistItemRow>(
    "SELECT id, promise_id, position, text, weight, required FROM checklist_items WHERE promise_id = $1 ORDER BY position",
    [promiseId],
  );
  return result.rows;
}

export async function replaceChecklist(
  client: DbClient,
  promiseId: string,
  items: { text: string; weight: number; required: boolean }[],
): Promise<ChecklistItemRow[]> {
  await client.query("DELETE FROM checklist_items WHERE promise_id = $1", [promiseId]);
  const saved: ChecklistItemRow[] = [];
  for (const [index, item] of items.entries()) {
    const result = await client.query<ChecklistItemRow>(
      `INSERT INTO checklist_items (promise_id, position, text, weight, required)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, promise_id, position, text, weight, required`,
      [promiseId, index, item.text, item.weight, item.required],
    );
    saved.push(result.rows[0]);
  }
  return saved;
}

export async function countFails(client: DbClient, promiseId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM verifications v
     JOIN submissions s ON s.id = v.submission_id
     WHERE s.promise_id = $1 AND v.verdict = 'fail'`,
    [promiseId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function nextAttempt(client: DbClient, promiseId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM submissions WHERE promise_id = $1",
    [promiseId],
  );
  return Number(result.rows[0]?.count ?? 0) + 1;
}

export async function findSubmissionById(
  submissionId: string,
): Promise<{ id: string; promise_id: string; storage_key: string; challenge_code: string } | undefined> {
  const result = await pool.query<{
    id: string;
    promise_id: string;
    storage_key: string;
    challenge_code: string;
  }>("SELECT id, promise_id, storage_key, challenge_code FROM submissions WHERE id = $1", [submissionId]);
  return result.rows[0];
}

export async function listHashes(promiseId: string): Promise<{ content_hash: string; perceptual_hash: string | null }[]> {
  const result = await pool.query<{ content_hash: string; perceptual_hash: string | null }>(
    `SELECT s.content_hash, s.perceptual_hash
     FROM submissions s
     WHERE s.promise_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM verifications v WHERE v.submission_id = s.id AND v.verdict = 'error'
       )`,
    [promiseId],
  );
  return result.rows;
}

export async function latestVerificationId(promiseId: string): Promise<string | undefined> {
  const result = await pool.query<{ id: string }>(
    `SELECT v.id FROM verifications v
     JOIN submissions s ON s.id = v.submission_id
     WHERE s.promise_id = $1
     ORDER BY v.created_at DESC LIMIT 1`,
    [promiseId],
  );
  return result.rows[0]?.id;
}

export async function listDue(now: Date): Promise<PromiseRow[]> {
  const result = await pool.query<PromiseRow>(
    `SELECT ${PROMISE_COLUMNS} FROM promises
     WHERE deadline_at <= $1
       AND status IN ('AWAITING_FUNDING', 'FUNDED', 'SUBMITTED', 'REJECTED_RETRY', 'NEEDS_REVIEW')`,
    [now],
  );
  return result.rows.map(asPromise);
}

export async function findPromiseByPaypalIds(ids: string[]): Promise<PromiseRow | undefined> {
  const usable = ids.filter(Boolean);
  if (!usable.length) return undefined;
  const uuids = usable.filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  );
  const result = await pool.query<PromiseRow>(
    `SELECT ${PROMISE_COLUMNS} FROM promises
     WHERE ($1::uuid[] <> '{}' AND id = ANY($1::uuid[]))
        OR paypal_order_id = ANY($2::text[])
        OR paypal_authorization_id = ANY($2::text[])
        OR paypal_capture_id = ANY($2::text[])
        OR paypal_payout_batch_id = ANY($2::text[])
     LIMIT 1`,
    [uuids, usable],
  );
  return result.rows[0] ? asPromise(result.rows[0]) : undefined;
}
