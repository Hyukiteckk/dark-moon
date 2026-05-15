import { EventEmitter } from 'events';
import { Client } from "discord.js-selfbot-v13";
import { joinVoiceChannel, getVoiceConnection } from "@discordjs/voice";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { ProxyAgent } from 'undici';

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_API_V9 = "https://discord.com/api/v9";
const SUPER_PROPS = Buffer.from(JSON.stringify({
  os: "Windows", browser: "Discord Client", release_channel: "stable",
  client_version: "1.0.9168", os_version: "10.0.22621", os_arch: "x64",
  app_arch: "x64", system_locale: "pt-BR",
  browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/124.0.6367.243 Electron/30.4.0 Safari/537.36",
  browser_version: "30.4.0", os_sdk_version: "22621",
  client_build_number: 540600,
  native_build_number: 50950,
})).toString("base64");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normalizeQuest(q) {
  return {
    ...q,
    quest_id: q.quest_id || q.id || q.questId,
    config: q.config || {
      application_name: q.application_name || q.name || "Missão",
      task_config: q.task_config || {},
    },
    user_status: q.user_status || {
      progress: q.progress || {},
      completed_at: q.completed_at || null,
    },
  };
}

async function discordApiRequest(token, path, options = {}, proxy = null) {
  const method = options.method || "GET";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const fetchOpts = {
      method,
      signal: controller.signal,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "User-Agent": UA,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    };
    if (proxy) fetchOpts.dispatcher = new ProxyAgent(proxy);
    const response = await fetch(`${DISCORD_API}${path}`, fetchOpts);
    const text = await response.text();
    if (!response.ok) throw new Error(`Discord API ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

export class BotRuntime extends EventEmitter {
  constructor(configPath, questHistoryPath, nickCachePath) {
    super();
    this.configPath = configPath;
    this.questHistoryPath = questHistoryPath;
    this.nickCachePath = nickCachePath;
    this.sessions = new Map();
    this._running = false;
    this._questMonitor = null;
    this._nukeJob = null;
    this._logs = [];
    this._logId = 0;
  }

  _addLog(level, msg) {
    const entry = { id: ++this._logId, time: new Date().toLocaleTimeString('pt-BR'), level, msg };
    this._logs.push(entry);
    if (this._logs.length > 500) this._logs.shift();
    this.emit('log', entry);
    console.log(`[${level.toUpperCase()}] ${msg}`);
  }

  getLogs() { return this._logs.slice(); }

  loadConfig() {
    if (!existsSync(this.configPath)) return { guildId: "", tokens: [], moderationToken: "" };
    try { return JSON.parse(readFileSync(this.configPath, "utf8")); } catch { return { guildId: "", tokens: [], moderationToken: "" }; }
  }

  saveConfig(config) {
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf8");
  }

  loadQuestHistory() {
    try {
      if (!existsSync(this.questHistoryPath)) return [];
      return JSON.parse(readFileSync(this.questHistoryPath, 'utf8'));
    } catch { return []; }
  }

  saveQuestHistory(history) {
    try { writeFileSync(this.questHistoryPath, JSON.stringify(history, null, 2), 'utf8'); } catch {}
  }

  _recordQuestCompletion(questId, questName, taskType, tokenTag, success, progress, total) {
    const history = this.loadQuestHistory();
    history.unshift({ id: randomUUID(), questId, questName, taskType, completedAt: new Date().toISOString(), tokenTag, success, progress: progress || 0, total: total || 0 });
    if (history.length > 200) history.pop();
    this.saveQuestHistory(history);
  }

  getQuestHistory() { return this.loadQuestHistory(); }
  clearQuestHistory() { this.saveQuestHistory([]); }

  loadNickCache() {
    try {
      if (!existsSync(this.nickCachePath)) return {};
      return JSON.parse(readFileSync(this.nickCachePath, 'utf8'));
    } catch { return {}; }
  }

  saveNickCache(cache) {
    try { writeFileSync(this.nickCachePath, JSON.stringify(cache, null, 2), 'utf8'); } catch {}
  }

  isRunning() { return this._running && this.sessions.size > 0; }

  getStatus() {
    return [...this.sessions.values()].map((s) => ({
      token: s.token,
      tag: s.tag,
      userId: s.userId,
      guildName: s.guildName || "-",
      channelName: s.channelName || "-",
      channelId: s.channelId || "-",
      inCall: s.inCall || false,
    }));
  }

  async identifyToken(token) {
    try {
      const data = await discordApiRequest(token, "/users/@me");
      const tag = data.discriminator && data.discriminator !== "0"
        ? `${data.username}#${data.discriminator}` : data.username;
      return { ok: true, token, tag, id: data.id, username: data.username, avatar: data.avatar };
    } catch (e) {
      return { ok: false, token, error: String(e.message) };
    }
  }

  async joinVoiceWithToken(token, guildId, channelId) {
    if (this.sessions.has(token)) {
      const s = this.sessions.get(token);
      await this._leaveVoice(token, s.client);
    }

    const cfg = this.loadConfig();
    const tokenEntry = (cfg.tokens || []).find((t) => t.token === token);
    const proxy = tokenEntry?.proxy || null;

    const clientOpts = { checkUpdate: false };
    if (proxy) {
      try {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        clientOpts.ws = { agent: new HttpsProxyAgent(proxy) };
      } catch {}
    }
    const client = new Client(clientOpts);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Login timeout")), 20000);
      client.once("ready", () => { clearTimeout(t); resolve(); });
      client.login(token).catch(reject);
    });

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
    const channel = guild?.channels.cache.get(channelId);
    const guildName = guild?.name || guildId;
    const channelName = channel?.name || channelId;

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });

    const tag = client.user.tag || client.user.username;
    this.sessions.set(token, {
      token, client, tag,
      userId: client.user.id,
      guildName, channelName, channelId,
      inCall: true, connection,
    });
    this._running = true;
    return { ok: true, tag, guildName, channelName };
  }

  async startFromConfig() {
    const config = this.loadConfig();
    if (!config.tokens?.length) throw new Error("Nenhum token configurado.");
    if (!config.guildId) throw new Error("Nenhum servidor configurado.");
    for (const entry of config.tokens) {
      try {
        await this.joinVoiceWithToken(entry.token, config.guildId, entry.channelId);
      } catch (e) {
        console.error(`Falha ao entrar com token: ${e.message}`);
      }
    }
  }

  async stopAll() {
    for (const [token, s] of this.sessions) {
      try { await this._leaveVoice(token, s.client); } catch {}
    }
    this.sessions.clear();
    this._running = false;
  }

  async _leaveVoice(token, client) {
    try {
      const s = this.sessions.get(token);
      if (s?.connection) { try { s.connection.destroy(); } catch {} }
      if (client) { try { client.destroy(); } catch {} }
    } catch {}
    this.sessions.delete(token);
  }

  removeTokenFromConfig(token) {
    const cfg = this.loadConfig();
    const before = (cfg.tokens || []).length;
    cfg.tokens = (cfg.tokens || []).filter((t) => t.token !== token);
    if (cfg.tokens.length !== before) { this.saveConfig(cfg); return true; }
    return false;
  }

  async listModerationGuilds(params = {}) {
    const token = params.token || this.loadConfig().moderationToken;
    if (!token) throw new Error("Token não configurado.");
    const guilds = await discordApiRequest(token, "/users/@me/guilds");
    return (Array.isArray(guilds) ? guilds : []).map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
      memberCount: g.approximate_member_count || 0,
      permissions: [],
      canModerate: Boolean(Number(g.permissions || 0) & 0x8),
    }));
  }

  async getModerationSnapshot(params = {}) {
    const token = params.token || this.loadConfig().moderationToken;
    const guildId = params.guildId;
    if (!token || !guildId) throw new Error("Token e servidor são obrigatórios.");

    const [guildData, channels] = await Promise.all([
      discordApiRequest(token, `/guilds/${guildId}`).catch(() => ({ name: guildId })),
      discordApiRequest(token, `/guilds/${guildId}/channels`).catch(() => []),
    ]);

    // Tenta buscar membros — endpoint padrão pode falhar (50001) para tokens sem permissão
    let members = [];
    let membersError = null;
    try {
      members = await discordApiRequest(token, `/guilds/${guildId}/members?limit=100`);
      if (!Array.isArray(members)) members = [];
    } catch (e) {
      if (e.message?.includes("403") || e.message?.includes("50001")) {
        // Fallback: busca via search (funciona em servidores que o token está)
        try {
          members = await discordApiRequest(token, `/guilds/${guildId}/members/search?query=&limit=100`);
          if (!Array.isArray(members)) members = [];
        } catch {
          membersError = "Sem permissão para listar membros neste servidor. O token precisa ser de um administrador do servidor.";
        }
      } else {
        membersError = e.message;
      }
    }

    if (membersError) throw new Error(membersError);

    const voiceChannels = (Array.isArray(channels) ? channels : [])
      .filter((c) => c.type === 2)
      .map((c) => ({ id: c.id, name: c.name, parentName: "", connected: [] }));

    const memberList = members.map((m) => ({
      id: m.user.id,
      tag: m.user.username,
      displayName: m.nick || m.user.global_name || m.user.username,
      avatar: m.user.avatar ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64` : null,
      bot: Boolean(m.user.bot),
      voiceChannelId: null,
      voiceChannelName: null,
      serverMuted: false,
      serverDeafened: false,
      timedOut: false,
    }));

    return {
      guild: {
        id: guildId,
        name: guildData.name || guildId,
        icon: guildData.icon ? `https://cdn.discordapp.com/icons/${guildId}/${guildData.icon}.png?size=64` : null,
        memberCount: guildData.approximate_member_count || memberList.length,
        permissions: ["Moderador"],
        canModerate: true,
        actions: ["mute", "unmute", "deafen", "undeafen", "voiceKick", "timeout", "untimeout", "kick", "ban"],
      },
      voiceChannels,
      members: memberList,
    };
  }

  async runModerationAction(params = {}) {
    const token = params.token || this.loadConfig().moderationToken;
    const { guildId, action, memberIds = [], reason = "" } = params;
    if (!token || !guildId) throw new Error("Token e servidor são obrigatórios.");
    const results = [];
    for (const memberId of memberIds) {
      try {
        if (action === "kick") {
          await discordApiRequest(token, `/guilds/${guildId}/members/${memberId}`, { method: "DELETE" });
        } else if (action === "ban") {
          await discordApiRequest(token, `/guilds/${guildId}/bans/${memberId}`, { method: "PUT", body: { delete_message_days: 0, reason } });
        } else if (action === "mute") {
          await discordApiRequest(token, `/guilds/${guildId}/members/${memberId}`, { method: "PATCH", body: { mute: true } });
        } else if (action === "unmute") {
          await discordApiRequest(token, `/guilds/${guildId}/members/${memberId}`, { method: "PATCH", body: { mute: false } });
        } else if (action === "deafen") {
          await discordApiRequest(token, `/guilds/${guildId}/members/${memberId}`, { method: "PATCH", body: { deaf: true } });
        } else if (action === "undeafen") {
          await discordApiRequest(token, `/guilds/${guildId}/members/${memberId}`, { method: "PATCH", body: { deaf: false } });
        }
        results.push({ id: memberId, ok: true });
      } catch (e) {
        results.push({ id: memberId, ok: false, error: e.message });
      }
      await sleep(300);
    }
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    return { ok, failed, total: results.length, results };
  }

  async cloneServer(params = {}) {
    const token = params.token || this.loadConfig().moderationToken;
    const { sourceGuildId, targetGuildId, includeRoles = true, includeChannels = true, reason = "" } = params;
    if (!token || !sourceGuildId || !targetGuildId) throw new Error("Token, origem e destino são obrigatórios.");

    const [sourceRoles, targetRoles, sourceChannels] = await Promise.all([
      discordApiRequest(token, `/guilds/${sourceGuildId}/roles`),
      discordApiRequest(token, `/guilds/${targetGuildId}/roles`),
      discordApiRequest(token, `/guilds/${sourceGuildId}/channels`),
    ]);

    const roleStats = { created: 0, reused: 0, failed: 0 };
    const channelStats = { created: 0, reused: 0, failed: 0 };
    const roleMap = new Map();

    if (includeRoles && Array.isArray(sourceRoles)) {
      const targetRoleNames = new Map((targetRoles || []).map((r) => [r.name.toLowerCase(), r.id]));
      for (const role of sourceRoles.filter((r) => r.name !== "@everyone" && !r.managed)) {
        const existing = targetRoleNames.get(role.name.toLowerCase());
        if (existing) { roleMap.set(role.id, existing); roleStats.reused++; continue; }
        try {
          const created = await discordApiRequest(token, `/guilds/${targetGuildId}/roles`, {
            method: "POST",
            body: { name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable },
          });
          roleMap.set(role.id, created.id);
          roleStats.created++;
        } catch { roleStats.failed++; }
        await sleep(350);
      }
    }

    if (includeChannels && Array.isArray(sourceChannels)) {
      const categories = sourceChannels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position);
      const categoryMap = new Map();
      for (const cat of categories) {
        try {
          const created = await discordApiRequest(token, `/guilds/${targetGuildId}/channels`, {
            method: "POST", body: { name: cat.name, type: 4 },
          });
          categoryMap.set(cat.id, created.id);
          channelStats.created++;
        } catch { channelStats.failed++; }
        await sleep(300);
      }
      const textChannels = sourceChannels.filter((c) => c.type !== 4).sort((a, b) => a.position - b.position);
      for (const ch of textChannels) {
        try {
          const body = { name: ch.name, type: ch.type };
          if (ch.parent_id && categoryMap.has(ch.parent_id)) body.parent_id = categoryMap.get(ch.parent_id);
          await discordApiRequest(token, `/guilds/${targetGuildId}/channels`, { method: "POST", body });
          channelStats.created++;
        } catch { channelStats.failed++; }
        await sleep(300);
      }
    }

    return {
      ok: true,
      roles: roleStats,
      channels: channelStats,
      source: { id: sourceGuildId },
      target: { id: targetGuildId },
    };
  }

  async _questsViaGateway(token, gameActivity = null) {
    let WS;
    try { const m = await import("ws"); WS = m.default || m; }
    catch { throw new Error("Módulo ws indisponível."); }

    const activities = gameActivity ? [{
      name: gameActivity.name,
      type: 0,
      application_id: gameActivity.application_id,
      timestamps: { start: Date.now() },
      flags: 0,
    }] : [];

    return new Promise((resolve, reject) => {
      let hbTimer = null;
      let resolved = false;
      const collected = [];
      let questTimer = null;

      const done = (list) => {
        if (resolved) return;
        resolved = true;
        clearInterval(hbTimer);
        clearTimeout(hardLimit);
        clearTimeout(questTimer);
        try { ws.terminate ? ws.terminate() : ws.close(); } catch {}
        resolve(list);
      };
      const fail = (e) => {
        if (resolved) return;
        resolved = true;
        clearInterval(hbTimer);
        clearTimeout(hardLimit);
        clearTimeout(questTimer);
        try { ws.terminate ? ws.terminate() : ws.close(); } catch {}
        reject(e);
      };

      const hardLimit = setTimeout(() => fail(new Error("Gateway timeout (35s)")), 35000);
      const ws = new WS("wss://gateway.discord.gg/?v=10&encoding=json");

      ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        const { op, d, t } = msg;

        if (op === 10) {
          clearInterval(hbTimer);
          hbTimer = setInterval(() => {
            try { if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: null })); } catch {}
          }, Math.floor(d.heartbeat_interval * 0.8));
          try {
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token,
                capabilities: 65534,
                properties: {
                  os: "Windows", browser: "Discord Client",
                  release_channel: "stable", client_version: "1.0.9168",
                  os_version: "10.0.22621", os_arch: "x64",
                  system_locale: "pt-BR",
                  browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/124.0.6367.243 Electron/30.4.0 Safari/537.36",
                  browser_version: "30.4.0", client_build_number: 336330,
                  native_build_number: 50950, client_event_source: null,
                },
                presence: { status: "online", since: 0, activities, afk: false },
                compress: false,
                client_state: {
                  guild_versions: {}, highest_last_message_id: "0",
                  read_state_version: 0, user_guild_settings_version: -1,
                  user_settings_version: -1, private_channels_version: "0",
                  api_code_version: 0,
                },
              },
            }));
          } catch (e) { fail(e); }
        }

        if (op === 0) {
          if (t === "READY") {
            const qs = d?.user_quests || d?.quests || d?.active_quests || [];
            if (Array.isArray(qs) && qs.length) collected.push(...qs);
            // After READY, update presence with the game so Discord can push quest events
            if (gameActivity && ws.readyState === 1) {
              setTimeout(() => {
                try {
                  ws.send(JSON.stringify({
                    op: 3, d: {
                      status: "online", since: null, afk: false,
                      activities,
                    },
                  }));
                } catch {}
              }, 500);
            }
            questTimer = setTimeout(() => done(collected), 8000);
          }

          if (t === "READY_SUPPLEMENTAL") {
            const qs = d?.user_quests || d?.quests || [];
            if (Array.isArray(qs) && qs.length) collected.push(...qs);
          }

          if (t && (
            t.includes("QUEST") || t.includes("ORBS") ||
            t.includes("REWARD") || t.includes("PROMOTION")
          )) {
            console.log(`[Gateway:Quest] ${t}:`, JSON.stringify(d).slice(0, 400));
            if (Array.isArray(d)) collected.push(...d);
            else if (d?.quests) collected.push(...(Array.isArray(d.quests) ? d.quests : [d.quests]));
            else if (d && typeof d === "object" && (d.quest_id || d.id)) collected.push(d);
            clearTimeout(questTimer);
            questTimer = setTimeout(() => done(collected), 1500);
          }
        }

        if (op === 9) fail(new Error("Token inválido ou sessão recusada pelo Gateway."));
        if (op === 7) done(collected);
      });

      ws.on("error", (e) => fail(new Error(`WebSocket: ${e.message}`)));
      ws.on("close", () => { if (!resolved) done(collected); });
    });
  }

  async fetchUserQuests(token) {
    // Loga com o selfbot e busca missões via cliente autenticado
    const client = new Client({ checkUpdate: false });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { client.destroy(); } catch {}
        resolve([]);
      }, 20000);

      client.once("ready", async () => {
        const found = [];
        try {
          const data = await client.api.users("@me").quests.get({
            query: { with_unredeemed: "true", with_combined_components: "true" },
          }).catch(() => null);
          const list = Array.isArray(data) ? data
            : (data?.quests || data?.user_quests || data?.active_quests || []);
          for (const q of list) found.push(normalizeQuest(q));
          console.log(`[Quests] Selfbot encontrou ${found.length} missão(ões).`);
        } catch (e) {
          console.warn("[Quests] API erro:", e.message);
        }
        clearTimeout(timer);
        try { client.destroy(); } catch {}
        resolve(found);
      });

      client.login(token).catch((e) => {
        clearTimeout(timer);
        try { client.destroy(); } catch {}
        resolve([]);
      });
    });
  }

  async _enrollQuest(token, questId) {
    const headers = {
      Authorization: token, "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/124.0.6367.243 Electron/30.4.0 Safari/537.36",
      "X-Super-Properties": SUPER_PROPS, "X-Discord-Locale": "pt-BR",
      Origin: "https://discord.com", Referer: "https://discord.com/channels/@me",
    };
    const tries = [
      { url: `${DISCORD_API_V9}/users/@me/quests/${questId}`, method: "PUT", body: {} },
      { url: `${DISCORD_API_V9}/quests/${questId}/enroll`, method: "POST", body: {} },
      { url: `${DISCORD_API_V9}/quests/${questId}/user-status`, method: "POST", body: { action: "accept" } },
      { url: `${DISCORD_API_V9}/users/@me/quests`, method: "POST", body: { quest_id: questId } },
    ];
    for (const t of tries) {
      try {
        const res = await fetch(t.url, {
          method: t.method, headers,
          body: JSON.stringify(t.body),
          signal: AbortSignal.timeout(10000),
        });
        const text = await res.text();
        console.log(`[Monitor/enroll] ${t.method} ${t.url.replace("https://discord.com/api/v9", "")} → ${res.status}`);
        if (res.status < 400 || res.status === 409) return true;
      } catch (e) { console.warn("[Monitor/enroll] error:", e.message); }
    }
    return false;
  }

  startQuestMonitor(token) {
    this.stopQuestMonitor();

    const monitor = { ws: null, hbTimer: null, active: false, tag: null, log: [], done: new Set(), activeQuest: null };
    this._questMonitor = monitor;

    const addLog = (msg) => {
      this._addLog('info', msg);
      monitor.log.unshift({ time: new Date().toLocaleTimeString('pt-BR'), msg });
      if (monitor.log.length > 80) monitor.log.pop();
    };

    const QUEST_CONTEXT = Buffer.from(JSON.stringify({ location: "Quest Bar" })).toString("base64");
    const QUEST_HEADERS = {
      Authorization: token,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/124.0.6367.243 Electron/30.4.0 Safari/537.36",
      "X-Super-Properties": SUPER_PROPS,
      "X-Discord-Locale": "pt-BR",
      "X-Discord-Timezone": "America/Sao_Paulo",
      "X-Context-Properties": QUEST_CONTEXT,
      "Content-Type": "application/json",
      Accept: "*/*",
      Origin: "https://discord.com",
      Referer: "https://discord.com/channels/@me",
    };

    const setGamePresence = (appId, gameName) => {
      if (!monitor.ws || monitor.ws.readyState !== 1) return;
      try {
        monitor.ws.send(JSON.stringify({
          op: 3, d: {
            status: "online", since: null, afk: false,
            activities: [{
              name: gameName, type: 0,
              application_id: appId,
              timestamps: { start: Date.now() },
              flags: 0,
            }],
          },
        }));
      } catch {}
    };

    const clearPresence = () => {
      if (!monitor.ws || monitor.ws.readyState !== 1) return;
      try {
        monitor.ws.send(JSON.stringify({
          op: 3, d: { status: "online", since: null, afk: false, activities: [] },
        }));
      } catch {}
    };

    const fetchAndComplete = async (questList) => {
      const pending = questList.filter((q) => {
        const qid = q.quest_id || q.id;
        return !q.user_status?.completed_at && !monitor.done.has(qid);
      });
      if (!pending.length) return;

      for (const q of pending) {
        const qid = q.quest_id || q.id;
        const name = q.config?.application_name || qid;
        const tasks = q.config?.task_config || {};
        const taskType = Object.keys(tasks)[0] || "WATCH_VIDEO";
        const target = tasks[taskType]?.target_minutes || 150;
        const enrolled = q.user_status != null;
        const appId = q.config?.application_id;

        monitor.done.add(qid);
        monitor.activeQuest = { qid, name, taskType, appId };

        if (!enrolled) {
          addLog(`Missão disponível: "${name}" [${taskType}] — inscrevendo...`);
          const ok = await this._enrollQuest(token, qid);
          addLog(ok ? `Inscrição em "${name}" confirmada.` : `Inscrição não confirmada, tentando mesmo assim...`);
          await sleep(1500);
        } else {
          addLog(`Missão: "${name}" [${taskType}] — completando...`);
        }

        // Para quests de jogo/stream: ativa presença de jogo antes dos heartbeats
        if ((taskType === "PLAY_ON_DESKTOP" || taskType === "STREAM_ON_DESKTOP") && appId) {
          addLog(`Ativando presença de jogo "${name}" (${appId})...`);
          setGamePresence(appId, name);
          await sleep(3000); // aguarda Discord detectar o "jogo"
        }

        try {
          const r = await this.completeQuest(token, qid, taskType, target, 2000);
          addLog(r.completed ? `✓ "${name}" concluída!` : `Heartbeats enviados para "${name}".`);
          this._recordQuestCompletion(qid, name, taskType, token.slice(0, 12) + '...', r.completed, r.progress, r.total);
        } catch (e) {
          addLog(`Erro: ${e.message}`);
          if (e.message.includes("404") || e.message.includes("inscrito") || e.message.includes("não encontrada")) {
            monitor.done.delete(qid);
          }
        } finally {
          // Limpa presença após quest finalizar
          if (taskType === "PLAY_ON_DESKTOP" || taskType === "STREAM_ON_DESKTOP") clearPresence();
          monitor.activeQuest = null;
        }
      }
    };

    const fetchQuestsRest = async () => {
      const urls = [
        `${DISCORD_API_V9}/users/@me/quests?with_unredeemed=true&with_combined_components=true`,
        `${DISCORD_API_V9}/users/@me/quests`,
        `${DISCORD_API}/users/@me/quests?with_unredeemed=true&with_combined_components=true`,
        `${DISCORD_API_V9}/users/@me/promotions`,
        `${DISCORD_API_V9}/promotions`,
        `${DISCORD_API}/users/@me/promotions`,
        `${DISCORD_API_V9}/users/@me/quest-bar`,
        `${DISCORD_API_V9}/quest-bar`,
      ];
      for (const url of urls) {
        try {
          const res = await fetch(url, { headers: QUEST_HEADERS, signal: AbortSignal.timeout(12000) });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          const list = Array.isArray(json) ? json
            : (json?.quests || json?.user_quests || json?.active_quests || json?.quest_user_statuses
              || json?.promotions || json?.user_promotions || []);
          const short = url.replace("https://discord.com/api/", "");
          addLog(`[REST ${res.status}] ${short} — ${list.length} item(s)`);
          if (res.ok && list.length) return list;
          if (!res.ok && res.status !== 404) addLog(`[REST erro] ${text.slice(0, 120)}`);
        } catch (e) { addLog(`[REST falhou] ${e.message}`); }
      }
      return [];
    };

    const extractQuestsFromPacket = (d) => {
      if (!d || typeof d !== "object") return [];
      const QUEST_KEYS = ["user_quests", "quests", "active_quests", "quest_user_statuses",
        "quest_notices", "quests_v2", "orb_quests", "promotions"];
      for (const key of QUEST_KEYS) {
        if (Array.isArray(d[key]) && d[key].length) {
          console.log(`[Monitor/quests] Encontrado via campo "${key}":`, d[key].length);
          return d[key];
        }
      }
      // Quest única no payload
      if (d.quest_id || (d.id && d.config?.task_config)) return [d];
      // Varre 1 nível de profundidade (ex: { data: { user_quests: [...] } })
      for (const val of Object.values(d)) {
        if (val && typeof val === "object" && !Array.isArray(val)) {
          for (const key of QUEST_KEYS) {
            if (Array.isArray(val[key]) && val[key].length) {
              console.log(`[Monitor/quests] Encontrado nested via "${key}":`, val[key].length);
              return val[key];
            }
          }
        }
      }
      return [];
    };

    const connect = async () => {
      let WS;
      try { const m = await import("ws"); WS = m.default || m; } catch { addLog("Módulo ws indisponível."); return; }

      const ws = new WS("wss://gateway.discord.gg/?v=10&encoding=json");
      monitor.ws = ws;

      ws.on("message", async (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        const { op, d, t } = msg;

        if (op === 10) {
          clearInterval(monitor.hbTimer);
          monitor.hbTimer = setInterval(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: null }));
          }, Math.floor(d.heartbeat_interval * 0.85));

          ws.send(JSON.stringify({
            op: 2,
            d: {
              token,
              capabilities: 65534,
              properties: {
                os: "Windows", browser: "Discord Client", release_channel: "stable",
                client_version: "1.0.9168", os_version: "10.0.22621", os_arch: "x64",
                app_arch: "x64", system_locale: "pt-BR",
                browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/124.0.6367.243 Electron/30.4.0 Safari/537.36",
                browser_version: "30.4.0", client_build_number: 540600,
                native_build_number: 50950, os_sdk_version: "22621",
                client_event_source: null,
              },
              presence: { status: "online", since: 0, activities: [], afk: false },
              compress: false,
              client_state: {
                guild_versions: {}, highest_last_message_id: "0",
                read_state_version: 0, user_guild_settings_version: -1,
                user_settings_version: -1, private_channels_version: "0",
                api_code_version: 0,
              },
            },
          }));
        }

        if (op === 0) {
          if (t === "READY") {
            monitor.active = true;
            monitor.tag = d?.user?.username || d?.user?.global_name || null;
            addLog(`Conectado como ${monitor.tag}. Aguardando eventos...`);

            // Loga todas as chaves do READY para diagnóstico
            const keys = Object.keys(d || {});
            console.log("[Monitor/READY keys]", keys.join(", "));
            // Loga experiments/apex_experiments para detectar quest flags
            if (d?.apex_experiments) console.log("[Monitor/apex_experiments]", JSON.stringify(d.apex_experiments).slice(0, 600));
            if (d?.experiments) console.log("[Monitor/experiments]", JSON.stringify(d.experiments).slice(0, 600));

            const fromReady = extractQuestsFromPacket(d);
            if (fromReady.length) {
              addLog(`${fromReady.length} quest(s) encontrada(s) — processando...`);
              await fetchAndComplete(fromReady);
            } else {
              // Fallback: tenta via REST
              const restList = await fetchQuestsRest();
              if (restList.length) {
                addLog(`${restList.length} quest(s) via REST — processando...`);
                await fetchAndComplete(restList);
              } else {
                addLog("Nenhuma quest ativa nesta conta. Monitorando eventos em tempo real...");
              }
            }
          }

          if (t === "READY_SUPPLEMENTAL") {
            const fromSupp = extractQuestsFromPacket(d);
            if (fromSupp.length) {
              addLog(`${fromSupp.length} quest(s) no READY_SUPPLEMENTAL — processando...`);
              await fetchAndComplete(fromSupp);
            }
          }

          // Discord pede heartbeat quando detecta o jogo rodando
          if (t === "QUESTS_SEND_HEARTBEAT") {
            const questId = d?.quest_id;
            const streamKey = d?.stream_key;
            console.log(`[Monitor/event] QUESTS_SEND_HEARTBEAT quest=${questId} key=${streamKey}`);
            addLog(`Heartbeat solicitado pelo Discord para quest ${questId}`);
            if (questId && streamKey) {
              try {
                const res = await fetch(`${DISCORD_API_V9}/quests/${questId}/heartbeat`, {
                  method: "POST", headers: QUEST_HEADERS,
                  body: JSON.stringify({ stream_key: streamKey, terminal: false }),
                  signal: AbortSignal.timeout(10000),
                });
                const data = await res.json().catch(() => ({}));
                const done = data?.completed_at || data?.user_status?.completed_at ||
                  Object.values(data?.progress || {}).some(v => v?.completed_at);
                addLog(`Heartbeat respondido (${res.status})${done ? " — quest COMPLETA!" : ""}`);
              } catch (e) { addLog(`Erro heartbeat: ${e.message}`); }
            } else if (questId && monitor.activeQuest?.appId) {
              // Sem stream_key: tenta com minutes_played
              try {
                const res = await fetch(`${DISCORD_API_V9}/quests/${questId}/heartbeat`, {
                  method: "POST", headers: QUEST_HEADERS,
                  body: JSON.stringify({ stream_type: "DESKTOP_AUDIO", additional_metadata: { minutes_played: 1 } }),
                  signal: AbortSignal.timeout(10000),
                });
                addLog(`Heartbeat (fallback) respondido (${res.status})`);
              } catch {}
            }
          } else if (t === "QUESTS_USER_STATUS_UPDATE" || t === "QUEST_USER_STATUS_CREATE" || t === "QUEST_USER_STATUS_UPDATE") {
            console.log(`[Monitor/event] ${t}:`, JSON.stringify(d).slice(0, 600));
            const status = d?.user_status || d;
            const questId = status?.quest_id;
            if (!questId) return;

            // Se já está concluída, apenas marca
            const alreadyDone = status?.completed_at ||
              Object.values(status?.progress || {}).some(p => p?.completed_at);
            if (alreadyDone) {
              if (!monitor.done.has(questId)) addLog(`Quest ${questId} já concluída.`);
              monitor.done.add(questId);
              return;
            }

            // Aguarda evento com taskType real — progresso vazio = acabou de ser inscrito
            const progressKeys = Object.keys(status?.progress || {});
            if (!progressKeys.length) {
              addLog(`Quest ${questId} inscrita — aguardando tipo de tarefa...`);
              return;
            }

            // Já sendo processada
            if (monitor.done.has(questId)) return;

            const taskType = progressKeys[0]; // ex: "WATCH_VIDEO", "PLAY_ON_DESKTOP"
            const progressVal = status?.progress?.[taskType]?.value || 0;
            addLog(`Quest ativa: ${questId} [${taskType}] progresso=${progressVal} — iniciando...`);
            monitor.done.add(questId);
            monitor.activeQuest = { qid: questId, taskType, appId: null };

            // Busca detalhes completos: application_id e target
            let appId = null, appName = questId, targetMinutes = 15, targetSeconds = 900;
            for (const ep of [
              `${DISCORD_API_V9}/quests/${questId}`,
              `${DISCORD_API}/quests/${questId}`,
            ]) {
              try {
                const r = await fetch(ep, { headers: QUEST_HEADERS, signal: AbortSignal.timeout(8000) });
                if (r.ok) {
                  const qd = await r.json();
                  appId = qd?.config?.application_id || qd?.application_id;
                  appName = qd?.config?.application_name || appName;
                  const taskCfg = qd?.config?.task_config?.[taskType] || {};
                  targetMinutes = taskCfg.target_minutes || targetMinutes;
                  targetSeconds = taskCfg.target_video_seconds || taskCfg.target_seconds || (targetMinutes * 60);
                  if (appId) addLog(`Quest: "${appName}" | app=${appId} | alvo=${targetSeconds}s`);
                  break;
                }
              } catch {}
            }
            monitor.activeQuest.appId = appId;

            // Ativa presença de jogo se PLAY/STREAM e tiver app ID
            if (appId && (taskType === "PLAY_ON_DESKTOP" || taskType === "STREAM_ON_DESKTOP")) {
              addLog(`Ativando presença: "${appName}"...`);
              setGamePresence(appId, appName);
              await sleep(3000);
            }

            // Para WATCH_VIDEO: passa segundos diretamente (a função usa <= 600 como segundos)
            // Garante ao menos 300s para cobrir qualquer quest de vídeo
            const isVideo = taskType === "WATCH_VIDEO" || taskType === "VIDEO";
            const target = isVideo
              ? Math.max(targetSeconds + 30, 300)  // alvo + margem, mínimo 300s
              : targetMinutes;
            const delay = isVideo ? 400 : 1500; // vídeo pode ir mais rápido

            try {
              const r = await this.completeQuest(token, questId, taskType, target, delay);
              addLog(r.completed ? `✓ "${appName}" concluída!` : `Progresso enviado para "${appName}" (${r.progress}/${r.total}).`);
              this._recordQuestCompletion(questId, appName, taskType, token.slice(0, 12) + '...', r.completed, r.progress, r.total);
            } catch (e) {
              addLog(`Erro ao completar: ${e.message}`);
              monitor.done.delete(questId);
            } finally {
              if (appId) clearPresence();
              monitor.activeQuest = null;
            }

          } else if (t && (t.includes("QUEST") || t.includes("ORBS") || t.includes("REWARD") || t.includes("PROMOTION"))) {
            console.log(`[Monitor/event] ${t}:`, JSON.stringify(d).slice(0, 300));
            addLog(`Evento: ${t}`);
            const fromEvent = extractQuestsFromPacket(d);
            if (fromEvent.length) {
              await fetchAndComplete(fromEvent);
            } else {
              const restList = await fetchQuestsRest();
              if (restList.length) await fetchAndComplete(restList);
            }
          }
        }

        if (op === 9) { addLog("Sessão recusada pelo Gateway (token inválido ou expirou)."); monitor.active = false; }
      });

      ws.on("error", (e) => addLog(`Erro Gateway: ${e.message}`));
      ws.on("close", (code) => {
        clearInterval(monitor.hbTimer);
        if (monitor.ws === ws) {
          addLog(`Gateway fechou (${code}). Reconectando em 10s...`);
          setTimeout(() => { if (monitor.ws === ws) connect(); }, 10000);
        }
      });
    };

    connect();
  }

  stopQuestMonitor() {
    const m = this._questMonitor;
    if (m) {
      clearInterval(m.hbTimer);
      if (m.ws) { try { m.ws.terminate(); } catch {} }
      if (m.client) { try { m.client.destroy(); } catch {} }
    }
    this._questMonitor = null;
  }

  getQuestMonitorStatus() {
    if (!this._questMonitor) return { active: false, log: [] };
    return {
      active: this._questMonitor.active,
      tag: this._questMonitor.tag,
      log: this._questMonitor.log.slice(0, 30),
    };
  }

  async debugQuestsRaw(token) {
    const headers = {
      Authorization: token, "User-Agent": UA,
      "X-Discord-Locale": "pt-BR", "X-Super-Properties": SUPER_PROPS,
    };
    const endpoints = [
      `${DISCORD_API_V9}/users/@me/quests?with_unredeemed=true&with_combined_components=true`,
      `${DISCORD_API_V9}/users/@me/quests`,
      `${DISCORD_API_V9}/quests`,
      `${DISCORD_API}/users/@me/quests?with_unredeemed=true&with_combined_components=true`,
      `${DISCORD_API}/users/@me/quests`,
      `${DISCORD_API_V9}/users/@me/promotions`,
      `${DISCORD_API_V9}/promotions`,
      `${DISCORD_API}/users/@me/promotions`,
      `${DISCORD_API_V9}/users/@me/quest-bar`,
      `${DISCORD_API_V9}/quest-bar`,
      `${DISCORD_API_V9}/users/@me/orbs`,
    ];
    const results = [];
    for (const ep of endpoints) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(ep, { signal: controller.signal, headers });
        const text = await response.text();
        clearTimeout(timeout);
        let parsed = null; try { parsed = JSON.parse(text); } catch {}
        results.push({ endpoint: ep.replace("https://discord.com/api/", ""), status: response.status, body: text.slice(0, 500), parsed });
      } catch (e) { clearTimeout(timeout); results.push({ endpoint: ep.replace("https://discord.com/api/", ""), error: e.message }); }
    }

    // Gateway debug
    try {
      const gwQuests = await this._questsViaGateway(token);
      results.push({
        endpoint: "gateway/READY → user_quests",
        status: 200,
        body: JSON.stringify(gwQuests).slice(0, 800),
        parsed: gwQuests,
      });
    } catch (e) {
      results.push({ endpoint: "gateway/READY → user_quests", error: e.message });
    }

    return { results };
  }

  async completeQuest(token, questId, taskType = "VIDEO", targetMinutes = 15, delayMs = 2000) {
    const HB_HEADERS = {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": UA,
      "X-Super-Properties": SUPER_PROPS,
      "X-Discord-Locale": "pt-BR",
      "X-Discord-Timezone": "America/Sao_Paulo",
      "Accept": "*/*",
      "Origin": "https://discord.com",
      "Referer": "https://discord.com/channels/@me",
    };

    const isCompleted = (d) => Boolean(
      d?.completed_at || d?.user_status?.completed_at ||
      d?.progress?.WATCH_VIDEO?.completed_at ||
      d?.progress?.VIDEO?.completed_at ||
      d?.progress?.PLAY_ON_DESKTOP?.completed_at ||
      d?.progress?.STREAM_ON_DESKTOP?.completed_at
    );

    if (taskType === "WATCH_VIDEO" || taskType === "VIDEO") {
      const clientHeartbeatSessionId = randomUUID();
      const clientAdSessionId = randomUUID();

      // x-super-properties com client_heartbeat_session_id incluído (igual ao Chrome)
      const videoSuperProps = Buffer.from(JSON.stringify({
        os: "Windows", browser: "Chrome", device: "",
        system_locale: "pt-BR", has_client_mods: false,
        browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        browser_version: "147.0.0.0", os_version: "10",
        referrer: "", referring_domain: "",
        referrer_current: "https://discord.com/",
        referring_domain_current: "discord.com",
        release_channel: "stable",
        client_build_number: 540600,
        client_event_source: null,
        client_launch_id: randomUUID(),
        launch_signature: randomUUID(),
        client_heartbeat_session_id: clientHeartbeatSessionId,
        client_app_state: "focused",
      })).toString("base64");

      const VIDEO_HEADERS = {
        ...HB_HEADERS,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "X-Super-Properties": videoSuperProps,
        "X-Debug-Options": "bugReporterEnabled",
        "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      };

      await sleep(300);

      const totalSeconds = targetMinutes <= 600 ? targetMinutes : targetMinutes * 60;
      const step = 6;
      let lastData = null;

      for (let ts = step; ts <= totalSeconds; ts += step) {
        const timestamp = parseFloat(ts.toFixed(6));
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await fetch(`${DISCORD_API_V9}/quests/${questId}/video-progress`, {
              method: "POST",
              headers: VIDEO_HEADERS,
              body: JSON.stringify({ timestamp }),
              signal: AbortSignal.timeout(15000),
            });
            if (res.status === 429) {
              const rd = await res.json().catch(() => ({}));
              await sleep(((rd.retry_after || 5) * 1000) + 500);
              continue;
            }
            if (res.status === 401) throw new Error("Token inválido ou expirado.");
            if (res.status === 404) throw new Error("Missão não encontrada. Confirme se você está inscrito na quest no Discord e se o ID está correto.");
            const text = await res.text();
            if (res.status >= 400) throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
            lastData = JSON.parse(text);
            const done = isCompleted(lastData);
            console.log(`[Quest] video-progress ts=${timestamp}s status=${res.status} completed=${done}`);
            if (done) {
              this._recordQuestCompletion(questId, questId, taskType, token.slice(0, 12) + '...', true, ts, totalSeconds);
              return { ok: true, completed: true, progress: ts, total: totalSeconds, data: lastData };
            }
            break;
          } catch (e) {
            if (e.message.includes("Token") || e.message.includes("Missão") || e.message.includes("inscrito")) throw e;
            if (attempt === 2) throw e;
            await sleep(1500);
          }
        }
        if (ts < totalSeconds) await sleep(delayMs);
      }
      const done = isCompleted(lastData);
      this._recordQuestCompletion(questId, questId, taskType, token.slice(0, 12) + '...', done, totalSeconds, totalSeconds);
      return { ok: true, completed: done, progress: totalSeconds, total: totalSeconds, data: lastData };
    }

    // Quests clássicas de jogo/stream (PLAY_ON_DESKTOP, STREAM_ON_DESKTOP)
    const streamType = "DESKTOP_AUDIO";
    let lastData = null;
    for (let min = 1; min <= targetMinutes; min++) {
      const additionalMeta = taskType === "PLAY_ON_DESKTOP"
        ? { minutes_played: min }
        : { minutes_of_video: min };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${DISCORD_API_V9}/quests/${questId}/heartbeat`, {
            method: "POST", headers: HB_HEADERS,
            body: JSON.stringify({ stream_type: streamType, additional_metadata: additionalMeta }),
            signal: AbortSignal.timeout(15000),
          });
          if (res.status === 429) {
            const rd = await res.json().catch(() => ({}));
            await sleep(((rd.retry_after || 5) * 1000) + 500);
            continue;
          }
          if (res.status === 401) throw new Error("Token inválido ou expirado.");
          if (res.status === 404) throw new Error("Missão não encontrada. Verifique o ID ou se a missão ainda está ativa.");
          const text = await res.text();
          if (res.status >= 400) throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
          lastData = JSON.parse(text);
          const done = isCompleted(lastData);
          console.log(`[Quest] heartbeat min=${min} status=${res.status} completed=${done}`);
          if (done) {
            this._recordQuestCompletion(questId, questId, taskType, token.slice(0, 12) + '...', true, min, targetMinutes);
            return { ok: true, completed: true, progress: min, total: targetMinutes, data: lastData };
          }
          break;
        } catch (e) {
          if (e.message.includes("Token") || e.message.includes("Missão")) throw e;
          if (attempt === 2) throw e;
          await sleep(1500);
        }
      }
      if (min < targetMinutes) await sleep(delayMs);
    }
    const done = isCompleted(lastData);
    this._recordQuestCompletion(questId, questId, taskType, token.slice(0, 12) + '...', done, targetMinutes, targetMinutes);
    return { ok: true, completed: done, progress: targetMinutes, total: targetMinutes, data: lastData };
  }

  async investigateUser(myToken, targetId) {
    // Pega meus servidores primeiro — temos nomes reais aqui
    let myGuilds = [];
    try { myGuilds = await discordApiRequest(myToken, "/users/@me/guilds"); } catch {}
    if (!Array.isArray(myGuilds)) myGuilds = [];
    const myGuildMap = new Map(myGuilds.map((g) => [g.id, g.name || g.id]));

    // 1) Profile completo (amigos, mutual guilds, conexões)
    let profile = null;
    let targetUser = null;
    try {
      profile = await discordApiRequest(myToken, `/users/${targetId}/profile?with_mutual_guilds=true&with_mutual_friends=true`);
      targetUser = profile.user;
    } catch {}

    // 2) Varre todos os meus servidores procurando o membro
    if (!targetUser) {
      for (const g of myGuilds.slice(0, 50)) {
        try {
          const member = await discordApiRequest(myToken, `/guilds/${g.id}/members/${targetId}`);
          if (member?.user) { targetUser = member.user; break; }
        } catch {}
        await sleep(120);
      }
    }

    // 3) Fallback básico
    if (!targetUser) {
      try { targetUser = await discordApiRequest(myToken, `/users/${targetId}`); } catch {}
    }

    if (!targetUser) {
      throw new Error(
        "Usuário não encontrado. O Discord só expõe dados de usuários que estão em servidores em comum com você ou são seus amigos."
      );
    }

    const createdAt = new Date(Number((BigInt(targetId) >> 22n) + 1420070400000n));
    const accountAgeDays = Math.floor((Date.now() - createdAt.getTime()) / 86400000);

    const premiumType = profile?.premium_type || targetUser.premium_type || 0;
    const premiumSince = profile?.premium_since || null;
    const bio = profile?.user_profile?.bio || null;
    const pronouns = profile?.user_profile?.pronouns || null;
    const connections = (profile?.connected_accounts || []).map((c) => ({
      type: c.type, name: c.name, verified: c.verified || false,
    }));
    const mutualFriends = (profile?.mutual_friends || []).map((f) => ({
      id: f.id, username: f.username, global_name: f.global_name || null, avatar: f.avatar,
      discriminator: (f.discriminator && f.discriminator !== "0") ? f.discriminator : null,
    }));

    // Monta lista de guilds mútuos com nomes reais
    const profileMutualIds = new Set((profile?.mutual_guilds || []).map((g) => g.id));
    const mutualGuilds = (profile?.mutual_guilds || []).map((g) => ({
      id: g.id,
      name: myGuildMap.get(g.id) || g.name || g.id,  // nome real do meu mapa
      nick: g.nick || null,
    }));

    // Varre TODOS os meus servidores buscando o membro e seu nick
    const nicknames = [];
    const checkedIds = new Set();

    // Primeiro os guilds mútuos (mais provável de encontrar), depois o resto — sem limite
    const guildsToScan = [
      ...myGuilds.filter((g) => profileMutualIds.has(g.id)),
      ...myGuilds.filter((g) => !profileMutualIds.has(g.id)),
    ];

    for (const g of guildsToScan) {
      if (checkedIds.has(g.id)) continue;
      checkedIds.add(g.id);
      try {
        const member = await discordApiRequest(myToken, `/guilds/${g.id}/members/${targetId}`);
        if (member?.user) {
          nicknames.push({ guildId: g.id, guildName: g.name || g.id, nick: member.nick || null });
          // Adiciona à lista de mutual guilds se ainda não está
          if (!mutualGuilds.find((mg) => mg.id === g.id)) {
            mutualGuilds.push({ id: g.id, name: g.name || g.id, nick: member.nick || null });
          }
        }
      } catch {}
      await sleep(180);
    }

    // Merge with nick cache
    const cache = this.loadNickCache();
    if (!cache[targetId]) cache[targetId] = [];
    const seenNow = new Set(nicknames.map((n) => `${n.guildId}:${n.nick}`));
    const now = new Date().toISOString();
    for (const n of nicknames) {
      const existing = cache[targetId].find((c) => c.guildId === n.guildId && c.nick === n.nick);
      if (existing) { existing.seenAt = now; } else { cache[targetId].push({ guildId: n.guildId, guildName: n.guildName, nick: n.nick, seenAt: now }); }
    }
    if (cache[targetId].length > 100) cache[targetId] = cache[targetId].slice(-100);
    this.saveNickCache(cache);
    const nicksHistory = [
      ...nicknames.map((n) => ({ ...n, current: true, seenAt: now })),
      ...cache[targetId].filter((c) => !seenNow.has(`${c.guildId}:${c.nick}`)).map((c) => ({ ...c, current: false })),
    ];

    // Agrupa todos os nicks únicos por valor (não por servidor)
    const uniqueNickMap = new Map();
    for (const n of nicksHistory) {
      const val = n.nick || null;
      const key = val ?? '__none__';
      if (!uniqueNickMap.has(key)) {
        uniqueNickMap.set(key, { nick: val, servers: [], firstSeen: n.seenAt });
      }
      uniqueNickMap.get(key).servers.push({ guildId: n.guildId, guildName: n.guildName, current: Boolean(n.current) });
    }
    const uniqueNickValues = [...uniqueNickMap.values()]
      .filter((v) => v.nick !== null) // exclui entradas sem nick
      .sort((a, b) => b.servers.length - a.servers.length);

    const reasons = [];
    if (accountAgeDays < 30) reasons.push("Conta criada há menos de 30 dias");
    else if (accountAgeDays < 90) reasons.push("Conta nova (menos de 90 dias)");
    if (mutualGuilds.length === 0) reasons.push("Não encontrado em nenhum servidor em comum");
    if (!(targetUser.public_flags || 0) && premiumType === 0) reasons.push("Sem badges ou Nitro detectado");
    if (profile && connections.length === 0) reasons.push("Sem conexões públicas vinculadas");
    const risk = reasons.length >= 3 ? "ALTO" : reasons.length >= 2 ? "MÉDIO" : "BAIXO";

    return {
      ok: true,
      user: {
        id: targetUser.id, username: targetUser.username,
        global_name: targetUser.global_name || null,
        discriminator: (targetUser.discriminator && targetUser.discriminator !== "0") ? targetUser.discriminator : null,
        avatar: targetUser.avatar, banner: targetUser.banner || null,
        accent_color: targetUser.accent_color || null,
        public_flags: targetUser.public_flags || 0, premium_type: premiumType,
        createdAt: createdAt.toISOString(), accountAgeDays,
      },
      bio, pronouns, premiumSince, mutualGuilds, mutualFriends, connections, nicknames, nicksHistory, uniqueNickValues,
      altAnalysis: { risk, accountAgeDays, reasons },
    };
  }

  async purgeMessages(params = {}) {
    const { token, channelId, limit = 100, userId, keyword } = params;
    if (!token || !channelId) throw new Error("Token e canal são obrigatórios.");
    let messages = await discordApiRequest(token, `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`);
    if (!Array.isArray(messages)) messages = [];
    if (userId) messages = messages.filter((m) => m.author?.id === userId);
    if (keyword) messages = messages.filter((m) => m.content?.includes(keyword));
    let deleted = 0, failed = 0;
    for (const msg of messages) {
      try {
        await discordApiRequest(token, `/channels/${channelId}/messages/${msg.id}`, { method: "DELETE" });
        deleted++;
      } catch { failed++; }
      await sleep(1100);
    }
    return { ok: true, scanned: messages.length, matched: messages.length, deleted, failed };
  }

  async listDMChannels(token) {
    const channels = await discordApiRequest(token, "/users/@me/channels");
    if (!Array.isArray(channels)) return [];
    return channels
      .filter((c) => c.type === 1 || c.type === 3)
      .map((c) => ({
        id: c.id,
        type: c.type,
        name: c.type === 1
          ? (c.recipients?.[0]?.global_name || c.recipients?.[0]?.username || "DM")
          : (c.name || "Grupo"),
        recipientId: c.type === 1 ? c.recipients?.[0]?.id : null,
        recipientAvatar: c.type === 1 ? c.recipients?.[0]?.avatar : c.icon,
        lastMessageId: c.last_message_id || null,
      }));
  }

  getNukeStatus() {
    return this._nukeJob
      ? { running: this._nukeJob.running, deleted: this._nukeJob.deleted, failed: this._nukeJob.failed, scanned: this._nukeJob.scanned, channelId: this._nukeJob.channelId }
      : { running: false, deleted: 0, failed: 0, scanned: 0 };
  }

  stopNuke() {
    if (this._nukeJob) this._nukeJob.stopped = true;
  }

  async nukeChannel(params = {}) {
    const { token, channelId, userId, keyword, limit } = params;
    if (!token || !channelId) throw new Error("Token e ID do canal são obrigatórios.");

    this._nukeJob = { running: true, stopped: false, deleted: 0, failed: 0, scanned: 0, channelId };
    const job = this._nukeJob;
    const maxDelete = (limit > 0 ? limit : 0) || Infinity;
    let before = null;

    const label = `Canal ${channelId}${userId ? ` / usuário ${userId}` : ""}${keyword ? ` / filtro "${keyword}"` : ""}`;
    this._addLog("info", `Nuke iniciado — ${label}`);

    try {
      while (!job.stopped && job.deleted < maxDelete) {
        let url = `/channels/${channelId}/messages?limit=100`;
        if (before) url += `&before=${before}`;

        let messages;
        try {
          messages = await discordApiRequest(token, url);
          if (!Array.isArray(messages) || !messages.length) break;
        } catch (e) {
          this._addLog("error", `Nuke: erro ao buscar mensagens — ${e.message}`);
          break;
        }

        before = messages[messages.length - 1].id;
        job.scanned += messages.length;

        let batch = messages;
        if (userId) batch = batch.filter((m) => m.author?.id === userId);
        if (keyword) batch = batch.filter((m) => m.content?.includes(keyword));

        for (const msg of batch) {
          if (job.stopped || job.deleted >= maxDelete) break;
          try {
            await discordApiRequest(token, `/channels/${channelId}/messages/${msg.id}`, { method: "DELETE" });
            job.deleted++;
            if (job.deleted % 10 === 0 || job.deleted <= 5) {
              this._addLog("info", `Nuke: ${job.deleted} apagadas, ${job.scanned} escaneadas...`);
            }
          } catch (e) {
            if (e.message?.includes("429")) {
              this._addLog("warn", "Nuke: rate limit — aguardando 5s...");
              await sleep(5000);
            } else if (e.message?.includes("403")) {
              job.failed++;
              this._addLog("warn", `Nuke: sem permissão para apagar msg ${msg.id} (provavelmente de outro usuário)`);
            } else {
              job.failed++;
            }
          }
          await sleep(900);
        }

        if (messages.length < 100) break;
        await sleep(400);
      }
    } finally {
      job.running = false;
      this._addLog("info", `Nuke finalizado: ${job.deleted} apagadas, ${job.failed} falhas, ${job.scanned} escaneadas`);
    }

    return { ok: true, deleted: job.deleted, failed: job.failed, scanned: job.scanned };
  }
}
