# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the Electron desktop app (normal usage)
npm run dev

# Alternatively, double-click Iniciar.cmd on Windows

# Run a debug/diagnostic script standalone
node debug_quest_activate.mjs
node debug_rpc.mjs
# etc.
```

There is no build step, no linter configured, and no test suite.

## Architecture

This is an **Electron desktop app** wrapping an **Express HTTP server** that serves a **vanilla JS SPA**. The Electron process and the web server are separate processes communicating via IPC.

### Process topology

```
desktop/main.cjs  (Electron main — CommonJS)
  └─ forks server.js via child_process.fork()
       └─ sends IPC { type: "port", port: N } when ready
  └─ BrowserWindow → http://127.0.0.1:<port>
```

`desktop/main.cjs` must stay CommonJS (`.cjs`) because Electron's main process does not support ES modules. Everything else uses ESM (`"type": "module"` in `package.json`).

### Server layer (`server.js`)

Express server on port 4100 (auto-increments on `EADDRINUSE`). Bound to `127.0.0.1` only — not exposed to the network. Serves `public/` as a no-cache static SPA with an `index.html` fallback for all non-API routes.

Auth is cookie-session (`dm.sid`, 7-day TTL). `requireAuth` / `requireOwner` middleware guards all `/api/*` routes except auth and ping.

### Core logic (`botManager.js` — `BotRuntime`)

All Discord operations live in `BotRuntime`. Each authenticated app-user gets their own isolated `BotRuntime` instance (see `userRuntime.js`). Key capabilities:

- **Voice sessions** — uses `discord.js-selfbot-v13` + `@discordjs/voice` to join voice channels with multiple tokens simultaneously. Sessions tracked in `this.sessions` Map (keyed by token).
- **Quest monitor** — persistent WebSocket connection to Discord Gateway (`wss://gateway.discord.gg/?v=10`). On `READY`/`READY_SUPPLEMENTAL` events and quest-related dispatches, auto-enrolls and completes quests via REST. Reconnects after 10 s on WS close. State in `this._questMonitor`.
- **Quest completion** — `WATCH_VIDEO` tasks use `POST /quests/:id/video-progress` with 6-second timestamp steps; game/stream tasks use `POST /quests/:id/heartbeat` with per-minute steps. Both retry up to 3× with rate-limit handling.
- **Moderation** — `runModerationAction` maps action names (`kick`, `ban`, `mute`, `unmute`, `deafen`, `undeafen`) to Discord REST with 300 ms delay between members.
- **Server clone** — copies roles then channels (categories first, then text/voice) from source guild to target guild, using a `roleMap` to reuse existing roles by name.
- **Investigate** — fetches mutual guilds, mutual friends, connected accounts, and scans up to 60 guilds for the target member's nicknames.
- **Purge** — deletes messages in a channel filtered by userId and/or keyword, 1100 ms between deletions.

`discordApiRequest()` in `botManager.js` is the shared REST helper (v10). `discordPost()` in `discordAuth.js` is used only for the login/MFA flow (v10 auth endpoints).

### Per-user isolation (`userRuntime.js`)

Module-level `Map` cache: `userId → BotRuntime`. Each runtime's config is stored at `data/accounts/<fsSafeUserId>/config.json` (structure: `{ guildId, tokens: [{token, channelId}], moderationToken }`).

### Auth store (`authStore.js`)

Users stored in `data/users.json`. Passwords hashed with SHA-512 + random 16-byte salt. The **first registered user** and anyone with username `"manager"` automatically gets `role: "owner"` and `approved: true`. All other new accounts require owner approval before they can log in.

### Paths (`paths.js`)

All runtime data goes under `data/` next to `server.js`. Directories are created on import — no manual setup needed.

### Frontend (`public/`)

Plain HTML + CSS + JS, no framework, no transpilation. `utils.js` provides shared helpers; `app.js` contains all UI logic for the six tabs: Visão Geral, Operação de Call, Clonagem, Missões Orbs, Moderação, Investigação.

### Debug scripts (`debug_*.mjs`)

Standalone ES module scripts meant to be run directly with `node`. They are not imported by the server — they exist for manual API testing/diagnostics and each requires you to hardcode a token or IDs inside the file before running.
