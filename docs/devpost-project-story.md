# Programmable Promises

**Pay when the work is real.** A payer describes what “done” means; PayPal holds funds in sandbox; a worker submits photo proof; AI checks it against a machine-readable checklist; pass triggers capture and payout, fail explains why—with a human review path when confidence is low.

> **Disclaimer:** Sandbox prototype for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). Not escrow, not legal advice, no real money.

---

## Inspiration

Freelance and gig work often breaks down at the same moment: *“Did they actually do what I paid for?”* Escrow products exist, but they rarely encode **your** definition of done in a way software can enforce. At the same time, vision models can read photos well enough to check simple, explicit criteria—and PayPal already knows how to **authorize**, **capture**, and **pay out**.

We wanted a small story judges could feel in three minutes: write a promise, fund it with PayPal Buttons, watch a worker upload proof, and see money move only when the rules say so—not when the model “feels” confident. The name **Programmable Promises** is the idea: payment logic as data (checklist + thresholds + state machine), not as ad-hoc chat.

Partner tracks pushed us further: **AG Studio** for operational visibility, and **MCP** so agents can create and track promises without replacing the human step in PayPal’s checkout UI.

---

## What it does

| Actor | Experience |
|--------|------------|
| **Payer** | Create promise → AI drafts checklist → edit & confirm → authorize hold via PayPal → monitor status, review edge cases, open AG Studio dashboard |
| **Worker** | Open one-time link → receive challenge code → upload JPG/PNG showing the code → see live verification progress |
| **Agent (optional)** | Cursor + `pp_*` MCP tools + PayPal MCP for sandbox APIs; funding still completed by a person in PayPal Buttons |

**Core flow**

1. Create promise (amount, deadline ≤ 48h, natural-language condition).
2. Confirm checklist (required items, weights, pass threshold).
3. Fund → **Money held** (PayPal authorization).
4. Worker submits proof with challenge code visible in the image.
5. **Pass** → capture + 100% payout to worker email. **Clear fail** → hold kept, reasons shown. **Uncertain / 3rd fail / verifier error** → payer review (approve pays, deny voids).
6. Expired deadline → authorization voided.

**Also included:** paginated promise list, SSE + polling for worker/payer live updates, async verification & webhooks via Kafka workers, studio LLM proxy for AG Studio’s agent panel, custom MCP server wrapping the REST API.

---

## How we built it

### Architecture

Monorepo, bounded contexts kept practical for a hackathon:

- **`packages/shared`** — promise state machine, shared decision rules, tests (London-style around the rules engine).
- **`apps/api`** — Express, Postgres, Redis, PayPal OAuth + Orders + Capture + Payouts, verifier abstraction, analytics for AG Studio, LLM proxy for studio turns.
- **`apps/web`** — Angular UI: create, fund, worker upload, payer detail/review, lazy-loaded **AG Studio** dashboard.
- **`apps/mcp`** — stdio MCP server (`pp_login`, `pp_create_promise`, `pp_submit_proof`, …) over the same API.
- **`worker`** (Docker) — Redpanda/Kafka consumers: photo verification, webhook inbox, capture/payout off the hot path.

```text
Browser ──► Angular (8090) ──► Express API ──► Postgres / Redis
                    │                │
                    │                ├──► PayPal Sandbox (auth, capture, payouts)
                    │                ├──► OpenAI / Gemini (vision + checklist)
                    │                └──► Kafka ──► worker service
Cursor / agents ──► MCP (pp_* + @paypal/mcp) ──► API
```

**Run:** `docker compose up --build` → UI at `http://localhost:8090`. Without PayPal keys the app still runs; funding surfaces a clear config error.

### PayPal integration

- Sandbox REST app: OAuth token caching, order create/authorize, capture on success, **Payouts** to worker sandbox email.
- PayPal Buttons in the UI; `fund/confirm` on success so localhost demos don’t require a public webhook URL.
- Optional webhooks: signature verification, idempotent event store, **200** immediately, async processing when Kafka is enabled.
- Payout resilience: reuse batch id on retry, poll while PayPal shows pending, **Retry payment** in UI—avoid double capture.

### AI integration (without letting the model touch money)

Two phases, one **`Verifier`** interface:

1. **Checklist generation** from the payer’s condition (editable before confirm).
2. **Proof verification** — multimodal model returns per-item scores; a **deterministic rules engine** decides pass/fail/review.

The model’s raw verdict is logged for debugging; **it is not the payment decision.**

Decision rule (simplified):

- Every **required** item must pass with confidence \(\geq \tau_{\mathrm{item}}\) (default \(0.7\)).
- Weighted score \(\displaystyle\frac{\sum_i w_i \cdot s_i}{\sum_i w_i} \geq \tau_{\mathrm{global}}\) (default \(0.8\)).
- Challenge code in the image must match (anti-replay / wrong-upload guard).

If any check is ambiguous → **human review**, not auto-pay.

Providers: `openai`, `gemini` (vision), or `mock` for offline demo of the review queue. `npm run eval` scores labeled proofs when `eval/labels.json` exists—we don’t claim accuracy until that file is filled.

### AG Studio

Embedded report at `/dashboard`: KPIs, status charts, promise pipeline grid from `GET /api/analytics/studio-data`, evidence page for checklist pass/fail. Cross-filtering and layout persistence in `localStorage`. Studio Agent Framework calls **`POST /api/studio/llm-turn`** so API keys stay server-side. We integrated **`ag-studio`** directly (lazy route ~5MB chunk) after peer dependency friction with Angular 21.

### MCP

- Official **[PayPal MCP](https://developer.paypal.com/ai-tools/mcp-server)** for sandbox API operations.
- **`@pp/mcp`** — wraps our REST API for promise lifecycle and proof submission; documented in `config/mcp.cursor.example.json`. Funding intentionally remains a **human-in-the-loop** PayPal Buttons step.

---

## What we learned

1. **Separate “AI opinion” from “payment action.”** A thin rules layer on top of vision output made demos trustworthy and debuggable.
2. **PayPal state is async.** Payouts can sit in `PENDING`; UX and idempotent retries matter as much as the happy-path capture.
3. **Week 1 vs Week 2:** synchronous verification in-process is fine for dev; Kafka + webhook inbox scales the story for “production-shaped” hackathon criteria without rewriting the domain model.
4. **Agents need boundaries.** MCP tools accelerate create/track/submit, but PayPal’s own UI for authorization keeps us aligned with real compliance and user consent.
5. **Partner SDKs are real engineering.** AG Studio + Angular version pins, LLM proxy request shapes, and lazy loading were a substantial slice of the week—not bolt-on polish.
6. **Live UI wins judges.** SSE and short polling on the worker page turned a batch job into something people could *watch*.

---

## Challenges we faced

| Challenge | What happened | What we did |
|-----------|----------------|-------------|
| **Double capture / duplicate proof** | Retries and race paths could re-trigger payment | Idempotent payout batch handling, explicit proof dedup, clearer terminal states |
| **Payout stuck in PENDING** | Sandbox latency; UI looked “broken” | Extended polling, **Retry payment**, honest status copy |
| **502 on AG Studio LLM turn** | Request body didn’t match proxy; wrong `AI_MODEL` for Gemini | Parse AG Studio conversation format, provider-aware model selection, clearer adapter errors |
| **Angular × AG Studio** | Peer conflicts on newer Angular | Pin Angular 19, lazy dashboard route, bundle budget relief |
| **Localhost vs webhooks** | Judges won’t ngrok | Buttons + confirm endpoint on critical path; webhooks optional enhancement |
| **Worker UX** | Page felt static during verify | SSE + 2s polling, `NgZone` so Angular updates live |
| **Time / scope** | 48h deadline cap, images-only MVP | Documented limits in README; focused on one crisp E2E narrative |

---

## Tech stack

- **Frontend:** Angular 19, lazy AG Studio dashboard
- **Backend:** Node.js, Express, TypeScript
- **Data:** PostgreSQL, Redis
- **Messaging:** Redpanda (Kafka-compatible), dedicated worker service
- **Payments:** PayPal Sandbox (authorize, capture, Payouts, optional webhooks)
- **AI:** OpenAI or Google Gemini (vision), mock provider
- **Agents:** MCP (`@modelcontextprotocol/sdk`), PayPal MCP + custom `pp_*` server
- **Ops:** Docker Compose, shared package + tests

---

## Try it

1. Clone [programmable-promises](https://github.com/deveshparmar/programmable-promises) and `cp .env.example .env` (PayPal sandbox credentials + `AI_API_KEY`).
2. `docker compose up --build` → [http://localhost:8090](http://localhost:8090)
3. Sign in with any email → create → fund → open worker link → submit photo with challenge code.
4. Open **Dashboard** for AG Studio; optional: wire MCP from `config/mcp.cursor.example.json`.

**Public demo:** *(add URL before Devpost submit)*

---

## What’s next

- Labeled eval set and published accuracy on `npm run eval`
- Hosted demo + LICENSE on GitHub About
- CI smoke tests; optional Render deploy for sponsor visibility
- Richer proof types (PDF/URL) only if product demand appears

---

## Closing

Programmable Promises is our answer to a simple question: **Can PayPal hold the money while AI checks the proof—and only then pay?** We built the smallest system that says yes in sandbox, shows the work in AG Studio, and invites agents through MCP—without letting the model sign the check.

---

## Devpost checklist (copy elsewhere on the form)

- **Elevator pitch (≤200 chars):** Escrow-like promises: fund with PayPal, worker submits photos, AI checks your checklist, auto payout on pass. AG Studio ops dashboard + MCP for agents. Hackathon sandbox.
- **Video:** Create → fund → worker proof → dashboard → optional MCP (~3 min).
- **Built with:** PayPal, OpenAI/Gemini, AG Grid AG Studio, MCP.
