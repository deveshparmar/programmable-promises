import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { UPLOAD_STATUSES, type PromiseStatus } from "@pp/shared";
import { config } from "../config.js";
import { pool, withTx } from "../db.js";
import { HttpError } from "../errors.js";
import { DUPLICATE_HAMMING, assertImage, hammingHex, perceptualHash } from "../images/phash.js";
import { assertDeadline, hashToken, newChallengeCode, newToken, sha256 } from "../money.js";
import {
  findPromiseById,
  insertPromise,
  latestVerificationId,
  listChecklist,
  listHashes,
  listPromises,
  nextAttempt,
  patchPromise,
  replaceChecklist,
  transitionStatus,
  type ChecklistItemRow,
  type PromiseRow,
} from "../repos/promises.js";
import { withLock } from "../redis.js";
import { publish } from "../sse.js";
import { cancelPromise, settle } from "./paymentService.js";
import { verifySubmission } from "./verificationService.js";
import { generateChecklist } from "../verifier/model.js";

export interface PublicPromise {
  id: string;
  payer_id: string;
  worker_email: string;
  title: string;
  description: string;
  amount_minor: number;
  currency: string;
  status: PromiseStatus;
  deadline_at: string;
  checklist_version: number;
  pass_threshold: number;
  status_detail: string | null;
  paypal_order_id: string | null;
  has_authorization: boolean;
  created_at: string;
  updated_at: string;
  checklist: ChecklistItemRow[];
}

export function present(promise: PromiseRow, checklist: ChecklistItemRow[]): PublicPromise {
  return {
    id: promise.id,
    payer_id: promise.payer_id,
    worker_email: promise.worker_email,
    title: promise.title,
    description: promise.description,
    amount_minor: promise.amount_minor,
    currency: promise.currency,
    status: promise.status,
    deadline_at: promise.deadline_at.toISOString(),
    checklist_version: promise.checklist_version,
    pass_threshold: Number(promise.pass_threshold),
    status_detail: promise.status_detail,
    paypal_order_id: promise.paypal_order_id,
    has_authorization: Boolean(promise.paypal_authorization_id),
    created_at: promise.created_at.toISOString(),
    updated_at: promise.updated_at.toISOString(),
    checklist,
  };
}

async function visible(id: string, payerId?: string): Promise<{ promise: PromiseRow; checklist: ChecklistItemRow[] }> {
  const promise = await findPromiseById(id);
  if (!promise || (payerId && promise.payer_id !== payerId)) {
    throw new HttpError(404, "NOT_FOUND", "Promise not found.");
  }
  return { promise, checklist: await listChecklist(id) };
}

export async function createPromise(input: {
  payerId: string;
  title?: string;
  description: string;
  amountMinor: number;
  workerEmail: string;
  deadlineAt: string;
}): Promise<PublicPromise & { share_token: string; worker_url: string; checklist_error?: string }> {
  const deadline = assertDeadline(input.deadlineAt);
  const shareToken = newToken();
  const created = await withTx(async (client) =>
    insertPromise(client, {
      payerId: input.payerId,
      workerEmail: input.workerEmail.toLowerCase(),
      title: input.title ?? input.description.slice(0, 80),
      description: input.description,
      amountMinor: input.amountMinor,
      deadline,
      shareTokenHash: hashToken(shareToken),
    }),
  );
  let checklist = await listChecklist(created.id);
  let checklistError: string | undefined;
  try {
    const generated = await generateChecklist(input.description);
    const saved = await withTx(async (client) => {
      if (!input.title) await patchPromise(client, created.id, { title: generated.title });
      await patchPromise(client, created.id, { pass_threshold: generated.pass_threshold ?? 0.8 });
      return replaceChecklist(client, created.id, generated.items);
    });
    checklist = saved;
  } catch (error) {
    checklistError = error instanceof HttpError ? error.message : "Checklist generation failed. Edit one by hand.";
    console.error("Checklist generation failed", error);
  }
  const promise = (await findPromiseById(created.id)) ?? created;
  const workerUrl = `${config.appBaseUrl}/w/${promise.id}/${shareToken}`;
  return { ...present(promise, checklist), share_token: shareToken, worker_url: workerUrl, checklist_error: checklistError };
}

export async function getPromise(id: string, payerId?: string): Promise<PublicPromise> {
  const { promise, checklist } = await visible(id, payerId);
  return present(promise, checklist);
}

export async function getPromiseList(payerId: string): Promise<PublicPromise[]> {
  const rows = await listPromises(payerId);
  const result: PublicPromise[] = [];
  for (const promise of rows) {
    result.push(present(promise, await listChecklist(promise.id)));
  }
  return result;
}

export async function updateChecklist(
  id: string,
  payerId: string,
  input: {
    items: { text: string; weight: number; required: boolean }[];
    passThreshold?: number;
    confirm?: boolean;
    deadlineAt?: string;
  },
): Promise<PublicPromise> {
  const { promise } = await visible(id, payerId);
  if (promise.status !== "DRAFT" && promise.status !== "AWAITING_FUNDING") {
    throw new HttpError(409, "CHECKLIST_LOCKED", "The checklist is locked after funding.");
  }
  if (!input.items.some((item) => item.required)) {
    throw new HttpError(400, "CHECKLIST_INVALID", "At least one checklist item must be required.");
  }
  const deadline = input.deadlineAt ? assertDeadline(input.deadlineAt) : undefined;
  const updated = await withTx(async (client) => {
    const checklist = await replaceChecklist(client, id, input.items);
    const version = promise.status === "DRAFT" ? (input.confirm ? 1 : 0) : promise.checklist_version + 1;
    await patchPromise(client, id, {
      checklist_version: version,
      pass_threshold: input.passThreshold ?? Number(promise.pass_threshold),
      deadline_at: deadline,
    });
    let current = (await findPromiseById(id, client))!;
    if (promise.status === "DRAFT" && input.confirm) {
      current = await transitionStatus(client, id, "DRAFT", "AWAITING_FUNDING", null);
    }
    return { current, checklist };
  });
  await publish(id, { type: "status", status: updated.current.status, at: new Date().toISOString() });
  return present(updated.current, updated.checklist);
}

export async function issueChallenge(promise: PromiseRow): Promise<{ challenge_code: string }> {
  if (!UPLOAD_STATUSES.includes(promise.status)) {
    throw new HttpError(409, "STATE_CONFLICT", "This promise is not waiting for a photo.");
  }
  if (promise.deadline_at.getTime() <= Date.now()) {
    throw new HttpError(409, "DEADLINE_PASSED", "The deadline has passed.");
  }
  const code = newChallengeCode();
  await withTx(async (client) => {
    await patchPromise(client, promise.id, { pending_challenge_code: code });
  });
  return { challenge_code: code };
}

export async function submitProof(promise: PromiseRow, file: Express.Multer.File | undefined): Promise<unknown> {
  if (!UPLOAD_STATUSES.includes(promise.status)) {
    throw new HttpError(409, "STATE_CONFLICT", "This promise is not accepting a photo.");
  }
  if (promise.deadline_at.getTime() <= Date.now()) {
    throw new HttpError(409, "DEADLINE_PASSED", "The deadline has passed.");
  }
  if (!promise.pending_challenge_code) {
    throw new HttpError(400, "CHALLENGE_REQUIRED", "Request a challenge code and include it in the photo.");
  }
  if (!file || file.size > 10 * 1024 * 1024) {
    throw new HttpError(400, "UNSUPPORTED_FILE", "Upload one jpg or png, up to 10 MB.");
  }
  const mime = assertImage(file.buffer, file.mimetype);
  const contentHash = sha256(file.buffer);
  const perceptual = perceptualHash(file.buffer, mime);
  const prior = await listHashes();
  if (prior.some((row) => row.content_hash === contentHash)) {
    throw new HttpError(409, "DUPLICATE_PROOF", "That photo was already submitted.");
  }
  if (perceptual && prior.some((row) => row.perceptual_hash && hammingHex(row.perceptual_hash, perceptual) <= DUPLICATE_HAMMING)) {
    throw new HttpError(409, "DUPLICATE_PROOF", "That photo looks like one already submitted.");
  }
  const locked = await withLock(`lock:submit:${promise.id}`, 60_000, async () => {
    const ext = mime === "image/png" ? "png" : "jpg";
    const storageKey = `${crypto.randomUUID()}.${ext}`;
    await mkdir(config.uploadDir, { recursive: true });
    await writeFile(path.join(config.uploadDir, storageKey), file.buffer);
    const issuedCode = promise.pending_challenge_code!;
    const submissionId = await withTx(async (client) => {
      const current = await findPromiseById(promise.id, client);
      if (!current || !UPLOAD_STATUSES.includes(current.status) || !current.pending_challenge_code) {
        throw new HttpError(409, "STATE_CONFLICT", "This promise is not accepting a photo.");
      }
      const attempt = await nextAttempt(client, promise.id);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO submissions (promise_id, kind, storage_key, content_hash, perceptual_hash, challenge_code, attempt_no)
         VALUES ($1, 'image', $2, $3, $4, $5, $6) RETURNING id`,
        [promise.id, storageKey, contentHash, perceptual ?? null, current.pending_challenge_code, attempt],
      );
      await patchPromise(client, promise.id, { pending_challenge_code: null });
      await transitionStatus(client, promise.id, current.status, "SUBMITTED", null);
      await transitionStatus(client, promise.id, "SUBMITTED", "VERIFYING", null);
      return inserted.rows[0].id;
    });
    await publish(promise.id, { type: "status", status: "VERIFYING", at: new Date().toISOString() });
    return verifySubmission({ promise, submissionId, issuedCode, image: file.buffer, mime });
  });
  if (!locked) throw new HttpError(409, "SUBMISSION_IN_PROGRESS", "A photo for this promise is already being checked.");
  return locked;
}

export async function reviewPromise(
  id: string,
  payerId: string,
  input: {
    decision: "approve" | "deny";
    note?: string;
    amountMinor?: number;
    currency?: string;
    workerEmail?: string;
    checklistVersion?: number;
  },
): Promise<PublicPromise> {
  const { promise } = await visible(id, payerId);
  if (promise.status !== "NEEDS_REVIEW") {
    throw new HttpError(409, "STATE_CONFLICT", "This promise is not waiting for review.");
  }
  if (input.decision === "approve") {
    const fingerprintMatches =
      input.amountMinor === promise.amount_minor &&
      input.currency === promise.currency &&
      input.workerEmail?.toLowerCase() === promise.worker_email &&
      input.checklistVersion === promise.checklist_version;
    if (!fingerprintMatches) {
      throw new HttpError(409, "FINGERPRINT_MISMATCH", "The approval does not match the promise amount, worker, or checklist.");
    }
  }
  const verificationId = await latestVerificationId(id);
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO human_reviews (promise_id, verification_id, decided_by, decision, note, amount_minor, currency, worker_email, checklist_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        verificationId ?? null,
        payerId,
        input.decision,
        input.note ?? null,
        promise.amount_minor,
        promise.currency,
        promise.worker_email,
        promise.checklist_version,
      ],
    );
    if (input.decision === "approve") {
      await transitionStatus(client, id, "NEEDS_REVIEW", "APPROVED", input.note ?? "Payer approved.");
    }
  });
  if (input.decision === "deny") {
    await cancelPromise(id, payerId);
  } else {
    await settle(id);
  }
  return getPromise(id, payerId);
}

export async function listVerifications(id: string, payerId?: string): Promise<unknown[]> {
  await visible(id, payerId);
  const result = await pool.query<{
    id: string;
    verdict: string;
    score: number | null;
    model: string;
    raw_json: { worker_feedback?: string; rules?: { reason?: string } } | null;
    created_at: Date;
    checklist_item_id: string | null;
    passed: boolean | null;
    evidence: string | null;
    item_confidence: number | null;
    text: string | null;
  }>(
    `SELECT v.id, v.verdict, v.score, v.confidence, v.model, v.raw_json, v.created_at,
            vi.checklist_item_id, vi.passed, vi.evidence, vi.confidence AS item_confidence, c.text
     FROM verifications v
     JOIN submissions s ON s.id = v.submission_id
     LEFT JOIN verification_items vi ON vi.verification_id = v.id
     LEFT JOIN checklist_items c ON c.id = vi.checklist_item_id
     WHERE s.promise_id = $1
     ORDER BY v.created_at DESC, c.position`,
    [id],
  );
  const grouped = new Map<string, {
    id: string;
    verdict: string;
    score: number | null;
    model: string;
    worker_feedback: string | null;
    created_at: string;
    items: { checklist_item_id: string; text: string; passed: boolean; evidence: string; confidence: number }[];
  }>();
  for (const row of result.rows) {
    const existing = grouped.get(row.id) ?? {
      id: row.id,
      verdict: row.verdict,
      score: row.score === null ? null : Number(row.score),
      model: row.model,
      worker_feedback: row.raw_json?.worker_feedback ?? row.raw_json?.rules?.reason ?? null,
      created_at: new Date(row.created_at).toISOString(),
      items: [] as { checklist_item_id: string; text: string; passed: boolean; evidence: string; confidence: number }[],
    };
    if (row.checklist_item_id) {
      existing.items.push({
        checklist_item_id: row.checklist_item_id,
        text: row.text ?? "",
        passed: Boolean(row.passed),
        evidence: row.evidence ?? "",
        confidence: Number(row.item_confidence),
      });
    }
    grouped.set(row.id, existing);
  }
  return [...grouped.values()];
}
