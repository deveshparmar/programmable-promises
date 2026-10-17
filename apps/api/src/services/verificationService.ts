import { decide, statusAfterVerdict, type DecisionItem } from "@pp/shared";
import { withTx } from "../db.js";
import { HttpError } from "../errors.js";
import {
  countFails,
  findPromiseById,
  listChecklist,
  transitionStatus,
  type PromiseRow,
} from "../repos/promises.js";
import { publish } from "../sse.js";
import { verifyProof } from "../verifier/model.js";
import { settle } from "./paymentService.js";

export async function verifySubmission(input: {
  promise: PromiseRow;
  submissionId: string;
  issuedCode: string;
  image: Buffer;
  mime: string;
}): Promise<{ verdict: string; score: number | null; status: string; workerFeedback: string; items: unknown[] }> {
  let run: Awaited<ReturnType<typeof verifyProof>> | undefined;
  try {
    const checklist = await listChecklist(input.promise.id);
    run = await verifyProof({
      description: input.promise.description,
      items: checklist.map((item) => ({ id: item.id, text: item.text, required: item.required })),
      issuedCode: input.issuedCode,
      image: input.image,
      mime: input.mime,
    });
    const byId = new Map(checklist.map((item) => [item.id, item]));
    const decisionItems: DecisionItem[] = checklist.map((item) => {
      const modelItem = run!.output.items.find((candidate) => candidate.checklist_item_id === item.id);
      return {
        checklistItemId: item.id,
        passed: modelItem?.passed ?? false,
        confidence: modelItem?.confidence ?? 0,
        weight: Number(item.weight),
        required: item.required,
      };
    });
    const decision = decide({
      items: decisionItems,
      challengeCodeSeen: run.output.challenge_code_seen ?? null,
      challengeCodeConfidence: run.output.challenge_code_confidence ?? run.output.confidence ?? 0,
      issuedCode: input.issuedCode,
      threshold: Number(input.promise.pass_threshold),
    });
    const saved = await withTx(async (client) => {
      const current = await findPromiseById(input.promise.id, client);
      if (!current || current.status !== "VERIFYING") {
        throw new HttpError(409, "STATE_CONFLICT", "That promise changed. Refresh and try again.");
      }
      const verification = await client.query<{ id: string }>(
        `INSERT INTO verifications (submission_id, model, verdict, score, confidence, raw_json, prompt_version, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING id`,
        [
          input.submissionId,
          run!.model,
          decision.decision,
          decision.score,
          run!.output.confidence ?? null,
          JSON.stringify({ ...run!.output, rules: decision }),
          run!.promptVersion,
          run!.latencyMs,
        ],
      );
      for (const item of decisionItems) {
        const evidence =
          run!.output.items.find((candidate) => candidate.checklist_item_id === item.checklistItemId)?.evidence ??
          "The model did not return evidence for this item.";
        await client.query(
          `INSERT INTO verification_items (verification_id, checklist_item_id, passed, evidence, confidence)
           VALUES ($1, $2, $3, $4, $5)`,
          [verification.rows[0].id, item.checklistItemId, item.passed, evidence, item.confidence],
        );
      }
      const failCount = await countFails(client, input.promise.id);
      const next = statusAfterVerdict(decision.decision, failCount);
      const updated = await transitionStatus(client, input.promise.id, "VERIFYING", next, decision.reason);
      return {
        verdict: decision.decision,
        score: decision.score,
        status: updated.status,
        workerFeedback: run!.output.worker_feedback ?? decision.reason,
        items: decisionItems.map((item) => ({
          checklist_item_id: item.checklistItemId,
          text: byId.get(item.checklistItemId)?.text ?? "",
          passed: item.passed,
          confidence: item.confidence,
          evidence:
            run!.output.items.find((candidate) => candidate.checklist_item_id === item.checklistItemId)?.evidence ??
            "The model did not return evidence for this item.",
        })),
      };
    });
    await publish(input.promise.id, { type: "status", status: saved.status, at: new Date().toISOString() });
    if (saved.status === "APPROVED") {
      try {
        const paid = await settle(input.promise.id);
        saved.status = paid.status;
      } catch (error) {
        console.error("Payment did not finish", error);
        const latest = await findPromiseById(input.promise.id);
        if (latest) saved.status = latest.status;
      }
    }
    return saved;
  } catch (error) {
    await recordVerifierError(input.promise.id, input.submissionId, error);
    const latest = await findPromiseById(input.promise.id);
    if (latest?.status === "NEEDS_REVIEW") {
      return {
        verdict: "error",
        score: null,
        status: latest.status,
        workerFeedback: "The verifier could not score this photo. The payer will review it, and the funds stay held.",
        items: [],
      };
    }
    throw error instanceof HttpError
      ? error
      : new HttpError(502, "MODEL_ERROR", "The verifier could not score this photo. A person will review it.");
  }
}

async function recordVerifierError(promiseId: string, submissionId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "Verifier failed";
  try {
    await withTx(async (client) => {
      const current = await findPromiseById(promiseId, client);
      if (!current || current.status !== "VERIFYING") return;
      await client.query(
        `INSERT INTO verifications (submission_id, model, verdict, raw_json, prompt_version)
         VALUES ($1, $2, 'error', $3::jsonb, 'verify-v1')`,
        [submissionId, "error", JSON.stringify({ error: message })],
      );
      await transitionStatus(client, promiseId, "VERIFYING", "NEEDS_REVIEW", "The verifier failed, so the funds stay held.");
    });
    await publish(promiseId, { type: "status", status: "NEEDS_REVIEW", at: new Date().toISOString() });
  } catch (inner) {
    console.error("Could not record verifier error", inner);
  }
}
