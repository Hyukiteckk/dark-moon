/**
 * @name SpyMode
 * @description Fake Mute/Deaf controlado pelo app Dark Moon
 * @version 12.0.0
 * @author Hyukiteckk
 */

module.exports = (meta) => {
  let spyMute = false;
  let spyDeaf = false;
  let _originalSend = null;
  let _socket = null;
  let _pollInterval = null;
  const PLUGIN_ID = meta.name;
  const APP_URL = 'http://127.0.0.1:4100';

  const log  = (...a) => console.log(`[${PLUGIN_ID}]`, ...a);
  const warn = (...a) => console.warn(`[${PLUGIN_ID}]`, ...a);

  function showToast(msg, type = "info") {
    try { BdApi.UI?.showToast?.(msg, { type }); } catch {}
    try { BdApi.showToast?.(msg, { type }); } catch {}
  }

  function byKeys(...keys) {
    try { const m = BdApi.Webpack?.getByKeys?.(...keys); if (m) return m; } catch {}
    try { const m = BdApi.findModuleByProps?.(...keys); if (m) return m; } catch {}
    return null;
  }

  // ── Patch no socket do Discord (op=4 = Voice State Update) ───────────────
  function installPatch() {
    const wsModule = byKeys("getSocket");
    if (!wsModule) { warn("wsModule não encontrado"); return false; }

    _socket = wsModule.getSocket?.();
    if (!_socket) { warn("socket não disponível"); return false; }

    _originalSend = _socket.send.bind(_socket);
    _socket.send = function (op, data, ...args) {
      if (op === 4 && data && (spyMute || spyDeaf)) {
        data.self_mute = true;
        data.self_deaf = !!spyDeaf;
      }
      return _originalSend(op, data, ...args);
    };

    log("Patch instalado no socket.send");
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

  // ── Envia op4 imediatamente para aplicar estado na call atual ─────────────
  function refreshVoiceState() {
    const wsModule        = byKeys("getSocket");
    const selectedChannel = byKeys("getVoiceChannelId");
    const channelStore    = byKeys("getChannel", "getDMFromUserId");

    const socket    = _socket || wsModule?.getSocket?.();
    const channelId = selectedChannel?.getVoiceChannelId?.();

    if (!socket || !channelId) return;

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
      log(`op4 enviado — mute:${spyDeaf || spyMute} deaf:${spyDeaf}`);
    } catch (e) { warn("Erro ao enviar op4:", e); }
  }

  // ── Polling: busca estado do app Dark Moon a cada 1s ──────────────────────
  function startPolling() {
    _pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${APP_URL}/api/spymode/state`, { signal: AbortSignal.timeout(200) });
        if (!res.ok) return;
        const data = await res.json();
        const newMute = Boolean(data.spyMute);
        const newDeaf = Boolean(data.spyDeaf);
        if (newMute !== spyMute || newDeaf !== spyDeaf) {
          spyMute = newMute;
          spyDeaf = newDeaf;
          refreshVoiceState();
          log(`Estado atualizado pelo app: mute=${spyMute} deaf=${spyDeaf}`);
        }
      } catch {}
    }, 250);
  }

  function stopPolling() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
  }

  function getSettingsPanel() {
    const w = document.createElement("div");
    w.style.cssText = "padding:14px 18px;font-family:'gg sans',sans-serif;color:#aaa;font-size:13px;line-height:1.8";
    w.innerHTML = `<b style="color:#fff;font-size:15px">SpyMode v12.0</b><br>
      Controlado pelo app <b style="color:#c084fc">Dark Moon</b>.<br>
      Acesse a aba <b>Fake Mute</b> no app para ativar os modos.<br>
      O plugin fica invisível e responde aos comandos automaticamente.<br><br>
      <span style="color:#555;font-size:11px">v12.0 — app-controlled polling @ 127.0.0.1:4100</span>`;
    return w;
  }

  return {
    start() {
      const ok = installPatch();
      startPolling();
      if (ok) showToast("SpyMode v12.0 ✓ — controlado pelo app Dark Moon", "success");
      log("Iniciado");
    },
    stop() {
      stopPolling();
      removePatches();
      spyMute = false;
      spyDeaf = false;
      log("Parado");
    },
    getSettingsPanel,
  };
};
