"use strict";

// ─── STAR CANVAS ─────────────────────────────────────────────────────────
(function initStars() {
  const canvas = document.getElementById("star-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let W, H, stars = [];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function mkStar() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.4 + 0.2,
      speed: Math.random() * 0.12 + 0.02,
      opacity: Math.random(),
      opDir: Math.random() > 0.5 ? 1 : -1,
      opSpeed: Math.random() * 0.008 + 0.002,
      hue: Math.random() > 0.85 ? 280 : (Math.random() > 0.7 ? 240 : 0),
    };
  }

  function init() {
    resize();
    stars = Array.from({ length: 260 }, mkStar);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.opacity += s.opDir * s.opSpeed;
      if (s.opacity >= 1) { s.opacity = 1; s.opDir = -1; }
      if (s.opacity <= 0.05) { s.opacity = 0.05; s.opDir = 1; }
      s.y -= s.speed;
      if (s.y < -2) { s.y = H + 2; s.x = Math.random() * W; }

      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      if (s.hue) {
        ctx.fillStyle = `hsla(${s.hue},80%,75%,${s.opacity})`;
      } else {
        ctx.fillStyle = `rgba(255,255,255,${s.opacity})`;
      }
      ctx.fill();

      if (s.r > 1) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
        ctx.fillStyle = s.hue
          ? `hsla(${s.hue},80%,75%,${s.opacity * 0.08})`
          : `rgba(255,255,255,${s.opacity * 0.06})`;
        ctx.fill();
      }
    }
    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  init();
  draw();
})();

// ─── STATE ───────────────────────────────────────────────────────────────
const state = {
  user: null,
  activeTab: "overview",
  sessions: [],
  modGuilds: [],
  modSelectedGuildId: null,
  modMembers: [],
  modSelectedIds: new Set(),
  modToken: "",
  cloneGuilds: [],
  cloneSourceId: "",
  cloneTargetId: "",
  purgedCount: 0,
  questsCompleted: 0,
  globalToken: "",
  globalUser: null,
};

// ─── INIT ─────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  wireAuth();
  wireNav();
  wireTogglePw();
  wireGlobalToken();

  const me = await api("/api/auth/me");
  if (me?.user) {
    state.user = me.user;
    enterApp();
  }
});

// ─── AUTH ─────────────────────────────────────────────────────────────────
function wireAuth() {
  $("auth-login").querySelectorAll("input").forEach((el) =>
    el.addEventListener("keydown", (e) => e.key === "Enter" && doLogin())
  );
  $("auth-register").querySelectorAll("input").forEach((el) =>
    el.addEventListener("keydown", (e) => e.key === "Enter" && doRegister())
  );

  document.querySelectorAll(".auth-tab").forEach((btn) =>
    btn.addEventListener("click", () => switchAuthTab(btn.dataset.tab))
  );

  $("btn-login").addEventListener("click", doLogin);
  $("btn-register").addEventListener("click", doRegister);
  $("btn-logout").addEventListener("click", doLogout);
}

function switchAuthTab(tab) {
  document.querySelectorAll(".auth-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("auth-login").classList.toggle("hidden", tab !== "login");
  $("auth-register").classList.toggle("hidden", tab !== "register");
}

async function doLogin() {
  const btn = $("btn-login");
  const errEl = $("login-error");
  errEl.textContent = "";
  const username = $("login-username").value.trim();
  const password = $("login-password").value;
  if (!username || !password) { errEl.textContent = "Preencha usuário e senha."; return; }
  setLoading(btn, true);
  const res = await api("/api/auth/login", { username, password });
  setLoading(btn, false);
  if (res.error) { errEl.textContent = res.error; return; }
  state.user = res.user;
  enterApp();
}

async function doRegister() {
  const btn = $("btn-register");
  const errEl = $("register-error");
  const infoEl = $("register-info");
  errEl.textContent = "";
  infoEl.classList.add("hidden");
  const username = $("reg-username").value.trim();
  const password = $("reg-password").value;
  if (!username || !password) { errEl.textContent = "Preencha todos os campos."; return; }
  setLoading(btn, true);
  const res = await api("/api/auth/register", { username, password });
  setLoading(btn, false);
  if (res.error) { errEl.textContent = res.error; return; }
  if (res.pendingApproval) {
    infoEl.textContent = res.message || "Aguarde aprovação do administrador.";
    infoEl.classList.remove("hidden");
    return;
  }
  state.user = res.user;
  enterApp();
}

async function doLogout() {
  await api("/api/auth/logout", {});
  state.user = null;
  $("app-screen").classList.add("hidden");
  $("auth-screen").classList.remove("hidden");
}

// ─── APP ENTER ────────────────────────────────────────────────────────────
function enterApp() {
  $("auth-screen").classList.add("hidden");
  $("app-screen").classList.remove("hidden");
  renderSidebarProfile();
  switchTab("overview");
  refreshStatus();
}

function renderSidebarProfile() {
  const u = state.user;
  if (!u) return;
  $("sb-name").textContent = u.username || "—";
  $("sb-role").textContent = u.role === "owner" ? "Owner" : "Membro";
  const av = $("sb-avatar");
  av.textContent = initials(u.username);
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────
function wireNav() {
  document.querySelectorAll(".nav-btn[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".nav-btn[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  document.querySelectorAll(".tab-section").forEach((s) =>
    s.classList.toggle("active", s.id === `tab-${tab}`)
  );

  if (tab === "overview") refreshStatus();
  if (tab === "call") { wireCall(); refreshCallSessions(); }
  if (tab === "clone") { wireClone(); syncGlobalTokenToTab("clone-token"); }
  if (tab === "orbs-auto") { wireOrbsAuto(); }
  if (tab === "moderation") { wireMod(); syncGlobalTokenToTab("mod-token"); }
  if (tab === "investigate") wireInvestigate();
  if (tab === "nuke") { wireNuke(); syncGlobalTokenToTab("nuke-token"); }
  if (tab === "logs") wireLogs();
  if (tab === "history") { wireHistory(); loadQuestHistory(); }
}

// ─── PASSWORD TOGGLE ──────────────────────────────────────────────────────
function wireTogglePw() {
  document.querySelectorAll(".btn-toggle-pw").forEach((btn) => {
    btn.addEventListener("click", () => {
      const inp = $(btn.dataset.target);
      if (!inp) return;
      inp.type = inp.type === "password" ? "text" : "password";
    });
  });
}

// ─── GLOBAL TOKEN ─────────────────────────────────────────────────────────
function wireGlobalToken() {
  $("btn-global-token-save").addEventListener("click", saveGlobalToken);
  $("global-token").addEventListener("keydown", (e) => e.key === "Enter" && saveGlobalToken());
}

async function saveGlobalToken() {
  const token = $("global-token").value.trim();
  if (!token) return;
  const btn = $("btn-global-token-save");
  btn.disabled = true;
  const res = await api("/api/discord/validate-token", { token });
  btn.disabled = false;
  if (res.error) {
    $("global-token-info").classList.add("hidden");
    return;
  }
  state.globalToken = token;
  state.globalUser = res.user;
  renderGlobalTokenInfo(res.user);
  renderOverview();
}

function renderGlobalTokenInfo(user) {
  if (!user) return;
  const avEl = $("global-token-avatar");
  avEl.innerHTML = "";
  renderAvatar(avEl, user.id, user.avatar, user.username, 22);
  const tag = user.global_name || user.username;
  $("global-token-name").textContent = tag;
  $("global-token-info").classList.remove("hidden");
}

function syncGlobalTokenToTab(inputId) {
  if (!state.globalToken) return;
  const el = $(inputId);
  if (el && !el.value.trim()) el.value = state.globalToken;
}

// ─── STATUS / OVERVIEW ────────────────────────────────────────────────────
async function refreshStatus() {
  const res = await api("/api/status", undefined, "GET");
  if (!res) return;
  state.sessions = res.sessions || [];
  renderOverview();
  renderCallSessions();
}

function renderOverview() {
  const inCall = state.sessions.filter((s) => s.inCall).length;
  const total = state.sessions.length;
  $("ov-sessions").textContent = inCall;
  $("ov-tokens").textContent = total;
  $("ov-purged").textContent = state.purgedCount;
  $("ov-quests").textContent = state.questsCompleted;
  renderSessionList($("ov-session-list"), state.sessions);

  const card = $("ov-account-card");
  const profileEl = $("ov-account-profile");
  if (state.globalUser) {
    card.classList.remove("hidden");
    renderDiscordAccountProfile(profileEl, state.globalUser);
  } else {
    card.classList.add("hidden");
  }
}

function renderDiscordAccountProfile(container, user) {
  const tag = user.discriminator && user.discriminator !== "0"
    ? `${user.username}#${user.discriminator}` : (user.global_name || user.username);

  const snowflakeMs = (BigInt(user.id) >> 22n) + 1420070400000n;
  const createdAt = new Date(Number(snowflakeMs));
  const ageDays = Math.floor((Date.now() - createdAt.getTime()) / 86400000);
  const createdStr = createdAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

  const premiumLabels = { 0: "Sem Nitro", 1: "Nitro Classic", 2: "Nitro", 3: "Nitro Basic" };
  const premiumLabel = premiumLabels[user.premium_type || 0] || "Sem Nitro";
  const nitroColor = user.premium_type ? "var(--purple-bright)" : "var(--text-muted)";

  const flagNames = {
    1: "Discord Staff", 2: "Parceiro", 4: "HypeSquad Events", 8: "Bug Hunter Nv1",
    64: "HypeSquad Bravery", 128: "HypeSquad Brilliance", 256: "HypeSquad Balance",
    512: "Apoiador Antigo", 16384: "Bug Hunter Nv2", 131072: "Verificado Bot Dev",
    4194304: "Moderador Ativo",
  };
  const flags = user.public_flags || 0;
  const badges = Object.entries(flagNames).filter(([bit]) => flags & Number(bit)).map(([, name]) => name);

  container.innerHTML = `
    <div class="dc-profile">
      <div class="dc-profile-left">
        <div class="dc-avatar-wrap">
          <div id="dc-av-slot" class="dc-avatar dc-avatar-fallback">${esc(initials(tag))}</div>
        </div>
        <div class="dc-profile-info">
          <div class="dc-username">${esc(tag)}</div>
          <div class="dc-id">ID: <span class="dc-id-val">${esc(user.id)}</span></div>
          <div class="dc-meta-row">
            <span class="dc-meta-item">Criado: ${esc(createdStr)} <span style="color:var(--text-muted)">(${ageDays} dias)</span></span>
            <span class="dc-badge" style="color:${nitroColor};border-color:${nitroColor}40">${esc(premiumLabel)}</span>
          </div>
          ${badges.length ? `<div class="dc-badges-row">${badges.map((b) => `<span class="dc-badge">${esc(b)}</span>`).join("")}</div>` : ""}
        </div>
      </div>
    </div>`;

  // Injeta avatar via DOM (evita problema de escaping/GIF no Electron)
  if (user.avatar) {
    const slot = container.querySelector("#dc-av-slot");
    if (slot) {
      const img = document.createElement("img");
      img.className = "dc-avatar";
      img.alt = tag;
      img.src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
      img.onerror = () => { slot.parentNode.replaceChild(slot, img); };
      slot.parentNode.replaceChild(img, slot);
    }
  }
}

function renderSessionList(container, sessions) {
  if (!container) return;
  if (!sessions?.length) {
    container.className = "session-list empty-hint";
    container.textContent = "Nenhuma sessão ativa.";
    return;
  }
  container.className = "session-list";
  container.innerHTML = "";
  sessions.forEach((s) => {
    const card = document.createElement("div");
    card.className = "session-card";
    const av = document.createElement("div");
    av.className = "session-avatar";
    av.textContent = initials(s.tag);
    card.appendChild(av);
    const info = document.createElement("div");
    info.innerHTML = `<div class="session-tag">${esc(s.tag || "—")}</div>
      <div class="session-meta">${esc(s.guildName || "—")} › ${esc(s.channelName || "—")}</div>`;
    card.appendChild(info);
    const badge = document.createElement("span");
    badge.className = `session-badge ${s.inCall ? "badge-call" : "badge-idle"}`;
    badge.textContent = s.inCall ? "Na Call" : "Ocioso";
    card.appendChild(badge);
    container.appendChild(card);
  });
}

$("btn-refresh-status") && $("btn-refresh-status").addEventListener("click", refreshStatus);

// ─── CALL ─────────────────────────────────────────────────────────────────
let callWired = false;
function wireCall() {
  if (callWired) return;
  callWired = true;

  $("btn-identify").addEventListener("click", doIdentify);
  $("btn-call-join").addEventListener("click", doJoinCall);
  $("btn-call-stop").addEventListener("click", doStopAll);
  $("btn-call-refresh").addEventListener("click", refreshCallSessions);
}

async function doIdentify() {
  const raw = $("call-tokens").value.trim();
  const tokens = raw.split("\n").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return;
  const btn = $("btn-identify");
  setLoading(btn, true);
  const res = await api("/api/identify", { tokens });
  setLoading(btn, false);
  if (res.error) { showResult($("identify-results"), res.error, "err"); return; }
  renderIdentifyResults(res.results || []);
}

function renderIdentifyResults(results) {
  const container = $("identify-results");
  container.innerHTML = "";
  container.className = "identify-list mt-2";
  results.forEach((r) => {
    const card = document.createElement("div");
    card.className = `identify-card ${r.ok ? "ok-card" : "err-card"}`;
    if (r.ok) {
      card.innerHTML = `<div class="id-tag">${esc(r.tag)}</div><span class="id-badge">${esc(r.id || "")}</span>`;
    } else {
      card.innerHTML = `<div class="id-tag" style="color:var(--text-muted)">${esc(r.token.slice(0, 12))}...</div>
        <div class="id-error">${esc(r.error || "Falha")}</div>`;
    }
    container.appendChild(card);
  });
}

async function doJoinCall() {
  const raw = $("call-tokens").value.trim();
  const tokens = raw.split("\n").map((t) => t.trim()).filter(Boolean);
  const guildId = $("call-guild").value.trim();
  const channelId = $("call-channel").value.trim();
  const resEl = $("call-result");
  if (!tokens.length || !guildId || !channelId) {
    showResult(resEl, "Preencha tokens, ID do servidor e ID do canal.", "err"); return;
  }
  const btn = $("btn-call-join");
  setLoading(btn, true);
  hideResult(resEl);
  const res = await api("/api/call/join", { tokens, guildId, channelId });
  setLoading(btn, false);
  if (res.error) { showResult(resEl, res.error, "err"); return; }
  const ok = (res.results || []).filter((r) => r.ok).length;
  const fail = (res.results || []).filter((r) => !r.ok).length;
  showResult(resEl, `${ok} conta(s) entrou na call. ${fail ? fail + " falha(s)." : ""}`, ok ? "ok" : "err");
  await refreshStatus();
  renderCallSessions();
}

async function doStopAll() {
  setLoading($("btn-call-stop"), true);
  await api("/api/stop", {});
  setLoading($("btn-call-stop"), false);
  await refreshStatus();
  renderCallSessions();
}

function refreshCallSessions() {
  renderSessionList($("call-session-list"), state.sessions);
}

// ─── CLONE ────────────────────────────────────────────────────────────────
let cloneWired = false;
function wireClone() {
  if (cloneWired) return;
  cloneWired = true;

  $("btn-clone-load-guilds").addEventListener("click", loadCloneGuilds);
  $("btn-clone-run").addEventListener("click", doClone);
}

async function loadCloneGuilds() {
  const token = $("clone-token").value.trim();
  if (!token) { showResult($("clone-result"), "Insira um token primeiro.", "err"); return; }
  const btn = $("btn-clone-load-guilds");
  setLoading(btn, true);
  const res = await api("/api/moderation/guilds", { token });
  setLoading(btn, false);
  if (res.error) { showResult($("clone-result"), res.error, "err"); return; }
  state.cloneGuilds = res.guilds || [];
  renderCloneGuilds(state.cloneGuilds);
}

function renderCloneGuilds(guilds) {
  const container = $("clone-guild-list");
  if (!guilds.length) {
    container.className = "guild-grid empty-hint";
    container.textContent = "Nenhum servidor encontrado.";
    return;
  }
  container.className = "guild-grid";
  container.innerHTML = "";
  guilds.forEach((g) => {
    const card = document.createElement("div");
    card.className = "guild-card";
    const iconEl = document.createElement("div");
    iconEl.className = "guild-icon";
    if (g.icon) {
      const img = document.createElement("img");
      img.src = g.icon; img.alt = g.name;
      img.onerror = () => { iconEl.textContent = initials(g.name); };
      iconEl.appendChild(img);
    } else {
      iconEl.textContent = initials(g.name);
    }
    card.innerHTML = `<div class="guild-card-head">
      ${iconEl.outerHTML}
      <div><div class="guild-name">${esc(g.name)}</div><div class="guild-id">${esc(g.id)}</div></div>
    </div>
    <div class="guild-card-btns">
      <button class="guild-btn" data-gid="${esc(g.id)}" data-role="source">Origem</button>
      <button class="guild-btn" data-gid="${esc(g.id)}" data-role="target">Destino</button>
    </div>`;
    container.appendChild(card);

    card.querySelectorAll(".guild-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const role = btn.dataset.role;
        if (role === "source") {
          state.cloneSourceId = btn.dataset.gid;
          $("clone-source").value = btn.dataset.gid;
          container.querySelectorAll(".guild-btn.selected-source").forEach((b) => b.classList.remove("selected-source"));
          btn.classList.add("selected-source");
        } else {
          state.cloneTargetId = btn.dataset.gid;
          $("clone-target").value = btn.dataset.gid;
          container.querySelectorAll(".guild-btn.selected-target").forEach((b) => b.classList.remove("selected-target"));
          btn.classList.add("selected-target");
        }
      });
    });
  });
}

async function doClone() {
  const token = $("clone-token").value.trim();
  const sourceGuildId = $("clone-source").value.trim();
  const targetGuildId = $("clone-target").value.trim();
  const resEl = $("clone-result");
  if (!token || !sourceGuildId || !targetGuildId) {
    showResult(resEl, "Token, origem e destino são obrigatórios.", "err"); return;
  }
  if (sourceGuildId === targetGuildId) { showResult(resEl, "Origem e destino não podem ser iguais.", "err"); return; }
  const btn = $("btn-clone-run");
  setLoading(btn, true);
  hideResult(resEl);
  const res = await api("/api/clone/run", {
    token, sourceGuildId, targetGuildId,
    includeRoles: $("clone-roles").checked,
    includeChannels: $("clone-channels").checked,
  });
  setLoading(btn, false);
  if (res.error) { showResult(resEl, res.error, "err"); return; }
  showResult(resEl,
    `Clonagem concluída! Cargos: ${res.roles?.created || 0} criados, ${res.roles?.reused || 0} reutilizados. ` +
    `Canais: ${res.channels?.created || 0} criados.`,
    "ok"
  );
}

// ─── ORBS-AUTO ────────────────────────────────────────────────────────────
let qaWired = false;

function wireOrbsAuto() {
  if (qaWired) return;
  qaWired = true;

  // Plugin BetterDiscord
  bdCheckStatus();
  $("btn-discord-inject").addEventListener("click", bdCopyPlugin);

  // Start / Stop
  $("btn-orion-start").addEventListener("click", orionStart);
  $("btn-orion-stop").addEventListener("click", orionStop);

  // Poll live progress every 2s
  setInterval(orionLivePoll, 2000);
  orionLivePoll();
}

async function orionStart() {
  const btn = $("btn-orion-start");
  btn.disabled = true;
  try {
    await api("/api/orion/command", { command: "start" });
    $("btn-orion-stop").disabled = false;
    const badge = $("orion-ctrl-badge");
    badge.className = "status-badge status-on"; badge.textContent = "Rodando";
    showResult($("orion-ctrl-result"), "Comando enviado! O Discord vai iniciar as missões em ~2 segundos.", "ok");
  } catch (e) {
    showResult($("orion-ctrl-result"), e.message, "err");
    btn.disabled = false;
  }
}

async function orionStop() {
  try {
    await api("/api/orion/command", { command: "stop" });
    $("btn-orion-start").disabled = false;
    $("btn-orion-stop").disabled = true;
    const badge = $("orion-ctrl-badge");
    badge.className = "status-badge status-off"; badge.textContent = "Parado";
    showResult($("orion-ctrl-result"), "Parado.", "ok");
  } catch (e) {
    showResult($("orion-ctrl-result"), e.message, "err");
  }
}

function _fmtTime(sec) {
  if (sec <= 0) return "concluindo...";
  if (sec < 60) return `~${Math.ceil(sec)}s`;
  return `~${Math.ceil(sec / 60)}min`;
}

async function orionLivePoll() {
  try {
    const d = await api("/api/orion/live");
    const liveBadge   = $("orion-live-badge");
    const bridgeBadge = $("orion-bridge-badge");
    const hint        = $("orion-live-hint");
    const tasks       = $("orion-live-tasks");
    const done        = $("orion-live-done");
    const summary     = $("orion-summary");
    if (!liveBadge) return;

    // Bridge connection indicator
    if (bridgeBadge) {
      if (d.bridgeConnected) {
        bridgeBadge.className = "status-badge status-on";
        bridgeBadge.textContent = "Conectada";
        bridgeBadge.style.fontSize = ".7rem";
      } else {
        bridgeBadge.className = "status-badge status-off";
        bridgeBadge.textContent = "Não detectada";
        bridgeBadge.style.fontSize = ".7rem";
      }
    }

    const taskList  = Object.values(d.tasks || {});
    const total     = d.questList?.length || taskList.length;
    const completed = taskList.filter(t => t.status === "COMPLETED" || t.status === "CLAIMED").length;
    const active    = taskList.filter(t => t.status === "RUNNING").length;

    if (summary && total > 0) {
      summary.style.display = "";
      $("orion-sum-total").textContent = total;
      $("orion-sum-done").textContent  = completed;
      $("orion-sum-active").textContent = active;
    }

    if (d.error) {
      liveBadge.className = "status-badge status-off"; liveBadge.textContent = "Erro";
      hint.style.display = ""; hint.textContent = `Erro: ${d.error}`;
      tasks.innerHTML = ""; done.style.display = "none";
      $("btn-orion-start").disabled = false;
      $("btn-orion-stop").disabled = true;
      const cb2 = $("orion-ctrl-badge"); cb2.className = "status-badge status-off"; cb2.textContent = "Parado";
    } else if (d.allDone) {
      liveBadge.className = "status-badge status-on"; liveBadge.textContent = "Concluído";
      hint.style.display = "none"; tasks.innerHTML = "";
      done.style.display = "flex";
      const elapsed = d.startedAt ? Math.round((Date.now() - d.startedAt) / 1000) : 0;
      const el = $("orion-done-time");
      if (el && elapsed > 0) el.textContent = `Concluído em ${_fmtTime(elapsed).replace("~", "")}`;
      $("btn-orion-start").disabled = false;
      $("btn-orion-stop").disabled  = true;
      const cb = $("orion-ctrl-badge"); cb.className = "status-badge status-off"; cb.textContent = "Parado";
    } else if (d.noQuests) {
      liveBadge.className = "status-badge status-off"; liveBadge.textContent = "Sem missões";
      hint.style.display = ""; hint.textContent = "Nenhuma missão ativa no momento.";
      tasks.innerHTML = ""; done.style.display = "none";
    } else if (taskList.length) {
      liveBadge.className = "status-badge status-on"; liveBadge.textContent = "Rodando";
      hint.style.display = "none"; done.style.display = "none";
      tasks.innerHTML = taskList.map(t => {
        const pct = t.max > 0 ? Math.min(100, Math.round((t.cur / t.max) * 100)) : 0;
        const isDone   = t.status === "COMPLETED" || t.status === "CLAIMED";
        const isFailed = t.status === "FAILED";
        const color    = isDone ? "#3BA55C" : isFailed ? "#f04747" : "#5865F2";
        const remaining = t.max > 0 && t.cur < t.max ? (t.taskType === "VIDEO" ? t.max - t.cur : (t.max - t.cur) * 60) : 0;
        const timeStr  = isDone ? "Concluída" : isFailed ? "Falhou" : _fmtTime(remaining);
        const progStr  = t.taskType === "VIDEO" ? `${Math.floor(t.cur)}s / ${t.max}s` : `${Math.round(t.cur)} / ${t.max} min`;
        return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
            <span style="font-size:.64rem;font-weight:700;background:${color}22;color:${color};border:1px solid ${color}44;border-radius:4px;padding:1px 6px;flex-shrink:0">${t.taskType || "?"}</span>
            <span style="font-size:.8rem;font-weight:700;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.name || t.id}</span>
          </div>
          <div style="height:7px;background:var(--bg2);border-radius:4px;overflow:hidden;margin-bottom:5px">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width .5s ease"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:.71rem;color:var(--text-muted)">
            <span>${progStr} &nbsp;(${pct}%)</span>
            <span style="color:${color};font-weight:600">${timeStr}</span>
          </div>
        </div>`;
      }).join("");
    } else {
      liveBadge.className = "status-badge status-off"; liveBadge.textContent = "Aguardando";
      hint.style.display = "";
      hint.textContent = d.bridgeConnected
        ? "Bridge conectada — clique em Iniciar Missões."
        : "Bridge não detectada — injete e reinicie o Discord.";
      tasks.innerHTML = ""; done.style.display = "none";
    }
  } catch (_) {}
}

async function bdCheckStatus() {
  try {
    const data = await api("/api/discord/plugin-status");
    const icon  = $("inject-status-icon");
    const title = $("inject-status-title");
    const desc  = $("inject-status-desc");
    const btn   = $("btn-discord-inject");
    if (!icon) return;

    if (!data.bdInstalled) {
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#f04747" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
      title.textContent = "BetterDiscord não encontrado";
      desc.textContent = "Instale em betterdiscord.app e reabra o app.";
      if (btn) btn.disabled = true;
    } else if (data.pluginInstalled) {
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#3BA55C" stroke-width="2.5" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>`;
      title.textContent = "Plugin instalado";
      desc.textContent = "OrionQuests está na pasta do BetterDiscord. Ative-o em Discord → Configurações → Plugins.";
      if (btn) btn.disabled = false;
    } else {
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#faa61a" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
      title.textContent = "BetterDiscord detectado — plugin não instalado";
      desc.textContent = "Clique em Instalar para copiar o plugin automaticamente.";
      if (btn) btn.disabled = false;
    }
  } catch (_) {}
}

async function bdCopyPlugin() {
  const btn = $("btn-discord-inject");
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg> Instalando...`;
  try {
    const data = await api("/api/discord/copy-plugin", {}, "POST");
    if (data.ok) {
      showResult($("inject-result"), "Plugin copiado! Vá em Discord → Configurações → Plugins e ative OrionQuests.", "ok");
      bdCheckStatus();
    } else {
      showResult($("inject-result"), data.error || "Erro ao instalar.", "err");
    }
  } catch (e) {
    showResult($("inject-result"), e.message, "err");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}


// ─── MODERATION ───────────────────────────────────────────────────────────
let modWired = false;
function wireMod() {
  if (modWired) return;
  modWired = true;

  $("btn-mod-load-guilds").addEventListener("click", loadModGuilds);
  $("btn-select-all").addEventListener("click", () => {
    state.modMembers.forEach((m) => state.modSelectedIds.add(m.id));
    updateMemberSelection();
  });
  $("btn-deselect-all").addEventListener("click", () => {
    state.modSelectedIds.clear();
    updateMemberSelection();
  });
  $("mod-search").addEventListener("input", filterMembers);
  document.querySelectorAll(".action-btn[data-action]").forEach((btn) =>
    btn.addEventListener("click", () => doModAction(btn.dataset.action))
  );
}

async function loadModGuilds() {
  const token = $("mod-token").value.trim();
  const resEl = $("mod-action-result");
  if (!token) { showResult(resEl, "Insira um token primeiro.", "err"); return; }
  state.modToken = token;
  const btn = $("btn-mod-load-guilds");
  setLoading(btn, true);
  const res = await api("/api/moderation/guilds", { token });
  setLoading(btn, false);
  if (res.error) { showResult(resEl, res.error, "err"); return; }
  state.modGuilds = res.guilds || [];
  renderModGuilds(state.modGuilds);
}

function renderModGuilds(guilds) {
  const container = $("mod-guild-list");
  if (!guilds.length) {
    container.className = "guild-grid empty-hint";
    container.textContent = "Nenhum servidor encontrado.";
    return;
  }
  container.className = "guild-grid";
  container.innerHTML = "";
  guilds.forEach((g) => {
    const card = document.createElement("div");
    card.className = "guild-card";
    const iconHtml = g.icon
      ? `<div class="guild-icon"><img src="${esc(g.icon)}" alt="${esc(g.name)}" onerror="this.parentNode.textContent='${esc(initials(g.name))}'"/></div>`
      : `<div class="guild-icon">${esc(initials(g.name))}</div>`;
    card.innerHTML = `<div class="guild-card-head">
      ${iconHtml}
      <div><div class="guild-name">${esc(g.name)}</div><div class="guild-id">${esc(g.id)}</div></div>
    </div>
    <div class="guild-card-btns">
      <button class="guild-btn" data-gid="${esc(g.id)}">Abrir</button>
    </div>`;
    card.querySelector(".guild-btn").addEventListener("click", () => loadModSnapshot(g.id, g.name));
    container.appendChild(card);
  });
}

async function loadModSnapshot(guildId, guildName) {
  state.modSelectedGuildId = guildId;
  state.modSelectedIds.clear();
  $("mod-snapshot-wrap").classList.remove("hidden");
  $("mod-snapshot-title").textContent = guildName || guildId;
  const memberList = $("mod-member-list");
  memberList.innerHTML = "<div style='color:var(--text-muted);padding:12px'>Carregando membros...</div>";

  const res = await api("/api/moderation/snapshot", { token: state.modToken, guildId });
  if (res.error) {
    memberList.innerHTML = `<div style="color:var(--red)">${esc(res.error)}</div>`;
    return;
  }
  state.modMembers = res.members || [];
  $("mod-snapshot-sub").textContent = `${state.modMembers.length} membros carregados`;
  renderModMembers(state.modMembers);
}

function renderModMembers(members) {
  const container = $("mod-member-list");
  container.innerHTML = "";
  members.forEach((m) => {
    const card = document.createElement("div");
    card.className = `member-card${state.modSelectedIds.has(m.id) ? " selected" : ""}`;
    card.dataset.id = m.id;

    const av = document.createElement("div");
    av.className = "member-av";
    renderAvatar(av, m.id, m.avatar?.split("/avatars/")[1]?.split(".")[0], m.tag, 32);

    card.innerHTML = `<div class="member-check"></div>`;
    card.appendChild(av);
    const info = document.createElement("div");
    info.innerHTML = `<div class="member-name">${esc(m.displayName || m.tag)}</div>
      <div class="member-sub">${esc(m.tag)}</div>`;
    card.appendChild(info);

    card.addEventListener("click", () => {
      if (state.modSelectedIds.has(m.id)) state.modSelectedIds.delete(m.id);
      else state.modSelectedIds.add(m.id);
      card.classList.toggle("selected", state.modSelectedIds.has(m.id));
      updateSelectedCount();
    });
    container.appendChild(card);
  });
  updateSelectedCount();
}

function filterMembers() {
  const q = $("mod-search").value.toLowerCase();
  const filtered = state.modMembers.filter((m) =>
    m.tag.toLowerCase().includes(q) || (m.displayName || "").toLowerCase().includes(q)
  );
  renderModMembers(filtered);
}

function updateMemberSelection() {
  document.querySelectorAll(".member-card").forEach((card) => {
    card.classList.toggle("selected", state.modSelectedIds.has(card.dataset.id));
  });
  updateSelectedCount();
}

function updateSelectedCount() {
  $("mod-selected-count").textContent = `${state.modSelectedIds.size} membro(s) selecionado(s)`;
}

async function doModAction(action) {
  const memberIds = [...state.modSelectedIds];
  const resEl = $("mod-action-result");
  if (!memberIds.length) { showResult(resEl, "Selecione ao menos um membro.", "err"); return; }
  if (!state.modSelectedGuildId) { showResult(resEl, "Selecione um servidor primeiro.", "err"); return; }

  const actionNames = { mute: "mutar", unmute: "desmutar", deafen: "ensurdecer", undeafen: "desensurdecer", kick: "kickar", ban: "banir" };
  const confirm = window.confirm(`Confirma: ${actionNames[action] || action} ${memberIds.length} membro(s)?`);
  if (!confirm) return;

  hideResult(resEl);
  const btn = document.querySelector(`.action-btn[data-action="${action}"]`);
  if (btn) btn.disabled = true;

  const res = await api("/api/moderation/action", {
    token: state.modToken,
    guildId: state.modSelectedGuildId,
    action,
    memberIds,
  });

  if (btn) btn.disabled = false;
  if (res.error) { showResult(resEl, res.error, "err"); return; }
  showResult(resEl, `${res.ok || 0} sucesso(s), ${res.failed || 0} falha(s) de ${res.total || 0} total.`, res.failed ? "err" : "ok");
}

// ─── INVESTIGAÇÃO ─────────────────────────────────────────────────────────
let investigateWired = false;
function wireInvestigate() {
  if (investigateWired) return;
  investigateWired = true;
  $("btn-investigate").addEventListener("click", doInvestigate);
  $("inv-target-id").addEventListener("keydown", (e) => e.key === "Enter" && doInvestigate());
}

async function doInvestigate() {
  const targetId = $("inv-target-id").value.trim();
  const resEl = $("inv-result");
  const myToken = state.globalToken || $("global-token").value.trim();
  if (!myToken) { showResult(resEl, "Defina o Token Global no menu lateral antes de investigar.", "err"); return; }
  if (!targetId) { showResult(resEl, "Insira o ID do usuário alvo.", "err"); return; }
  if (!/^\d{17,20}$/.test(targetId)) { showResult(resEl, "ID inválido. Deve conter apenas números (17-20 dígitos).", "err"); return; }

  const btn = $("btn-investigate");
  setLoading(btn, true);
  hideResult(resEl);
  $("inv-report").classList.add("hidden");

  const res = await api("/api/investigate", { myToken, targetId });
  setLoading(btn, false);

  if (res.error) { showResult(resEl, res.error, "err"); return; }

  $("inv-report").classList.remove("hidden");
  const scanEl = $("inv-scan-count");
  if (scanEl) scanEl.textContent = `${(res.nicknames || []).length} servidor(es) escaneados`;
  renderInvProfile(res);
  renderInvExtraDetails(res);
  renderInvAltAnalysis(res.altAnalysis);
  renderInvMutualGuilds(res.mutualGuilds);
  renderInvMutualFriends(res.mutualFriends);
  renderInvNicknames(res.nicknames);
  renderInvConnections(res.connections);
  renderInvUniqueNicks(res.uniqueNickValues);
  renderInvNicksHistory(res.nicksHistory);
}

function renderInvProfile(data) {
  const u = data.user;
  const tag = u.discriminator ? `${u.username}#${u.discriminator}` : (u.global_name || u.username);
  const avatarExt = u.avatar?.startsWith("a_") ? "gif" : "png";
  const avatarUrl = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${avatarExt}?size=256` : null;
  const bannerUrl = u.banner ? `https://cdn.discordapp.com/banners/${u.id}/${u.banner}${u.banner.startsWith("a_") ? ".gif" : ".png"}?size=480` : null;

  const createdAt = new Date(u.createdAt);
  const createdDate = createdAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const createdTime = createdAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const premiumLabels = { 0: "Sem Nitro", 1: "Nitro Classic", 2: "Nitro", 3: "Nitro Basic" };
  const premiumColors = { 0: "var(--text-muted)", 1: "#9d8fc4", 2: "var(--purple-bright)", 3: "#c084fc" };

  const flagNames = {
    1: "Discord Staff", 2: "Parceiro Discord", 4: "HypeSquad Events",
    8: "Bug Hunter Nv.1", 64: "HypeSquad Bravery", 128: "HypeSquad Brilliance",
    256: "HypeSquad Balance", 512: "Apoiador Antigo (2017)", 16384: "Bug Hunter Nv.2",
    65536: "Discord Bot", 131072: "Bot Dev Verificado", 262144: "Usuário MENA",
    1048576: "Staff Antigo", 4194304: "Moderador de Servidor Ativo",
  };
  const badges = Object.entries(flagNames).filter(([bit]) => (u.public_flags || 0) & Number(bit)).map(([, n]) => n);
  const isAnimatedAvatar = u.avatar?.startsWith("a_");

  const el = $("inv-profile");
  el.innerHTML = `
    <div class="inv-profile-wrap">
      ${bannerUrl ? `<div class="inv-banner"><img src="${esc(bannerUrl)}" alt="banner" /></div>` : ""}
      <div class="inv-profile-body">
        <div class="inv-avatar-wrap">
          ${avatarUrl
            ? `<img class="inv-avatar" src="${esc(avatarUrl)}" alt="avatar" />`
            : `<div class="inv-avatar inv-avatar-fallback">${esc(initials(tag))}</div>`}
          ${isAnimatedAvatar ? `<div style="font-size:.65rem;color:var(--purple-bright);text-align:center;margin-top:3px">GIF animado</div>` : ""}
        </div>
        <div class="inv-user-info">
          <div class="inv-username">${esc(tag)}</div>
          ${u.global_name && u.global_name !== u.username
            ? `<div class="inv-display-name">@${esc(u.username)}</div>` : ""}
          <div class="inv-id-row">ID: <code class="inv-id">${esc(u.id)}</code></div>
          <div class="inv-meta">
            Conta criada: <strong>${esc(createdDate)}</strong> às ${esc(createdTime)}
            <span style="color:var(--text-muted)">(${u.accountAgeDays} dias atrás)</span>
          </div>
          <div class="inv-meta">
            <span class="inv-tag-badge" style="color:${premiumColors[u.premium_type] || "var(--text-muted)"};border-color:${premiumColors[u.premium_type] || "var(--border)"}40">
              ${esc(premiumLabels[u.premium_type] || "Sem Nitro")}
            </span>
            ${u.accent_color ? `<span class="inv-tag-badge" style="border-color:${"#" + (u.accent_color).toString(16).padStart(6, "0")}80">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#${(u.accent_color).toString(16).padStart(6, "0")};margin-right:3px"></span>
              Cor de Perfil
            </span>` : ""}
            ${u.avatar ? `<span class="inv-tag-badge" style="color:var(--green);border-color:rgba(52,211,153,.3)">Tem foto</span>` : ""}
            ${u.banner ? `<span class="inv-tag-badge" style="color:var(--blue);border-color:rgba(129,140,248,.3)">Tem banner</span>` : ""}
          </div>
          ${badges.length ? `<div class="inv-badges">${badges.map((b) => `<span class="inv-tag-badge" style="color:var(--purple-bright);border-color:rgba(168,85,247,.3)">${esc(b)}</span>`).join("")}</div>` : ""}
          ${data.bio ? `<div class="inv-bio">"${esc(data.bio)}"</div>` : ""}
        </div>
      </div>
    </div>`;

  const dlWrap = $("inv-avatar-download-wrap");
  const dlBtn = $("btn-download-avatar");
  const avatarUrl2 = avatarUrl;
  if (dlWrap && dlBtn && avatarUrl2) {
    dlBtn.href = `/api/avatar-download?url=${encodeURIComponent(avatarUrl2)}`;
    dlBtn.download = `avatar_${u.id}.${avatarExt}`;
    dlWrap.classList.remove("hidden");
  } else if (dlWrap) {
    dlWrap.classList.add("hidden");
  }
}

function renderInvExtraDetails(data) {
  const el = $("inv-extra-details");
  if (!el) return;
  const u = data.user;
  const createdAt = new Date(u.createdAt);

  const items = [
    { label: "Username", value: `@${esc(u.username)}` },
    { label: "ID Snowflake", value: esc(u.id) },
    { label: "Criado em", value: `${createdAt.toLocaleDateString("pt-BR")} ${createdAt.toLocaleTimeString("pt-BR")}` },
    { label: "Idade", value: `${u.accountAgeDays}d (≈${Math.floor(u.accountAgeDays / 365)}a ${Math.floor((u.accountAgeDays % 365) / 30)}m)` },
    { label: "Nitro", value: ["Sem Nitro", "Nitro Classic", "Nitro", "Nitro Basic"][u.premium_type || 0] },
    { label: "Servidores Mútuos", value: String((data.mutualGuilds || []).length) },
    { label: "Amigos Mútuos", value: String((data.mutualFriends || []).length) },
    { label: "Contas Vinculadas", value: String((data.connections || []).length) },
    { label: "Nicks Únicos", value: String((data.uniqueNickValues || []).length) },
    { label: "Servers Escaneados", value: String((data.nicknames || []).length) },
    { label: "Public Flags", value: `${u.public_flags || 0} (0x${(u.public_flags || 0).toString(16).toUpperCase()})` },
    { label: "Tem Avatar", value: u.avatar ? "Sim" + (u.avatar.startsWith("a_") ? " (GIF)" : " (PNG)") : "Não" },
    { label: "Tem Banner", value: u.banner ? "Sim" : "Não" },
    { label: "Pronomes", value: data.pronouns || "Não informado" },
  ];
  if (data.premiumSince) {
    items.push({ label: "Nitro Desde", value: new Date(data.premiumSince).toLocaleDateString("pt-BR") });
  }

  el.innerHTML = `<div class="inv-detail-grid">${items.map((i) =>
    `<div class="inv-detail-item">
      <div class="inv-detail-label">${i.label}</div>
      <div class="inv-detail-value">${i.value}</div>
    </div>`
  ).join("")}</div>`;
}

function renderInvAltAnalysis(alt) {
  const el = $("inv-alt-analysis");
  const riskColor = alt.risk === "ALTO" ? "var(--red)" : alt.risk === "MÉDIO" ? "var(--orange)" : "var(--green)";
  el.innerHTML = `
    <div class="inv-alt-risk" style="color:${riskColor}">Risco: <strong>${esc(alt.risk)}</strong></div>
    <div style="color:var(--text-dim);font-size:.82rem;margin-top:6px">Conta criada há <strong>${alt.accountAgeDays}</strong> dias</div>
    ${alt.reasons.length ? `<ul class="inv-alt-reasons">${alt.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : `<div style="color:var(--green);font-size:.82rem;margin-top:6px">Nenhum indicador de alt detectado.</div>`}`;
}

function renderInvMutualGuilds(guilds) {
  const el = $("inv-mutual-guilds");
  const list = guilds || [];
  if (!list.length) { el.className = "empty-hint"; el.textContent = "Nenhum servidor em comum encontrado."; return; }
  el.className = "";
  el.innerHTML = list.map((g) => `
    <div class="inv-list-item">
      <div class="inv-list-icon">${esc(initials(g.name))}</div>
      <div>
        <div class="inv-list-name">${esc(g.name)}</div>
        <div class="inv-list-sub">ID: ${esc(g.id)}${g.nick ? ` · Nick: <strong>${esc(g.nick)}</strong>` : ""}</div>
      </div>
    </div>`).join("");
}

function renderInvMutualFriends(friends) {
  const el = $("inv-mutual-friends");
  const list = friends || [];
  if (!list.length) { el.className = "empty-hint"; el.textContent = "Nenhum amigo em comum."; return; }
  el.className = "";
  el.innerHTML = list.map((f) => {
    const tag = f.discriminator ? `${f.username}#${f.discriminator}` : (f.global_name || f.username);
    return `<div class="inv-list-item">
      <div class="inv-list-avatar"></div>
      <div>
        <div class="inv-list-name">${esc(tag)}</div>
        <div class="inv-list-sub">ID: ${esc(f.id)}</div>
      </div>
    </div>`;
  }).join("");
  el.querySelectorAll(".inv-list-avatar").forEach((av, i) => {
    renderAvatar(av, list[i].id, list[i].avatar, list[i].username, 30);
  });
}

function renderInvNicknames(nicknames) {
  const el = $("inv-nicknames");
  const list = nicknames || [];
  if (!list.length) { el.className = "empty-hint"; el.textContent = "Sem nicks encontrados nos servidores."; return; }
  el.className = "";
  el.innerHTML = list.map((n) => `
    <div class="inv-list-item">
      <div class="inv-list-icon" style="font-size:.7rem">${esc(initials(n.guildName))}</div>
      <div>
        <div class="inv-list-name">${esc(n.guildName)}</div>
        <div class="inv-list-sub">${n.nick ? `Nick: <strong style="color:var(--text)">${esc(n.nick)}</strong>` : `<span style="color:var(--text-muted)">Sem nick customizado</span>`}</div>
      </div>
    </div>`).join("");
}

function renderInvConnections(connections) {
  const el = $("inv-connections");
  const list = connections || [];
  if (!list.length) { el.className = "empty-hint"; el.textContent = "Nenhuma conexão pública."; return; }
  el.className = "";
  const typeIcons = { github: "🐙", spotify: "🎵", steam: "🎮", twitter: "🐦", twitch: "🟣", youtube: "📺", reddit: "🔴", facebook: "🔵", xbox: "🟢" };
  el.innerHTML = list.map((c) => `
    <div class="inv-list-item">
      <div class="inv-list-icon" style="font-size:1rem">${typeIcons[c.type] || "🔗"}</div>
      <div>
        <div class="inv-list-name">${esc(c.name)}</div>
        <div class="inv-list-sub">${esc(c.type)}${c.verified ? " · Verificado" : ""}</div>
      </div>
    </div>`).join("");
}

function renderInvUniqueNicks(uniqueNickValues) {
  const el = $("inv-unique-nicks");
  if (!el) return;
  const list = uniqueNickValues || [];
  if (!list.length) {
    el.className = "empty-hint";
    el.textContent = "Nenhum nick customizado encontrado.";
    return;
  }
  el.className = "";
  el.innerHTML = list.map((n) => {
    const serverCount = n.servers.length;
    const serverNames = n.servers.slice(0, 3).map((s) => esc(s.guildName)).join(", ");
    const more = serverCount > 3 ? ` e mais ${serverCount - 3}` : "";
    return `<div class="inv-list-item" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <div class="inv-list-icon" style="background:var(--blue)20;color:var(--blue);font-weight:700;font-size:.75rem">${esc(n.nick.slice(0, 2).toUpperCase())}</div>
      <div style="flex:1">
        <div class="inv-list-name" style="font-size:.95rem">${esc(n.nick)}</div>
        <div class="inv-list-sub">${serverCount} servidor(es): ${serverNames}${more}</div>
      </div>
      <span style="font-size:.75rem;background:var(--bg3);border-radius:12px;padding:2px 8px;color:var(--text-muted)">${serverCount}x</span>
    </div>`;
  }).join("");
}

function renderInvNicksHistory(nicksHistory) {
  const el = $("inv-nicks-history");
  if (!el) return;
  const historical = (nicksHistory || []).filter((n) => !n.current);
  if (!historical.length) {
    el.className = "empty-hint";
    el.textContent = "Nenhum histórico registrado para este usuário.";
    return;
  }
  el.className = "";
  el.innerHTML = historical.map((n) => {
    const date = n.seenAt ? new Date(n.seenAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
    return `<div class="inv-list-item">
      <div class="inv-list-icon" style="font-size:.7rem">${esc(initials(n.guildName))}</div>
      <div style="flex:1">
        <div class="inv-list-name">${esc(n.guildName)}</div>
        <div class="inv-list-sub">${n.nick ? `Nick antigo: <strong style="color:var(--text)">${esc(n.nick)}</strong>` : `<span style="color:var(--text-muted)">Sem nick</span>`} <span style="color:var(--text-muted);margin-left:6px">· Visto em ${esc(date)}</span></div>
      </div>
    </div>`;
  }).join("");
}

// ─── NUKE ─────────────────────────────────────────────────────────────────
let nukeWired = false;
let nukePolling = null;

function wireNuke() {
  if (nukeWired) return;
  nukeWired = true;
  $("btn-nuke-start").addEventListener("click", startNuke);
  $("btn-nuke-stop").addEventListener("click", stopNuke);
  $("btn-nuke-load-dms").addEventListener("click", loadNukeDMs);
}

async function startNuke() {
  const token = $("nuke-token").value.trim() || state.globalToken;
  const channelId = $("nuke-channel-id").value.trim();
  const userId = $("nuke-user-id").value.trim();
  const keyword = $("nuke-keyword").value.trim();
  const limit = parseInt($("nuke-limit").value) || 0;
  const resEl = $("nuke-result");

  if (!token) { showResult(resEl, "Insira um token ou defina o Token Global.", "err"); return; }
  if (!channelId) { showResult(resEl, "Insira o ID do canal.", "err"); return; }

  const confirm = window.confirm(
    `Confirma o NUKE no canal ${channelId}?\n` +
    `${userId ? `Usuário: ${userId}\n` : ""}` +
    `${keyword ? `Filtro: "${keyword}"\n` : ""}` +
    `${limit > 0 ? `Limite: ${limit} msgs\n` : "Sem limite — TODAS as mensagens.\n"}` +
    `\nEsta ação é irreversível!`
  );
  if (!confirm) return;

  const btn = $("btn-nuke-start");
  setLoading(btn, true);
  hideResult(resEl);

  const res = await api("/api/nuke/start", { token, channelId, userId: userId || null, keyword: keyword || null, limit });
  setLoading(btn, false);

  if (res.error) { showResult(resEl, res.error, "err"); return; }

  showResult(resEl, "Nuke iniciado! Acompanhe o progresso abaixo e nos Logs.", "ok");
  $("btn-nuke-stop").disabled = false;
  $("nuke-progress").classList.remove("hidden");
  $("nuke-status-display").textContent = "Nuke em andamento...";

  if (nukePolling) clearInterval(nukePolling);
  nukePolling = setInterval(pollNukeStatus, 2000);
  pollNukeStatus();
}

async function pollNukeStatus() {
  const res = await api("/api/nuke/status", undefined, "GET");
  if (res.error) return;

  $("nuke-stat-deleted").textContent = res.deleted || 0;
  $("nuke-stat-scanned").textContent = res.scanned || 0;
  $("nuke-stat-failed").textContent = res.failed || 0;
  state.purgedCount = (res.deleted || 0);
  renderOverview();

  if (!res.running) {
    clearInterval(nukePolling);
    nukePolling = null;
    $("btn-nuke-stop").disabled = true;
    $("nuke-status-display").textContent = `Finalizado: ${res.deleted || 0} apagadas, ${res.failed || 0} falhas.`;
  }
}

async function stopNuke() {
  await api("/api/nuke/stop", {});
  $("btn-nuke-stop").disabled = true;
  $("nuke-status-display").textContent = "Parando nuke...";
}

async function loadNukeDMs() {
  const token = $("nuke-token").value.trim() || state.globalToken;
  const btn = $("btn-nuke-load-dms");
  const container = $("nuke-dm-list");
  if (!token) { container.className = "result-box err"; container.textContent = "Insira um token primeiro."; return; }
  setLoading(btn, true);
  const res = await api("/api/nuke/dms", { token });
  setLoading(btn, false);
  if (res.error) { container.className = "result-box err"; container.textContent = res.error; return; }
  renderNukeDMList(res.dms || []);
}

function renderNukeDMList(dms) {
  const container = $("nuke-dm-list");
  if (!dms.length) {
    container.className = "empty-hint";
    container.textContent = "Nenhuma conversa privada encontrada.";
    return;
  }
  container.className = "";
  container.innerHTML = dms.map((dm) => `
    <div class="inv-list-item" style="margin-bottom:6px">
      <div class="inv-list-icon" style="font-size:.7rem">${esc(initials(dm.name))}</div>
      <div style="flex:1">
        <div class="inv-list-name">${esc(dm.name)}</div>
        <div class="inv-list-sub">Canal ID: <code>${esc(dm.id)}</code>${dm.type === 3 ? " · Grupo" : ""}</div>
      </div>
      <button class="btn-ghost btn-sm" onclick="nukeUseDMChannel('${esc(dm.id)}')">Usar</button>
    </div>`).join("");
}

function nukeUseDMChannel(channelId) {
  $("nuke-channel-id").value = channelId;
}

// ─── LOGS ──────────────────────────────────────────────────────────────────
let logsWired = false;
let logsSse = null;
let logFilter = "all";

function wireLogs() {
  if (logsWired) return;
  logsWired = true;

  ["all", "info", "warn", "error"].forEach((f) => {
    const btn = $(`log-filter-${f}`);
    if (btn) btn.addEventListener("click", () => {
      logFilter = f;
      document.querySelectorAll("[id^='log-filter-']").forEach((b) => b.classList.remove("active-filter"));
      btn.classList.add("active-filter");
      // re-render visible entries
      document.querySelectorAll(".log-entry").forEach((el) => {
        el.style.display = (f === "all" || el.dataset.level === f) ? "" : "none";
      });
    });
  });

  $("btn-log-clear").addEventListener("click", () => {
    const stream = $("log-stream");
    if (stream) stream.innerHTML = "";
  });

  startLogSse();
}

function startLogSse() {
  if (logsSse) { logsSse.close(); logsSse = null; }
  setLogStatus(false);

  // Load existing logs first via REST
  api("/api/logs", undefined, "GET").then((res) => {
    if (res?.entries) res.entries.forEach((e) => appendLogEntry(e, true));
  });

  const sse = new EventSource("/api/logs/stream");
  logsSse = sse;

  sse.onopen = () => setLogStatus(true);
  sse.onmessage = (ev) => {
    try { appendLogEntry(JSON.parse(ev.data)); } catch {}
  };
  sse.onerror = () => {
    setLogStatus(false);
    // EventSource auto-reconnects
  };
}

function appendLogEntry(entry, prepend) {
  const stream = $("log-stream");
  if (!stream) return;
  const levelClass = entry.level === "warn" ? "warn" : entry.level === "error" ? "error" : "info";
  const hidden = logFilter !== "all" && logFilter !== levelClass ? ' style="display:none"' : "";
  const html = `<div class="log-entry" data-level="${esc(levelClass)}"${hidden}>` +
    `<span class="log-time">${esc(entry.time || "")}</span>` +
    `<span class="log-lvl log-lvl-${esc(levelClass)}">${esc(levelClass.toUpperCase())}</span>` +
    `<span class="log-msg">${esc(entry.msg || "")}</span></div>`;
  if (prepend) {
    stream.insertAdjacentHTML("afterbegin", html);
  } else {
    stream.insertAdjacentHTML("beforeend", html);
    stream.scrollTop = stream.scrollHeight;
  }
  // Keep max 300 entries in DOM
  while (stream.children.length > 300) stream.removeChild(stream.firstChild);
}

function setLogStatus(connected) {
  const dot = $("log-status");
  if (!dot) return;
  dot.className = `log-status-dot ${connected ? "connected" : "disconnected"}`;
  dot.title = connected ? "SSE conectado" : "SSE desconectado";
}

// ─── HISTÓRICO ────────────────────────────────────────────────────────────
let historyWired = false;

function wireHistory() {
  if (historyWired) return;
  historyWired = true;
  $("btn-history-refresh").addEventListener("click", loadQuestHistory);
  $("btn-history-clear").addEventListener("click", async () => {
    if (!confirm("Limpar todo o histórico de missões?")) return;
    await api("/api/quest-history", {}, "DELETE");
    loadQuestHistory();
  });
}

async function loadQuestHistory() {
  const container = $("quest-history-list");
  if (!container) return;
  container.innerHTML = `<div style="color:var(--text-muted);padding:12px">Carregando...</div>`;
  const res = await api("/api/quest-history", undefined, "GET");
  if (res?.error) { container.innerHTML = `<div style="color:var(--red);padding:12px">${esc(res.error)}</div>`; return; }
  renderQuestHistory(res?.history || []);
}

function renderQuestHistory(history) {
  const container = $("quest-history-list");
  if (!container) return;
  if (!history.length) {
    container.className = "quest-history-list empty-hint";
    container.textContent = "Nenhuma missão registrada.";
    return;
  }
  container.className = "quest-history-list";
  container.innerHTML = history.map((h) => {
    const date = new Date(h.completedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const taskColor = h.taskType === "WATCH_VIDEO" ? "var(--blue)" : h.taskType?.includes("STREAM") ? "var(--orange, #f59e0b)" : "var(--text-muted)";
    const successBadge = h.success
      ? `<span class="badge-success">Concluída</span>`
      : `<span class="badge-fail">Parcial</span>`;
    return `<div class="history-item">
      <div class="history-item-main">
        <div class="history-quest-name">${esc(h.questName || h.questId || "—")}</div>
        <div class="history-meta">
          <span class="history-task-badge" style="border-color:${taskColor}40;color:${taskColor}">${esc(h.taskType || "—")}</span>
          <span class="history-token">${esc(h.tokenTag || "—")}</span>
          <span class="history-date">${esc(date)}</span>
        </div>
      </div>
      <div>${successBadge}</div>
    </div>`;
  }).join("");
}

// ─── HELPERS ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
