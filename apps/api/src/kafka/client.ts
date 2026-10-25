import { Kafka, type Producer, type Consumer, type Admin } from "kafkajs";
import { kafkaBrokers, kafkaEnabled } from "../config.js";
import { ALL_TOPICS } from "./topics.js";

let kafka: Kafka | undefined;
let producer: Producer | undefined;
let admin: Admin | undefined;

function client(): Kafka {
  if (!kafkaEnabled()) throw new Error("Kafka is not configured.");
  if (!kafka) {
    kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID ?? "programmable-promises",
      brokers: kafkaBrokers(),
      retry: { retries: 5 },
    });
  }
  return kafka;
}

export async function kafkaProducer(): Promise<Producer> {
  if (!producer) {
    producer = client().producer();
    await producer.connect();
  }
  return producer;
}

export async function kafkaConsumer(groupId: string): Promise<Consumer> {
  const consumer = client().consumer({ groupId });
  await consumer.connect();
  return consumer;
}

export async function ensureKafkaTopics(): Promise<void> {
  if (!kafkaEnabled()) return;
  if (!admin) {
    admin = client().admin();
    await admin.connect();
  }
  const existing = new Set(await admin.listTopics());
  const missing = ALL_TOPICS.filter((topic) => !existing.has(topic));
  if (missing.length) {
    await admin.createTopics({
      topics: missing.map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })),
    });
  }
}

export async function kafkaPing(): Promise<boolean> {
  if (!kafkaEnabled()) return false;
  await ensureKafkaTopics();
  return true;
}

export async function disconnectKafka(): Promise<void> {
  await producer?.disconnect().catch(() => undefined);
  await admin?.disconnect().catch(() => undefined);
  producer = undefined;
  admin = undefined;
  kafka = undefined;
}
