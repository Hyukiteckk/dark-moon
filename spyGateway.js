const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/124.0.6367.243 Electron/30.4.0 Safari/537.36";

export class SpyGateway {
  constructor() {
    this.ws          = null;
    this.token       = null;
    this.userId      = null;
    this.username    = null;
    this.connected   = false;
    this.sequence    = null;
    this.hbTimer     = null;
    this.guildId     = null;
    this.channelId   = null;
    this.channelName = null;
    this.spyMute     = false;
    this.spyDeaf     = false;
  }

  // ── public ────────────────────────────────────────────────────────────────

  connect(token) {
    return new Promise(async (resolve, reject) => {
      this.disconnect();
      this.token = token;

      let WS;
      try { const m = await import("ws"); WS = m.default || m; }
      catch { return reject(new Error("ws module unavailable")); }

      this.ws = new WS(GATEWAY);
      let settled = false;
      const settle = (ok, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ok ? resolve(val) : reject(val);
      };

      const timer = setTimeout(() => settle(false, new Error("Timeout ao conectar ao Gateway")), 20000);

      this.ws.on("error", (e) => { settle(false, new Error(e.message)); this._cleanup(); });
      this.ws.on("close", () => { settle(false, new Error("Conexão fechada")); this._cleanup(); });

      this.ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        const { op, d, s, t } = msg;
        if (s != null) this.sequence = s;

        // HELLO → heartbeat + identify
        if (op === 10) {
          this.hbTimer = setInterval(() => {
            if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op: 1, d: this.sequence }));
          }, Math.floor(d.heartbeat_interval * 0.85));
          this._identify();
        }

        // Invalid session
        if (op === 9) settle(false, new Error("Sessão inválida — token incorreto ou expirado"));

        // Reconnect requested
        if (op === 7) { this.disconnect(); settle(false, new Error("Gateway pediu reconexão — tente novamente")); }

        if (op === 0) {
          if (t === "READY") {
            this.connected = true;
            this.userId    = d.user.id;
            this.username  = d.user.global_name || d.user.username;
            // scan READY for existing voice state
            for (const g of (d.guilds || [])) {
              for (const vs of (g.voice_states || [])) {
                if (vs.user_id === this.userId && vs.channel_id) {
                  this.guildId   = vs.guild_id || g.id;
                  this.channelId = vs.channel_id;
                }
              }
            }
            settle(true, { username: this.username, userId: this.userId });
          }

          if (t === "VOICE_STATE_UPDATE" && d.user_id === this.userId) {
            this._handleVSU(d);
          }
        }
      });
    });
  }

  setSpyState(mute, deaf) {
    this.spyMute = !!mute;
    this.spyDeaf = !!deaf;
    this._applyNow();
  }

  disconnect() {
    try { this.ws?.terminate?.() || this.ws?.close?.(); } catch {}
    this._cleanup();
    this.token = this.userId = this.username = null;
    this.guildId = this.channelId = this.channelName = null;
    this.spyMute = this.spyDeaf = false;
  }

  getStatus() {
    return {
      connected:   this.connected,
      username:    this.username,
      inChannel:   !!this.channelId,
      channelId:   this.channelId,
      channelName: this.channelName,
      guildId:     this.guildId,
      spyMute:     this.spyMute,
      spyDeaf:     this.spyDeaf,
    };
  }

  // ── private ───────────────────────────────────────────────────────────────

  _handleVSU(d) {
    if (d.channel_id) {
      this.guildId   = d.guild_id;
      this.channelId = d.channel_id;
      // Re-apply spy state if Discord client overrode it
      const needsMute = this.spyMute && !d.self_mute;
      const needsDeaf = this.spyDeaf && !d.self_deaf;
      if (needsMute || needsDeaf) setTimeout(() => this._applyNow(), 150);
    } else {
      this.guildId = this.channelId = this.channelName = null;
    }
  }

  _applyNow() {
    if (!this.channelId || !this.guildId) return;
    this._send({ op: 4, d: {
      guild_id:   this.guildId,
      channel_id: this.channelId,
      self_mute:  this.spyMute,
      self_deaf:  this.spyDeaf,
    }});
  }

  _identify() {
    this._send({ op: 2, d: {
      token: this.token,
      capabilities: 65534,
      properties: {
        os: "Windows", browser: "Discord Client", release_channel: "stable",
        client_version: "1.0.9168", os_version: "10.0.22621",
        os_arch: "x64", app_arch: "x64", system_locale: "pt-BR",
        browser_user_agent: UA, browser_version: "30.4.0",
        client_build_number: 540600, native_build_number: 50950,
        os_sdk_version: "22621", client_event_source: null,
      },
      presence: { status: "online", since: 0, activities: [], afk: false },
      compress: false,
      client_state: {
        guild_versions: {}, highest_last_message_id: "0",
        read_state_version: 0, user_guild_settings_version: -1,
        user_settings_version: -1, private_channels_version: "0",
        api_code_version: 0,
      },
    }});
  }

  _send(data) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(data));
  }

  _cleanup() {
    clearInterval(this.hbTimer);
    this.hbTimer   = null;
    this.connected = false;
    this.ws        = null;
  }
}
