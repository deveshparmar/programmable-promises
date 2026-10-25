import { Router } from "express";
import multer from "multer";
import { createPromiseSchema, reviewSchema, updateChecklistSchema } from "@pp/shared";
import { requirePayer, requirePayerOrToken, requireToken, login } from "./auth.js";
import { aiConfigured, config, kafkaEnabled, paypalConfigured } from "./config.js";
import { kafkaPing } from "./kafka/client.js";
import { pool } from "./db.js";
import { HttpError } from "./errors.js";
import { idempotent } from "./idempotency.js";
import { redis } from "./redis.js";
import { rateLimit } from "./redis.js";
import { addClient, removeClient } from "./sse.js";
import { cancelPromise, confirmFunding, createFundingOrder, requestSettle } from "./services/paymentService.js";
import { verifyWebhook } from "./paypal/client.js";
import { recordWebhook } from "./services/paymentService.js";
import {
  createPromise,
  getPromise,
  getPromiseList,
  issueChallenge,
  listVerifications,
  reviewPromise,
  submitProof,
  updateChecklist,
} from "./services/promiseService.js";
import { findPromiseById } from "./repos/promises.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function send(res: { status: (code: number) => { json: (body: unknown) => void } }, status: number, body: unknown): void {
  res.status(status).json(body);
}

export function apiRouter(): Router {
  const router = Router();

  router.get("/health", async (_req, res, next) => {
    try {
      await pool.query("SELECT 1");
      await redis.ping();
      let kafka: string = "disabled";
      if (kafkaEnabled()) {
        try {
          kafka = (await kafkaPing()) ? "up" : "down";
        } catch {
          kafka = "down";
        }
      }
      res.json({
        ok: true,
        postgres: "up",
        redis: "up",
        kafka,
        paypal: paypalConfigured() ? "configured" : "unconfigured",
        ai: aiConfigured() ? "configured" : "unconfigured",
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/config", (_req, res) => {
    res.json({ paypal_client_id: config.paypalClientId, paypal_mode: config.paypalMode, currency: "USD" });
  });

  router.post("/auth/login", async (req, res, next) => {
    try {
      const allowed = await rateLimit(`rl:login:${req.ip}`, 30, 60);
      if (!allowed) throw new HttpError(429, "RATE_LIMITED", "Too many sign-in attempts. Wait a minute.");
      const email = typeof req.body?.email === "string" ? req.body.email : "";
      const result = await idempotent(req, `login:${email.toLowerCase()}`, async () => ({
        status: 200,
        body: await login(email),
      }));
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post("/promises", requirePayer, async (req, res, next) => {
    try {
      const parsed = createPromiseSchema.parse(req.body);
      const result = await idempotent(req, `payer:${req.payer!.id}:create`, async () => ({
        status: 201,
        body: await createPromise({
          payerId: req.payer!.id,
          title: parsed.title,
          description: parsed.description,
          amountMinor: parsed.amount_minor,
          workerEmail: parsed.worker_email,
          deadlineAt: parsed.deadline_at,
        }),
      }));
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/promises", requirePayer, async (req, res, next) => {
    try {
      res.json(await getPromiseList(req.payer!.id));
    } catch (error) {
      next(error);
    }
  });

  router.get("/promises/:id", requirePayerOrToken, async (req, res, next) => {
    try {
      const payerId = req.payer ? req.payer.id : undefined;
      if (req.payer) res.json(await getPromise(req.params.id, payerId));
      else res.json(await getPromise(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.put("/promises/:id/checklist", requirePayer, async (req, res, next) => {
    try {
      const parsed = updateChecklistSchema.parse(req.body);
      const result = await idempotent(req, `payer:${req.payer!.id}:checklist:${req.params.id}`, async () => ({
        status: 200,
        body: await updateChecklist(req.params.id, req.payer!.id, {
          items: parsed.items,
          passThreshold: parsed.pass_threshold,
          confirm: parsed.confirm,
          deadlineAt: parsed.deadline_at,
        }),
      }));
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post("/promises/:id/fund", requirePayer, async (req, res, next) => {
    try {
      const result = await idempotent(req, `payer:${req.payer!.id}:fund:${req.params.id}`, async () => ({
        status: 200,
        body: await createFundingOrder(req.params.id, req.payer!.id),
      }));
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post("/promises/:id/fund/confirm", requirePayer, async (req, res, next) => {
    try {
      const result = await idempotent(req, `payer:${req.payer!.id}:fund-confirm:${req.params.id}`, async () => ({
        status: 200,
        body: await getPromise((await confirmFunding(req.params.id, req.payer!.id)).id, req.payer!.id),
      }));
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post("/promises/:id/challenge", requireToken, async (req, res, next) => {
    try {
      const result = await idempotent(req, `token:${req.params.id}:challenge`, async () => ({
        status: 200,
        body: await issueChallenge(req.promiseAuth!),
      }));
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post("/promises/:id/submissions", requireToken, upload.single("file"), async (req, res, next) => {
    try {
      const allowed = await rateLimit(`rl:submit:${req.params.id}`, 10, 3600);
      if (!allowed) throw new HttpError(429, "RATE_LIMITED", "Too many photo uploads for this promise.");
      const result = await idempotent(req, `token:${req.params.id}:submit`, async () => ({
        status: 200,
        body: await submitProof(req.promiseAuth!, req.file),
      }));
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/promises/:id/verifications", requirePayerOrToken, async (req, res, next) => {
    try {
      res.json({ verifications: await listVerifications(req.params.id, req.payer?.id) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/promises/:id/review", requirePayer, async (req, res, next) => {
    try {
      const parsed = reviewSchema.parse(req.body);
      const result = await idempotent(req, `payer:${req.payer!.id}:review:${req.params.id}:${parsed.decision}`, async () => ({
        status: 200,
        body: await reviewPromise(req.params.id, req.payer!.id, {
          decision: parsed.decision,
          note: parsed.note,
          amountMinor: parsed.amount_minor,
          currency: parsed.currency,
          workerEmail: parsed.worker_email,
          checklistVersion: parsed.checklist_version,
        }),
      }));
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post("/promises/:id/cancel", requirePayer, async (req, res, next) => {
    try {
      const result = await idempotent(req, `payer:${req.payer!.id}:cancel:${req.params.id}`, async () => ({
        status: 200,
        body: await getPromise((await cancelPromise(req.params.id, req.payer!.id)).id, req.payer!.id),
      }));
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post("/promises/:id/settle", requirePayer, async (req, res, next) => {
    try {
      const result = await idempotent(req, `payer:${req.payer!.id}:settle:${req.params.id}`, async () => {
        const promise = await findPromiseById(req.params.id);
        if (!promise || promise.payer_id !== req.payer!.id) throw new HttpError(404, "NOT_FOUND", "Promise not found.");
        await requestSettle(promise.id);
        return { status: 200, body: await getPromise(promise.id, req.payer!.id) };
      });
      send(res, result.status, result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/promises/:id/events", requirePayerOrToken, async (req, res, next) => {
    try {
      const promise = req.payer ? await getPromise(req.params.id, req.payer.id) : await getPromise(req.params.id);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      res.write(`data: ${JSON.stringify({ type: "status", status: promise.status, at: new Date().toISOString() })}\n\n`);
      await addClient(req.params.id, res);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        void removeClient(req.params.id, res);
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/webhooks/paypal", async (req, res, next) => {
    try {
      const event = req.body as { id?: string; event_type?: string; resource?: Record<string, unknown> };
      const headers = {
        "paypal-auth-algo": req.header("paypal-auth-algo"),
        "paypal-cert-url": req.header("paypal-cert-url"),
        "paypal-transmission-id": req.header("paypal-transmission-id"),
        "paypal-transmission-sig": req.header("paypal-transmission-sig"),
        "paypal-transmission-time": req.header("paypal-transmission-time"),
      };
      const verified = await verifyWebhook(headers, event);
      if (!verified) throw new HttpError(400, "INVALID_WEBHOOK", "PayPal webhook signature was rejected.");
      if (!event.id || !event.event_type) throw new HttpError(400, "INVALID_WEBHOOK", "Webhook event is missing an id.");
      await recordWebhook(event.id, event.event_type, event.resource ?? {});
      res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
