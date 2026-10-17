CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'payer' CHECK (role = 'payer'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE promises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id UUID NOT NULL REFERENCES users (id),
  worker_email TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 100),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL CHECK (status IN (
    'DRAFT', 'AWAITING_FUNDING', 'FUNDED', 'SUBMITTED', 'VERIFYING',
    'APPROVED', 'REJECTED_RETRY', 'NEEDS_REVIEW', 'PAYING', 'CAPTURED',
    'PAYMENT_FAILED', 'PAID', 'EXPIRED_VOIDED', 'CANCELLED'
  )),
  deadline_at TIMESTAMPTZ NOT NULL,
  share_token_hash TEXT NOT NULL UNIQUE,
  checklist_version INTEGER NOT NULL DEFAULT 0,
  pending_challenge_code TEXT,
  paypal_order_id TEXT,
  paypal_authorization_id TEXT,
  paypal_capture_id TEXT,
  paypal_payout_batch_id TEXT,
  pass_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  status_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX promises_payer_status_idx ON promises (payer_id, status);
CREATE INDEX promises_deadline_idx ON promises (deadline_at) WHERE status IN (
  'FUNDED', 'SUBMITTED', 'REJECTED_RETRY', 'NEEDS_REVIEW', 'AWAITING_FUNDING'
);

CREATE TABLE checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promise_id UUID NOT NULL REFERENCES promises (id),
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  weight DOUBLE PRECISION NOT NULL CHECK (weight > 0),
  required BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promise_id UUID NOT NULL REFERENCES promises (id),
  kind TEXT NOT NULL DEFAULT 'image',
  storage_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  perceptual_hash TEXT,
  challenge_code TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions (id),
  model TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'unsure', 'error')),
  score DOUBLE PRECISION,
  confidence DOUBLE PRECISION,
  raw_json JSONB NOT NULL,
  prompt_version TEXT NOT NULL,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verification_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id UUID NOT NULL REFERENCES verifications (id),
  checklist_item_id UUID NOT NULL REFERENCES checklist_items (id),
  passed BOOLEAN NOT NULL,
  evidence TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL
);

CREATE TABLE payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promise_id UUID REFERENCES promises (id),
  type TEXT NOT NULL,
  paypal_event_id TEXT UNIQUE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  response_body JSONB NOT NULL,
  status_code INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, scope)
);

CREATE TABLE human_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promise_id UUID NOT NULL REFERENCES promises (id),
  verification_id UUID REFERENCES verifications (id),
  decided_by UUID NOT NULL REFERENCES users (id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
  note TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  worker_email TEXT NOT NULL,
  checklist_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO users (email, name, role)
VALUES ('payer@example.com', 'Demo Payer', 'payer')
ON CONFLICT (email) DO NOTHING;
