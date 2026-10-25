CREATE TABLE IF NOT EXISTS kafka_inbox (
  message_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
