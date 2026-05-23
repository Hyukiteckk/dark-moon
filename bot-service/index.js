/**
 * Dark Moon — Bot de aprovação de cadastros
 * Deploy: Railway / Render / Fly.io
 *
 * Fluxo:
 *  1. App principal POST /notify-register  → bot envia msg com botões no Discord
 *  2. Owner clica botão  → Discord POST /interactions → bot adiciona UUID ao approvals.json no GitHub
 *  3. App principal faz polling do GitHub approvals.json e aprova localmente
 */

import express from "express";
import nacl from "tweetnacl";
import { Octokit } from "@octokit/rest";

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

const {
  DISCORD_APP_ID,
  DISCORD_PUBLIC_KEY,
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH = "main",
  SECRET,          // chave compartilhada com o app principal
  PORT = 3000,
} = process.env;

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ─── GitHub helpers ───────────────────────────────────────────────────────────

async function ghGet(path) {
  try {
    const r = await octokit.repos.getContent({
      owner: GITHUB_OWNER, repo: GITHUB_REPO, path, ref: GITHUB_BRANCH,
    });
    const content = Buffer.from(r.data.content, "base64").toString("utf8");
    return { data: JSON.parse(content), sha: r.data.sha };
  } catch (e) {
    if (e.status === 404) return { data: null, sha: null };
    throw e;
  }
}

async function ghPut(path, content, sha, message) {
  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER, repo: GITHUB_REPO, path,
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
    sha: sha || undefined,
    branch: GITHUB_BRANCH,
  });
}

// ─── Discord helpers ──────────────────────────────────────────────────────────

async function discordPost(path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function discordPatch(path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

function verifySignature(req) {
  const sig = req.headers["x-signature-ed25519"];
  const ts  = req.headers["x-signature-timestamp"];
  if (!sig || !ts) return false;
  return nacl.sign.detached.verify(
    Buffer.from(ts + req.rawBody),
    Buffer.from(sig, "hex"),
    Buffer.from(DISCORD_PUBLIC_KEY, "hex")
  );
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

// Healthcheck
app.get("/", (_req, res) => res.json({ ok: true, service: "DarkMoon Bot" }));

/**
 * POST /notify-register
 * Chamado pelo app principal quando alguém se cadastra.
 * Body: { username, userId, secret }
 */
app.post("/notify-register", async (req, res) => {
  const { username, userId, secret } = req.body || {};
  if (secret !== SECRET) return res.status(403).json({ error: "Unauthorized" });
  if (!username || !userId) return res.status(400).json({ error: "Missing fields" });

  const dt = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  await discordPost(`/channels/${DISCORD_CHANNEL_ID}/messages`, {
    embeds: [{
      title: "🟡 Novo cadastro aguardando aprovação",
      color: 0xf59e0b,
      fields: [
        { name: "Usuário", value: `\`${username}\``, inline: true },
        { name: "Data", value: dt, inline: true },
        { name: "ID interno", value: `\`${userId}\``, inline: false },
      ],
      footer: { text: "Dark Moon — Sistema de aprovação" },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "✅ Aprovar", custom_id: `approve:${userId}:${username}` },
        { type: 2, style: 4, label: "❌ Rejeitar", custom_id: `reject:${userId}:${username}`  },
      ],
    }],
  });

  res.json({ ok: true });
});

/**
 * POST /interactions
 * Endpoint de interações do Discord (botões).
 * Configure em: discord.dev → seu app → Interactions Endpoint URL
 */
app.post("/interactions", (req, res) => {
  if (!verifySignature(req)) return res.status(401).send("Invalid signature");

  const { type, data, id: iId, token: iTok } = req.body;

  // Ping de verificação do Discord
  if (type === 1) return res.json({ type: 1 });

  // Clique de botão
  if (type === 3) {
    // Responde imediatamente com "deferred update" para o Discord não dar timeout
    res.json({ type: 6 });

    const [action, userId, username] = data.custom_id.split(":");
    const followUp = (content) =>
      discordPatch(`/webhooks/${DISCORD_APP_ID}/${iTok}/messages/@original`, {
        embeds: [{
          title: action === "approve" ? "✅ Aprovado!" : "❌ Rejeitado",
          color: action === "approve" ? 0x3ba55c : 0xf04747,
          description: content,
        }],
        components: [],
      });

    if (action === "approve") {
      ghGet("approvals.json").then(({ data: current, sha }) => {
        const obj = current || { approved: [], rejected: [] };
        if (!obj.approved.includes(userId)) obj.approved.push(userId);
        obj.rejected = (obj.rejected || []).filter(id => id !== userId);
        return ghPut("approvals.json", obj, sha, `approve: ${username}`);
      })
        .then(() => followUp(`\`${username}\` agora tem acesso ao Dark Moon.`))
        .catch(e => followUp(`Erro ao aprovar: ${e.message}`));
    }

    if (action === "reject") {
      ghGet("approvals.json").then(({ data: current, sha }) => {
        const obj = current || { approved: [], rejected: [] };
        if (!obj.rejected.includes(userId)) obj.rejected.push(userId);
        obj.approved = (obj.approved || []).filter(id => id !== userId);
        return ghPut("approvals.json", obj, sha, `reject: ${username}`);
      })
        .then(() => followUp(`\`${username}\` foi rejeitado e não poderá acessar o app.`))
        .catch(e => followUp(`Erro ao rejeitar: ${e.message}`));
    }

    return;
  }

  res.json({ type: 1 });
});

app.listen(PORT, () => console.log(`[DarkMoon Bot] Online na porta ${PORT}`));
