import { pool } from "../db.js";

/** Returns true when this message should be processed (first time). */
export async function claimKafkaMessage(messageId: string, topic: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO kafka_inbox (message_id, topic) VALUES ($1, $2)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, topic],
  );
  return (result.rowCount ?? 0) > 0;
}
