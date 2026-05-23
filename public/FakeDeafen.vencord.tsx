/*
 * @name FakeDeafen
 * @description Apareça mutado/surdo para os outros enquanto continua ouvindo tudo
 * @version 2.0.0
 * @author Hyukiteckk
 *
 * INSTALAÇÃO (Vencord userplugin):
 *   1. Coloque este arquivo em src/userplugins/FakeDeafen.tsx
 *   2. Rode `pnpm build` (ou `pnpm watch`)
 *   3. Ative nas Configurações do Discord → Vencord → Plugins → FakeDeafen
 */

import definePlugin from "@utils/types";
import { SelectedChannelStore, UserStore, VoiceActions, VoiceStateStore } from "@webpack/common";

// ── Estado ───────────────────────────────────────────────────────────────────
let fakeMute  = false;
let fakeDeaf  = false;
let fakeVideo = false;
let updateTimeout: ReturnType<typeof setTimeout> | null = null;
let floatingPanel: HTMLDivElement | null = null;

// ── Persistência (inspirado no settingsManager do Uzzi-Selfbot) ──────────────
function saveState() {
    try { localStorage.setItem("FakeDeafen_state", JSON.stringify({ fakeMute, fakeDeaf, fakeVideo })); } catch {}
}

function loadState(): { fakeMute?: boolean; fakeDeaf?: boolean; fakeVideo?: boolean } {
    try { return JSON.parse(localStorage.getItem("FakeDeafen_state") ?? "{}"); } catch { return {}; }
}

// ── Lógica de atualização forçada (baseada no fakeStateUtils do Uzzi-Selfbot) ─
function forceVoiceUpdate() {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;

    const channelId = SelectedChannelStore.getVoiceChannelId();
    let voiceState: any;

    if (channelId) {
        const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
        if (states) voiceState = (states as any)[userId];
    }
    if (!voiceState) voiceState = VoiceStateStore.getVoiceStateForUser(userId);
    if (!voiceState?.channelId) return;

    if (updateTimeout) { clearTimeout(updateTimeout); updateTimeout = null; }

    // Se já mutado localmente: toggle deafen (não vaza áudio)
    // Se não mutado: toggle mute por 50ms (imperceptível)
    if (voiceState.selfMute) {
        VoiceActions.toggleSelfDeaf();
        updateTimeout = setTimeout(() => VoiceActions.toggleSelfDeaf(), 50) as any;
    } else {
        VoiceActions.toggleSelfMute();
        updateTimeout = setTimeout(() => VoiceActions.toggleSelfMute(), 50) as any;
    }
}

// ── Função injetada no patch ─────────────────────────────────────────────────
function applyFake(original: boolean, type: "mute" | "deaf" | "video"): boolean {
    if (type === "mute"  && fakeMute)  return true;
    if (type === "deaf"  && fakeDeaf)  return true;
    if (type === "video" && fakeVideo) return true;
    return original;
}

// ── Painel flutuante ─────────────────────────────────────────────────────────
function syncPanel() {
    const ids = ["spy", "mute", "deaf", "video"] as const;
    const states = {
        spy:   fakeMute && fakeDeaf,
        mute:  fakeMute,
        deaf:  fakeDeaf,
        video: fakeVideo,
    };
    for (const key of ids) {
        const track = document.getElementById(`fd-${key}-track`);
        const knob  = document.getElementById(`fd-${key}-knob`);
        const val   = states[key];
        if (track) track.style.background = val ? "#00e676" : "#333";
        if (knob) {
            knob.style.left       = val ? "18px" : "3px";
            knob.style.background = val ? "#001a0a" : "#888";
        }
    }
}

function createPanel(): HTMLDivElement {
    document.getElementById("fake-deafen-panel")?.remove();

    const saved = (() => {
        try { return JSON.parse(localStorage.getItem("FakeDeafen_pos") ?? "{}"); }
        catch { return {}; }
    })();

    const panel = document.createElement("div");
    panel.id = "fake-deafen-panel";
    Object.assign(panel.style, {
        position:     "fixed",
        top:          saved.top  ?? "80px",
        left:         saved.left ?? "20px",
        zIndex:       "99999",
        background:   "#1a1a2e",
        border:       "1px solid rgba(255,255,255,.14)",
        borderRadius: "12px",
        width:        "200px",
        boxShadow:    "0 8px 32px rgba(0,0,0,.7)",
        fontFamily:   "'gg sans','Noto Sans',sans-serif",
        userSelect:   "none",
    });

    // ── Título / drag ──────────────────────────────────────────────────────
    const titleBar = document.createElement("div");
    Object.assign(titleBar.style, {
        display:        "flex",
        alignItems:     "center",
        justifyContent: "space-between",
        padding:        "8px 10px 7px",
        cursor:         "grab",
        borderBottom:   "1px solid rgba(255,255,255,.08)",
    });

    const title = document.createElement("span");
    title.textContent = "👁 Fake Deafen";
    Object.assign(title.style, { fontSize: "12px", fontWeight: "700", color: "#aaa", letterSpacing: ".5px" });

    const btnMin = document.createElement("span");
    btnMin.textContent = "—";
    Object.assign(btnMin.style, { fontSize: "14px", color: "#555", cursor: "pointer", padding: "0 3px" });

    titleBar.append(title, btnMin);
    panel.appendChild(titleBar);

    // ── Corpo ──────────────────────────────────────────────────────────────
    const body = document.createElement("div");
    body.style.padding = "8px 10px 12px";

    function makeRow(
        label: string,
        emoji: string,
        key: string,
        getVal: () => boolean,
        setVal: (v: boolean) => void,
        onEnable?: () => void,
    ) {
        const row = document.createElement("div");
        Object.assign(row.style, {
            display:        "flex",
            alignItems:     "center",
            justifyContent: "space-between",
            padding:        "8px 9px",
            borderRadius:   "8px",
            cursor:         "pointer",
            marginBottom:   "5px",
            background:     "rgba(255,255,255,.04)",
            transition:     "background .15s",
        });
        row.onmouseenter = () => { row.style.background = "rgba(255,255,255,.09)"; };
        row.onmouseleave = () => { row.style.background = "rgba(255,255,255,.04)"; };

        const lbl = document.createElement("span");
        lbl.style.cssText = "font-size:12.5px;color:#ccc;display:flex;align-items:center;gap:6px";
        lbl.innerHTML = `<span>${emoji}</span><span>${label}</span>`;

        const track = document.createElement("div");
        track.id = `fd-${key}-track`;
        Object.assign(track.style, {
            width: "36px", height: "20px", borderRadius: "10px",
            position: "relative", flexShrink: "0", transition: "background .2s",
            background: getVal() ? "#00e676" : "#333",
        });

        const knob = document.createElement("div");
        knob.id = `fd-${key}-knob`;
        Object.assign(knob.style, {
            position: "absolute", top: "3px",
            left: getVal() ? "18px" : "3px",
            width: "14px", height: "14px", borderRadius: "50%",
            background: getVal() ? "#001a0a" : "#888",
            transition: "left .2s, background .2s",
        });
        track.appendChild(knob);

        row.addEventListener("click", () => {
            setVal(!getVal());
            if (getVal() && onEnable) onEnable();
            syncPanel();
            saveState();
            forceVoiceUpdate();
        });
        row.append(lbl, track);
        return row;
    }

    // Modo Espião — ativa mute+deaf de uma vez (comportamento do Uzzi-Selfbot)
    const spyRow = makeRow(
        "Modo Espião", "🕵️", "spy",
        () => fakeMute && fakeDeaf,
        (v) => { fakeMute = v; fakeDeaf = v; },
    );

    // Separador visual
    const sep = document.createElement("div");
    sep.style.cssText = "height:1px;background:rgba(255,255,255,.06);margin:4px 0 8px";

    const muteRow = makeRow(
        "Mutado", "🎙️", "mute",
        () => fakeMute,
        (v) => { fakeMute = v; if (!v) fakeDeaf = false; },
    );
    const deafRow = makeRow(
        "Surdo",  "🎧", "deaf",
        () => fakeDeaf,
        (v) => { fakeDeaf = v; if (v) fakeMute = true; },
    );
    const videoRow = makeRow(
        "Câmera",  "📷", "video",
        () => fakeVideo,
        (v) => { fakeVideo = v; },
    );

    body.append(spyRow, sep, muteRow, deafRow, videoRow);
    panel.appendChild(body);
    document.body.appendChild(panel);

    // ── Minimizar ──────────────────────────────────────────────────────────
    let minimized = false;
    btnMin.addEventListener("click", e => {
        e.stopPropagation();
        minimized = !minimized;
        body.style.display = minimized ? "none" : "block";
        btnMin.textContent = minimized ? "+" : "—";
        panel.style.width  = minimized ? "auto" : "200px";
    });

    // ── Drag ───────────────────────────────────────────────────────────────
    let dragging = false, ox = 0, oy = 0;
    titleBar.addEventListener("mousedown", e => {
        if (e.target === btnMin) return;
        dragging = true;
        ox = e.clientX - panel.offsetLeft;
        oy = e.clientY - panel.offsetTop;
        titleBar.style.cursor = "grabbing";
    });
    document.addEventListener("mousemove", e => {
        if (!dragging) return;
        panel.style.left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox)) + "px";
        panel.style.top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy)) + "px";
    });
    document.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        titleBar.style.cursor = "grab";
        try { localStorage.setItem("FakeDeafen_pos", JSON.stringify({ top: panel.style.top, left: panel.style.left })); } catch {}
    });

    return panel as HTMLDivElement;
}

// ── Plugin ────────────────────────────────────────────────────────────────────
export default definePlugin({
    name: "FakeDeafen",
    description: "Apareça mutado/surdo para os outros enquanto continua ouvindo tudo. Modo Espião ativa mute+deaf com um clique.",
    authors: [{ id: 0n, name: "Hyukiteckk" }],

    patches: [
        {
            // Intercepta o pacote voiceStateUpdate antes de enviar ao gateway
            find: "}voiceStateUpdate(",
            replacement: {
                match: /self_mute:([^,]+),self_deaf:([^,]+),self_video:([^,]+)/,
                replace: "self_mute:$self.applyFake($1,'mute'),self_deaf:$self.applyFake($2,'deaf'),self_video:$self.applyFake($3,'video')",
            },
        },
    ],

    // Referenciado no patch como $self.applyFake
    applyFake,

    start() {
        // Restaura estado salvo (igual ao Uzzi-Selfbot que restaura toggles no start)
        const saved = loadState();
        if (saved.fakeMute)  fakeMute  = true;
        if (saved.fakeDeaf)  { fakeDeaf = true; fakeMute = true; }
        if (saved.fakeVideo) fakeVideo = true;

        floatingPanel = createPanel();

        // Se havia estado ativo, force update para o servidor saber
        if (fakeMute || fakeDeaf || fakeVideo) {
            setTimeout(() => forceVoiceUpdate(), 1500);
        }
    },

    stop() {
        if (updateTimeout) clearTimeout(updateTimeout);
        floatingPanel?.remove();
        floatingPanel = null;
        fakeMute  = false;
        fakeDeaf  = false;
        fakeVideo = false;
        saveState();
        forceVoiceUpdate();
    },

    getSettingsPanel() {
        const div = document.createElement("div");
        div.style.cssText = "padding:14px 18px;font-family:sans-serif;color:#aaa;font-size:13px;line-height:1.8";
        div.innerHTML = `
            <b style="color:#fff;font-size:15px">FakeDeafen v2.0</b><br>
            Painel flutuante aparece direto no Discord.<br><br>
            <b style="color:#ccc">🕵️ Modo Espião</b> — ativa mute+deaf com <b>um clique</b>.<br>
            <b style="color:#ccc">🎙️ Mutado</b> — aparece mutado, mas envia áudio normalmente.<br>
            <b style="color:#ccc">🎧 Surdo</b> — aparece surdo, mas <b>ouve tudo</b>.<br>
            <b style="color:#ccc">📷 Câmera</b> — aparece com câmera ativa sem abri-la.<br><br>
            <span style="color:#555;font-size:11px">Estado é salvo automaticamente e restaurado ao reabrir o Discord.</span>
        `;
        return div;
    },
});
