# Programmable Promises

Pay when the work is real. A payer writes a condition, PayPal holds the money, and a photo is checked against a checklist before the worker is paid.

This is a PayPal sandbox prototype for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). It is not escrow, not legal advice, and it does not move real money.

## Run it

Docker, with a filled `.env`, brings the UI up at [http://localhost:8090](http://localhost:8090).

```bash
cp .env.example .env
docker compose up --build
```

Sign in as `payer@example.com`. There is no password.

Creating the PayPal sandbox app is a separate step, not part of the five-minute start. Without those keys the UI still runs, and funding returns a clear configuration error. A hosted demo is the backup when a judge will not create a sandbox app.

For local iteration, start only Postgres and Redis, then run the apps on the host:

```bash
docker compose up postgres redis
npm install
npm test
npm run dev:api
npm run dev:web
```

The dev UI is [http://localhost:4200](http://localhost:4200). Copy `.env.example` to `.env` first, and set `APP_BASE_URL=http://localhost:4200`.

## PayPal sandbox, before the demo

1. Create a REST app at [developer.paypal.com](https://developer.paypal.com/) and put the sandbox client id and secret in `.env`.
2. Enable Payouts on the sandbox business account.
3. Put enough balance in that business account to pay the demo.
4. Create a personal sandbox account and use its email as the worker address.
5. Optional: create a webhook for the events below and set `PAYPAL_WEBHOOK_ID`. The happy path does not wait on webhooks. PayPal Buttons call `POST /api/promises/:id/fund/confirm` directly, so localhost does not need a public URL.

`AI_PROVIDER=openai` uses `AI_API_KEY` and `AI_MODEL` (default `gpt-4o-mini`). `AI_PROVIDER=gemini` uses a free Gemini key from [Google AI Studio](https://aistudio.google.com/apikey) and `gemini-3.5-flash-lite`, which can read photos. `AI_PROVIDER=mock` saves a draft checklist and returns an unsure verdict so the review queue can be exercised without a model key.

## What the demo does

1. Create a promise. The model writes a checklist. Edit it and confirm it.
2. Authorize a hold with PayPal Buttons. The status becomes **Money held**.
3. Open the worker link, get a challenge code, and submit a jpg or png that shows the code.
4. A pass captures the hold and pays 100% to the worker email. A clear fail keeps the hold and explains which items missed. The third fail, a low-confidence result, or a verifier error goes to the payer. Approve pays. Deny voids the hold.
5. Deadlines are capped at 48 hours. When one passes, the authorization is voided.

Amounts are USD cents. The minimum is $1.00 and the demo cap is $10,000. There is no platform fee.

## AI tools

Checklist generation and proof verification use the OpenAI Chat Completions API through `AI_MODEL`, behind a `Verifier` interface. The model's own pass or fail is logged and is not the decision. A rules engine requires every required item to pass at confidence 0.7 or higher, a weighted score at or above the threshold (default 0.8), and a matching challenge code. Anything unclear becomes a human review. The model never calls PayPal.

`npm run eval` prints accuracy from `eval/labels.json` when that file exists. No accuracy number is claimed until labeled proofs are scored.

## Limits

- Sandbox only. Authorizations are most reliable for about 3 days and expire after 29. This build caps deadlines at 48 hours and does not reauthorize.
- Proofs are one jpg or png, up to 10 MB. PDF and URL proofs are not in this build.
- Workers do not have accounts. The worker link is shown once and stored only as a hash.
- Payout is marked paid when the payout item succeeds. If PayPal is still processing, the promise stays captured and **Retry payment** checks again. A failed payout is retried with the same batch id and is never captured twice.
- Week 1 is a monolith: the API calls the verifier and PayPal in process. Postgres and Redis are required. Kafka is not in this build and is not required to submit.
