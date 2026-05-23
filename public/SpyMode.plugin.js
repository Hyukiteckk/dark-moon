/**
 * @name SpyMode
 * @description Apareça mutado/surdo para os outros mas continue ouvindo tudo na call
 * @version 11.0.0
 * @author Hyukiteckk
 * @based-on hyyven/Vencord-FakeDeafen
 */

module.exports = (meta) => {
  let spyMute = false;
  let spyDeaf = false;
  let _originalSend = null;
  let _socket = null;
  let _floatingPanel = null;
  const _docListeners = [];
  const PLUGIN_ID = meta.name;

  const log  = (...a) => console.log(`[${PLUGIN_ID}]`, ...a);
  const warn = (...a) => console.warn(`[${PLUGIN_ID}]`, ...a);

  function addDocListener(type, fn) {
    document.addEventListener(type, fn);
    _docListeners.push({ type, fn });
  }
  function removeDocListeners() {
    for (const { type, fn } of _docListeners) document.removeEventListener(type, fn);
    _docListeners.length = 0;
  }

  function showToast(msg, type = "info") {
    try { BdApi.UI?.showToast?.(msg, { type }); } catch {}
    try { BdApi.showToast?.(msg, { type }); } catch {}
  }

  function byKeys(...keys) {
    try { const m = BdApi.Webpack?.getByKeys?.(...keys); if (m) return m; } catch {}
    try { const m = BdApi.findModuleByProps?.(...keys); if (m) return m; } catch {}
    return null;
  }

  // ── Instala o patch no socket interno do Discord ──────────────────────────
  // O Discord usa um wrapper com send(op, data) — NÃO o WebSocket.prototype.send
  // op=4 é o Voice State Update
  function installPatch() {
    const wsModule = byKeys("getSocket");
    if (!wsModule) {
      warn("wsModule (getSocket) não encontrado");
      showToast("SpyMode: gateway não encontrado", "error");
      return false;
    }

    _socket = wsModule.getSocket?.();
    if (!_socket) {
      warn("socket não disponível");
      showToast("SpyMode: socket não disponível", "error");
      return false;
    }

    _originalSend = _socket.send.bind(_socket);

    _socket.send = function (op, data, ...args) {
      if (op === 4 && data && (spyMute || spyDeaf)) {
        data.self_mute = true;
        data.self_deaf = !!spyDeaf;
      }
      return _originalSend(op, data, ...args);
    };

    log("Patch instalado no socket.send (op=4)");
    return true;
  }

  function removePatches() {
    if (_socket && _originalSend) {
      _socket.send = _originalSend;
      _originalSend = null;
      _socket = null;
      log("Patch removido");
    }
  }

  // ── Envia op4 imediatamente (aplica o estado fake na call atual) ──────────
  function refreshVoiceState() {
    const wsModule        = byKeys("getSocket");
    const selectedChannel = byKeys("getVoiceChannelId");
    const channelStore    = byKeys("getChannel", "getDMFromUserId");
    const mediaEngine     = byKeys("isDeaf", "isMute");

    const socket    = _socket || wsModule?.getSocket?.();
    const channelId = selectedChannel?.getVoiceChannelId?.();

    if (!socket || !channelId) {
      showToast("Entre em uma call primeiro!", "warning");
      return;
    }

    const channel = channelStore?.getChannel?.(channelId);

    try {
      socket.send(4, {
        guild_id:   channel?.guild_id ?? null,
        channel_id: channelId,
        self_mute:  spyDeaf || spyMute,
        self_deaf:  !!spyDeaf,
        self_video: false,
        flags: 0,
      });
      log("op4 enviado — mute:", spyDeaf || spyMute, "deaf:", spyDeaf);
    } catch (e) {
      warn("Erro ao enviar op4:", e);
    }
  }

  // ── Painel flutuante ──────────────────────────────────────────────────────
  function createFloatingPanel() {
    document.getElementById("spymode-panel")?.remove();
    const saved = (() => { try { return JSON.parse(localStorage.getItem("SpyMode_pos") || "{}"); } catch { return {}; } })();

    const panel = document.createElement("div");
    panel.id = "spymode-panel";
    Object.assign(panel.style, {
      position: "fixed", top: saved.top ?? "80px", left: saved.left ?? "20px",
      zIndex: "99999",
      background: "linear-gradient(160deg, #0c0719 0%, #07040e 100%)",
      border: "1px solid #5b2d9e",
      borderRadius: "14px", width: "240px",
      boxShadow: "0 0 28px rgba(168,85,247,.22), 0 12px 36px rgba(0,0,0,.85)",
      fontFamily: "'Segoe UI','gg sans','Noto Sans',sans-serif", userSelect: "none",
    });

    const titleBar = document.createElement("div");
    Object.assign(titleBar.style, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 12px 9px", cursor: "grab",
      borderBottom: "1px solid #261550",
      borderRadius: "14px 14px 0 0",
      background: "linear-gradient(135deg, rgba(168,85,247,.1) 0%, transparent 100%)",
    });
    const title = document.createElement("span");
    title.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" style="vertical-align:-2px;margin-right:7px;filter:drop-shadow(0 0 4px rgba(168,85,247,.8))"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg><span style="color:#c084fc;font-size:12px;font-weight:700;letter-spacing:.6px">Fake Mute</span>`;
    const btnMin = document.createElement("span");
    btnMin.textContent = "—";
    Object.assign(btnMin.style, { fontSize: "14px", color: "#5b2d9e", cursor: "pointer", padding: "0 3px", transition: "color .15s" });
    btnMin.onmouseenter = () => { btnMin.style.color = "#c084fc"; };
    btnMin.onmouseleave = () => { btnMin.style.color = "#5b2d9e"; };
    titleBar.append(title, btnMin);
    panel.appendChild(titleBar);

    const body = document.createElement("div");
    body.style.padding = "10px 12px 14px";

    function makeRow(label, emoji, trackId, knobId, getVal, onClick) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "9px 10px", borderRadius: "9px", cursor: "pointer",
        marginBottom: "6px",
        background: "rgba(168,85,247,.05)",
        border: "1px solid rgba(92,45,158,.4)",
        transition: "background .15s, border-color .15s",
      });
      row.onmouseenter = () => { row.style.background = "rgba(168,85,247,.12)"; row.style.borderColor = "rgba(168,85,247,.5)"; };
      row.onmouseleave = () => {
        const active = row.dataset.active === "1";
        row.style.background  = active ? "rgba(168,85,247,.14)" : "rgba(168,85,247,.05)";
        row.style.borderColor = active ? "rgba(168,85,247,.55)"  : "rgba(92,45,158,.4)";
      };

      const lbl = document.createElement("span");
      lbl.style.cssText = "font-size:12.5px;color:#bbaee0;display:flex;align-items:center;gap:7px";
      lbl.innerHTML = `<span style="font-size:.95rem">${emoji}</span><span>${label}</span>`;

      const track = document.createElement("div");
      track.id = trackId;
      Object.assign(track.style, {
        width: "34px", height: "18px", borderRadius: "9px", position: "relative",
        flexShrink: "0", transition: "background .2s",
        background: getVal() ? "#9333ea" : "#120b22",
        border: getVal() ? "1px solid #a855f7" : "1px solid #261550",
      });
      const knob = document.createElement("div");
      knob.id = knobId;
      Object.assign(knob.style, {
        position: "absolute", top: "2px", left: getVal() ? "16px" : "2px",
        width: "14px", height: "14px", borderRadius: "50%",
        background: getVal() ? "#e2baff" : "#5b2d9e",
        transition: "left .2s, background .2s",
        boxShadow: getVal() ? "0 0 6px rgba(168,85,247,.7)" : "none",
      });
      track.appendChild(knob);
      row.addEventListener("click", onClick);
      row.append(lbl, track);
      return row;
    }

    function sync(trackId, knobId, val) {
      const t = document.getElementById(trackId);
      const k = document.getElementById(knobId);
      if (!t || !k) return;
      t.style.background = val ? "#9333ea" : "#120b22";
      t.style.border     = val ? "1px solid #a855f7" : "1px solid #261550";
      k.style.left       = val ? "16px"    : "2px";
      k.style.background = val ? "#e2baff" : "#5b2d9e";
      k.style.boxShadow  = val ? "0 0 6px rgba(168,85,247,.7)" : "none";
      const row = t?.parentElement;
      if (row) {
        row.dataset.active = val ? "1" : "0";
        row.style.background  = val ? "rgba(168,85,247,.14)" : "rgba(168,85,247,.05)";
        row.style.borderColor = val ? "rgba(168,85,247,.55)"  : "rgba(92,45,158,.4)";
        row.style.boxShadow   = val ? "0 0 14px rgba(168,85,247,.18)" : "none";
      }
    }

    body.appendChild(makeRow("Modo Espião", "🕵️", "sm-st", "sm-sk", () => spyMute && spyDeaf, () => {
      const novo = !(spyMute && spyDeaf);
      spyMute = novo; spyDeaf = novo;
      sync("sm-st", "sm-sk", spyMute && spyDeaf);
      sync("sm-mt", "sm-mk", spyMute);
      sync("sm-dt", "sm-dk", spyDeaf);
      refreshVoiceState();
    }));

    const sep = document.createElement("div");
    sep.style.cssText = "height:1px;background:rgba(92,45,158,.3);margin:4px 0 8px";
    body.appendChild(sep);

    body.appendChild(makeRow("Mutado", "🎙️", "sm-mt", "sm-mk", () => spyMute, () => {
      spyMute = !spyMute;
      if (!spyMute) spyDeaf = false;
      sync("sm-mt", "sm-mk", spyMute);
      sync("sm-dt", "sm-dk", spyDeaf);
      sync("sm-st", "sm-sk", spyMute && spyDeaf);
      refreshVoiceState();
    }));

    body.appendChild(makeRow("Surdo", "🎧", "sm-dt", "sm-dk", () => spyDeaf, () => {
      spyDeaf = !spyDeaf;
      if (spyDeaf) spyMute = true;
      sync("sm-dt", "sm-dk", spyDeaf);
      sync("sm-mt", "sm-mk", spyMute);
      sync("sm-st", "sm-sk", spyMute && spyDeaf);
      refreshVoiceState();
    }));

    panel.appendChild(body);
    document.body.appendChild(panel);

    let minimized = false;
    btnMin.addEventListener("click", e => {
      e.stopPropagation();
      minimized = !minimized;
      body.style.display = minimized ? "none" : "block";
      btnMin.textContent = minimized ? "+" : "—";
      panel.style.width  = minimized ? "auto" : "240px";
    });

    let dragging = false, ox = 0, oy = 0;
    titleBar.addEventListener("mousedown", e => {
      if (e.target === btnMin) return;
      dragging = true; ox = e.clientX - panel.offsetLeft; oy = e.clientY - panel.offsetTop;
      titleBar.style.cursor = "grabbing";
    });
    addDocListener("mousemove", e => {
      if (!dragging) return;
      panel.style.left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox)) + "px";
      panel.style.top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy)) + "px";
    });
    addDocListener("mouseup", () => {
      if (!dragging) return;
      dragging = false; titleBar.style.cursor = "grab";
      try { localStorage.setItem("SpyMode_pos", JSON.stringify({ top: panel.style.top, left: panel.style.left })); } catch {}
    });

    return panel;
  }

  function getSettingsPanel() {
    const w = document.createElement("div");
    w.style.cssText = "padding:14px 18px;font-family:'gg sans',sans-serif;color:#aaa;font-size:13px;line-height:1.8";
    w.innerHTML = `<b style="color:#fff;font-size:15px">Spy Mode v11.0</b><br>
      <b>🕵️ Modo Espião</b> — mute+surdo com um clique.<br>
      <b>🎙️ Mutado</b> — outros te veem mutado, você ouve tudo.<br>
      <b>🎧 Surdo</b> — outros te veem surdo+mutado, você ouve tudo.<br><br>
      <span style="color:#555;font-size:11px">v11.0 — socket.send(op=4) patch, baseado em hyyven/FakeDeafen.</span>`;
    return w;
  }

  return {
    start() {
      const ok = installPatch();
      _floatingPanel = createFloatingPanel();
      if (ok) showToast("FakeMute v11.0 ✓", "success");
      log("Iniciado");
    },
    stop() {
      removePatches();
      spyMute = false;
      spyDeaf = false;
      removeDocListeners();
      document.getElementById("spymode-panel")?.remove();
      _floatingPanel = null;
      log("Parado");
    },
    getSettingsPanel,
  };
};
