import { execSync } from "child_process";
import { copyFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT    = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "desktop");

// Prepara config de admin
copyFileSync(join(DESKTOP, "config.admin.json"), join(DESKTOP, "config.json"));
console.log("✅ Config ADMIN pronto");

// Compila
execSync("npm run build:win", {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    BUILDER_PRODUCT_NAME: "Dark Moon ADMIN",
    BUILDER_ARTIFACT: "DarkMoon-ADMIN-portable.exe",
  },
});

// Copia para o Desktop com nome ADMIN
const src  = join(ROOT, "dist", "DiscordManager-portable-x64.exe");
const dest = join(process.env.USERPROFILE || "C:\\Users\\Abner Martins", "Desktop", "DarkMoon-ADMIN.exe");
if (existsSync(src)) {
  copyFileSync(src, dest);
  console.log(`\n✅ ADMIN gerado em: ${dest}`);
} else {
  console.error("❌ exe não encontrado em dist/");
}
