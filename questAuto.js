import { randomUUID } from 'crypto';

const API     = "https://discord.com/api/v9";
const API_V10 = "https://discord.com/api/v10";
const SUPER_PROPS = Buffer.from(JSON.stringify({
  os: "Windows", browser: "Discord Client", release_channel: "stable",
  client_version: "1.0.9168", os_version: "10.0.22621", os_arch: "x64",
  app_arch: "x64", system_locale: "pt-BR",
  browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/124.0.6367.243 Electron/30.4.0 Safari/537.36",
  browser_version: "30.4.0", os_sdk_version: "22621",
  client_build_number: 540600, native_build_number: 50950,
})).toString("base64");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/124.0.6367.243 Electron/30.4.0 Safari/537.36";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

let _state = { running: false, log: [], quests: [], currentQuest: null, _stopFlag: false, _debugFetch: [], _readyKeys: [] };

function addLog(msg, level = 'info') {
  const entry = { time: new Date().toLocaleTimeString('pt-BR'), msg, level };
  _state.log.unshift(entry);
  if (_state.log.length > 120) _state.log.pop();
  console.log(`[QuestAuto/${level}] ${msg}`);
}

function makeHeaders(token) {
  return {
    Authorization: token,
    "Content-Type": "application/json",
    "User-Agent": UA,
    "X-Super-Properties": SUPER_PROPS,
    "X-Discord-Locale": "pt-BR",
    "X-Discord-Timezone": "America/Sao_Paulo",
    "X-Context-Properties": Buffer.from(JSON.stringify({ location: "Quest Bar" })).toString("base64"),
    Accept: "*/*",
    Origin: "https://discord.com",
    Referer: "https://discord.com/channels/@me",
  };
}

async function dfetch(token, path, method = 'GET', body = null, base = API) {
  const opts = { method, headers: makeHeaders(token), signal: AbortSignal.timeout(15000) };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, raw: text };
}

const QUEST_KEYS = ["user_quests", "quests", "active_quests", "quest_user_statuses",
  "quest_notices", "quests_v2", "orb_quests", "promotions", "user_promotions",
  "items", "data"];

function extractFromPacket(d) {
  if (!d || typeof d !== "object") return [];
  if (Array.isArray(d)) return d.filter(q => q.quest_id || (q.id && q.config?.task_config));
  for (const k of QUEST_KEYS) {
    if (Array.isArray(d[k]) && d[k].length > 0) {
      const filtered = d[k].filter(q => q.quest_id || q.id || q.config?.task_config);
      if (filtered.length) return filtered;
    }
  }
  // Single quest object at root
  if (d.quest_id || (d.id && d.config?.task_config)) return [d];
  // One level deep
  for (const val of Object.values(d)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      for (const k of QUEST_KEYS) {
        if (Array.isArray(val[k]) && val[k].length > 0) return val[k];
      }
    }
  }
  return [];
}

// Connects to Gateway, gets READY event, extracts quests and disconnects
async function fetchQuestsViaGateway(token) {
  let WS;
  try { const m = await import("ws"); WS = m.default || m; }
  catch { return { quests: [], readyKeys: [], error: 'ws module unavailable' }; }

  return new Promise((resolve) => {
    const ws = new WS("wss://gateway.discord.gg/?v=10&encoding=json");
    let hbTimer = null;
    let done = false;

    const finish = (quests, readyKeys = [], error = null) => {
      if (done) return;
      done = true;
      if (hbTimer) clearInterval(hbTimer);
      try { ws.terminate(); } catch {}
      resolve({ quests, readyKeys, error });
    };

    const timeout = setTimeout(() => finish([], [], 'timeout'), 15000);

    ws.on("open", () => {});
    ws.on("error", (e) => { clearTimeout(timeout); finish([], [], e.message); });
    ws.on("close", () => { clearTimeout(timeout); if (!done) finish([], []); });

    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const { op, d, t } = msg;

      if (op === 10) {
        hbTimer = setInterval(() => {
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
              browser_user_agent: UA,
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

      if (op === 9) { clearTimeout(timeout); finish([], [], 'invalid session — token inválido ou sessão expirada'); }

      if (op === 0 && t === "READY") {
        clearTimeout(timeout);
        const keys = Object.keys(d || {});
        console.log("[QuestAuto/gateway READY keys]", keys.join(", "));
        const quests = extractFromPacket(d);
        console.log(`[QuestAuto/gateway] ${quests.length} quest(s) no READY`);
        // Log all quest-related keys that have data
        for (const k of QUEST_KEYS) {
          if (d[k] !== undefined) console.log(`[QuestAuto/gateway] READY.${k} =`, JSON.stringify(d[k]).slice(0, 300));
        }
        finish(quests, keys);
      }

      if (op === 0 && t === "READY_SUPPLEMENTAL") {
        const quests = extractFromPacket(d);
        if (quests.length) {
          console.log(`[QuestAuto/gateway] ${quests.length} quest(s) no READY_SUPPLEMENTAL`);
          clearTimeout(timeout);
          finish(quests, _state._readyKeys);
        }
      }
    });
  });
}

export async function fetchQuests(token) {
  const debug = [];

  // 1. Try REST endpoints first (fast)
  const restEndpoints = [
    { base: API,     path: '/users/@me/quests?with_unredeemed=true&with_combined_components=true' },
    { base: API_V10, path: '/users/@me/quests?with_unredeemed=true&with_combined_components=true' },
    { base: API,     path: '/users/@me/promotions' },
  ];

  for (const { base, path } of restEndpoints) {
    try {
      const { status, body, raw } = await dfetch(token, path, 'GET', null, base);
      const label = base.replace('https://discord.com/api/', '') + path.split('?')[0];
      debug.push({ label, status, preview: raw.slice(0, 200) });
      console.log(`[QuestAuto/REST] ${label} → ${status} ${raw.slice(0, 80)}`);
      if (status === 401) throw new Error('Token inválido ou sessão expirada.');
      if (status === 200) {
        const list = extractFromPacket(body);
        if (list.length) { _state._debugFetch = debug; return list; }
      }
    } catch (e) {
      if (e.message.includes('inválido') || e.message.includes('expirada')) throw e;
    }
  }

  // 2. Fallback: connect to Gateway briefly to read READY event
  console.log("[QuestAuto] REST vazio — tentando via Gateway...");
  debug.push({ label: 'gateway/READY', status: '...', preview: 'Conectando ao Gateway...' });
  _state._debugFetch = debug;

  const { quests, readyKeys, error } = await fetchQuestsViaGateway(token);
  _state._readyKeys = readyKeys;

  const gwIdx = debug.findIndex(d => d.label === 'gateway/READY');
  if (gwIdx !== -1) {
    debug[gwIdx].status = error ? 'ERR' : 200;
    debug[gwIdx].preview = error
      ? `Erro: ${error}`
      : `READY keys: [${readyKeys.join(', ')}] — ${quests.length} quest(s) encontrada(s)`;
  }
  _state._debugFetch = debug;

  if (error && error.includes('inválido')) throw new Error(error);
  return quests;
}

export function getDebugFetch() {
  return _state._debugFetch || [];
}

async function enrollQuest(token, questId) {
  const { status } = await dfetch(token, `/quests/${questId}/enroll`, 'POST', {});
  return status < 400 || status === 409;
}

async function claimReward(token, questId) {
  const { status } = await dfetch(token, `/quests/${questId}/claim-reward`, 'POST', {
    platform: 0, location: 11, is_targeted: false,
    metadata_raw: null, metadata_sealed: null,
    traffic_metadata_raw: null, traffic_metadata_sealed: null,
  });
  return status < 400;
}

async function doVideoQuest(token, questId) {
  let ts = 0.0;
  while (ts < 1.0 && !_state._stopFlag) {
    ts = Math.min(1.0, ts + 0.006 + Math.random() * 0.002);
    const payload = { timestamp: parseFloat(ts.toFixed(6)) };
    const { status, body } = await dfetch(token, `/quests/${questId}/video-progress`, 'POST', payload);
    if (status === 429) {
      const wait = ((body?.retry_after || 5) * 1000) + rand(200, 800);
      addLog(`Rate limit — aguardando ${Math.round(wait / 1000)}s...`, 'warn');
      await sleep(wait);
      continue;
    }
    if (status >= 500) { await sleep(3000); continue; }
    if (status >= 400) throw new Error(`Erro ${status} em video-progress`);
    if (body?.completed_at) return true;
    await sleep(rand(7000, 9500));
  }
  return ts >= 1.0;
}

async function doHeartbeatQuest(token, questId) {
  const streamKey = randomUUID();
  let ticks = 0;
  while (ticks < 90 && !_state._stopFlag) {
    const { status, body } = await dfetch(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey });
    if (status === 429) {
      const wait = ((body?.retry_after || 5) * 1000) + rand(200, 800);
      addLog(`Rate limit — aguardando ${Math.round(wait / 1000)}s...`, 'warn');
      await sleep(wait);
      continue;
    }
    if (status >= 500) { await sleep(5000); continue; }
    if (status >= 400) throw new Error(`Erro ${status} em heartbeat`);
    if (body?.completed_at) return true;
    ticks++;
    await sleep(rand(19000, 22000));
  }
  return false;
}

export function stopAuto() {
  _state._stopFlag = true;
  _state.running = false;
  _state.currentQuest = null;
  addLog('Automação interrompida pelo usuário.');
}

export function getAutoStatus() {
  return {
    running: _state.running,
    currentQuest: _state.currentQuest,
    quests: _state.quests,
    log: _state.log.slice(0, 40),
  };
}

export async function runAuto(token, questIds = [], { autoEnroll = true, autoClaim = true } = {}) {
  if (_state.running) throw new Error('Automação já em andamento.');
  _state = { running: true, log: [], quests: [], currentQuest: null, _stopFlag: false, _debugFetch: _state._debugFetch, _readyKeys: _state._readyKeys };

  (async () => {
    try {
      addLog('Buscando missões no Discord...');
      let all = await fetchQuests(token);

      // If questIds provided as manual entries (no config), build minimal quest objects
      if (questIds.length && !all.length) {
        all = questIds.map(id => ({
          id, quest_id: id,
          config: { application_name: `Quest ${id}`, task_config: { WATCH_VIDEO: { target_minutes: 15 } } },
          user_status: null,
        }));
      }

      if (!all.length) {
        addLog('Nenhuma missão encontrada. Use o campo "ID Manual" para adicionar manualmente.', 'warn');
        _state.running = false;
        return;
      }

      const pool = questIds.length ? all.filter(q => questIds.includes(q.id || q.quest_id)) : all;
      const pending = pool.filter(q => !q.user_status?.completed_at);

      if (!pending.length) {
        addLog('Todas as missões já estão concluídas!', 'warn');
        _state.running = false;
        return;
      }

      _state.quests = pending.map(q => {
        const taskType = Object.keys(q.config?.task_config || {})[0] || 'WATCH_VIDEO';
        return { id: q.id || q.quest_id, name: q.config?.application_name || 'Missão', type: taskType, status: 'pending' };
      });

      addLog(`${pending.length} missão(ões) para completar.`);

      for (const q of pending) {
        if (_state._stopFlag) break;
        const qid = q.id || q.quest_id;
        const name = q.config?.application_name || qid;
        const taskType = Object.keys(q.config?.task_config || {})[0] || 'WATCH_VIDEO';
        const qi = _state.quests.find(x => x.id === qid);

        _state.currentQuest = { id: qid, name, type: taskType };
        if (qi) qi.status = 'running';

        if (!q.user_status && autoEnroll) {
          addLog(`Inscrevendo em "${name}"...`);
          const ok = await enrollQuest(token, qid);
          addLog(ok ? `Inscrito em "${name}".` : `Inscrição não confirmada, continuando...`, ok ? 'info' : 'warn');
          await sleep(rand(1200, 2000));
        }

        addLog(`Completando "${name}" [${taskType}]...`);
        let completed = false;
        try {
          completed = taskType === 'WATCH_VIDEO'
            ? await doVideoQuest(token, qid)
            : await doHeartbeatQuest(token, qid);

          if (completed) {
            addLog(`✓ "${name}" concluída!`, 'success');
            if (qi) qi.status = 'done';
            if (autoClaim) {
              await sleep(rand(800, 1800));
              const ok = await claimReward(token, qid);
              addLog(ok ? `Recompensa de "${name}" resgatada!` : `Falha ao resgatar recompensa.`, ok ? 'success' : 'warn');
            }
          } else {
            if (!_state._stopFlag) addLog(`"${name}" não completada.`, 'warn');
            if (qi) qi.status = 'failed';
          }
        } catch (e) {
          addLog(`Erro em "${name}": ${e.message}`, 'error');
          if (qi) qi.status = 'error';
        }

        if (!_state._stopFlag) await sleep(rand(2000, 4000));
      }

      if (!_state._stopFlag) addLog('Automação concluída.', 'success');
    } catch (e) {
      addLog(`Erro fatal: ${e.message}`, 'error');
    } finally {
      _state.running = false;
      _state.currentQuest = null;
    }
  })();
}
