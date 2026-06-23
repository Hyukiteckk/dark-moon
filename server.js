import http from "http";
import express from "express";
import cookieSession from "cookie-session";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { DATA_ROOT } from "./paths.js";
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "fs";
import { registerUser, loginUser, findUserById, listPendingUsers, approveUser, listAllUsersSafe, revokeUser, deleteUser, setUserRole, setUserPassword } from "./authStore.js";
import { getRuntimeForUser, removeRuntimeForUser } from "./userRuntime.js";
import { getOrCreateSessionSecret } from "./sessionSecret.js";
import { securityHeaders, sanitizeInputs } from "./securityMiddleware.js";
import { loginWithDiscord, loginWithMfa, getDiscordUserInfo } from "./discordAuth.js";
import { startRPC, stopRPC, getRPCStatus } from "./questRPC.js";
import { fetchQuests, runAuto, stopAuto, getAutoStatus, getDebugFetch } from "./questAuto.js";
import { startFakeProcess, stopFakeProcess, getFakeStatus } from "./fakeProcess.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Rate limiting para cadastro (3 tentativas por IP a cada 24h) ─────────────
const _regAttempts = new Map();
function checkRegisterRateLimit(ip) {
  const now = Date.now();
  const entry = _regAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    _regAttempts.set(ip, { count: 1, resetAt: now + 24 * 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 3) return false;
  entry.count++;
  return true;
}

// ── Discord approval bot integration (Cloudflare Worker) ─────────────────────
const BOT_SERVICE_URL = process.env.BOT_SERVICE_URL || "";
const BOT_SECRET      = process.env.BOT_SECRET      || "";
const CLIENT_SECRET   = process.env.CLIENT_SECRET   || BOT_SECRET;
const MASTER_ADMIN    = process.env.MASTER_ADMIN    || "";
const APP_VERSION     = process.env.APP_VERSION     || "";
const MIN_VERSION     = process.env.MIN_VERSION     || "";

function semverLt(a, b) {
  const pa = (a || "0").split(".").map(Number);
  const pb = (b || "0").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}
let _cachedPermissions = null;
let _cachedUserPerms   = {};
let _cachedUserRoles   = {};
const _bannedIds       = new Set();
let _workerStatus      = { online: null, lastCheck: 0, lastOnline: 0 };

// Cache local de contas — persiste entre sessões para funcionar offline
const _ACCOUNTS_CACHE_FILE = join(DATA_ROOT, "accounts-cache.json");
let _accountsCache = [];
let _accountsCacheTs = 0;          // timestamp da última busca no Worker
const _ACCOUNTS_TTL = 60_000;      // só busca do Worker a cada 60s
try {
  if (existsSync(_ACCOUNTS_CACHE_FILE))
    _accountsCache = JSON.parse(readFileSync(_ACCOUNTS_CACHE_FILE, "utf8")) || [];
} catch {}
function _saveAccountsCache(accounts) {
  _accountsCache = accounts;
  _accountsCacheTs = Date.now();
  try { writeFileSync(_ACCOUNTS_CACHE_FILE, JSON.stringify(accounts), "utf8"); } catch {}
}

async function _pingWorker() {
  if (!BOT_SERVICE_URL || !BOT_SECRET) return;
  try {
    const r = await fetch(`${BOT_SERVICE_URL}/`, { signal: AbortSignal.timeout(5000) });
    _workerStatus = { online: r.ok, lastCheck: Date.now(), lastOnline: r.ok ? Date.now() : _workerStatus.lastOnline };
  } catch {
    _workerStatus = { online: false, lastCheck: Date.now(), lastOnline: _workerStatus.lastOnline };
  }
}
// Pinga o Worker a cada 2 minutos para manter monitoramento e "aquecido"
setInterval(_pingWorker, 120_000);
setTimeout(_pingWorker, 3000);

const DEFAULT_PERMISSIONS_SERVER = {
  membro:  ["overview", "fake-call", "orbs-auto", "nuke", "conversations"],
  pro:     ["overview", "call", "fake-call", "orbs-auto", "nuke", "conversations", "logs", "history"],
  elite:   ["overview", "call", "fake-call", "orbs-auto", "moderation", "investigate", "nuke", "conversations", "logs", "history"],
  master:  ["overview", "call", "fake-call", "clone", "orbs-auto", "moderation", "investigate", "nuke", "conversations", "logs", "history"],
};

function getAllowedTabs(userId, workerRole) {
  if (_cachedUserPerms[userId]) return _cachedUserPerms[userId];
  const role = workerRole || "membro";
  if (_cachedPermissions && _cachedPermissions[role]) return _cachedPermissions[role];
  return DEFAULT_PERMISSIONS_SERVER[role] || DEFAULT_PERMISSIONS_SERVER.membro;
}

function isMasterAdmin(user) {
  return MASTER_ADMIN ? user?.username === MASTER_ADMIN : user?.role === "owner";
}

async function notifyBotService(username, userId, discordUsername = "", discordId = "", password = "") {
  if (!BOT_SERVICE_URL || !BOT_SECRET) return;
  try {
    await fetch(`${BOT_SERVICE_URL}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, userId, discordUsername, discordId, password, secret: BOT_SECRET }),
    });
  } catch (e) {
    console.warn("[Auth] Bot service notification failed:", e.message);
  }
}

async function syncApprovalsFromWorker() {
  if (!BOT_SERVICE_URL || !BOT_SECRET) return;
  try {
    const res = await fetch(
      `${BOT_SERVICE_URL}/check-approvals?secret=${encodeURIComponent(BOT_SECRET)}`,
      { headers: { "Cache-Control": "no-cache" } }
    );
    if (!res.ok) return;
    const data = await res.json();

    if (data.permissions) _cachedPermissions = data.permissions;
    // Merge: local vence sobre Worker (preserva mudanças ainda não sincronizadas)
    if (data.userPerms) _cachedUserPerms = { ...data.userPerms, ..._cachedUserPerms };
    // Popula roles do Worker sem sobrescrever mudanças locais recentes
    if (data.roles) {
      for (const [uid, role] of Object.entries(data.roles)) {
        if (!_cachedUserRoles[uid]) _cachedUserRoles[uid] = role;
      }
    }
    if (data.banned?.length) {
      for (const id of data.banned) _bannedIds.add(id);
    }
  } catch (e) {
    console.warn("[Auth] Worker sync failed:", e.message);
  }
}

// Registra/garante a conta do master admin no Worker na primeira inicialização
async function initMasterAdmin() {
  if (!MASTER_ADMIN || !process.env.ADMIN_PASSWORD) return;
  if (!BOT_SERVICE_URL || !BOT_SECRET) {
    // Sem Worker: fallback local (dev)
    const result = registerUser(MASTER_ADMIN, process.env.ADMIN_PASSWORD);
    if (result.ok) { approveUser(result.user.id); console.log(`[Auth] Master admin local criado: ${MASTER_ADMIN}`); }
    return;
  }
  try {
    const regRes = await fetch(`${BOT_SERVICE_URL}/account/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // BOT_SECRET → auto-aprovado, sem notificação Discord, sem aparecer em pending
      body: JSON.stringify({ username: MASTER_ADMIN, password: process.env.ADMIN_PASSWORD, secret: BOT_SECRET }),
    });
    const regData = await regRes.json();
    if (regData.ok) console.log(`[Auth] Master admin pronto: ${MASTER_ADMIN}`);
    // "Usuário já cadastrado" = conta já existe, sem ação necessária
  } catch (e) {
    console.warn("[Auth] Falha ao inicializar master admin:", e.message);
  }
}
initMasterAdmin();

// Poll a cada 5 minutos — evita esgotar o limite gratuito de KV (100k reads/dia)
// Cada chamada faz ~33 reads; a 30s consumia ~95k/dia sozinho
setInterval(syncApprovalsFromWorker, 300_000);
syncApprovalsFromWorker();
const app = express();
const PORT = Number(process.env.PORT) || 4100;
const HOST = "127.0.0.1";

app.use(securityHeaders);
app.use(sanitizeInputs);
app.use(express.json({ limit: "2mb" }));
app.use(cookieSession({
  name: "dm.sid",
  secret: process.env.SESSION_SECRET || getOrCreateSessionSecret(),
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: "lax",
}));
app.use(express.static(join(__dir, "public"), {
  etag: false, lastModified: false,
  setHeaders(res) { res.setHeader("Cache-Control", "no-store"); },
}));

function requireAuth(req, res, next) {
  const uid = req.session?.userId;
  if (!uid) return res.status(401).json({ error: "Não autenticado." });
  req.userId = uid;

  if (_bannedIds.has(uid)) {
    req.session = null;
    return res.status(401).json({ error: "Conta banida." });
  }

  // Usuário Worker (sessão com userData)
  const cached = req.session?.userData;
  if (cached?.id === uid && cached.approved) {
    req.user = { ...cached, workerRole: cached.workerRole || "membro" };
    return next();
  }

  // Fallback local (dev sem Worker)
  const localUser = findUserById(uid);
  if (localUser?.approved) {
    req.user = localUser;
    return next();
  }

  req.session = null;
  return res.status(401).json({ error: "Sessão inválida." });
}

function requireOwner(req, res, next) {
  if (!isMasterAdmin(req.user)) return res.status(403).json({ error: "Acesso negado." });
  next();
}

// ─── Detectable games cache ───────────────────────────────────────────────
let _gamesCache = null;
let _gamesCacheTime = 0;

async function getDetectableGames() {
  const TTL = 30 * 60 * 1000;
  if (_gamesCache && Date.now() - _gamesCacheTime < TTL) return _gamesCache;
  const res = await fetch("https://discord.com/api/applications/detectable", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`Discord retornou ${res.status} ao buscar jogos.`);
  const data = await res.json();
  _gamesCache = data.map((g) => ({
    id: g.id,
    name: g.name,
    exes: (g.executables || [])
      .filter(e => e.os === 'win32' && !e.is_launcher && e.name)
      .map(e => e.name.split(/[\\/]/).pop())
      .filter(Boolean),
  }));
  _gamesCacheTime = Date.now();
  return _gamesCache;
}

// Ping for Electron
app.get("/api/ping", (_req, res) => res.json({ ok: true }));

// ── SpyMode state (controlado pelo app, lido pelo plugin via polling) ────────
let _spyModeState = { spyMute: false, spyDeaf: false };
app.use('/api/spymode', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get("/api/spymode/state", (_req, res) => res.json(_spyModeState));
app.post("/api/spymode/set", requireAuth, (req, res) => {
  const { spyMute, spyDeaf } = req.body || {};
  if (typeof spyMute === "boolean") _spyModeState.spyMute = spyMute;
  if (typeof spyDeaf === "boolean") _spyModeState.spyDeaf = spyDeaf;
  res.json({ ok: true, ..._spyModeState });
});

// Abre a pasta de plugins do BetterDiscord no Explorer
app.get("/api/open-bd-plugins", requireAuth, async (_req, res) => {
  try {
    const { exec } = await import("child_process");
    const bdPlugins = join(process.env.APPDATA || "", "BetterDiscord", "plugins");
    exec(`explorer "${bdPlugins}"`);
    res.json({ ok: true, path: bdPlugins });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Auth
app.post("/api/auth/register", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!isLocal && !checkRegisterRateLimit(ip))
    return res.status(429).json({ error: "Muitas tentativas. Tente novamente em 24 horas." });

  const { username, password, discordUsername = "", discordId = "", turnstileToken } = req.body || {};

  // Bloqueia tentativa de registrar com o username do admin
  if (MASTER_ADMIN && String(username || "").trim().toLowerCase() === MASTER_ADMIN.toLowerCase())
    return res.status(400).json({ error: "Nome de usuário indisponível." });

  if (process.env.TURNSTILE_SECRET) {
    if (!turnstileToken) return res.status(400).json({ error: "Verificação de segurança obrigatória." });
    try {
      const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET, response: turnstileToken }),
      });
      const result = await verify.json();
      if (!result.success) return res.status(400).json({ error: "Falha na verificação de segurança." });
    } catch {
      return res.status(500).json({ error: "Erro ao verificar CAPTCHA." });
    }
  }

  // Sem Worker configurado: fallback local (dev/owner)
  if (!BOT_SERVICE_URL) {
    const out = registerUser(username, password);
    if (!out.ok) return res.status(400).json({ error: out.error });
    if (!out.user.approved) {
      return res.status(202).json({ ok: true, pendingApproval: true, message: "Conta criada. Aguarde aprovação do administrador." });
    }
    req.session.userId = out.user.id;
    return res.json({ ok: true, user: { ...out.user, isMasterAdmin: isMasterAdmin(out.user) } });
  }

  // Registro centralizado via Worker
  try {
    const r = await fetch(`${BOT_SERVICE_URL}/account/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, discordUsername, discordId, secret: CLIENT_SECRET }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error || "Erro ao registrar." });
    return res.status(202).json({ ok: true, pendingApproval: true, message: "Conta criada. Aguarde aprovação do administrador." });
  } catch (e) {
    return res.status(500).json({ error: "Erro ao conectar com o servidor de autenticação." });
  }
});

app.get("/api/version", (_req, res) => {
  res.json({ version: APP_VERSION, minVersion: MIN_VERSION });
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password, appVersion } = req.body || {};

  // Bloqueia versões antigas se MIN_VERSION estiver configurado
  if (MIN_VERSION && appVersion && semverLt(appVersion, MIN_VERSION)) {
    return res.status(426).json({
      error: `Versão desatualizada (v${appVersion}). Feche e abra o app para atualizar automaticamente, ou baixe a versão mais recente.`,
      updateRequired: true,
    });
  }

  // Sem Worker: fallback local (dev)
  if (!BOT_SERVICE_URL) {
    const out = loginUser(username, password);
    if (!out.ok) return res.status(401).json({ error: out.error });
    req.session.userId = out.user.id;
    try { getRuntimeForUser(out.user.id).clearLogs(); } catch {}
    try { getRuntimeForUser(out.user.id).stopQuestMonitor(); } catch {}
    const isAdmin = isMasterAdmin(out.user);
    return res.json({ ok: true, user: { ...out.user, isMasterAdmin: isAdmin, allowedTabs: isAdmin ? null : getAllowedTabs(out.user.id, out.user.workerRole) } });
  }

  // Login centralizado via Worker (admin e usuários normais)
  try {
    const r = await fetch(`${BOT_SERVICE_URL}/account/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, secret: CLIENT_SECRET }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error || "Erro ao autenticar." });

    const user = data.user;
    const isAdmin = isMasterAdmin(user);

    if (_cachedUserPerms[user.id]) user.allowedTabs = _cachedUserPerms[user.id];
    else if (user.allowedTabs)     _cachedUserPerms[user.id] = user.allowedTabs;

    req.session.userId   = user.id;
    req.session.userData = { ...user, approved: true };

    const rt = getRuntimeForUser(user.id);
    try { rt.clearLogs(); } catch {}
    try { rt.stopQuestMonitor(); } catch {}

    return res.json({ ok: true, user: { ...user, isMasterAdmin: isAdmin, allowedTabs: isAdmin ? null : user.allowedTabs } });
  } catch (e) {
    return res.status(500).json({ error: "Erro ao conectar com o servidor de autenticação." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const uid = req.session?.userId;
  if (!uid) return res.status(401).json({ error: "Não autenticado." });

  if (_bannedIds.has(uid)) { req.session = null; return res.status(401).json({ error: "Conta banida." }); }

  const cached = req.session?.userData;
  if (cached?.id === uid && cached.approved) {
    const isAdmin = isMasterAdmin(cached);
    const freshTabs = _cachedUserPerms[uid] || cached.allowedTabs;
    return res.json({ user: { ...cached, isMasterAdmin: isAdmin, allowedTabs: isAdmin ? null : freshTabs } });
  }

  // Fallback local (dev sem Worker)
  const localUser = findUserById(uid);
  if (localUser?.approved) {
    const isAdmin = isMasterAdmin(localUser);
    return res.json({ user: { ...localUser, isMasterAdmin: isAdmin, allowedTabs: isAdmin ? null : getAllowedTabs(localUser.id, localUser.workerRole) } });
  }

  req.session = null;
  return res.status(401).json({ error: "Não autenticado." });
});

// Discord login with email/password
app.post("/api/discord/login", async (req, res) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) return res.status(400).json({ error: "Email e senha são obrigatórios." });
    const result = await loginWithDiscord(login, password);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/discord/mfa", async (req, res) => {
  try {
    const { ticket, code, loginInstanceId } = req.body || {};
    const result = await loginWithMfa(ticket, code, loginInstanceId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/discord/validate-token", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Token obrigatório." });
    const user = await getDiscordUserInfo(token);
    res.json({ ok: true, user });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

// Config
app.get("/api/config", requireAuth, (req, res) => {
  try { res.json(getRuntimeForUser(req.userId).loadConfig()); } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/config", requireAuth, (req, res) => {
  try {
    const { guildId, tokens, moderationToken } = req.body;
    if (!guildId || !Array.isArray(tokens)) return res.status(400).json({ error: "guildId e tokens[] são obrigatórios." });
    const rt = getRuntimeForUser(req.userId);
    rt.saveConfig({ guildId: String(guildId).trim(), tokens, moderationToken: String(moderationToken || "").trim() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Status/Start/Stop
app.get("/api/status", requireAuth, (req, res) => {
  const rt = getRuntimeForUser(req.userId);
  res.json({ running: rt.isRunning(), sessions: rt.getStatus() });
});

app.post("/api/start", requireAuth, async (req, res) => {
  try { const rt = getRuntimeForUser(req.userId); await rt.startFromConfig(); res.json({ ok: true, sessions: rt.getStatus() }); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/stop", requireAuth, async (req, res) => {
  try { await getRuntimeForUser(req.userId).stopAll(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/identify", requireAuth, async (req, res) => {
  try {
    const { tokens } = req.body;
    if (!Array.isArray(tokens)) return res.status(400).json({ error: "tokens[] obrigatório." });
    const rt = getRuntimeForUser(req.userId);
    const results = await Promise.all(tokens.map((t) => rt.identifyToken(String(t).trim())));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/call/join", requireAuth, async (req, res) => {
  try {
    const { guildId, channelId, tokens, fakeDeaf = false, selfMute = false } = req.body;
    if (!guildId || !channelId || !Array.isArray(tokens)) return res.status(400).json({ error: "Dados inválidos." });
    const rt = getRuntimeForUser(req.userId);
    const results = [];
    for (const token of tokens) {
      try { results.push(await rt.joinVoiceWithToken(String(token).trim(), guildId, channelId, { fakeDeaf: !!fakeDeaf, selfMute: selfMute !== false })); }
      catch (e) { results.push({ ok: false, error: e.message, token }); }
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/call/leave", requireAuth, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Token obrigatório." });
    await getRuntimeForUser(req.userId).leaveOneSession(String(token).trim());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Moderation
app.post("/api/moderation/guilds", requireAuth, async (req, res) => {
  try { res.json({ guilds: await getRuntimeForUser(req.userId).listModerationGuilds(req.body) }); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/moderation/snapshot", requireAuth, async (req, res) => {
  try { res.json(await getRuntimeForUser(req.userId).getModerationSnapshot(req.body)); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/moderation/action", requireAuth, async (req, res) => {
  try { res.json(await getRuntimeForUser(req.userId).runModerationAction(req.body)); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Clone
app.post("/api/clone/run", requireAuth, async (req, res) => {
  try { res.json(await getRuntimeForUser(req.userId).cloneServer(req.body)); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Purge
app.post("/api/purge", requireAuth, async (req, res) => {
  try { res.json(await getRuntimeForUser(req.userId).purgeMessages(req.body)); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Nuke
app.post("/api/nuke/start", requireAuth, (req, res) => {
  try {
    const { token, channelId, userId, keyword, limit, ownerDiscordId } = req.body || {};
    if (!token || !channelId) return res.status(400).json({ error: "Token e channelId são obrigatórios." });
    const rt = getRuntimeForUser(req.userId);
    if (rt.getNukeStatus().running) return res.status(409).json({ error: "Um nuke já está em andamento. Pare-o primeiro." });
    rt.nukeChannel({ token: String(token).trim(), channelId: String(channelId).trim(), userId: userId ? String(userId).trim() : null, keyword: keyword || null, limit: Number(limit) || 0, ownerDiscordId: ownerDiscordId || null })
      .catch((e) => console.error("[Nuke]", e.message));
    res.json({ ok: true, message: "Nuke iniciado. Acompanhe nos logs." });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.get("/api/nuke/status", requireAuth, (req, res) => {
  try { res.json(getRuntimeForUser(req.userId).getNukeStatus()); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/nuke/stop", requireAuth, (req, res) => {
  try { getRuntimeForUser(req.userId).stopNuke(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/nuke/dms", requireAuth, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Token obrigatório." });
    const dms = await getRuntimeForUser(req.userId).listDMChannels(String(token).trim());
    res.json({ dms });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post('/api/conversations/messages', requireAuth, async (req, res) => {
  try {
    const { token, channelId, before, limit } = req.body || {};
    if (!token || !channelId) return res.status(400).json({ error: 'Token e channelId obrigatórios.' });
    const messages = await getRuntimeForUser(req.userId).getDMMessages(
      String(token).trim(), String(channelId).trim(), before || null, Number(limit) || 50
    );
    res.json({ messages, hasMore: messages.length === (Number(limit) || 50) });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Stats persistentes por Discord user ID
app.get("/api/stats", requireAuth, (req, res) => {
  const discordId = req.query.discordId || null;
  try { res.json(getRuntimeForUser(req.userId).getStats(discordId)); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Backup de mensagens
app.post("/api/backup/start", requireAuth, async (req, res) => {
  try {
    const { token, channelId } = req.body || {};
    if (!token || !channelId) return res.status(400).json({ error: "token e channelId obrigatórios." });
    await getRuntimeForUser(req.userId).startChannelMonitor(String(token).trim(), String(channelId).trim());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/backup/stop", requireAuth, (req, res) => {
  try {
    const { channelId } = req.body || {};
    getRuntimeForUser(req.userId).stopChannelMonitor(String(channelId).trim());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.get("/api/backup/messages/:channelId", requireAuth, (req, res) => {
  try {
    const rt = getRuntimeForUser(req.userId);
    const messages = rt.getBackupMessages(req.params.channelId);
    res.json({ messages, isMonitoring: rt.isMonitoring(req.params.channelId) });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// SSE — eventos de backup em tempo real
app.get("/api/backup/events", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const rt = getRuntimeForUser(req.userId);
  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const onNew     = d => send('new',     d);
  const onDeleted = d => send('deleted', d);
  const onEdited  = d => send('edited',  d);

  rt.on('backup:new',     onNew);
  rt.on('backup:deleted', onDeleted);
  rt.on('backup:edited',  onEdited);

  const hb = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(hb);
    rt.off('backup:new',     onNew);
    rt.off('backup:deleted', onDeleted);
    rt.off('backup:edited',  onEdited);
  });
});

// ─── Quest (híbrido: monitor automático + RPC local) ─────────────────────

// Lista de jogos detectáveis pelo Discord
app.get("/api/quest/games", requireAuth, async (req, res) => {
  try {
    const games = await getDetectableGames();
    res.json({ games });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});


// RPC local — conecta ao Discord desktop com o app_id do jogo selecionado
app.post("/api/quest/rpc/start", requireAuth, async (req, res) => {
  try {
    const { appId, gameName } = req.body || {};
    if (!appId || !gameName) return res.status(400).json({ error: "appId e gameName são obrigatórios." });
    const result = await startRPC(String(appId).trim(), String(gameName).trim());
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/quest/rpc/stop", requireAuth, async (req, res) => {
  try { await stopRPC(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.get("/api/quest/rpc/status", requireAuth, (req, res) => {
  res.json(getRPCStatus());
});

// Processo falso — simula o jogo rodando para o Discord detectar
app.post("/api/quest/fake/start", requireAuth, async (req, res) => {
  const { exeName } = req.body || {};
  if (!exeName || typeof exeName !== 'string') return res.status(400).json({ error: "exeName obrigatório." });
  const safe = exeName.replace(/[^a-zA-Z0-9._\- ]/g, '').trim();
  if (!safe.endsWith('.exe') && !safe.includes('.')) {
    return res.status(400).json({ error: "exeName deve terminar em .exe" });
  }
  try {
    const result = await startFakeProcess(safe);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/quest/fake/stop", requireAuth, async (req, res) => {
  try { await stopFakeProcess(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/quest/fake/status", requireAuth, (req, res) => {
  res.json(getFakeStatus());
});

// BetterDiscord plugin install
const _bdPluginsDir = join(process.env.APPDATA || '', 'BetterDiscord', 'plugins');
const _pluginSrc = join(__dir, 'public', 'OrionQuests.plugin.js');

app.get("/api/discord/plugin-status", requireAuth, (req, res) => {
  const bdInstalled = existsSync(_bdPluginsDir);
  const pluginInstalled = existsSync(join(_bdPluginsDir, 'OrionQuests.plugin.js'));
  res.json({ bdInstalled, pluginInstalled });
});

app.post("/api/discord/copy-plugin", requireAuth, (req, res) => {
  try {
    if (!existsSync(_bdPluginsDir))
      return res.status(400).json({ ok: false, error: 'BetterDiscord não encontrado. Instale em betterdiscord.app primeiro.' });
    copyFileSync(_pluginSrc, join(_bdPluginsDir, 'OrionQuests.plugin.js'));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// OrionQuests plugin — auto-install into BetterDiscord plugins folder
app.get("/api/orion/status", requireAuth, (req, res) => {
  const bdDir = join(process.env.APPDATA || "", "BetterDiscord", "plugins");
  const pluginPath = join(bdDir, "OrionQuests.plugin.js");
  res.json({ bdInstalled: existsSync(bdDir), pluginInstalled: existsSync(pluginPath) });
});

app.post("/api/orion/install", requireAuth, (req, res) => {
  const bdDir = join(process.env.APPDATA || "", "BetterDiscord", "plugins");
  if (!existsSync(bdDir)) return res.json({ ok: false, reason: "bd_not_installed" });
  try {
    const src = join(__dir, "public", "OrionQuests.plugin.js");
    const dest = join(bdDir, "OrionQuests.plugin.js");
    copyFileSync(src, dest);
    res.json({ ok: true, path: dest });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  }
});

// Investigate
app.post("/api/investigate", requireAuth, async (req, res) => {
  try {
    const { myToken, targetId, additionalTokens } = req.body || {};
    if (!myToken || !targetId) return res.status(400).json({ error: "Token e ID do alvo são obrigatórios." });
    const extraTokens = Array.isArray(additionalTokens) ? additionalTokens.filter(Boolean) : [];
    const result = await getRuntimeForUser(req.userId).investigateUser(myToken, String(targetId).trim(), extraTokens);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Worker status — ping manual + retorna estado atual
app.get("/api/admin/worker-status", requireAuth, requireOwner, async (req, res) => {
  await _pingWorker();
  res.json(_workerStatus);
});

// Admin — lista centralizada via Worker (com cache local como fallback)
app.get("/api/admin/all-users", requireAuth, requireOwner, async (req, res) => {
  const applyOverrides = (accounts) => accounts
    .filter(u => u.approved && !u.banned)
    .map(u => ({
      ...u,
      role: _cachedUserRoles[u.id] || u.workerRole || u.role,
      allowedTabs: _cachedUserPerms[u.id] || u.allowedTabs || null,
    }));

  if (!BOT_SERVICE_URL || !BOT_SECRET) {
    return res.json({ users: applyOverrides(_accountsCache), fromCache: !!_accountsCache.length, workerError: "Worker não configurado." });
  }
  // Serve do cache se buscou recentemente (economiza KV reads do Cloudflare free tier)
  // ?force=1 bypassa o cache (usado pelo botão Atualizar e ao abrir o tab)
  const forceRefresh = req.query.force === "1";
  const cacheAge = Date.now() - _accountsCacheTs;
  if (!forceRefresh && _accountsCacheTs > 0 && cacheAge < _ACCOUNTS_TTL) {
    return res.json({ users: applyOverrides(_accountsCache), fromCache: false, cachedSec: Math.floor(cacheAge / 1000) });
  }
  try {
    const r = await fetch(`${BOT_SERVICE_URL}/accounts?secret=${encodeURIComponent(BOT_SECRET)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Worker retornou ${r.status}`);
    const data = await r.json();
    const all = data.accounts || [];
    _saveAccountsCache(all);
    res.json({ users: applyOverrides(all), totalInWorker: all.length });
  } catch (e) {
    // Worker offline — usa cache local
    const users = applyOverrides(_accountsCache);
    res.json({ users, fromCache: true, workerError: e.message });
  }
});

app.post("/api/admin/ban-remote", requireAuth, requireOwner, async (req, res) => {
  const userId = String(req.body?.userId || "");
  if (!BOT_SERVICE_URL || !BOT_SECRET) return res.status(400).json({ error: "Worker não configurado." });
  try {
    await fetch(`${BOT_SERVICE_URL}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, secret: BOT_SECRET }),
    });
    _bannedIds.add(userId);
    revokeUser(userId); // no-op se não for usuário local
    try { await removeRuntimeForUser(userId); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin
app.get("/api/admin/pending", requireAuth, requireOwner, async (req, res) => {
  if (!BOT_SERVICE_URL || !BOT_SECRET) return res.json({ users: listPendingUsers() });
  try {
    const r = await fetch(`${BOT_SERVICE_URL}/check-approvals?secret=${encodeURIComponent(BOT_SECRET)}`);
    const data = await r.json();
    res.json({ users: data.pending || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/approve", requireAuth, requireOwner, async (req, res) => {
  const userId = String(req.body?.userId || "");
  if (!BOT_SERVICE_URL || !BOT_SECRET) {
    const out = approveUser(userId);
    if (!out.ok) return res.status(400).json({ error: out.error });
    return res.json({ ok: true });
  }
  try {
    const r = await fetch(`${BOT_SERVICE_URL}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, secret: BOT_SECRET }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error || "Erro ao aprovar." });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/reject", requireAuth, requireOwner, async (req, res) => {
  const userId = String(req.body?.userId || "");
  if (!BOT_SERVICE_URL || !BOT_SECRET) return res.json({ ok: true });
  try {
    const r = await fetch(`${BOT_SERVICE_URL}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, secret: BOT_SECRET }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error || "Erro ao rejeitar." });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/admin/users", requireAuth, requireOwner, (req, res) => res.json({ users: listAllUsersSafe() }));
app.post("/api/admin/revoke", requireAuth, requireOwner, async (req, res) => {
  const uid = String(req.body?.userId || "");
  const out = revokeUser(uid);
  if (!out.ok) return res.status(400).json({ error: out.error });
  try { await removeRuntimeForUser(uid); } catch {}
  res.json({ ok: true });
});

app.post("/api/admin/ban", requireAuth, requireOwner, async (req, res) => {
  const uid = String(req.body?.userId || "");
  const out = revokeUser(uid);
  if (!out.ok) return res.status(400).json({ error: out.error });
  try { await removeRuntimeForUser(uid); } catch {}
  res.json({ ok: true, banned: true });
});
app.post("/api/admin/delete", requireAuth, requireOwner, async (req, res) => {
  try {
    await removeRuntimeForUser(String(req.body?.userId || ""));
    const out = deleteUser(String(req.body?.userId || ""));
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Permissions — any authenticated user reads the cached permissions matrix
app.get("/api/permissions", requireAuth, (req, res) => {
  res.json({ permissions: _cachedPermissions });
});

// Admin — set user role (syncs to Worker + local cache)
app.post("/api/admin/set-role", requireAuth, requireOwner, async (req, res) => {
  const { userId, role } = req.body || {};
  if (!userId || !role) return res.status(400).json({ error: "userId e role obrigatórios." });
  const validRoles = ["membro", "pro", "elite", "master"];
  if (!validRoles.includes(role)) return res.status(400).json({ error: "Cargo inválido." });
  // Aplica imediatamente no cache local (funciona mesmo offline)
  _cachedUserRoles[userId] = role;
  setUserRole(userId, role);
  const cached = _accountsCache.find(u => u.id === userId);
  if (cached) { cached.role = role; _saveAccountsCache(_accountsCache); }
  // Tenta sincronizar com o Worker (não bloqueia em caso de falha)
  if (BOT_SERVICE_URL && BOT_SECRET) {
    fetch(`${BOT_SERVICE_URL}/set-role`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, role, secret: BOT_SECRET }),
    }).catch(() => {});
  }
  res.json({ ok: true });
});

// Admin — set user password
app.post("/api/admin/set-password", requireAuth, requireOwner, async (req, res) => {
  const { userId, newPassword } = req.body || {};
  if (!userId || !newPassword) return res.status(400).json({ error: "userId e newPassword obrigatórios." });

  // Se for usuário local (master admin) → muda localmente
  const localUser = findUserById(userId);
  if (localUser) {
    const out = setUserPassword(userId, newPassword);
    if (!out.ok) return res.status(400).json({ error: out.error });
    return res.json({ ok: true });
  }

  // Usuário Worker
  if (!BOT_SERVICE_URL || !BOT_SECRET) return res.status(400).json({ error: "Worker não configurado." });
  try {
    const r = await fetch(`${BOT_SERVICE_URL}/account/set-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, newPassword, secret: BOT_SECRET }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error || "Erro ao alterar senha." });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — set per-user tab permissions (syncs to Worker + local cache)
app.post("/api/admin/set-user-perms", requireAuth, requireOwner, async (req, res) => {
  const { userId, tabs } = req.body || {};
  if (!userId || !Array.isArray(tabs)) return res.status(400).json({ error: "userId e tabs[] obrigatórios." });
  // Aplica imediatamente no cache local (funciona mesmo offline)
  _cachedUserPerms[userId] = tabs;
  const cached = _accountsCache.find(u => u.id === userId);
  if (cached) { cached.allowedTabs = tabs; _saveAccountsCache(_accountsCache); }
  // Tenta sincronizar com o Worker (não bloqueia em caso de falha)
  if (BOT_SERVICE_URL && BOT_SECRET) {
    fetch(`${BOT_SERVICE_URL}/user-perms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, tabs, secret: BOT_SECRET }),
    }).catch(() => {});
  }
  res.json({ ok: true });
});

// Admin — get/set permissions matrix
app.get("/api/admin/permissions", requireAuth, requireOwner, async (req, res) => {
  if (!BOT_SERVICE_URL || !BOT_SECRET) return res.json({ permissions: _cachedPermissions });
  try {
    const r = await fetch(`${BOT_SERVICE_URL}/permissions?secret=${encodeURIComponent(BOT_SECRET)}`);
    const data = await r.json();
    _cachedPermissions = data.permissions;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/permissions", requireAuth, requireOwner, async (req, res) => {
  const { permissions } = req.body || {};
  if (!permissions) return res.status(400).json({ error: "permissions obrigatório." });
  if (!BOT_SERVICE_URL || !BOT_SECRET) return res.status(400).json({ error: "Worker não configurado." });
  try {
    await fetch(`${BOT_SERVICE_URL}/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions, secret: BOT_SECRET }),
    });
    _cachedPermissions = permissions;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Logs
app.get('/api/logs', requireAuth, (req, res) => {
  res.json({ entries: getRuntimeForUser(req.userId).getLogs() });
});

app.get('/api/logs/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const rt = getRuntimeForUser(req.userId);
  const lastId = parseInt(req.headers['last-event-id'] || '0', 10);
  const initial = rt.getLogs().filter((e) => e.id > lastId);
  for (const e of initial) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);

  const onLog = (entry) => res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
  rt.on('log', onLog);
  req.on('close', () => rt.off('log', onLog));
});

// Quest history
// ─── QUEST AUTO endpoints ─────────────────────────────────────────────────
app.get("/api/quest-auto/quests", requireAuth, async (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(400).json({ error: "Token obrigatório." });
  try {
    const quests = await fetchQuests(token);
    res.json({ quests });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/quest-auto/run", requireAuth, async (req, res) => {
  const { token, questIds = [], autoEnroll = true, autoClaim = true } = req.body || {};
  if (!token) return res.status(400).json({ error: "Token obrigatório." });
  try {
    await runAuto(String(token).trim(), questIds, { autoEnroll, autoClaim });
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post("/api/quest-auto/stop", requireAuth, (req, res) => {
  stopAuto();
  res.json({ ok: true });
});

app.get("/api/quest-auto/status", requireAuth, (req, res) => {
  res.json(getAutoStatus());
});

app.get("/api/quest-auto/debug", requireAuth, (req, res) => {
  res.json({ debug: getDebugFetch() });
});

// CORS for BetterDiscord plugin (fetch from https://discord.com to http://localhost)
app.use('/api/orion', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Orion command — controlled by the app, polled by the injected bridge in Discord
let _orionCommand = { command: 'idle', questIds: [] };
let _bridgeLastSeen = 0;
const _orionState = { tasks: {}, questList: [], allDone: false, noQuests: false, error: null, updatedAt: 0, startedAt: 0 };

app.get('/api/orion/command', (req, res) => {
  _bridgeLastSeen = Date.now();
  res.json(_orionCommand);
});

app.post('/api/orion/command', requireAuth, (req, res) => {
  const cmd = req.body?.command;
  const questIds = Array.isArray(req.body?.questIds) ? req.body.questIds : [];
  if (!['start', 'stop', 'idle', 'discover'].includes(cmd)) return res.status(400).json({ error: 'Comando inválido.' });
  _orionCommand = { command: cmd, questIds };
  if (cmd === 'start') Object.assign(_orionState, { tasks: {}, questList: [], allDone: false, noQuests: false, error: null, startedAt: Date.now() });
  if (cmd === 'discover') Object.assign(_orionState, { allDone: false, noQuests: false, error: null });
  if (cmd === 'idle' || cmd === 'stop') _orionCommand = { command: 'idle', questIds: [] };
  res.json({ ok: true });
});

// Orion progress — receives updates from the injected script (no auth, localhost only)
app.post('/api/orion/progress', (req, res) => {
  const d = req.body;
  if (!d || typeof d !== 'object') return res.sendStatus(204);
  _orionState.updatedAt = Date.now();
  if (d.type === 'quests_found') {
    _orionState.questList = d.quests || [];
    _orionState.allDone = false;
    _orionState.noQuests = false;
    _orionState.tasks = {};
  } else if (d.type === 'task_update') {
    _orionState.tasks[d.id] = { id: d.id, name: d.name, taskType: d.taskType, cur: d.cur, max: d.max, status: d.status, ts: Date.now() };
  } else if (d.type === 'all_done') {
    _orionState.allDone = true;
    _orionCommand = { command: 'idle' };
  } else if (d.type === 'no_quests') {
    _orionState.noQuests = true;
    _orionCommand = { command: 'idle' };
  } else if (d.type === 'error') {
    _orionState.error = d.message || 'Erro desconhecido';
    _orionCommand = { command: 'idle' };
  } else if (d.type === 'discover_done') {
    _orionCommand = { command: 'idle', questIds: [] };
  }
  res.sendStatus(204);
});

app.get('/api/orion/live', requireAuth, (req, res) => {
  res.json({ ..._orionState, bridgeConnected: Date.now() - _bridgeLastSeen < 8000 });
});

app.get('/api/quest-history', requireAuth, (req, res) => {
  res.json({ history: getRuntimeForUser(req.userId).getQuestHistory() });
});

app.delete('/api/quest-history', requireAuth, (req, res) => {
  getRuntimeForUser(req.userId).clearQuestHistory();
  res.json({ ok: true });
});

// Avatar download proxy
app.get('/api/avatar-download', (req, res) => {
  const url = String(req.query.url || '');
  if (!url.startsWith('https://cdn.discordapp.com/')) return res.status(400).json({ error: 'URL inválida.' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  fetch(url, { signal: controller.signal })
    .then((r) => {
      clearTimeout(timeout);
      if (!r.ok) return res.status(502).json({ error: 'Falha ao buscar avatar.' });
      const ext = url.includes('.gif') ? 'gif' : 'png';
      res.setHeader('Content-Type', r.headers.get('content-type') || `image/${ext}`);
      res.setHeader('Content-Disposition', `attachment; filename="avatar.${ext}"`);
      res.setHeader('Cache-Control', 'no-store');
      import('stream').then(({ Readable }) => {
        Readable.fromWeb(r.body).pipe(res);
      }).catch(() => res.end());
    })
    .catch(() => { clearTimeout(timeout); res.status(504).json({ error: 'Timeout.' }); });
});

// SPA fallback
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
  res.sendFile(join(__dir, "public", "index.html"));
});

const server = http.createServer(app);

function tryListen(port, maxTries = 10) {
  server.listen(port, HOST, () => {
    const actual = server.address().port;
    console.log(`Discord Manager — http://${HOST}:${actual}`);
    if (process.send) process.send({ type: "port", port: actual });
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && maxTries > 0) {
      console.warn(`Porta ${port} ocupada, tentando ${port + 1}...`);
      server.removeAllListeners("error");
      server.close(() => tryListen(port + 1, maxTries - 1));
    } else {
      throw err;
    }
  });
}

tryListen(PORT);
