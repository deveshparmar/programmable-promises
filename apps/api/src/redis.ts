import { Redis } from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
export const redisSub = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count <= limit;
}

export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
  const token = `${Date.now()}-${Math.random()}`;
  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") return undefined;
  try {
    return await fn();
  } finally {
    const current = await redis.get(key);
    if (current === token) await redis.del(key);
  }
}
