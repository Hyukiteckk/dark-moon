/**
 * Dark Moon — Bot de aprovação (Cloudflare Worker)
 *
 * Free forever:
 *   Workers  → 100.000 req/dia
 *   KV       → 100k leituras + 1k escritas/dia
 *
 * Rotas:
 *   POST /notify            ← chamado pelo app ao cadastrar
 *   POST /interactions      ← Discord envia aqui ao clicar botão
 *   GET  /check-approvals   ← app faz polling a cada 30s
 */

const encoder = new TextEncoder();

// ─── utils ────────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Discord Ed25519 verification (Web Crypto — nativo no Worker) ─────────────

async function verifyDiscord(request, publicKey) {
  const sig = request.headers.get("x-signature-ed25519");
  const ts  = request.headers.get("x-signature-timestamp");
  if (!sig || !ts) return { ok: false, body: "" };
  const body = await request.text();
  try {
    const key = await crypto.subtle.importKey(
      "raw", hexToBytes(publicKey),
      { name: "Ed25519", namedCurve: "Ed25519" },
      false, ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "Ed25519", key,
      hexToBytes(sig),
      encoder.encode(ts + body)
    );
    return { ok, body };
  } catch {
    return { ok: false, body };
  }
}

// ─── Discord REST ─────────────────────────────────────────────────────────────

function discordAPI(method, path, body, token) {
  return fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleNotify(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }

  const { username, userId, discordId, discordUsername, secret } = body;
  if (secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
  if (!username || !userId)  return jsonRes({ error: "Campos faltando" }, 400);

  await env.DM_KV.put(`pending:${userId}`, username, { expirationTtl: 60 * 60 * 24 * 30 });

  const dt = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const shortId = userId.split("-")[0].toUpperCase();

  const fields = [
    { name: "👤  Usuário no app",   value: `\`\`\`${username}\`\`\``,      inline: true  },
    { name: "🆔  ID interno",        value: `\`\`\`${shortId}\`\`\``,       inline: true  },
    { name: "📅  Data de cadastro",  value: `\`\`\`${dt}\`\`\``,            inline: false },
  ];

  if (discordUsername) fields.push({ name: "🎮  Discord",  value: `\`\`\`${discordUsername}\`\`\``, inline: true });
  if (discordId)       fields.push({ name: "🔖  Discord ID", value: `\`\`\`${discordId}\`\`\``,     inline: true });

  await discordAPI("POST", `/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    embeds: [{
      title: "🌙  Novo cadastro aguardando aprovação",
      description: "Um novo usuário se registrou no **Dark Moon** e está aguardando sua aprovação.",
      color: 0x9333ea,
      fields,
      footer: { text: `Dark Moon  •  Sistema de aprovação  •  ID: ${userId}` },
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "  Aprovar", custom_id: `approve:${userId}`, emoji: { name: "✅" } },
        { type: 2, style: 4, label: "  Rejeitar", custom_id: `reject:${userId}`, emoji: { name: "❌" } },
      ],
    }],
  }, env.DISCORD_BOT_TOKEN);

  return jsonRes({ ok: true });
}

async function handleCheckApprovals(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.SECRET)
    return jsonRes({ error: "Não autorizado" }, 403);

  const [approvedList, rejectedList] = await Promise.all([
    env.DM_KV.list({ prefix: "approved:" }),
    env.DM_KV.list({ prefix: "rejected:" }),
  ]);

  return jsonRes({
    approved: approvedList.keys.map(k => k.name.replace("approved:", "")),
    rejected: rejectedList.keys.map(k => k.name.replace("rejected:", "")),
  });
}

async function handleInteractions(request, env, ctx) {
  const { ok, body: rawBody } = await verifyDiscord(request, env.DISCORD_PUBLIC_KEY);
  if (!ok) return new Response("Assinatura inválida", { status: 401 });

  const payload = JSON.parse(rawBody);
  const { type, data, token: iTok, application_id: appId } = payload;

  // Ping de verificação do Discord
  if (type === 1) return jsonRes({ type: 1 });

  // Clique de botão
  if (type === 3) {
    const [action, userId] = data.custom_id.split(":");

    // Responde imediatamente (tipo 6 = deferred update) — Discord precisa de < 3s
    ctx.waitUntil((async () => {
      const username = await env.DM_KV.get(`pending:${userId}`) || userId;
      let color, title, desc;

      if (action === "approve") {
        await Promise.all([
          env.DM_KV.put(`approved:${userId}`, username),
          env.DM_KV.delete(`rejected:${userId}`),
        ]);
        color = 0x3ba55c; title = "✅ Aprovado!";
        desc  = `\`${username}\` agora tem acesso ao **Dark Moon**.`;
      } else {
        await Promise.all([
          env.DM_KV.put(`rejected:${userId}`, username),
          env.DM_KV.delete(`approved:${userId}`),
        ]);
        color = 0xf04747; title = "❌ Rejeitado";
        desc  = `\`${username}\` não terá acesso ao app.`;
      }

      // Edita a mensagem original no Discord
      await fetch(`https://discord.com/api/v10/webhooks/${appId}/${iTok}/messages/@original`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        body: JSON.stringify({
          embeds: [{ title, color, description: desc }],
          components: [],
        }),
      });
    })());

    return jsonRes({ type: 6 }); // resposta imediata ao Discord
  }

  return jsonRes({ type: 1 });
}

// ─── Router principal ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "GET"  && pathname === "/")                 return jsonRes({ ok: true, service: "DarkMoon Bot" });
    if (method === "POST" && pathname === "/notify")           return handleNotify(request, env);
    if (method === "POST" && pathname === "/interactions")     return handleInteractions(request, env, ctx);
    if (method === "GET"  && pathname === "/check-approvals")  return handleCheckApprovals(request, env);

    return new Response("Not Found", { status: 404 });
  },
};
