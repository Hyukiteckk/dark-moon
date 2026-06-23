import { execSync } from "child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT    = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "desktop");
const PKG     = join(ROOT, "package.json");

// Prepara config de membro (sem BOT_SECRET, sem MASTER_ADMIN)
copyFileSync(join(DESKTOP, "config.membro.json"), join(DESKTOP, "config.json"));
console.log("✅ Config MEMBRO pronto");

// Aponta publish para o repo público do membro
const pkgRaw = readFileSync(PKG, "utf8");
const pkg    = JSON.parse(pkgRaw);
pkg.build.publish = { provider: "github", owner: "Hyukiteckk", repo: "dark-moon", private: false };
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
console.log("✅ Publish → dark-moon (público)");

// Compila
execSync("npm run build:win", {
  cwd: ROOT,
  stdio: "inherit",
});

// Restaura publish original
writeFileSync(PKG, pkgRaw);
console.log("✅ package.json restaurado");

// Copia para o Desktop com nome Membro
const src  = join(ROOT, "dist", "DiscordManager-portable-x64.exe");
const dest = join(process.env.USERPROFILE || "C:\\Users\\Abner Martins", "Desktop", "DarkMoon-Membro.exe");
if (existsSync(src)) {
  copyFileSync(src, dest);
  console.log(`\n✅ MEMBRO gerado em: ${dest}`);
} else {
  console.error("❌ exe não encontrado em dist/");
}
