import { mkdirSync } from "fs";
import { join } from "path";
import { ACCOUNTS_ROOT } from "./paths.js";
import { fsSafeUserId } from "./authStore.js";
import { BotRuntime } from "./botManager.js";

const cache = new Map();

export function getRuntimeForUser(userId) {
  const key = fsSafeUserId(userId);
  if (cache.has(key)) return cache.get(key);
  const dir = join(ACCOUNTS_ROOT, key);
  mkdirSync(dir, { recursive: true });
  const rt = new BotRuntime(
    join(dir, 'config.json'),
    join(dir, 'quest-history.json'),
    join(dir, 'nick-cache.json')
  );
  cache.set(key, rt);
  return rt;
}

export async function removeRuntimeForUser(userId) {
  const key = fsSafeUserId(userId);
  const rt = cache.get(key);
  if (rt) { await rt.stopAll(); cache.delete(key); }
}
