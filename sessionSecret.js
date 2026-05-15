import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { DATA_ROOT } from "./paths.js";

const SECRET_FILE = join(DATA_ROOT, ".session-secret");

export function getOrCreateSessionSecret() {
  if (existsSync(SECRET_FILE)) {
    try { return readFileSync(SECRET_FILE, "utf8").trim(); } catch {}
  }
  const secret = randomBytes(48).toString("hex");
  writeFileSync(SECRET_FILE, secret, "utf8");
  return secret;
}
