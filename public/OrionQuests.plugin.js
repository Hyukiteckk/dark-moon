/**
 * @name Dark-moonQuest
 * @description Conclusão automática de missões Discord + bypass de Nitro (1080p, emoji cross-server, upload 100MB).
 * @version 1.2.8
 * @author Hyukiteckk
 */
module.exports = class OrionQuests {
    constructor() { this._pollTimer = null; this._flushTimer = null; this._bdPatcher = null; this._fakeProfileCache = null; }

    start() {
        window.orionLock = false;
        window._orionProgressQueue = [];
        this._applyNitroBypasses();
        this._applyProfileDecoding();

        this._pollTimer = setInterval(async () => {
            try {
                const r = await fetch('http://127.0.0.1:4100/api/orion/command');
                const d = await r.json();
                if (d.command === 'start' && !window.orionLock) {
                    window.orionLock = true;
                    this._launch(d.questIds || [], false);
                } else if (d.command === 'discover' && !window.orionLock) {
                    window.orionLock = true;
                    this._launch([], true);
                } else if (d.command === 'idle' || d.command === 'stop') {
                    if (window._orionRuntime) window._orionRuntime.running = false;
                    window.orionLock = false;
                }
            } catch(_) {}
        }, 2000);

        this._flushTimer = setInterval(async () => {
            const q = window._orionProgressQueue;
            if (!q || !q.length) return;
            window._orionProgressQueue = [];
            for (const item of q) {
                try {
                    await fetch('http://127.0.0.1:4100/api/orion/progress', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(item)
                    });
                } catch(_) {}
            }
        }, 1000);
    }

    _launch(allowedIds = [], discoverOnly = false) {
        (async () => {
            "use strict";
            
                /* ── config (Safe for users to edit) ────────────────────────── */
            
                const CONFIG = {
                    NAME: "Dark Moon",
                    VERSION: "V1.0",
                    THEME: "#a855f7",             // discord blurple
                    SUCCESS: "#3BA55C",
                    WARN: "#faa61a",
                    ERR: "#f04747",
                    HIDE_ACTIVITY: false,           // suppress RPC status from friends list
                    MAX_LOG_ITEMS: 60,              // UI log limit
                    AUTO_START: true                // skip picker, start all quests automatically
                };
            
                /* ── internal system limits (DO NOT EDIT) ─────────────────── */
            
                const SYS = Object.freeze({
                    MAX_TIME: 25 * 60 * 1000,       // hard abort per task (25 min)
                    MAX_TASK_FAILURES: 5,           // consecutive network failures
                    MAX_RETRIES: 3,                 // 429/5xx transient error retries
                    IS_DESKTOP: typeof window.DiscordNative !== 'undefined'
                });
            
                // mutable runtime state lives here, CONFIG stays read-only
                const RUNTIME = {
                    running: true,
                    cleanups: new Set(),            // tracks active event listeners for safe shutdown
                    autoEnroll: true,               // whether to auto-enroll in quests before execution
                    autoClaim: true,                // whether to try auto-claiming quest rewards
                    playSound: false                // whether to play an audio cue on quest completion
                };
                window._orionRuntime = RUNTIME;
            
                /* ── audio cue ───────────────────────────────────────────────── */
                const Sound = {
                    play(type) {
                        if (!RUNTIME.playSound) return;
                        try {
                            const Ctx = window.AudioContext || window.webkitAudioContext;
                            if (!Ctx) return;
                            const ctx = new Ctx();
                            const o = ctx.createOscillator();
                            const g = ctx.createGain();
                            o.connect(g); g.connect(ctx.destination);
                            o.type = 'sine';
                            const t0 = ctx.currentTime;
                            if (type === 'done') {
                                // C5 E5 G5 arpeggio
                                o.frequency.setValueAtTime(523.25, t0);
                                o.frequency.setValueAtTime(659.25, t0 + 0.12);
                                o.frequency.setValueAtTime(783.99, t0 + 0.24);
                                g.gain.setValueAtTime(0.55, t0);
                                g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
                                o.start(t0); o.stop(t0 + 0.6);
                            } else {
                                o.frequency.value = 880; // A5
                                g.gain.setValueAtTime(0.45, t0);
                                g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
                                o.start(t0); o.stop(t0 + 0.2);
                            }
                        } catch (_) { }
                    }
                };
            
                const ICONS = Object.freeze({
                    BOLT: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.29-.62L14.5 3h1l-1 7h3.5c.58 0 .57.32.29.62L11 21z"/></svg>`,
                    VIDEO: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`,
                    GAME: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
                    STREAM: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
                    ACTIVITY: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>`,
                    CHECK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
                    CLOCK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
                    STOP: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`
                });
            
                const CONST = Object.freeze({
                    ID: "1412491570820812933",  // blacklisted quest — known to break enrollment
                    EVT: Object.freeze({
                        HEARTBEAT: "QUESTS_SEND_HEARTBEAT_SUCCESS",
                        GAME: "RUNNING_GAMES_CHANGE",
                        RPC: "LOCAL_ACTIVITY_UPDATE"
                    })
                });
            
                // lock is already set by the poll before _launch() is called
            
                /* ── util ──────────────────────────────────────────────────── */
            
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
            
                /* ── error classification ─────────────────────────────────── */
                // Traffic uses this to decide: retry, skip, or propagate.
                // 429/5xx = transient → backoff & retry.  4xx = permanent → skip quest.
            
                const ErrorHandler = {
                    RETRYABLE: new Set([429, 500, 502, 503, 504, 408]),
                    CLIENT_ERRORS: new Set([400, 403, 404, 409, 410]),
            
                    classify(error) {
                        const status = error?.status ?? error?.statusCode;
                        return {
                            isRetryable: this.RETRYABLE.has(status),
                            isClientError: this.CLIENT_ERRORS.has(status),
                            status,
                            message: error?.message ?? error?.body?.message ?? `HTTP ${status ?? 'UNKNOWN'}`
                        };
                    },
            
                    // 404 = quest removed server-side, 403 = region/permission, 410 = gone
                    isSkippableQuest(error) {
                        const status = error?.status;
                        return status === 404 || status === 403 || status === 410;
                    }
                };
            
                /* ── UI + logger ────────────────────────────────────────────
                   Injects a draggable dashboard into Discord's DOM.
                   Doubles as task-state store — render() rebuilds on every update.
                ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */
            
                const Logger = {
                    root: null, tasks: new Map(), tickerId: null,
            
                    init() {
                        const oldUI = document.getElementById('orion-ui'); if (oldUI) oldUI.remove();
                        const oldStyle = document.getElementById('orion-styles'); if (oldStyle) oldStyle.remove();
            
                        const style = document.createElement('style');
                        style.id = 'orion-styles';
                        style.innerHTML = `
                            @keyframes slideIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                            @keyframes fadeOut { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.95); margin: 0; padding: 0; height: 0; border: none; } }
                            
                            #orion-ui {
                                position: fixed; top: 32px; left: auto; right: 20px; width: 380px;
                                max-height: 53vh;
                                background: #07040e; color: #bbaee0;
                                border: 1px solid #261550; border-radius: 14px;
                                box-shadow: 0 0 28px rgba(168,85,247,.22), 0 12px 36px rgba(0,0,0,.85); z-index: 99999;
                                font-family: 'Segoe UI','gg sans','Noto Sans',sans-serif;
                                overflow: hidden; animation: slideIn 0.3s ease; 
                                display: flex; flex-direction: column; box-sizing: border-box;
                                user-select: none;
                            }
                            
                            #orion-head { padding: 12px 16px; background: #0c0719; flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #261550; cursor: grab; }
                            #orion-head.dragging { cursor: grabbing; background: rgba(168,85,247,.06); }
                            #orion-title { font-weight: 700; font-size: 15px; color: #e2baff; display: flex; align-items: center; gap: 8px; }
                            #orion-title svg { color: #a855f7; }
                            .dev-credit { font-size: 12px; margin-left: -4px; padding-top: 2px; font-weight: 500; color: #8b6ab5; }
                            
                            #orion-controls { display: flex; gap: 10px; align-items: center; }
                            .ctrl-btn { cursor: pointer; transition: 0.2s; display: flex; align-items: center; }
                            .ctrl-min { font-size: 15px; font-weight: 700; color: #8b6ab5; line-height: 1; padding: 0 2px; }
                            .ctrl-min:hover { color: #bbaee0; }
                            .ctrl-hide { font-size: 15px; font-weight: 400; color: #8b6ab5; line-height: 1; transition: color .15s; }
                            .ctrl-hide:hover { color: #f47070; }
                            .ctrl-stop { font-size: 11px; font-weight: 700; gap: 4px; padding: 3px 8px 3px 6px; border-radius: 8px; background: transparent; border: 1px solid #f04747; color: #f04747; }
                            .ctrl-stop:hover { background: #f04747; color: #fff; }
                            
                            #orion-logs { padding: 10px 14px; background: #030104; flex: 0 0 auto; font-family: 'Consolas', 'Monaco', monospace; font-size: 11px; height: 110px; overflow-y: auto; border-top: 1px solid #261550; scroll-behavior: smooth; }
                            .log-item { margin-bottom: 6px; display: flex; gap: 8px; line-height: 1.4; padding-bottom: 4px; }
                            .log-ts { opacity: 0.5; min-width: 50px; font-size: 10px; }
                            .c-info { color: #5b8af7; opacity: .8; } .c-success { color: #3ba55c; } .c-err { color: #f04747; } .c-warn { color: #faa61a; } .c-debug { color: #949ba4; }
                            
                            #orion-body { flex: 1 1 auto; padding: 12px; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
                            
                            #orion-picker-form { display: flex; flex-direction: column; min-height: 0; }
                            
                            #orion-ui ::-webkit-scrollbar { width: 4px; height: 4px; }
                            #orion-ui ::-webkit-scrollbar-track { background: transparent; }
                            #orion-ui ::-webkit-scrollbar-thumb { background: #5b2d9e; border-radius: 4px; }
            
                            .task-card { 
                                --state-color: #a855f7;
                                --icon-bg-opacity: 15%;
                                --icon-color: var(--state-color);
                                
                                display: flex; gap: 12px; padding: 10px 12px; margin-bottom: 8px; align-items: center;
                                background: rgba(168,85,247,.06); 
                                border-radius: 8px; border: 1px solid #1a0d35; 
                                border-left: 4px solid var(--state-color);
                                box-shadow: 0 2px 8px rgba(0,0,0,.4); transition: 0.3s; flex-shrink: 0;
                            }
                            .task-card.removing { animation: fadeOut 0.4s forwards; }
                            .task-card.done { --state-color: #3ba55c; --icon-bg-opacity: 100%; --icon-color: #fff; }
                            .task-card.failed { --state-color: #f04747; }
                            .task-card.pending { --state-color: #faa61a; }
                            
                            .task-icon { position: relative; width: 40px; height: 40px; border-radius: 50%; flex: 0 0 auto; background-color: color-mix(in srgb, var(--state-color) var(--icon-bg-opacity), transparent); display: flex; align-items: center; justify-content: center; }
                            
                            .task-card.running .task-icon::before { content: ''; position: absolute; inset: 0; border-radius: 50%; z-index: 1; background: conic-gradient(#a855f7 0% var(--p, 0%), #261550 var(--p, 0%) 100%); -webkit-mask-image: radial-gradient(circle at center, transparent 16px, black 17px); mask-image: radial-gradient(circle at center, transparent 16px, black 17px); }
                            
                            .task-icon-inner { z-index: 2; color: var(--icon-color); display: flex; transition: filter 0.2s, opacity 0.2s; }
                            .task-card.running:hover .task-icon-inner { filter: blur(2px); opacity: 0.3; }
                            
                            .task-icon-overlay { position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: #bbaee0; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
                            .task-card.running:hover .task-icon-overlay { opacity: 1; }
                            
                            .task-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; justify-content: center; }
                            .task-status { font-size: 10px; font-weight: 800; color: var(--state-color); text-transform: uppercase; letter-spacing: 0.5px; }
                            .task-name { font-size: 13px; font-weight: 700; color: #e2baff; letter-spacing: 0.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
                            .task-meta { font-size: 11px; font-weight: 700; color: #8b6ab5; display: flex; justify-content: space-between; }
                            .task-actions { flex: 0 0 auto; display: flex; align-items: center; margin-left: 4px; }
                            
                            .claim-btn, .goto-btn { padding: 6px 10px; border: none; border-radius: 8px; font-size: 11px; font-weight: 700; cursor: pointer; transition: 0.2s; text-transform: uppercase; letter-spacing: 0.2px; white-space: nowrap; font-family: inherit; color: #fff; }
                            .claim-btn { background: #3ba55c; }
                            .claim-btn:hover:not(:disabled) { background: #2d8c4c; }
                            .claim-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                            .claim-btn.failed { background: rgba(168,85,247,.18); color: #bbaee0; }
                            .goto-btn { background: #7c3aed; }
                            .goto-btn:hover:not(:disabled) { background: #9333ea; }
                            
                            .picker-section-title { font-size: 11px; font-weight: 700; color: #8b6ab5; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; }
                            .reward-filters { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; flex-shrink: 0; }
                            
                            .reward-filter, .type-filter { background-color: transparent; border: 2px solid; padding: 4px 10px; border-radius: 24px; font-size: 10px; font-weight: 600; cursor: pointer; transition: 0.2s; color: #6b4d9a; font-family: inherit; }
                            .reward-filter:hover, .type-filter:hover { background-color: color-mix(in srgb, currentColor 25%, transparent); }
                            .reward-filter.off, .type-filter.off { background: transparent; color: #8b6ab5; opacity: 0.4; }
                            
                            .picker-quest-list { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 50px; overflow-y: auto; padding-right: 4px; margin-bottom: 12px; }
                            
                            .quest-pick { display: flex; gap: 12px; padding: 10px; background: rgba(168,85,247,.06); border-radius: 8px; border: 1px solid #1a0d35; border-left-width: 4px; cursor: pointer; transition: 0.2s; align-items: center; user-select: none; flex-shrink: 0; }
                            .quest-pick:hover { filter: brightness(1.15); }
                            .quest-pick.hidden { display: none !important; }
                            
                            .native-cb { appearance: none; width: 20px; height: 20px; margin: 0; flex-shrink: 0; border: 1px solid #5b2d9e; border-radius: 4px; background: transparent; cursor: pointer; transition: 0.15s; display: grid; place-content: center; }
                            .native-cb::before {
                                content: ''; width: 12px; height: 12px; opacity: 0; transition: 0.1s;
                                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'%3E%3C/polyline%3E%3C/svg%3E");
                                background-size: contain; background-repeat: no-repeat; background-position: center;
                            }
                            .native-cb:checked { background: #9333ea; border-color: #a855f7; }
                            .native-cb:checked::before { opacity: 1; }
                            
                            .picker-options { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; flex-shrink: 0; }
                            .orion-option { display: flex; justify-content: space-between; align-items: center; background: rgba(168,85,247,.06); padding: 8px 12px; border-radius: 8px; border: 1px solid #1a0d35; }
                            .orion-option-label { font-size: 13px; font-weight: 500; color: #bbaee0; }
                            
                            .native-toggle { appearance: none; width: 40px; height: 20px; margin: 0; flex-shrink: 0; background: rgba(168,85,247,.06); border-radius: 12px; cursor: pointer; position: relative; transition: 0.2s; border: 1px solid #1a0d35; }
                            .native-toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: white; border-radius: 50%; box-shadow: 0 2px 8px rgba(0,0,0,.4); transition: 0.2s; }
                            .native-toggle:checked { background: #7c3aed; }
                            .native-toggle:checked::after { transform: translateX(20px); }
                            
                            .picker-actions { display: flex; gap: 10px; border-top: 1px solid #261550; padding-top: 8px; flex-shrink: 0; }
                            .quest-pick-btn { flex: 1; padding: 10px; border: 1px solid; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; transition: 0.2s; display: flex; align-items: center; justify-content: center; gap: 6px; font-family: inherit; color: #fff;}
                            .quest-pick-btn.start { background-color: #3ba55c; border-color: #2d8c4c; }
                            .quest-pick-btn.start:hover:not(:disabled) { background: #2d8c4c; border-color: #236b3a; }
                            .quest-pick-btn.deselect { background-color: rgba(168,85,247,.06); border-color: #261550; color: #bbaee0; }
                            .quest-pick-btn.deselect:hover:not(:disabled) { background: rgba(168,85,247,.12); }
                            .quest-pick-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                        `;
                        document.head.appendChild(style);
            
                        this.root = document.createElement('div');
                        this.root.id = 'orion-ui';
                        this.root.innerHTML = `
                            <div id="orion-head">
                                <span id="orion-title">${ICONS.BOLT} ${CONFIG.NAME}
                                    <span class="dev-credit">By Hyukiteckk</span>
                                    <span style="opacity:0.6; font-size:10px; margin-left:4px; padding-top: 3px; font-weight:500;">${CONFIG.VERSION}</span>
                                </span>
                                <div id="orion-controls">
                                    <span class="ctrl-btn ctrl-stop" id="orion-stop" title="Stop script">${ICONS.STOP} STOP</span>
                                    <span class="ctrl-btn ctrl-min" id="orion-min" title="Minimizar">—</span>
                                    <span class="ctrl-btn ctrl-hide" id="orion-close" title="Fechar painel (Shift + .)">&#x2715;</span>
                                </div>
                            </div>
                            <div id="orion-body"><div style="text-align:center; padding:30px; color:#8b6ab5; font-size:12px; font-weight:500;">Initializing System...</div></div>
                            <div id="orion-logs"></div>
                        `;
                        document.body.appendChild(this.root);
            
                        const head = document.getElementById('orion-head');
                        head.addEventListener('mousedown', e => {
                            if (e.target.closest('.ctrl-btn')) return;
                            
                            head.classList.add('dragging');
                            
                            const startX = e.clientX, startY = e.clientY;
                            const rect = this.root.getBoundingClientRect();
                            const initialLeft = rect.left, initialTop = rect.top;
                            
                            this.root.style.left = `${initialLeft}px`;
                            this.root.style.top = `${initialTop}px`;
                            this.root.style.right = 'auto';
                            e.preventDefault();
            
                            const onMouseMove = ev => {
                                this.root.style.left = `${initialLeft + (ev.clientX - startX)}px`;
                                this.root.style.top = `${initialTop + (ev.clientY - startY)}px`;
                            };
            
                            const onMouseUp = () => {
                                head.classList.remove('dragging');
                                document.removeEventListener('mousemove', onMouseMove);
                                document.removeEventListener('mouseup', onMouseUp);
                            };
            
                            document.addEventListener('mousemove', onMouseMove);
                            document.addEventListener('mouseup', onMouseUp);
                        });
            
                        document.getElementById('orion-body').addEventListener('click', async (e) => {
                            if (e.target.classList.contains('goto-btn')) {
                                if (Mods.Router) Mods.Router.transitionTo('/quest-home');
                                return;
                            }
            
                            if (e.target.classList.contains('claim-btn')) {
                                const btn = e.target;
                                if (btn.disabled) return;
            
                                const questId = btn.getAttribute('data-id');
                                const taskData = this.tasks.get(questId);
                                if (!taskData) return;
            
                                btn.innerText = "WAITING...";
                                btn.disabled = true;
                                btn.style.opacity = "0.5";
            
                                // save state so render() respects it
                                this.updateTask(questId, { ...taskData, claimState: 'WAITING' });
            
                                try {
                                    const claimRes = await Tasks.claimReward(questId);
            
                                    if (claimRes?.body?.claimed_at) {
                                        btn.innerText = "CLAIMED!";
                                        this.log(`[Claim] Reward for "${taskData.name}" claimed successfully!`, 'success');
            
                                        this.updateTask(questId, { ...taskData, status: "CLAIMED", claimable: false, claimState: null });
                                        setTimeout(() => this.removeTask(questId), 2000);
                                    }
                                } catch (err) {
                                    this.log(`[Claim] Action required for "${taskData.name}". Check Discord UI for captcha.`, 'warn');
                                    // formally update state to FAILED so render() locks it permanently
                                    this.updateTask(questId, { ...taskData, claimState: 'FAILED' });
                                }
                            }
                        });
            
                        document.getElementById('orion-close').onclick = () => this.toggle();
                        document.getElementById('orion-stop').onclick = () => this.shutdown();
                        document.getElementById('orion-min').onclick = () => this.minimize();
                        document.addEventListener('keydown', e => (e.key === '>' || (e.shiftKey && e.key === '.')) && this.toggle());
            
                        try { if (Notification.permission === "default") Notification.requestPermission(); } catch (e) {
                            this.log(`[Notification] Request permission failed: ${e.message}`, 'debug');
                        }
            
                        this.startTicker();
                    },
            
                    toggle() {
                        const hidden = this.root.style.display === 'none';
                        this.root.style.display = hidden ? 'flex' : 'none';
                        const fab = document.getElementById('orion-fab');
                        if (fab) { fab.style.display = hidden ? 'none' : 'flex'; }
                    },

                    minimize() {
                        const body = document.getElementById('orion-body');
                        const logs = document.getElementById('orion-logs');
                        const btn  = document.getElementById('orion-min');
                        const minimized = body?.style.display === 'none';
                        if (body) body.style.display = minimized ? '' : 'none';
                        if (logs) logs.style.display  = minimized ? '' : 'none';
                        if (btn)  btn.textContent      = minimized ? '—' : '+';
                        this.root.style.maxHeight      = minimized ? '53vh' : 'none';
                    },
            
                    shutdown() {
                        if (!RUNTIME.running) return;
                        RUNTIME.running = false;
                        this.log("[System] Stopping script & cleaning up...", "warn");
            
                        if (this.tickerId) clearInterval(this.tickerId);
            
                        for (const cleanupFn of RUNTIME.cleanups) {
                            try { cleanupFn(); } catch (e) { this.log(`[Cleanup] ${e.message}`, 'debug'); }
                        }
                        RUNTIME.cleanups.clear();
            
                        Patcher.clean();
                        setTimeout(() => {
                            const styles = document.getElementById('orion-styles');
                            if (styles) styles.remove();
                            if (this.root?.parentElement) this.root.remove();
                            const fab = document.getElementById('orion-fab');
                            if (fab) fab.remove();
                            window.orionLock = false;
                        }, 1000);
                    },
            
                    _getPct(t) {
                        if (t.done) return 100;
                        if (t.pending || t.failed || !t.max) return 0;
                        return Math.min(100, (t.cur / t.max) * 100);
                    },
            
                    startTicker() {
                        if (this.tickerId) clearInterval(this.tickerId);
                        this.tickerId = setInterval(() => {
                            if (!RUNTIME.running) return clearInterval(this.tickerId);
                            for (const [id, task] of this.tasks.entries()) {
                                if (task.status === "RUNNING" && task.type !== "ACHIEVEMENT") {
                                    let cur = Math.min(task.cur + 1, task.max);
                                    this.updateTask(id, { cur });
                                }
                            }
                        }, 1000);
                    },
            
                    updateTask(id, data) {
                        const oldData = this.tasks.get(id);
                        const isPending = data.status === "PENDING" || data.status === "QUEUE";
                        const isDone = data.status === "COMPLETED" || data.status === "CLAIMED";
                        const isFailed = data.status === "FAILED";
            
                        const newData = { ...oldData, ...data, done: isDone, pending: isPending, failed: isFailed };
                        this.tasks.set(id, newData);
            
                        if (oldData && oldData.status === newData.status && oldData.removing === newData.removing &&
                            oldData.claimable === newData.claimable && oldData.claimState === newData.claimState &&
                            oldData.actionRequired === newData.actionRequired) {
                            const card = document.getElementById(`orion-task-${id}`);
                            if (card) {
                                const pct = this._getPct(newData);
                                
                                const iconContainer = card.querySelector('.task-icon');
                                if (iconContainer) iconContainer.style.setProperty('--p', `${pct}%`);
                                
                                const overlay = card.querySelector('.task-icon-overlay');
                                if (overlay) overlay.textContent = `${Math.floor(pct)}%`;
            
                                const progressText = card.querySelector('.progress-text');
                                if (progressText) {
                                    const unit = newData.type === 'ACHIEVEMENT' ? '' : 's';
                                    progressText.textContent = `${Math.min(Math.floor(newData.cur), newData.max)} / ${newData.max}${unit}`;
                                }
                                return;
                            }
                        }
                        this.render();
                    },
            
                    removeTask(id) {
                        if (this.tasks.has(id)) {
                            this.tasks.get(id).removing = true;
                            this.render();
                            setTimeout(() => { this.tasks.delete(id); this.render(); }, 500);
                        }
                    },
            
                    log(msg, type = 'info') {
                        const colors = { info: "#a855f7", success: "#3BA55C", warn: "#faa61a", err: "#f04747", debug: "#999" };
                        console.log(`%c[ORION] %c${msg}`, `color: ${CONFIG.THEME}; font-weight: bold;`, `color: ${colors[type] || colors.info}`);
                        try {
                            const box = document.getElementById('orion-logs');
                            if (box && type !== 'debug') {
                                const el = document.createElement('div'); el.className = `log-item c-${type}`;
                                el.innerHTML = `<span class="log-ts">${new Date().toLocaleTimeString().split(' ')[0]}</span> <span>${msg}</span>`;
                                box.appendChild(el); box.scrollTop = box.scrollHeight;
                                while (box.children.length > CONFIG.MAX_LOG_ITEMS) box.firstChild.remove();
                            }
                        } catch (e) { console.debug('[Logger] DOM error:', e.message); }
                    },
            
                    render() {
                        if (document.getElementById('orion-picker-form')) return;
                        const body = document.getElementById('orion-body');
                        if (!body) return;
                        if (!this.tasks.size) return body.innerHTML = `<div style="text-align:center; padding:30px; color:#8b6ab5; font-size:13px;">Waiting for tasks...</div>`;
            
                        const sorted = [...this.tasks.entries()].sort((a, b) => {
                            const ta = a[1], tb = b[1];
                            if (ta.done !== tb.done) return ta.done ? 1 : -1;
                            if (ta.failed !== tb.failed) return ta.failed ? 1 : -1;
                            if (ta.pending !== tb.pending) return ta.pending ? 1 : -1;
                            // among active tasks, highest progress first
                            if (!ta.done && !ta.pending && !tb.done && !tb.pending) {
                                const pctA = ta.max ? ta.cur / ta.max : 0;
                                const pctB = tb.max ? tb.cur / tb.max : 0;
                                return pctB - pctA;
                            }
                            return 0;
                        });
            
                        body.innerHTML = sorted.map(([id, t]) => {
                            const pct = t.pending || t.failed ? 0 : Math.min(100, (t.cur / t.max) * 100).toFixed(1);
                            // state-based icons (done/failed/pending) win over type-based icons.
                            const icon =
                                t.done ? ICONS.CHECK :
                                t.failed ? ICONS.STOP :
                                t.pending ? ICONS.CLOCK :
                                (t.appId && t.appIcon) ? `<img src="https://cdn.discordapp.com/app-icons/${t.appId}/${t.appIcon}.webp?size=64" style="width:26px;height:26px;border-radius:6px;object-fit:cover;display:block;flex-shrink:0" onerror="this.style.display='none'">` :
                                t.type === 'VIDEO' ? ICONS.VIDEO :
                                t.type === 'ACHIEVEMENT' ? ICONS.ACTIVITY :
                                t.type?.includes('GAME') ? ICONS.GAME :
                                t.type?.includes('STREAM') ? ICONS.STREAM :
                                ICONS.BOLT;
            
                            let statusText = t.status === 'CLAIMED' ? 'CLAIMED' : t.done ? 'COMPLETED' : t.status;
                            let progressLabel = t.pending ? 'In Queue' : t.failed ? 'Aborted' : 'Progress';
                            const unit = t.type === 'ACHIEVEMENT' ? '' : 's';
                            
                            let actionBtn = '';
            
                            if (t.claimable) {
                                if (t.claimState === 'WAITING') actionBtn = `<button class="claim-btn" disabled>WAITING...</button>`;
                                else if (t.claimState === 'FAILED') actionBtn = `<button class="claim-btn failed" disabled>ACTION REQUIRED</button>`;
                                else actionBtn = `<button class="claim-btn" data-id="${id}">CLAIM REWARD</button>`;
                            } else if (t.actionRequired === 'ENROLL') {
                                statusText = 'ACTION REQUIRED'; progressLabel = 'Accept quest in Discord';
                                actionBtn = `<button class="goto-btn">GO TO QUESTS</button>`;
                            } else if (t.type === 'ACHIEVEMENT' && t.status === 'RUNNING') {
                                statusText = 'ACTION REQUIRED'; progressLabel = 'Please, complete manually';
                                actionBtn = `<button class="goto-btn">GO TO QUESTS</button>`;
                            }
            
                            const stateClass = t.done ? 'done' : t.failed ? 'failed' : t.pending ? 'pending' : 'running';
                            const removingClass = t.removing ? 'removing' : '';
            
                            let taskMetaHtml = '';
                            if (!t.done) {
                                taskMetaHtml = `
                                <div class="task-meta">
                                    <span>${progressLabel}</span>
                                    ${actionBtn ? '' : `<span class="progress-text">${Math.min(Math.floor(t.cur), t.max)} / ${t.max}${unit}</span>`}
                                </div>`;
                            }
            
                            return `
                            <div id="orion-task-${id}" class="task-card ${stateClass} ${removingClass}">
                                <div class="task-icon" style="--p: ${pct}%">
                                    <div class="task-icon-inner">${icon}</div>
                                    ${stateClass === 'running' ? `<div class="task-icon-overlay">${Math.floor(pct)}%</div>` : ''}
                                </div>
                                <div class="task-info">
                                    <div class="task-status">${statusText}</div>
                                    <div class="task-name" title="${t.name}">${t.name}</div>
                                    ${taskMetaHtml}
                                </div>
                                ${actionBtn ? `<div class="task-actions">${actionBtn}</div>` : ''}
                            </div>`;
                        }).join('');
                    },
            
                    showQuestPicker(quests) {
                        return new Promise((resolve) => {
                            const body = document.getElementById('orion-body');
                            const logs = document.getElementById('orion-logs');
            
                            const closePicker = (data) => {
                                if (logs) logs.style.display = 'block';
                                if (body) { body.classList.remove('picker-mode'); body.innerHTML = ''; }
                                resolve(data);
                            };
            
                            if (!body) return closePicker({ selectedQuests: new Set(), autoEnroll: false, autoClaim: false, playSound: false });
                            if (logs) logs.style.display = 'none';
            
                            const items = [];
                            const rewardTypes = new Map();
                            const questTypes = new Set();
            
                            const REWARD_META = { 1: { label: "IN-GAME", color: "#e67e22" }, 3: { label: "AVATAR DECORATION", color: "#a358f2" }, 4: { label: "ORBS", color: "#a855f7" } };
                            const REWARD_FALLBACK = { label: "OTHER", color: "#949ba4" };
            
                            quests.forEach(q => {
                                const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2;
                                if (!cfg?.tasks) return;
            
                                const typeData = Tasks.detectType(cfg, q.config?.application?.id);
                                if (!typeData) return;
                                // exclude desktop-only quests (play/stream) on any non-desktop clients
                                if (!SYS.IS_DESKTOP && (typeData.type === 'GAME' || typeData.type === 'STREAM')) return;
            
                                const rw = q.config?.rewardsConfig?.rewards?.[0];
                                const rewardType = rw?.type ?? 0;
                                const rewardText = rw?.messages?.name ?? "Unknown Reward";
            
                                const meta = REWARD_META[rewardType] ?? REWARD_FALLBACK;
            
                                const displayType = typeData.type === 'WATCH_VIDEO' ? 'VIDEO' : typeData.type;
                                questTypes.add(displayType);
            
                                if (!rewardTypes.has(rewardType)) {
                                    rewardTypes.set(rewardType, { label: meta.label, count: 0, type: rewardType, color: meta.color });
                                }
                                rewardTypes.get(rewardType).count++;
            
                                items.push({
                                    id: q.id,
                                    name: q.config?.messages?.questName ?? "Unknown Quest",
                                    type: displayType,
                                    rewardType,
                                    rewardText,
                                    color: meta.color
                                });
                            });
            
                            if (!items.length) return closePicker({ selectedQuests: new Set(), autoEnroll: false, autoClaim: false, playSound: false });
            
                            const buildCard = (q) => `
                                <label class="quest-pick" data-rt="${q.rewardType}" data-qt="${q.type}" style="border-left-color: ${q.color};">
                                    <input type="checkbox" name="quests" value="${q.id}" class="native-cb" checked>
                                    <div class="task-info">
                                        <div class="task-name" title="${q.name}">${q.name}</div>
                                        <div class="task-meta" style="justify-content: flex-start; gap: 8px;">
                                            <span style="text-transform: uppercase; color: #6b4d9a;">${q.type}</span>
                                            <span style="color: ${q.color};">${q.rewardText}</span>
                                        </div>
                                    </div>
                                </label>`;
            
                            const buildToggle = (name, label, isChecked) => `
                                <div class="orion-option">
                                    <span class="orion-option-label">${label}</span>
                                    <input type="checkbox" name="${name}" class="native-toggle" ${isChecked ? 'checked' : ''}>
                                </div>`;
            
                            body.innerHTML = `
                                <form id="orion-picker-form">
                                    ${rewardTypes.size > 1 ? `
                                        <div class="picker-section-title">Filter By Reward</div>
                                        <div class="reward-filters">
                                            ${[...rewardTypes.values()].map(rt => `<button type="button" class="reward-filter" data-rt="${rt.type}" style="color: ${rt.color}; border-color: ${rt.color};">${rt.label} (${rt.count})</button>`).join('')}
                                        </div>
                                    ` : ''}
                                    ${questTypes.size > 1 ? `
                                        <div class="picker-section-title">Filter By Type</div>
                                        <div class="reward-filters">
                                            ${[...questTypes].map(t => `<button type="button" class="type-filter" data-qt="${t}">${t}</button>`).join('')}
                                        </div>
                                    ` : ''}
                                    
                                    <div id="orion-quest-list" class="picker-quest-list">${items.map(buildCard).join('')}
                                        <div id="orion-no-quests" style="display: none; margin: auto; text-align: center; color: #8b6ab5; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
                                            No quests available
                                        </div>
                                    </div>
                                    
                                    <div class="picker-section-title">Options</div>
                                    <div class="picker-options">
                                        ${buildToggle('autoEnroll', 'Auto-enroll in quests', RUNTIME.autoEnroll)}
                                        ${buildToggle('autoClaim', 'Auto-claim rewards', RUNTIME.autoClaim)}
                                        ${buildToggle('playSound', 'Sound on completion', RUNTIME.playSound)}
                                    </div>
                                    
                                    <div class="picker-actions">
                                        <button type="button" class="quest-pick-btn deselect" id="select-all-btn">DESELECT ALL</button>
                                        <button type="submit" class="quest-pick-btn start" id="start-btn">${ICONS.BOLT} <span id="start-btn-text">START (${items.length})</span></button>
                                    </div>
                                </form>`;
            
                            const form = document.getElementById('orion-picker-form');
                            const selectAllBtn = document.getElementById('select-all-btn');
                            const startBtn = document.getElementById('start-btn');
            
                            const getVisibleCheckboxes = () => Array.from(form.querySelectorAll('.quest-pick input[type="checkbox"]'))
                                .filter(cb => !cb.closest('.quest-pick').classList.contains('hidden'));
            
                            const syncUI = () => {
                                const visibleCbs = getVisibleCheckboxes();
                                const totalChecked = visibleCbs.filter(cb => cb.checked).length;
            
                                const startBtnText = document.getElementById('start-btn-text');
                                if (startBtnText) startBtnText.textContent = `START (${totalChecked})`;
                                startBtn.disabled = totalChecked === 0;
            
                                if (visibleCbs.length === 0) {
                                    selectAllBtn.disabled = true;
                                    selectAllBtn.textContent = 'SELECT ALL';
                                } else {
                                    selectAllBtn.disabled = false;
                                    selectAllBtn.textContent = visibleCbs.every(cb => cb.checked) ? 'DESELECT ALL' : 'SELECT ALL';
                                }
            
                                const noQuestsMsg = document.getElementById('orion-no-quests');
                                if (noQuestsMsg) {
                                    noQuestsMsg.style.display = visibleCbs.length === 0 ? 'block' : 'none';
                                }
                            };
            
                            form.addEventListener('change', (e) => { if (e.target.name === 'quests') syncUI(); });
            
                            const activeRewards = new Set([...rewardTypes.keys()].map(String));
                            const activeTypes = new Set([...questTypes]);
            
                            const applyFilters = () => {
                                form.querySelectorAll('.quest-pick').forEach(el => {
                                    const rt = el.getAttribute('data-rt');
                                    const qt = el.getAttribute('data-qt');
                                    el.classList.toggle('hidden', !(activeRewards.has(rt) && activeTypes.has(qt)));
                                });
                                syncUI();
                            };
            
                            const FILTER_KINDS = [
                                { cls: 'reward-filter', attr: 'data-rt', set: activeRewards },
                                { cls: 'type-filter', attr: 'data-qt', set: activeTypes }
                            ];
            
                            form.addEventListener('click', (e) => {
                                const kind = FILTER_KINDS.find(k => e.target.classList.contains(k.cls));
                                if (kind) {
                                    e.preventDefault();
                                    const value = e.target.getAttribute(kind.attr);
                                    e.target.classList.toggle('off');
                                    if (e.target.classList.contains('off')) kind.set.delete(value);
                                    else kind.set.add(value);
                                    applyFilters();
                                    return;
                                }
            
                                if (e.target.id === 'select-all-btn') {
                                    e.preventDefault();
                                    const visibleCbs = getVisibleCheckboxes();
                                    if (visibleCbs.length === 0) return;
            
                                    const shouldCheck = !visibleCbs.every(cb => cb.checked);
                                    visibleCbs.forEach(cb => { cb.checked = shouldCheck; });
                                    syncUI();
                                }
                            });
            
                            form.addEventListener('submit', (e) => {
                                e.preventDefault();
                                
                                const selected = getVisibleCheckboxes().filter(cb => cb.checked);
                                if (selected.length === 0) return;
            
                                const data = new FormData(form);
            
                                closePicker({
                                    selectedQuests: new Set(selected.map(cb => cb.value)),
                                    autoEnroll: data.has('autoEnroll'),
                                    autoClaim: data.has('autoClaim'),
                                    playSound: data.has('playSound')
                                });
                            });
            
                            // apply layout lock and sync initial button states
                            body.classList.add('picker-mode');
                            syncUI();
                        });
                    }
                };
            
                /* ── request queue ────────────────────────────────────────────
                   FIFO queue processed one-at-a-time to respect rate limits.
                   Retryable errors (429, 5xx) re-queue with exponential backoff.
                   Client errors (4xx) reject immediately — caller decides what to do.
                ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */
            
                const Traffic = {
                    queue: [], processing: false,
            
                    async enqueue(url, body) {
                        if (!RUNTIME.running) return Promise.reject(new Error("Stopped"));
                        return new Promise((resolve, reject) => {
                            this.queue.push({ url, body, resolve, reject, attempts: 0 });
                            this.process();
                        });
                    },
            
                    async process() {
                        if (this.processing || this.queue.length === 0) return;
                        this.processing = true;
            
                        while (this.queue.length > 0) {
                            if (!RUNTIME.running) {
                                this.queue.forEach(req => req.reject(new Error("Shutdown")));
                                this.queue = [];
                                this.processing = false;
                                return;
                            }
            
                            const req = this.queue.shift();
                            try {
                                const res = await Mods.API.post({ url: req.url, body: req.body });
                                req.resolve(res);
                            } catch (e) {
                                const err = ErrorHandler.classify(e);
            
                                if (err.isRetryable && req.attempts < SYS.MAX_RETRIES) {
                                    req.attempts++;
                                    const delay = (e.body?.retry_after ?? Math.pow(2, req.attempts)) * 1000;
                                    const isGlobal = e.body?.global === true;
            
                                    Logger.log(`[Network] Retry ${req.attempts}/${SYS.MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s (HTTP ${err.status})`, 'warn');
            
                                    const retryJitter = rnd(200, 800);
            
                                    if (isGlobal) {
                                        // Freeze queue on global rate limits to prevent API abuse
                                        this.queue.unshift(req);
                                        await sleep(delay + retryJitter);
                                    } else {
                                        // Non-blocking retry for endpoint-specific limits
                                        setTimeout(() => {
                                            if (RUNTIME.running) {
                                                this.queue.push(req);
                                                this.process();
                                            }
                                        }, delay + retryJitter);
                                    }
                                } else if (err.isClientError) {
                                    Logger.log(`[Network] HTTP ${err.status}: ${req.url}`, 'debug');
                                    req.reject(e);
                                } else {
                                    Logger.log(`[Network] Request to ${req.url} failed: ${err.message}`, 'err');
                                    req.reject(e);
                                }
                            }
            
                            await sleep(rnd(1200, 1800)); // delay between API calls
                        }
                        this.processing = false;
                    }
                };
            
                /* ── store patching ───────────────────────────────────────────
                   Monkey-patches Discord's RunStore/StreamStore so the client
                   believes a game process is running. Fake PIDs, exePaths, and
                   RPC payloads are injected and cleaned up on task completion.
                ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */
            
                let Mods = {};  // populated by loadModules() — holds Discord webpack internals
            
                const Patcher = {
                    games: [], realGames: null, realPID: null, active: false,
            
                    // stash originals so we can restore them on cleanup
                    init(Store) {
                        if (!Store) return;
                        this.realGames = Store.getRunningGames;
                        this.realPID = Store.getGameForPID;
                    },
            
                    // swap between real and patched store methods
                    toggle(on) {
                        if (on && !this.active) {
                            Mods.RunStore.getRunningGames = () => [...this.realGames.call(Mods.RunStore), ...this.games];
                            Mods.RunStore.getGameForPID = (pid) => this.games.find(g => g.pid === pid) || this.realPID.call(Mods.RunStore, pid);
                            this.active = true;
                        } else if (!on && this.active) {
                            Mods.RunStore.getRunningGames = this.realGames;
                            Mods.RunStore.getGameForPID = this.realPID;
                            this.active = false;
                        }
                    },
            
                    add(g) {
                        if (this.games.some(x => x.pid === g.pid)) return;
                        this.games.push(g);
                        this.toggle(true);
                        this.dispatch(g, []);
                        this.rpc(g);
                    },
            
                    remove(g) {
                        const before = this.games.length;
                        this.games = this.games.filter(x => x.pid !== g.pid);
                        if (this.games.length === before) return;
            
                        this.dispatch([], [g]);
                        if (!this.games.length) {
                            this.toggle(false);
                            this.rpc(null);
                        } else {
                            this.rpc(this.games[0]);
                        }
                    },
            
                    dispatch(added, removed) {
                        Mods.Dispatcher?.dispatch({
                            type: CONST.EVT.GAME,
                            added: added ? [added] : [],
                            removed: removed ? [removed] : [],
                            games: Mods.RunStore.getRunningGames()
                        });
                    },
            
                    rpc(g) {
                        if (CONFIG.HIDE_ACTIVITY && g) return;
                        try {
                            Mods.Dispatcher?.dispatch({
                                type: CONST.EVT.RPC,
                                socketId: null,
                                // use a fake PID (9999) and null activity to clear the playing status
                                pid: g ? g.pid : 9999,
                                activity: g ? {
                                    application_id: g.id,
                                    name: g.name,
                                    type: 0,
                                    details: null,
                                    state: null,
                                    timestamps: { start: g.start },
                                    icon: g.icon,
                                    assets: null
                                } : null
                            });
                        } catch (e) {
                            Logger.log(`[RPC Cleanup] ${e.message}`, 'debug');
                        }
                    },
            
                    clean() {
                        this.games = [];
                        this.toggle(false);
                        this.rpc(null);
                    }
                };
            
                /* ── task handlers ────────────────────────────────────────────
                   Each quest type (VIDEO, GAME, STREAM, ACTIVITY) has its own
                   handler. GAME/STREAM share a generic() path that patches stores
                   and listens for heartbeat events. VIDEO and ACTIVITY poll in a
                   loop instead. Failed quest IDs go into `skipped` so we don't
                   re-attempt them on the next cycle.
                ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */
            
                const Tasks = {
                    skipped: new Set(),  // quest IDs that returned 4xx — no point retrying
            
                    sanitize(name) { return name.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, " "); },
            
                    // match task keys from quest config to our handler types
                    // order matters — ACHIEVEMENT_IN_ACTIVITY must match before generic ACTIVITY
                    detectType(cfg, applicationId) {
                        const taskKeys = Object.keys(cfg.tasks);
                        const typeMap = [
                            { key: "PLAY", type: "GAME" },
                            { key: "STREAM", type: "STREAM" },
                            { key: "VIDEO", type: "WATCH_VIDEO" },
                            { key: "ACHIEVEMENT_IN_ACTIVITY", type: "ACHIEVEMENT" },
                            { key: "ACTIVITY", type: "ACTIVITY" }
                        ];
            
                        for (const { key, type } of typeMap) {
                            const keyName = taskKeys.find(k => k.includes(key));
                            if (keyName) return { type, keyName, target: cfg.tasks[keyName]?.target ?? 0 };
                        }
            
                        if (applicationId) {
                            return { type: "GAME", keyName: "PLAY_ON_DESKTOP", target: cfg.tasks[taskKeys[0]]?.target ?? 0 };
                        }
            
                        return null;
                    },
            
                    // pull real exe metadata from Discord's app registry; falls back to synthetic paths
                    async fetchGameData(appId, appName) {
                        try {
                            const res = await Mods.API.get({ url: `/applications/public?application_ids=${appId}` });
                            const appData = res?.body?.[0];
                            const exeEntry = appData?.executables?.find(x => x.os === "win32");
                            const rawExe = exeEntry ? exeEntry.name.replace(">", "") : `${this.sanitize(appName)}.exe`;
                            const cleanName = this.sanitize(appData?.name || appName);
            
                            return {
                                name: appData?.name || appName,
                                icon: appData?.icon,
                                exeName: rawExe,
                                cmdLine: `C:\\Program Files\\${cleanName}\\${rawExe}`,
                                exePath: `c:/program files/${cleanName.toLowerCase()}/${rawExe}`,
                                id: appId
                            };
                        } catch (e) {
                            Logger.log(`[FetchGame] Fallback for ${appName}: ${e?.message ?? e}`, 'debug');
                            const cleanName = this.sanitize(appName);
                            const safeExe = `${cleanName.replace(/\s+/g, "")}.exe`;
                            return {
                                name: appName, exeName: safeExe,
                                cmdLine: `C:\\Program Files\\${cleanName}\\${safeExe}`,
                                exePath: `c:/program files/${cleanName.toLowerCase()}/${safeExe}`,
                                id: appId
                            };
                        }
                    },
            
                    async claimReward(questId, captchaKey) {
                        const body = { platform: 0, location: 11, is_targeted: false, metadata_raw: null, metadata_sealed: null, traffic_metadata_raw: null, traffic_metadata_sealed: null };
                        if (captchaKey) body.captcha_key = captchaKey;
                        return await Mods.API.post({ url: `/quests/${questId}/claim-reward`, body });
                    },

                    getCaptchaToken(sitekey, rqdata, rqtoken) {
                        return new Promise((resolve, reject) => {
                            const TIMEOUT = 90_000;
                            let settled = false;

                            const done = (token) => {
                                if (settled) return;
                                settled = true;
                                clearTimeout(tid);
                                try { Mods.Dispatcher.unsubscribe('CAPTCHA_COMPLETED', onDone); } catch {}
                                try { Mods.Dispatcher.unsubscribe('CAPTCHA_CANCEL', onCancel); } catch {}
                                try { Mods.Dispatcher.unsubscribe('CAPTCHA_CANCELED', onCancel); } catch {}
                                token ? resolve(token) : reject(new Error('Captcha cancelado'));
                            };

                            const tid = setTimeout(() => done(null), TIMEOUT);
                            const onDone   = (e) => done(e?.captchaToken ?? e?.token ?? null);
                            const onCancel = () => done(null);

                            Mods.Dispatcher.subscribe('CAPTCHA_COMPLETED', onDone);
                            Mods.Dispatcher.subscribe('CAPTCHA_CANCEL', onCancel);
                            Mods.Dispatcher.subscribe('CAPTCHA_CANCELED', onCancel);

                            Mods.Dispatcher.dispatch({
                                type: 'CAPTCHA_REQUIRED',
                                captchaRequiredData: {
                                    captcha_sitekey: sitekey,
                                    captcha_rqdata: rqdata,
                                    captcha_rqtoken: rqtoken,
                                    captcha_service: 'hcaptcha'
                                }
                            });
                        });
                    },
            
                    // safely aborts a broken or timed-out task, marks it as FAILED in the UI,
                    // and adds it to the skip list to prevent infinite retry loops
                    failTask(q, t, reason) {
                        const currentProgress = Logger.tasks.get(q.id)?.cur ?? 0;
                        Logger.updateTask(q.id, { name: t.name, type: t.type, cur: currentProgress, max: t.target, status: "FAILED" });
                        Logger.log(`[Task] Aborted "${t.name}": ${reason}`, 'err');
                        Tasks.skipped.add(q.id);
                        setTimeout(() => Logger.removeTask(q.id), 2000); 
                    },
            
                    // sends fake video-progress timestamps until Discord marks the quest done
                    async VIDEO(q, t, s) {
                        // read progress from actual task key, fall back to type name
                        let cur = s?.progress?.[t.keyName]?.value ?? s?.progress?.[t.type]?.value ?? 0;
                        let failCount = 0;
            
                        Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });
            
                        const startTime = Date.now();
                        let calls = 0;
            
                        // Simulate initial player buffer ping
                        if (cur === 0) {
                            await sleep(rnd(200, 350));
                            cur = 0.2 + (Math.random() * 0.05);
                            try {
                                await Traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: Number(cur.toFixed(6)) });
                                calls++;
                            } catch (e) { Logger.log(`[Video] Initial ping failed: ${e.message}`, 'debug'); }
                        }
            
                        while (cur < t.target && RUNTIME.running) {
                            // simulate real client polling interval (7-9.5s)
                            const delayMs = rnd(7000, 9500);
                            await sleep(delayMs);
            
                            // calculate elapsed time with execution jitter
                            const elapsedSec = (delayMs / 1000) + (Math.random() * 0.02 - 0.01);
                            cur += elapsedSec;
            
                            // match Discord's 6-decimal float format
                            const payloadTs = Number(Math.min(t.target, cur).toFixed(6));
            
                            try {
                                const r = await Traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: payloadTs });
                                calls++;
                                // sync with server if it reports higher progress
                                const serverVal = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.WATCH_VIDEO?.value;
                                if (serverVal > cur) cur = Math.min(t.target, serverVal);
                                if (r?.body?.completed_at) break;
                                failCount = 0;
                            } catch (e) {
                                failCount++;
                                const err = ErrorHandler.classify(e);
                                if (err.isClientError) {
                                    Logger.log(`[Task] Video quest unavailable (HTTP ${err.status}). Skipping.`, 'warn');
                                    return Tasks.failTask(q, t, `Client Error ${err.status}`);
                                }
                                if (failCount >= SYS.MAX_TASK_FAILURES) {
                                    return Tasks.failTask(q, t, 'Too many network failures');
                                }
                                Logger.log(`[Task] VIDEO progress failed (${failCount}/${SYS.MAX_TASK_FAILURES}): ${err.message}`, 'debug');
                            }
            
                            Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });
            
                            if (Date.now() - startTime > SYS.MAX_TIME) {
                                return Tasks.failTask(q, t, 'Timeout exceeded');
                            }
                        }
                        if (RUNTIME.running) {
                            Logger.log(`[Task] VIDEO "${t.name}" done in ${calls} API calls`, 'debug');
                            Tasks.finish(q, t);
                        }
                    },
            
                    GAME(q, t, s) { return Tasks.generic(q, t, "GAME", "PLAY_ON_DESKTOP", s); },
                    STREAM(q, t, s) { return Tasks.generic(q, t, "STREAM", "STREAM_ON_DESKTOP", s); },
            
                    // shared path for GAME/STREAM — injects fake process, subscribes to heartbeat events
                    async generic(q, t, type, key, s) {
                        if (!RUNTIME.running) return;
                        const gameData = await this.fetchGameData(t.appId, t.name);
            
                        return new Promise(resolve => {
                            const pid = rnd(2500, 12500) * 4;
                            const game = {
                                id: gameData.id, name: gameData.name, icon: gameData.icon,
                                pid, pidPath: [pid], processName: gameData.name, start: Date.now(),
                                exeName: gameData.exeName, exePath: gameData.exePath, cmdLine: gameData.cmdLine,
                                executables: [{ os: 'win32', name: gameData.exeName, is_launcher: false }],
                                windowHandle: 0, fullscreenType: 0, overlay: true, sandboxed: false,
                                hidden: false, isLauncher: false
                            };
            
                            let cleanupHook;
                            let cleaned = false;
                            let safetyTimer;
            
                            if (type === "STREAM") {
                                const real = Mods.StreamStore?.getStreamerActiveStreamMetadata;
                                if (Mods.StreamStore) {
                                    Mods.StreamStore.getStreamerActiveStreamMetadata = () => ({ id: gameData.id, pid, sourceName: gameData.name });
                                }
                                cleanupHook = () => { if (Mods.StreamStore && real) Mods.StreamStore.getStreamerActiveStreamMetadata = real; };
                            } else {
                                Patcher.add(game);
                                cleanupHook = () => Patcher.remove(game);
                            }
            
                            Logger.updateTask(q.id, { name: t.name, type, cur: 0, max: t.target, status: "RUNNING" });
                            Logger.log(`[Task] Started ${type}: ${gameData.name}`, 'info');
            
                            const finish = () => {
                                if (cleaned) return;
                                cleaned = true;
                                clearTimeout(safetyTimer);
                                try { cleanupHook(); } catch (e) { Logger.log(`[Task] Cleanup: ${e.message}`, 'debug'); }
                                try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, check); } catch (e) {
                                    Logger.log(`[Dispatcher] Unsubscribe failed: ${e.message}`, 'debug');
                                }
                                RUNTIME.cleanups.delete(finish);
                            };
            
                            safetyTimer = setTimeout(() => {
                                if (RUNTIME.running) Tasks.failTask(q, t, 'Timeout exceeded (25m)');
                                finish();
                                resolve();
                            }, SYS.MAX_TIME);
            
                            const check = (d) => {
                                if (!RUNTIME.running) { finish(); resolve(); return; }
                                if (d?.questId !== q.id) return;
            
                                const prog = d.userStatus?.progress?.[key]?.value ?? d.userStatus?.streamProgressSeconds ?? 0;
                                Logger.updateTask(q.id, { name: t.name, type, cur: prog, max: t.target, status: "RUNNING" });
            
                                if (prog >= t.target) {
                                    finish();
                                    Tasks.finish(q, t);
                                    resolve();
                                }
                            };
            
                            Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT, check);
                            RUNTIME.cleanups.add(finish);
                        });
                    },
            
                    // ACHIEVEMENT_IN_ACTIVITY — target is usually 1 (a milestone, not seconds).
                    // Strategy 1: try multiple stream_key formats (none, activities:, call:).
                    // Strategy 2: inject app via RPC and wait for Discord to send heartbeat (60s).
                    // Strategy 3: passive — wait for user to join the activity manually.
                    async ACHIEVEMENT(q, t) {
                        Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING" });

                        let chan = null;
                        try {
                            chan = Mods.ChanStore?.getSortedPrivateChannels()?.[0]?.id
                                ?? Object.values(Mods.GuildChanStore?.getAllGuilds() ?? {}).find(g => g?.VOCAL?.length)?.VOCAL?.[0]?.channel?.id;
                        } catch (e) { Logger.log(`[Achievement] Channel lookup: ${e.message}`, 'debug'); }

                        // Strategy 1: try multiple stream_key formats
                        const keysToTry = chan ? [
                            null,
                            `activities:${chan}:${rnd(1000, 9999)}`,
                            `call:${chan}:${rnd(1000, 9999)}`
                        ] : [];

                        for (const streamKey of keysToTry) {
                            if (!RUNTIME.running) return;
                            const body = streamKey ? { stream_key: streamKey, terminal: false } : { terminal: false };
                            Logger.log(`[Achievement] Trying stream_key format: ${streamKey ?? 'none'}`, 'debug');
                            try {
                                const r = await Traffic.enqueue(`/quests/${q.id}/heartbeat`, body);
                                let cur = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? 0;
                                Logger.log(`[Achievement] Heartbeat accepted (format: ${streamKey ?? 'none'}), progress: ${cur}`, 'info');
                                Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur, max: t.target, status: "RUNNING" });

                                let failCount = 0;
                                while (cur < t.target && RUNTIME.running) {
                                    await sleep(rnd(19000, 22000));
                                    try {
                                        const r2 = await Traffic.enqueue(`/quests/${q.id}/heartbeat`, body);
                                        cur = r2?.body?.progress?.[t.keyName]?.value ?? r2?.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? cur;
                                        Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur, max: t.target, status: "RUNNING" });
                                        failCount = 0;
                                    } catch (e) {
                                        const err = ErrorHandler.classify(e);
                                        if (err.isClientError || ++failCount >= SYS.MAX_TASK_FAILURES) break;
                                    }
                                }

                                if (cur >= t.target && RUNTIME.running) {
                                    try { await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { ...(streamKey ? { stream_key: streamKey } : {}), terminal: true }); } catch (_) {}
                                    return Tasks.finish(q, t);
                                }
                                break; // format worked but didn't complete — stop trying more formats
                            } catch (e) {
                                const err = ErrorHandler.classify(e);
                                if (err.isClientError) {
                                    Logger.log(`[Achievement] Format "${streamKey ?? 'none'}" → HTTP ${err.status}, trying next...`, 'debug');
                                    continue;
                                }
                                throw e;
                            }
                        }

                        if (!RUNTIME.running) return;

                        // Strategy 2: inject app via RPC, wait for Discord's own heartbeat (60s window)
                        if (t.appId) {
                            Logger.log(`[Achievement] Trying RPC injection for "${t.name}"...`, 'info');
                            try {
                                const gameData = await Tasks.fetchGameData(t.appId, t.name);
                                const pid = rnd(2500, 12500) * 4;
                                const game = {
                                    id: gameData.id, name: gameData.name, icon: gameData.icon,
                                    pid, pidPath: [pid], processName: gameData.name, start: Date.now(),
                                    exeName: gameData.exeName, exePath: gameData.exePath, cmdLine: gameData.cmdLine,
                                    executables: [{ os: 'win32', name: gameData.exeName, is_launcher: false }],
                                    windowHandle: 0, fullscreenType: 0, overlay: true, sandboxed: false,
                                    hidden: false, isLauncher: false
                                };
                                Patcher.add(game);

                                const achieved = await new Promise(resolve => {
                                    let done = false;
                                    const cleanup = () => {
                                        if (done) return; done = true;
                                        try { Patcher.remove(game); } catch (_) {}
                                        try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, check); } catch (_) {}
                                        RUNTIME.cleanups.delete(cleanup);
                                    };
                                    const timer = setTimeout(() => { cleanup(); resolve(false); }, 60000);
                                    const check = (d) => {
                                        if (!RUNTIME.running) { clearTimeout(timer); cleanup(); resolve(false); return; }
                                        if (d?.questId !== q.id) return;
                                        const prog = d.userStatus?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? 0;
                                        Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: prog, max: t.target, status: "RUNNING" });
                                        if (prog >= t.target) { clearTimeout(timer); cleanup(); resolve(true); }
                                    };
                                    Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT, check);
                                    RUNTIME.cleanups.add(cleanup);
                                });

                                if (achieved && RUNTIME.running) return Tasks.finish(q, t);
                            } catch (e) {
                                Logger.log(`[Achievement] RPC injection failed: ${e.message}`, 'debug');
                            }
                        }

                        if (!RUNTIME.running) return;

                        // Strategy 3: passive — wait for user to join the activity manually
                        Logger.log(`[Task] Action required: Join Activity to earn "${t.name}"`, 'warn');
                        Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING", actionRequired: true });

                        return new Promise(resolve => {
                            let cleaned = false;
                            let safetyTimer;

                            const finish = () => {
                                if (cleaned) return;
                                cleaned = true;
                                clearTimeout(safetyTimer);
                                try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, check); } catch (_) {}
                                RUNTIME.cleanups.delete(finish);
                            };

                            safetyTimer = setTimeout(() => {
                                if (RUNTIME.running) Tasks.failTask(q, t, 'Timeout - achievement not earned');
                                finish(); resolve();
                            }, SYS.MAX_TIME);

                            const check = (d) => {
                                if (!RUNTIME.running) { finish(); resolve(); return; }
                                if (d?.questId !== q.id) return;
                                const prog = d.userStatus?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? 0;
                                Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: prog, max: t.target, status: "RUNNING" });
                                if (prog >= t.target) { finish(); Tasks.finish(q, t); resolve(); }
                            };

                            Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT, check);
                            RUNTIME.cleanups.add(finish);
                        });
                    },
            
                    // heartbeat loop against a voice channel to simulate activity participation
                    async ACTIVITY(q, t) {
                        let chan = null;
                        try {
                            chan = Mods.ChanStore?.getSortedPrivateChannels()?.[0]?.id
                                ?? Object.values(Mods.GuildChanStore?.getAllGuilds() ?? {}).find(g => g?.VOCAL?.length)?.VOCAL?.[0]?.channel?.id;
                        } catch (e) {
                            Logger.log(`[Task] ACTIVITY channel lookup error: ${e.message}`, 'debug');
                        }
            
                        if (!chan) {
                            return Tasks.failTask(q, t, 'No voice channel found');
                        }
            
                        const key = `call:${chan}:${rnd(1000, 9999)}`;
                        let cur = 0;
                        let failCount = 0;
                        Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
            
                        const startTime = Date.now();
            
                        while (cur < t.target && RUNTIME.running) {
                            try {
                                const r = await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: false });
                                cur = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.PLAY_ACTIVITY?.value ?? cur + 20;
                                Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
                                failCount = 0;
                                if (cur >= t.target) {
                                    try { await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: true }); }
                                    catch (e) { Logger.log(`[ACTIVITY] Final heartbeat failed: ${e?.message}`, 'debug'); }
                                    break;
                                }
                            } catch (e) {
                                failCount++;
                                const err = ErrorHandler.classify(e);
                                if (err.isClientError) {
                                    Logger.log(`[Task] Activity quest unavailable (HTTP ${err.status}). Skipping.`, 'warn');
                                    return Tasks.failTask(q, t, `Client Error ${err.status}`);
                                }
                                if (failCount >= SYS.MAX_TASK_FAILURES) {
                                    return Tasks.failTask(q, t, 'Too many network failures');
                                }
                                Logger.log(`[Task] ACTIVITY heartbeat failed (${failCount}/${SYS.MAX_TASK_FAILURES}): ${err.message}`, 'debug');
                            }
            
                            if (Date.now() - startTime > SYS.MAX_TIME) {
                                return Tasks.failTask(q, t, 'Timeout exceeded');
                            }
                            await sleep(rnd(19000, 22000));
                        }
                        if (RUNTIME.running && cur >= t.target) Tasks.finish(q, t);
                    },
            
                    async finish(q, t) {
                        Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED" });
                        Logger.log(`[Task] Completed "${t.name}"!`, 'success');
                        Sound.play('tick');
            
                        try {
                            if (typeof Notification !== 'undefined' && Notification.permission === "granted") {
                                new Notification("Orion: Quest Completed", { body: t.name, icon: "https://cdn.discordapp.com/emojis/1120042457007792168.webp", tag: `orion-${q.id}` });
                            }
                        } catch (e) { Logger.log(`[Notification] ${e.message}`, 'debug'); }
            
                        if (RUNTIME.autoClaim) {
                            try {
                                await sleep(rnd(2500, 6000));
                                if (!RUNTIME.running) return;
                                // optimistic claim — try without captcha first
                                const claimRes = await this.claimReward(q.id);

                                if (claimRes?.body?.claimed_at) {
                                    Logger.log(`[Claim] Recompensa de "${t.name}" coletada automaticamente!`, 'success');
                                    Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                                    setTimeout(() => Logger.removeTask(q.id), 2000);
                                    return;
                                }
                            } catch (e) {
                                const needsCaptcha = e?.body?.captcha_key || e?.body?.captcha_sitekey;
                                if (needsCaptcha) {
                                    Logger.log(`[Claim] Captcha detectado para "${t.name}". Abrindo verificação no Discord...`, 'warn');
                                    try {
                                        const captchaToken = await this.getCaptchaToken(
                                            e.body.captcha_sitekey,
                                            e.body.captcha_rqdata,
                                            e.body.captcha_rqtoken
                                        );
                                        if (!RUNTIME.running) return;
                                        const retryRes = await this.claimReward(q.id, captchaToken);
                                        if (retryRes?.body?.claimed_at) {
                                            Logger.log(`[Claim] Recompensa de "${t.name}" coletada após captcha!`, 'success');
                                            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                                            setTimeout(() => Logger.removeTask(q.id), 2000);
                                            return;
                                        }
                                    } catch (captchaErr) {
                                        Logger.log(`[Claim] Captcha falhou para "${t.name}": ${captchaErr.message}`, 'err');
                                    }
                                } else {
                                    Logger.log(`[Claim] Auto-claim falhou para "${t.name}": ${e?.body?.message ?? e?.message}`, 'err');
                                }
                            }
                        }
            
                        // show claim button instead of auto-removing
                        Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED", claimable: true, questId: q.id });
                    }
                };
            
                /* ── webpack module extraction ───────────────────────────────
                   Uses getName() as a stable discriminator for Flux stores.
                   Real stores return their name (e.g. "QuestStore"), fakes
                   return "[object Object]". No hardcoded property paths needed.
                   Dispatcher and API use structural checks instead.
                ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */
            
                function loadModules() {
                    try {
                        // === VENCORD USAGE ===
                        if (typeof window.Vencord !== 'undefined' && window.Vencord.Webpack) {
                            Logger.log('[System] Vencord detected. Using Vencord Webpack API...', 'info');
                            const W = window.Vencord.Webpack;
            
                            let routerModule;
                            try {
                                const m = W.findByCode('transitionTo -');
                                if (m) {
                                    for (const prop of [m, m.default, ...Object.values(m)]) {
                                        if (typeof prop === 'function' && prop.toString().includes('transitionTo -')) {
                                            routerModule = { transitionTo: prop };
                                            break;
                                        }
                                    }
                                }
                            } catch (e) { }
            
                            Mods = {
                                QuestStore: W.findStore('QuestStore') || W.findStore('QuestsStore'),
                                RunStore: W.findStore('RunningGameStore'),
                                StreamStore: W.findStore('ApplicationStreamingStore'),
                                ChanStore: W.findStore('ChannelStore'),
                                GuildChanStore: W.findStore('GuildChannelStore'),
                                Dispatcher: W.Common?.FluxDispatcher || W.findByProps('dispatch', 'subscribe', 'flushWaitQueue'),
                                API: W.Common?.RestAPI || W.findByProps('get', 'post', 'del'),
                                Router: routerModule
                            };
            
                            const required = ['QuestStore', 'API', 'Dispatcher', 'RunStore'];
                            const missing = required.filter(k => !Mods[k]);
                            
                            if (missing.length === 0) {
                                const optional =['StreamStore', 'ChanStore', 'GuildChanStore', 'Router'];
                                optional.forEach(k => { if (!Mods[k]) Logger.log(`[System] Optional module '${k}' not found. Features may be limited.`, 'warn'); });
                                
                                Patcher.init(Mods.RunStore);
                                return true;
                            }
                            Logger.log(`[System] Vencord extraction missed: ${missing.join(', ')}. Falling back to native...`, 'warn');
                        }
            
                        // === NATIVE FALLBACK (Canary / PTB without mods) ===
                        if (typeof webpackChunkdiscord_app === 'undefined') {
                            throw new Error("Webpack chunk not found - is this running inside Discord?");
                        }
            
                        // The push callback fires once per registered webpack runtime. Discord ships
                        // Sentry's stripped runtime alongside the real one — Sentry's `req.c` is tiny.
                        // Pick the require with the largest cache so we ignore the Sentry instance.
                        let req;
                        webpackChunkdiscord_app.push([[Symbol()], {}, (r) => {
                            const cur = Object.keys(req?.c || {}).length;
                            const incoming = Object.keys(r?.c || {}).length;
                            if (incoming > cur) req = r;
                        }]);
                        webpackChunkdiscord_app.pop();
            
                        if (!req?.c) throw new Error("Module registry not available - Discord build incompatible (see issue #20)");
            
                        const modules = Object.values(req.c);
            
                        // real Flux stores have constructor.displayName set to their class name
                        // fakes have displayName "Object" — this check never triggers Proxy traps
                        function findStore(storeName) {
                            for (const m of modules) {
                                try {
                                    const exp = m?.exports;
                                    if (!exp || typeof exp !== 'object') continue;
                                    for (const key of Object.keys(exp)) {
                                        const prop = exp[key];
                                        if (prop && typeof prop === 'object'
                                            && prop.__proto__?.constructor?.displayName === storeName) {
                                            return prop;
                                        }
                                    }
                                } catch { }
                            }
                            return undefined;
                        }
            
                        // Dispatcher has _subscriptions + subscribe on proto, no valid getName
                        function findDispatcher() {
                            for (const m of modules) {
                                try {
                                    const exp = m?.exports;
                                    if (!exp || typeof exp !== 'object') continue;
                                    for (const key of Object.keys(exp)) {
                                        const prop = exp[key];
                                        if (prop && prop._subscriptions
                                            && typeof prop.subscribe === 'function'
                                            && typeof prop.dispatch === 'function'
                                            && typeof prop.__proto__?.flushWaitQueue === 'function') {
                                            return prop;
                                        }
                                    }
                                } catch { }
                            }
                            return undefined;
                        }
            
                        // Discord's API client has .del (not .delete) — this distinguishes it
                        // from generic HTTP wrappers. Also has get/post/put/patch as own props.
                        function findAPI() {
                            for (const m of modules) {
                                try {
                                    const exp = m?.exports;
                                    if (!exp || typeof exp !== 'object') continue;
                                    for (const key of Object.keys(exp)) {
                                        const prop = exp[key];
                                        if (prop && typeof prop.get === 'function'
                                            && typeof prop.post === 'function'
                                            && typeof prop.del === 'function'
                                            && !prop._dispatcher) {
                                            return prop;
                                        }
                                    }
                                } catch { }
                            }
                            return undefined;
                        }
            
                        // Navigation functions are exported standalone and minified.
                        // transitionTo is identified by searching its source code for the "transitionTo -" signature.
                        function findRouter() {
                            for (const m of modules) {
                                try {
                                    const exp = m?.exports;
                                    if (!exp) continue;
            
                                    for (const prop of [exp, exp.default, ...Object.values(exp)]) {
                                        if (typeof prop === 'function' && prop.toString().includes('transitionTo -')) {
                                            return { transitionTo: prop };
                                        }
                                    }
                                } catch { }
                            }
                            return undefined;
                        }
            
                        Mods = {
                            QuestStore: findStore('QuestStore'),
                            RunStore: findStore('RunningGameStore'),
                            StreamStore: findStore('ApplicationStreamingStore'),
                            ChanStore: findStore('ChannelStore'),
                            GuildChanStore: findStore('GuildChannelStore'),
                            Dispatcher: findDispatcher(),
                            API: findAPI(),
                            Router: findRouter()
                        };
            
                        const required = ['QuestStore', 'API', 'Dispatcher', 'RunStore'];
                        const missing = required.filter(k => !Mods[k]);
                        if (missing.length > 0) throw new Error(`Core modules not found: ${missing.join(', ')}`);
            
                        const optional = ['StreamStore', 'ChanStore', 'GuildChanStore', 'Router'];
                        optional.forEach(k => { if (!Mods[k]) Logger.log(`[System] Optional module '${k}' not found. Features may be limited.`, 'warn'); });
                        Patcher.init(Mods.RunStore);
                        return true;
                    } catch (e) {
                        Logger.log(`[System] Module loading error: ${e.message ?? e}`, 'err');
                        console.error(e);
                        return false;
                    }
                }
            
                /* ── main loop ─────────────────────────────────────────────── */
            
                // run async tasks concurrently up to a specified limit
                async function runConcurrent(tasks, limit) {
                    const executing = new Set();
            
                    for (const task of tasks) {
                        if (!RUNTIME.running) break;
            
                        const p = task().finally(() => executing.delete(p));
                        executing.add(p);
            
                        await sleep(rnd(1500, 4000)); // stagger initialization to avoid API bursts
            
                        if (executing.size >= limit) {
                            await Promise.race(executing);
                        }
                    }
            
                    // use allSettled to prevent a single rejection from crashing the batch
                    return Promise.allSettled(executing);
                }
            
                async function main() {
                    Logger.init();
                    if (!loadModules()) {
                        Logger.log('[System] Failed to load Discord modules. Aborting.', 'err');
                        _dmReport({ type: 'error', message: 'Módulos do Discord não encontrados — versão incompatível?' });
                        return;
                    }
            
                    const getQuests = () => {
                        const q = Mods.QuestStore.quests;
                        return q instanceof Map ? [...q.values()] : Object.values(q);
                    };
            
                    let quests = getQuests().filter(q =>
                        !q.userStatus?.completedAt
                        && new Date(q.config?.expiresAt).getTime() > Date.now()
                        && q.id !== CONST.ID
                        && !Tasks.skipped.has(q.id)
                    );
            
                    if (!quests.length) {
                        Logger.log('[System] Nenhuma missão ativa no momento.', 'success');
                        _dmReport({ type: 'no_quests' });
                        return Logger.shutdown();
                    }
            
                    // AUTO_START: pula o picker e inicia todas as missões automaticamente
                    let pickerResult;
                    if (CONFIG.AUTO_START) {
                        RUNTIME.autoEnroll = true;
                        RUNTIME.autoClaim = true;
                        // If allowedIds provided, only run those; otherwise run all
                        const selectedSet = allowedIds.length > 0
                            ? new Set(quests.filter(q => allowedIds.includes(q.id)).map(q => q.id))
                            : new Set(quests.map(q => q.id));
                        pickerResult = { selectedQuests: selectedSet, autoEnroll: true, autoClaim: true, playSound: false };
                        Logger.log(`[Auto] ${quests.length} missão(ões) encontrada(s), ${selectedSet.size} selecionada(s)...`, 'info');
                        const questsFoundPayload = { type: 'quests_found', quests: quests.map(q => {
                            const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2;
                            const keys = cfg?.tasks ? Object.keys(cfg.tasks) : [];
                            const qtype = keys.some(k => k.includes('VIDEO')) ? 'VIDEO'
                                : keys.some(k => k.includes('STREAM')) ? 'STREAM'
                                : keys.some(k => k.includes('ACHIEVEMENT')) ? 'ACHIEVEMENT'
                                : keys.some(k => k.includes('ACTIVITY')) ? 'ACTIVITY'
                                : keys.some(k => k.includes('PLAY')) ? 'GAME' : null;
                            const app = q.config?.application ?? {};
                            const msgs = q.config?.messages ?? {};
                            const applicationId = app.id ?? q.config?.application_id ?? q.application_id ?? null;
                            return {
                                id: q.id,
                                name: msgs.questName ?? q.id,
                                appId: applicationId,
                                appIcon: app.icon ?? null,
                                heroImage: q.config?.assets?.hero ?? q.config?.keyArt ?? q.config?.heroImageHash ?? null,
                                rewardText: q.config?.rewardsConfig?.rewards?.[0]?.messages?.name ?? null,
                                type: qtype
                            };
                        }) };
                        if (discoverOnly) {
                            // Envia quests_found e discover_done diretamente em ordem garantida (sem fila)
                            try {
                                for (const item of [questsFoundPayload, { type: 'discover_done' }]) {
                                    await fetch('http://127.0.0.1:4100/api/orion/progress', {
                                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify(item)
                                    });
                                }
                            } catch(_) {}
                            window.orionLock = false;
                            return;
                        }
                        _dmReport(questsFoundPayload);
                    } else {
                        pickerResult = await Logger.showQuestPicker(quests);
                        if (!RUNTIME.running) return;
                        RUNTIME.autoEnroll = pickerResult.autoEnroll;
                        RUNTIME.autoClaim = pickerResult.autoClaim;
                        RUNTIME.playSound = pickerResult.playSound;
                        if (pickerResult.selectedQuests.size === 0) {
                            Logger.log('[System] Nenhuma missão selecionada.', 'info');
                            return Logger.shutdown();
                        }
                    }
            
                    let loopCount = 1;
            
                    while (RUNTIME.running) {
                        try {
                            Logger.log(`[Cycle] Starting loop #${loopCount}...`, 'info');
                            quests = getQuests();
            
                            const active = quests.filter(q =>
                                pickerResult.selectedQuests.has(q.id)
                                && !q.userStatus?.completedAt
                                && new Date(q.config?.expiresAt).getTime() > Date.now()
                                && q.id !== CONST.ID
                                && !Tasks.skipped.has(q.id)
                            );
            
                            if (!active.length) { Logger.log('[System] All available quests are completed!', 'success'); Sound.play('done'); _dmReport({ type: 'all_done' }); break; }
            
                            const queues = { video: [], game: [] };
            
                            active.forEach(q => {
                                try {
                                    const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2;
                                    if (!cfg?.tasks || typeof cfg.tasks !== 'object') {
                                        Logger.log(`[Quest] ${q.id} has invalid task config. Skipping.`, 'warn');
                                        return;
                                    }
            
                                    const typeData = Tasks.detectType(cfg, q.config?.application?.id);
                                    if (!typeData) {
                                        Logger.log(`[Quest] Unknown task type: ${q.config?.messages?.questName ?? q.id}`, 'warn');
                                        return;
                                    }
            
                                    if (!SYS.IS_DESKTOP && (typeData.type === 'GAME' || typeData.type === 'STREAM')) {
                                        Logger.log(`[Quest] "${q.config?.messages?.questName}" requires desktop app. Skipping.`, 'warn');
                                        return;
                                    }
            
                                    const { type, keyName, target } = typeData;
                                    if (target <= 0) {
                                        Logger.log(`[Quest] Invalid target (${target}) for ${q.id}. Skipping.`, 'warn');
                                        return;
                                    }
            
                                    const tInfo = {
                                        id: q.id,
                                        appId: q.config?.application?.id ?? 0,
                                        appIcon: q.config?.application?.icon ?? null,
                                        name: q.config?.messages?.questName ?? "Unknown Quest",
                                        target,
                                        type,
                                        keyName  // actual task key from config (e.g. WATCH_VIDEO_ON_MOBILE)
                                    };
            
                                    // handle disabled auto-enroll (wait for user)
                                    if (!q.userStatus?.enrolledAt && !RUNTIME.autoEnroll) {
                                        Logger.updateTask(tInfo.id, {
                                            name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target,
                                            status: "PENDING", actionRequired: 'ENROLL',
                                            appId: tInfo.appId, appIcon: tInfo.appIcon
                                        });
                                        return; // skip execution queue, wait for next cycle
                                    }
            
                                    if (Logger.tasks.has(q.id) && Logger.tasks.get(q.id).status === "RUNNING") return;
            
                                    // clear the action button if user enrolled manually
                                    Logger.updateTask(tInfo.id, {
                                        name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target,
                                        status: "QUEUE", actionRequired: null,
                                        appId: tInfo.appId, appIcon: tInfo.appIcon
                                    });
            
                                    const taskFunc = async () => {
                                        // JIT enrollment (only if autoEnroll is true or user already enrolled)
                                        if (!q.userStatus?.enrolledAt) {
                                            Logger.log(`[Enroll] Accepting quest: ${tInfo.name}`, 'info');
                                            try {
                                                await Traffic.enqueue(`/quests/${q.id}/enroll`, { location: 11, is_targeted: false });
                                                await sleep(rnd(800, 1500));
                                            } catch (e) {
                                                const err = ErrorHandler.classify(e);
                                                if (ErrorHandler.isSkippableQuest(e)) {
                                                    Tasks.skipped.add(q.id);
                                                    Logger.log(`[Enroll] ${tInfo.name} unavailable (${err.status}). Skipping.`, 'warn');
                                                } else {
                                                    Logger.log(`[Enroll] Failed for ${tInfo.name}: ${err.message}`, 'err');
                                                }
                                                return Tasks.failTask(q, tInfo, `Enrollment failed`);
                                            }
                                        }
            
                                        if (type === "WATCH_VIDEO") return Tasks.VIDEO(q, tInfo, q.userStatus);
                                        if (type === "ACHIEVEMENT") return Tasks.ACHIEVEMENT(q, tInfo);
                                        const runner = type === "STREAM" ? Tasks.STREAM : (type === "ACTIVITY" ? Tasks.ACTIVITY : Tasks.GAME);
                                        return runner(q, tInfo, q.userStatus);
                                    };
            
                                    if (type === "WATCH_VIDEO") queues.video.push(taskFunc);
                                    else queues.game.push(taskFunc);
                                } catch (e) {
                                    Logger.log(`[Quest] Error processing ${q.id}: ${e.message}`, 'err');
                                }
                            });
            
                            const totalTasks = queues.video.length + queues.game.length;
            
                            if (totalTasks > 0) {
                                Logger.log(`[Cycle] Processing: ${queues.video.length} videos, ${queues.game.length} games.`, 'info');
                                const pGames = runConcurrent(queues.game, queues.game.length || 1);
                                const pVideos = runConcurrent(queues.video, queues.video.length || 1);
                                await Promise.all([pGames, pVideos]);
                            } else {
                                if (active.length === 0) { Logger.log('[System] All available quests are completed!', 'success'); break; }
                                else await sleep(rnd(4000, 6000));  // idle loop wait
                            }
            
                            if (!RUNTIME.running) break;
                            Logger.log(`[Cycle] Loop #${loopCount} complete. Waiting before rescan...`, 'info');
                            await sleep(rnd(2500, 4500));
                            loopCount++;
            
                        } catch (cycleError) {
                            Logger.log(`[Cycle] Error in loop #${loopCount}: ${cycleError?.message ?? cycleError}`, 'err');
                            console.error(cycleError);
                            await sleep(3000);
                            loopCount++;
                        }
                    }
            
                    Logger.shutdown();
                }
            
                // ── Progress reporter: envia atualizações para o Discord Manager ────────
                const _dmReport = (payload) => {
                    try {
                        if (!window._orionProgressQueue) window._orionProgressQueue = [];
                        window._orionProgressQueue.push(payload);
                    } catch {}
                };
            
                // Wrap Logger.updateTask to forward every task update to the app
                const _origUpdateTask = Logger.updateTask.bind(Logger);
                Logger.updateTask = function(id, data) {
                    _origUpdateTask(id, data);
                    const task = Logger.tasks.get(id);
                    if (task) _dmReport({ type: 'task_update', id, name: task.name, taskType: task.type, cur: task.cur ?? 0, max: task.max ?? 1, status: task.status });
                };
            
                main()
                    .then(() => { setTimeout(() => { window.orionLock = false; }, 1500); })
                    .catch(e => {
                        const msg = e?.message ?? e?.toString?.() ?? "Unknown fatal error";
                        console.error('[Orion Fatal]', e);
                        try { Logger.log(`[System] FATAL: ${msg}`, 'err'); } catch (_) { }
                        try { Logger.shutdown(); } catch (_) { }
                        try { _dmReport({ type: 'error', message: msg }); } catch (_) { }
                        setTimeout(() => { window.orionLock = false; }, 1500);
                    });
        })().catch(e => {
            const msg = e?.message ?? String(e) ?? 'Setup error';
            console.error('[Orion IIFE]', e);
            if (!window._orionProgressQueue) window._orionProgressQueue = [];
            window._orionProgressQueue.push({ type: 'error', message: msg });
            window.orionLock = false;
        });
    }

    stop() {
        clearInterval(this._pollTimer);
        clearInterval(this._flushTimer);
        if (window._orionRuntime) { window._orionRuntime.running = false; window._orionRuntime = null; }
        window.orionLock = false;
        try { document.getElementById('orion-ui')?.remove(); } catch {}
        try { document.getElementById('orion-styles')?.remove(); } catch {}
        if (this._bdPatcher) { try { this._bdPatcher.unpatchAll(); } catch {} this._bdPatcher = null; }
        if (this._fakeProfileCache) { this._fakeProfileCache.clear(); this._fakeProfileCache = null; }
    }

    _3y3Reveal(text) {
        if (!text || !text.includes('\uDB40')) return null;
        return [...text].map(ch => {
            const cp = ch.codePointAt(0);
            return (cp > 0xe0000 && cp < 0xe007f) ? String.fromCodePoint(cp - 0xe0000) : ch;
        }).join('');
    }

    _applyProfileDecoding() {
        try {
            const { Patcher, Webpack } = new BdApi("Dark-moonQuest");
            const UserProfileStore = Webpack.getStore("UserProfileStore");
            const PresenceStore    = Webpack.getStore("PresenceStore");

            if (!UserProfileStore) return;

            const self = this;
            self._fakeProfileCache = new Map();

            // Decode 3y3 from bio/status → apply banner, colors, effect
            Patcher.after(UserProfileStore, "getUserProfile", (_, [userId], ret) => {
                if (!ret) return;
                const bio = ret.bio || '';
                let revealed = self._3y3Reveal(bio);

                if (!revealed && PresenceStore) {
                    try {
                        const acts = PresenceStore.getActivities(userId) || [];
                        const cs   = acts.find(a => a.name === 'Custom Status' || a.id === 'custom');
                        if (cs?.state) revealed = self._3y3Reveal(cs.state);
                    } catch {}
                }
                if (!revealed) return;

                // Profile colors: [#rrggbb,#rrggbb]
                const cm = revealed.match(/\[#([0-9a-fA-F]{6}),#([0-9a-fA-F]{6})\]/);
                if (cm) {
                    try {
                        ret.themeColors = [parseInt(cm[1], 16), parseInt(cm[2], 16)];
                        ret.premiumType = 2;
                    } catch {}
                }

                // Profile effect: fx{skuId}
                const fm = revealed.match(/fx\{(\d+)\}/);
                if (fm) {
                    try {
                        const skuId = fm[1];
                        ret.profileEffect = { id: skuId, skuId, expiresAt: null };
                        ret.premiumType = 2;
                    } catch {}
                }

                // Fake banner: B{imgurId[.ext]} or B{https://any-host/img.gif}
                const bm = revealed.match(/B\{([^}]+)\}/);
                if (bm && userId) {
                    let val = bm[1];
                    let bannerUrl;
                    if (/^https?:\/\//i.test(val)) {
                        // Full URL (catbox, giphy, tenor, etc.)
                        bannerUrl = val;
                    } else {
                        // Imgur short ID
                        if (!/\.(gif|png|jpg|jpeg|webp)$/i.test(val)) val += '.gif';
                        bannerUrl = `https://i.imgur.com/${val}`;
                    }
                    try {
                        ret.premiumType = 2;
                        // banner=null faz o Discord nem chamar getUserBannerURL.
                        // Qualquer valor truthy faz ele chamar — aí nosso patch retorna a URL real.
                        if (!ret.banner) ret.banner = 'dm_fake';
                        self._fakeProfileCache.set(userId, bannerUrl);
                    } catch {}
                }
            });

            // Inject Imgur URL into banner rendering
            const AvatarMod = Webpack.getByKeys("getUserBannerURL");
            if (AvatarMod) {
                Patcher.instead(AvatarMod, "getUserBannerURL", (_, args, orig) => {
                    const uid = args[0]?.id;
                    if (uid && self._fakeProfileCache?.has(uid)) return self._fakeProfileCache.get(uid);
                    return orig(...args);
                });
            }

            console.log('[Dark-moonQuest] Profile decoding patches aplicados.');
        } catch(e) {
            console.warn('[DM] Profile decoding error:', e);
        }
    }

    _applyNitroBypasses() {
        try {
            const { Patcher, Webpack } = new BdApi("Dark-moonQuest");
            this._bdPatcher = Patcher;

            // ── 1. Desbloqueia emojis no picker (sem ícone de cadeado) ──────────
            try {
                const emojiMod = Webpack.getByKeys("isEmojiFilteredOrLocked", "isEmojiDisabled");
                if (emojiMod) {
                    ['isEmojiFilteredOrLocked', 'isEmojiDisabled', 'isEmojiFiltered', 'isEmojiPremiumLocked'].forEach(fn => {
                        if (typeof emojiMod[fn] === 'function') Patcher.instead(emojiMod, fn, () => false);
                    });
                    if (typeof emojiMod.getEmojiUnavailableReason === 'function')
                        Patcher.instead(emojiMod, "getEmojiUnavailableReason", () => undefined);
                }
            } catch(e) { console.warn('[DM-Bypass] Emoji unlock:', e); }

            // ── 2. Envia emoji cross-server como emoji real <:name:id> ──────────
            try {
                const MsgActions = Webpack.getByKeys("jumpToMessage", "_sendMessage");
                const EmojiStore = Webpack.getStore("EmojiStore");
                if (MsgActions && EmojiStore) {
                    // Busca emoji por nome em qualquer estrutura que o Discord use
                    function _findEmoji(name) {
                        // Tenta getGuilds()
                        const guilds = EmojiStore.getGuilds?.() || {};
                        for (const guild of Object.values(guilds)) {
                            const raw = guild?.emojis;
                            if (!raw) continue;
                            // Array ou objeto (keyed by id)
                            const list = Array.isArray(raw) ? raw : Object.values(raw);
                            const e = list.find(e => e?.name === name || e?.originalName === name);
                            if (e?.id) return e;
                        }
                        // Tenta getAll() como fallback
                        try {
                            const all = EmojiStore.getAll?.() || [];
                            const allList = Array.isArray(all) ? all : Object.values(all);
                            const e = allList.find(e => e?.name === name || e?.originalName === name);
                            if (e?.id) return e;
                        } catch {}
                        return null;
                    }
                    Patcher.before(MsgActions, "sendMessage", (_, [, msg]) => {
                        if (!msg?.content?.includes(':')) return;
                        msg.content = msg.content.replace(/:([a-zA-Z0-9_~]+):/g, (match, name) => {
                            const e = _findEmoji(name);
                            if (!e) return match;
                            return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
                        });
                    });
                }
            } catch(e) { console.warn('[DM-Bypass] Emoji send:', e); }

            // ── 3. Desbloqueia upload até 100MB ─────────────────────────────────
            try {
                const fileMod = Webpack.getModule(m => {
                    try { return typeof m?.getMaxFileSize === 'function' && typeof m?.exceedsMessageSizeLimit === 'function'; }
                    catch { return false; }
                });
                if (fileMod) {
                    Patcher.instead(fileMod, "getMaxFileSize", () => 100 * 1024 * 1024);
                    Patcher.instead(fileMod, "exceedsMessageSizeLimit", () => false);
                }
            } catch(e) { console.warn('[DM-Bypass] File size:', e); }

            // ── 4. Stream 1080p/60fps sem Nitro ─────────────────────────────────
            try {
                const VideoQualityClass = Webpack.getByPrototypeKeys("updateVideoQuality");
                if (VideoQualityClass?.prototype) {
                    Patcher.before(VideoQualityClass.prototype, "updateVideoQuality", (thisArg) => {
                        const params = thisArg.videoStreamParameters?.[0];
                        if (!params) return;
                        const quality = {
                            width: Math.max(params.maxResolution?.width || 0, 1920),
                            height: Math.max(params.maxResolution?.height || 0, 1080),
                            framerate: Math.max(params.maxFrameRate || 0, 60),
                        };
                        if (quality.height <= 0) quality.height = 1080;
                        if (quality.width <= 0) quality.width = 1920;
                        const mgr = thisArg.videoQualityManager;
                        if (mgr?.options) {
                            mgr.options.videoBudget = quality;
                            mgr.options.videoCapture = quality;
                        }
                        thisArg.remoteSinkWantsMaxFramerate = quality.framerate;
                    });
                }
            } catch(e) { console.warn('[DM-Bypass] Stream quality:', e); }

            // ── 5. Remove cadeado visual de features (picker, upsell) ───────────
            try {
                const canUseMod = Webpack.getModule(m => {
                    try { return typeof m?.canUserUse === 'function' && m.canUserUse.toString().includes('getFeatureValue'); }
                    catch { return false; }
                });
                if (canUseMod) {
                    const BYPASS_FEATURES = [
                        'emojisEverywhere', 'animatedEmojis',
                        'highVideoResolutions', 'videoQuality', 'streamQuality',
                        'highQualityStreaming', 'streamFPS', 'videoStreamFPS',
                    ];
                    Patcher.instead(canUseMod, "canUserUse", (_, [feature, user], orig) => {
                        const name = feature?.name ?? feature;
                        if (BYPASS_FEATURES.includes(name)) return true;
                        return orig(feature, user);
                    });
                }
            } catch(e) { console.warn('[DM-Bypass] CanUserUse:', e); }

            // ── 5b. Stream quality capability patches (varre todos os nomes possíveis) ──
            try {
                const streamFnNames = [
                    'canUseHighVideoResolutions', 'canStreamHighQuality',
                    'canUseHighFrameRate',         'canUseVideoQuality',
                    'canStreamQuality',            'hasVideoQualityPerk',
                    'canUseHighBitrate',           'canUsePremiumVideoQuality',
                ];
                // Varr toda a árvore de módulos com searchExports para achar qualquer cópia
                for (const fnName of streamFnNames) {
                    try {
                        const mod = Webpack.getModule(m => {
                            try { return typeof m?.[fnName] === 'function'; }
                            catch { return false; }
                        }, { searchExports: true });
                        if (mod && typeof mod[fnName] === 'function')
                            Patcher.instead(mod, fnName, () => true);
                    } catch {}
                }
            } catch(e) { console.warn('[DM-Bypass] StreamQuality:', e); }

            // ── 5c. Intercepta openModal para suprimir upsells de streaming ─────
            try {
                const ModalActions = Webpack.getByKeys("openModal", "closeModal", "hasModalOpen");
                if (ModalActions) {
                    Patcher.instead(ModalActions, "openModal", (_, args, orig) => {
                        try {
                            const renderFn = args[0];
                            if (typeof renderFn === 'function') {
                                const src = renderFn.toString();
                                // Suprime modais de upsell de qualidade de vídeo/stream
                                if ((src.includes('VIDEO') || src.includes('STREAM') || src.includes('video') || src.includes('stream'))
                                    && (src.includes('premium') || src.includes('Premium') || src.includes('nitro') || src.includes('Nitro'))) {
                                    return;
                                }
                            }
                        } catch {}
                        return orig(...args);
                    });
                }
            } catch(e) { console.warn('[DM-Bypass] ModalIntercept:', e); }

            // ── 6. Client themes unlock (temas de cliente sem Nitro) ─────────────
            try {
                // isPreview = false: libera a UI de preview de tema
                const clientThemesMod = Webpack.getModule(m => {
                    try { return typeof m?.isPreview === 'boolean' && typeof m?.updateClientTheme === 'function'; }
                    catch { return false; }
                });
                if (clientThemesMod) {
                    Object.defineProperty(clientThemesMod, 'isPreview', { get: () => false, configurable: true });
                }
            } catch(e) { console.warn('[DM-Bypass] Client themes (isPreview):', e); }
            try {
                // O componente de tema checa user.premiumType diretamente.
                // Patchamos getCurrentUser para reportar Nitro (2) na UI.
                const UserStore = Webpack.getStore("UserStore");
                if (UserStore) {
                    Patcher.after(UserStore, "getCurrentUser", (_, __, ret) => {
                        if (!ret || ret.premiumType >= 2) return;
                        Object.defineProperty(ret, 'premiumType', {
                            value: 2, configurable: true, enumerable: true, writable: true
                        });
                    });
                }
            } catch(e) { console.warn('[DM-Bypass] getCurrentUser premiumType:', e); }
            try {
                // canUseClientThemes = true: remove o bloqueio de premium na aba Temas
                const themeCapMod = Webpack.getModule(m => {
                    try { return typeof m?.canUseClientThemes === 'function'; }
                    catch { return false; }
                });
                if (themeCapMod) {
                    Patcher.instead(themeCapMod, 'canUseClientThemes', () => true);
                    if (typeof themeCapMod.canUsePremiumProfileCustomization === 'function')
                        Patcher.instead(themeCapMod, 'canUsePremiumProfileCustomization', () => true);
                }
            } catch(e) { console.warn('[DM-Bypass] Client themes (canUse):', e); }
            try {
                // Expande canUserUse pra incluir temas de cliente
                // (já foi patchado acima, mas garante o nome correto da feature)
                const themeFeatureMod = Webpack.getModule(m => {
                    try { return typeof m?.canUseClientThemes === 'function' && typeof m?.canUserUse === 'function'; }
                    catch { return false; }
                });
                if (themeFeatureMod && typeof themeFeatureMod.canUserUse === 'function') {
                    Patcher.instead(themeFeatureMod, 'canUserUse', (_, [feature, user], orig) => {
                        const name = feature?.name ?? feature;
                        if (['clientThemes', 'customProfileThemes', 'premiumProfileCustomization'].includes(name)) return true;
                        return orig(feature, user);
                    });
                }
            } catch(e) { console.warn('[DM-Bypass] Client themes (feature):', e); }

            // ── 6c. Persiste tema — intercepta PATCH de settings-proto ───────────
            // Quando o usuário aplica um tema, Discord manda PATCH /settings-proto/1.
            // O servidor rejeita (sem Nitro) e retorna as configs antigas → revert em ~5s.
            // Fingindo sucesso, o cliente nunca recebe a resposta real e o tema permanece.
            try {
                const API = Webpack.getByKeys("get", "post", "patch", "put", "del");
                if (API?.patch) {
                    Patcher.instead(API, 'patch', (_, args, orig) => {
                        const opts  = args[0];
                        const url   = typeof opts === 'string' ? opts : (opts?.url ?? '');
                        if (typeof url === 'string' && url.includes('settings-proto')) {
                            // Resposta de sucesso falsa — impede o servidor de reverter o tema
                            return Promise.resolve({ ok: true, body: {}, status: 200, text: '{}' });
                        }
                        return orig(...args);
                    });
                }
            } catch(e) { console.warn('[DM-Bypass] Theme persist (settings-proto):', e); }

            // ── 6d. Figurinhas (stickers) sem Nitro ──────────────────────────────
            try {
                // getStickerSendability retorna enum: 0=SENDABLE, 1=PREMIUM, 2=BOOSTED, 3=NOT_SENDABLE
                // Patchamos pra sempre retornar 0 (SENDABLE)
                const stickerMod = Webpack.getModule(m => {
                    try { return typeof m?.getStickerSendability === 'function'; }
                    catch { return false; }
                });
                if (stickerMod) {
                    Patcher.instead(stickerMod, 'getStickerSendability', () => 0);
                }
            } catch(e) { console.warn('[DM-Bypass] Sticker sendability:', e); }
            try {
                const stickerCapFns = [
                    'canUseStickersEverywhere',
                    'canUseCustomStickersEverywhere',
                    'canUseHighQualityLottieStickerPlayer',
                ];
                for (const fnName of stickerCapFns) {
                    const mod = Webpack.getModule(m => {
                        try { return typeof m?.[fnName] === 'function'; }
                        catch { return false; }
                    }, { searchExports: true });
                    if (mod && typeof mod[fnName] === 'function')
                        Patcher.instead(mod, fnName, () => true);
                }
            } catch(e) { console.warn('[DM-Bypass] Sticker caps:', e); }

            // ── 7. Suprime modais de upsell "Obter Nitro" ────────────────────────
            try {
                const nitroMod = Webpack.getModule(m => {
                    try { return typeof m?.openNitroModal === 'function'; }
                    catch { return false; }
                });
                if (nitroMod) Patcher.instead(nitroMod, 'openNitroModal', () => {});
            } catch(e) { console.warn('[DM-Bypass] Nitro upsell:', e); }
            try {
                const premiumMod = Webpack.getModule(m => {
                    try { return typeof m?.openPremiumModal === 'function' && typeof m?.openPremiumGiftingModal === 'function'; }
                    catch { return false; }
                });
                if (premiumMod) Patcher.instead(premiumMod, 'openPremiumModal', () => {});
            } catch(e) { console.warn('[DM-Bypass] Premium modal:', e); }

            // ── 7b. Suprime modal específico de qualidade de vídeo ───────────────
            try {
                const videoUpsellMod = Webpack.getModule(m => {
                    try {
                        return typeof m?.openPremiumVideoUpsellModal === 'function' ||
                               typeof m?.maybeOpenVideoUpsellModal   === 'function';
                    }
                    catch { return false; }
                });
                if (videoUpsellMod) {
                    if (typeof videoUpsellMod.openPremiumVideoUpsellModal === 'function')
                        Patcher.instead(videoUpsellMod, 'openPremiumVideoUpsellModal', () => {});
                    if (typeof videoUpsellMod.maybeOpenVideoUpsellModal === 'function')
                        Patcher.instead(videoUpsellMod, 'maybeOpenVideoUpsellModal', () => {});
                }
            } catch(e) { console.warn('[DM-Bypass] Video upsell modal:', e); }

            console.log('[Dark-moonQuest] Nitro bypasses aplicados: emoji cross-server, upload 100MB, stream 1080p, temas de cliente.');
        } catch(e) {
            console.error('[Dark-moonQuest] Falha ao aplicar bypasses:', e);
        }
    }

    getSettingsPanel() {
        const div = document.createElement('div');
        div.style.cssText = 'padding:16px;color:#fff;font-family:sans-serif;';
        div.innerHTML = '<b>Dark-moonQuest v1.2.0</b><br><br>' +
            'O plugin aguarda o comando do Discord Manager (http://127.0.0.1:4100).<br><br>' +
            '<span style="color:#faa61a">Modo: controlado pelo servidor</span> — use o botão Start/Stop no app para iniciar as missões.<br><br>' +
            '<b style="color:#3BA55C">Nitro Bypasses ativos:</b><br>' +
            '✅ Emoji cross-server (sem Nitro)<br>' +
            '✅ Upload até 100MB<br>' +
            '✅ Stream 1080p/60fps<br>' +
            '✅ Temas de cliente desbloqueados<br>' +
            '✅ Upsell "Obter Nitro" suprimido<br><br>' +
            '<b style="color:#a855f7">Profile 3y3 (ver perfis personalizados):</b><br>' +
            '✅ Banners falsos via Imgur<br>' +
            '✅ Cores de perfil<br>' +
            '✅ Efeitos de perfil<br><br>' +
            '<span style="color:#949ba4;font-size:.85em">Use o app Dark Moon → aba Perfil para gerar seus próprios códigos 3y3.</span>';
        return div;
    }
};
