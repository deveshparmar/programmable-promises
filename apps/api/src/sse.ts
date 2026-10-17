import type { Response } from "express";
import { redis, redisSub } from "./redis.js";

const clients = new Map<string, Set<Response>>();

redisSub.on("message", (channel: string, message: string) => {
  const id = channel.slice("promise:".length);
  for (const res of clients.get(id) ?? []) {
    res.write(`data: ${message}\n\n`);
  }
});

export async function publish(promiseId: string, event: unknown): Promise<void> {
  await redis.publish(`promise:${promiseId}`, JSON.stringify(event));
}

export async function addClient(promiseId: string, res: Response): Promise<void> {
  let set = clients.get(promiseId);
  if (!set) {
    set = new Set();
    clients.set(promiseId, set);
    await redisSub.subscribe(`promise:${promiseId}`);
  }
  set.add(res);
}

export async function removeClient(promiseId: string, res: Response): Promise<void> {
  const set = clients.get(promiseId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    clients.delete(promiseId);
    await redisSub.unsubscribe(`promise:${promiseId}`);
  }
}
