import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";

const __dir = dirname(fileURLToPath(import.meta.url));
export const ROOT = __dir;
export const DATA_ROOT = join(__dir, "data");
export const ACCOUNTS_ROOT = join(DATA_ROOT, "accounts");

mkdirSync(DATA_ROOT, { recursive: true });
mkdirSync(ACCOUNTS_ROOT, { recursive: true });
