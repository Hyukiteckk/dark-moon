/**
 * Dark Moon — Bot de aprovação (Cloudflare Worker)
 *
 * Free forever:
 *   Workers  → 100.000 req/dia
 *   KV       → 100k leituras + 1k escritas/dia
 *
 * Rotas:
 *   POST /account/register    ← cadastro centralizado (com hash de senha)
 *   POST /account/login       ← login verificado no KV
 *   POST /account/set-password← troca de senha (admin)
 *   GET  /accounts            ← lista todas as contas (admin)
 *   POST /approve             ← aprovar usuário (admin app)
 *   POST /reject              ← rejeitar usuário (admin app)
 *   POST /notify              ← legado: notificação Discord
 *   POST /interactions        ← Discord botões
 *   GET  /check-approvals     ← polling 30s (inclui pending)
 *   GET  /users               ← lista usuários (legado)
 *   POST /ban                 ← banir usuário
 *   POST /set-role            ← definir cargo
 *   POST /user-perms          ← definir abas permitidas
 *   GET  /permissions         ← matriz de permissões
 *   POST /permissions         ← salvar matriz
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

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100_000, hash: "SHA-256" },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Discord Ed25519 verification ─────────────────────────────────────────────

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
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── Discord approval notification ────────────────────────────────────────────

async function sendApprovalNotification(env, userId, username, password, discordUsername = "", discordId = "") {
  const dt = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const shortId = String(userId).split("-")[0].toUpperCase();

  const fields = [
    { name: "👤  Usuário no app",  value: `\`\`\`${username}\`\`\``,         inline: true  },
    { name: "🔑  Senha",            value: `\`\`\`${password || "—"}\`\`\``,  inline: true  },
    { name: "🆔  ID interno",       value: `\`\`\`${shortId}\`\`\``,          inline: false },
    { name: "📅  Data de cadastro", value: `\`\`\`${dt}\`\`\``,               inline: false },
  ];
  if (discordUsername) fields.push({ name: "🎮  Discord",    value: `\`\`\`${discordUsername}\`\`\``, inline: true });
  if (discordId)       fields.push({ name: "🔖  Discord ID", value: `\`\`\`${discordId}\`\`\``,       inline: true });

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
        { type: 2, style: 4, label: "  Rejeitar", custom_id: `reject:${userId}`,  emoji: { name: "❌" } },
      ],
    }],
  }, env.DISCORD_BOT_TOKEN);
}

// ─── Account handlers (centralized auth) ──────────────────────────────────────

async function handleRegisterAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }

  const { username, password, discordUsername = "", discordId = "", secret } = body;
  const isAdminSecret = secret === env.SECRET;
  const isAuth = isAdminSecret || secret === env.CLIENT_SECRET;
  if (!isAuth) return jsonRes({ error: "Não autorizado" }, 403);

  const u = String(username || "").trim();
  const p = String(password || "");
  if (!u || u.length < 3) return jsonRes({ error: "Username precisa ter pelo menos 3 caracteres." }, 400);
  if (!p || p.length < 4) return jsonRes({ error: "Senha precisa ter pelo menos 4 caracteres." }, 400);

  const existingId = await env.DM_KV.get(`acctname:${u.toLowerCase()}`);
  if (existingId) return jsonRes({ error: "Usuário já cadastrado." }, 409);

  const id   = crypto.randomUUID();
  const salt = randomHex(16);
  const passwordHash = await hashPassword(p, salt);

  // Registro via BOT_SECRET (admin/owner): auto-aprovado, sem notificação, sem pending
  const autoApprove = isAdminSecret;

  const account = {
    id,
    username: u,
    passwordHash,
    salt,
    approved: autoApprove,
    role: "user",
    workerRole: "membro",
    registeredAt: new Date().toISOString(),
  };

  const kvWrites = [
    env.DM_KV.put(`account:${id}`, JSON.stringify(account)),
    env.DM_KV.put(`acctname:${u.toLowerCase()}`, id),
    env.DM_KV.put(`user:${id}`, JSON.stringify({ username: u, registeredAt: account.registeredAt }), { expirationTtl: 60 * 60 * 24 * 365 }),
  ];

  if (autoApprove) {
    // Já entra direto como aprovado — sem pending, sem log no Discord
    kvWrites.push(env.DM_KV.put(`approved:${id}`, u));
  } else {
    // Usuário normal: fica pendente e notifica Discord
    kvWrites.push(env.DM_KV.put(`pending:${id}`, u, { expirationTtl: 60 * 60 * 24 * 30 }));
  }

  await Promise.all(kvWrites);

  if (!autoApprove) {
    await sendApprovalNotification(env, id, u, p, discordUsername, discordId).catch(() => {});
  }

  return jsonRes({ ok: true, userId: id, pendingApproval: !autoApprove });
}

async function handleLoginAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }

  const { username, password, secret } = body;
  const isAuth = secret === env.SECRET || secret === env.CLIENT_SECRET;
  if (!isAuth) return jsonRes({ error: "Não autorizado" }, 403);

  const u = String(username || "").trim();
  const p = String(password || "");

  const id = await env.DM_KV.get(`acctname:${u.toLowerCase()}`);
  if (!id) return jsonRes({ error: "Usuário não encontrado." }, 401);

  const raw = await env.DM_KV.get(`account:${id}`);
  if (!raw) return jsonRes({ error: "Usuário não encontrado." }, 401);

  let account;
  try { account = JSON.parse(raw); } catch { return jsonRes({ error: "Erro interno." }, 500); }

  const bannedVal = await env.DM_KV.get(`banned:${id}`);
  if (bannedVal !== null) return jsonRes({ error: "Conta banida." }, 403);

  const hash = await hashPassword(p, account.salt);
  if (hash !== account.passwordHash) return jsonRes({ error: "Senha incorreta." }, 401);

  if (!account.approved) {
    // Resync with approved: index (Discord button may have approved)
    const approvedVal = await env.DM_KV.get(`approved:${id}`);
    if (approvedVal !== null) {
      account.approved = true;
      await env.DM_KV.put(`account:${id}`, JSON.stringify(account));
    } else {
      return jsonRes({ error: "Conta aguardando aprovação." }, 403);
    }
  }

  const permsRaw = await env.DM_KV.get(`userperms:${id}`);
  let allowedTabs = null;
  if (permsRaw) { try { allowedTabs = JSON.parse(permsRaw); } catch {} }

  return jsonRes({
    ok: true,
    user: {
      id: account.id,
      username: account.username,
      role: "user",
      approved: true,
      workerRole: account.workerRole || "membro",
      allowedTabs,
    },
  });
}

async function handleSetAccountPassword(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }

  const { userId, newPassword, secret } = body;
  if (secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
  if (!userId || !newPassword) return jsonRes({ error: "userId e newPassword obrigatórios" }, 400);
  if (String(newPassword).length < 4) return jsonRes({ error: "Senha precisa ter pelo menos 4 caracteres." }, 400);

  const raw = await env.DM_KV.get(`account:${userId}`);
  if (!raw) return jsonRes({ error: "Usuário não encontrado." }, 404);

  let account;
  try { account = JSON.parse(raw); } catch { return jsonRes({ error: "Erro interno." }, 500); }

  const salt = randomHex(16);
  account.passwordHash = await hashPassword(String(newPassword), salt);
  account.salt = salt;

  await env.DM_KV.put(`account:${userId}`, JSON.stringify(account));
  return jsonRes({ ok: true });
}

async function handleListAccounts(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.SECRET)
    return jsonRes({ error: "Não autorizado" }, 403);

  const accountKeys = await env.DM_KV.list({ prefix: "account:" });
  const accounts = await Promise.all(accountKeys.keys.map(async k => {
    const raw = await env.DM_KV.get(k.name);
    try {
      const { passwordHash, salt, ...safe } = JSON.parse(raw);
      const permsRaw = await env.DM_KV.get(`userperms:${safe.id}`);
      const bannedVal = await env.DM_KV.get(`banned:${safe.id}`);
      let allowedTabs = null;
      if (permsRaw) { try { allowedTabs = JSON.parse(permsRaw); } catch {} }
      return { ...safe, allowedTabs, banned: bannedVal !== null };
    } catch { return null; }
  }));

  return jsonRes({ accounts: accounts.filter(Boolean) });
}

async function handleApproveAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }

  const { userId, secret } = body;
  if (secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
  if (!userId) return jsonRes({ error: "userId obrigatório" }, 400);

  const raw = await env.DM_KV.get(`account:${userId}`);
  if (!raw) return jsonRes({ error: "Usuário não encontrado." }, 404);

  let account;
  try { account = JSON.parse(raw); } catch { return jsonRes({ error: "Erro interno." }, 500); }

  account.approved = true;
  await Promise.all([
    env.DM_KV.put(`account:${userId}`, JSON.stringify(account)),
    env.DM_KV.put(`approved:${userId}`, account.username),
    env.DM_KV.delete(`pending:${userId}`),
    env.DM_KV.delete(`rejected:${userId}`),
  ]);

  return jsonRes({ ok: true });
}

async function handleRejectAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }

  const { userId, secret } = body;
  if (secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
  if (!userId) return jsonRes({ error: "userId obrigatório" }, 400);

  const raw = await env.DM_KV.get(`account:${userId}`);
  let username = userId;
  if (raw) {
    try {
      const acc = JSON.parse(raw);
      username = acc.username || userId;
      acc.approved = false;
      await env.DM_KV.put(`account:${userId}`, JSON.stringify(acc));
    } catch {}
  }

  await Promise.all([
    env.DM_KV.put(`rejected:${userId}`, username),
    env.DM_KV.delete(`pending:${userId}`),
    env.DM_KV.delete(`approved:${userId}`),
  ]);

  return jsonRes({ ok: true });
}

// ─── Existing handlers ────────────────────────────────────────────────────────

async function handleNotify(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }

  const { username, userId, discordId, discordUsername, password, secret } = body;
  if (secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
  if (!username || !userId)  return jsonRes({ error: "Campos faltando" }, 400);

  const userMeta = JSON.stringify({ username, discordUsername: discordUsername || "", discordId: discordId || "", registeredAt: new Date().toISOString() });
  await env.DM_KV.put(`pending:${userId}`, username, { expirationTtl: 60 * 60 * 24 * 30 });
  await env.DM_KV.put(`user:${userId}`, userMeta, { expirationTtl: 60 * 60 * 24 * 365 });

  await sendApprovalNotification(env, userId, username, password, discordUsername, discordId).catch(() => {});

  return jsonRes({ ok: true });
}

async function handleUsers(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.SECRET)
    return jsonRes({ error: "Não autorizado" }, 403);

  const [userKeys, approvedList, rejectedList, bannedList] = await Promise.all([
    env.DM_KV.list({ prefix: "user:" }),
    env.DM_KV.list({ prefix: "approved:" }),
    env.DM_KV.list({ prefix: "rejected:" }),
    env.DM_KV.list({ prefix: "banned:" }),
  ]);

  const approvedIds = new Set(approvedList.keys.map(k => k.name.replace("approved:", "")));
  const rejectedIds = new Set(rejectedList.keys.map(k => k.name.replace("rejected:", "")));
  const bannedIds   = new Set(bannedList.keys.map(k => k.name.replace("banned:", "")));

  const users = await Promise.all(userKeys.keys.map(async k => {
    const uid = k.name.replace("user:", "");
    const raw = await env.DM_KV.get(k.name);
    try {
      const meta = JSON.parse(raw);
      return { id: uid, ...meta, approved: approvedIds.has(uid), rejected: rejectedIds.has(uid), banned: bannedIds.has(uid) };
    } catch {
      return { id: uid, username: raw, approved: approvedIds.has(uid), rejected: rejectedIds.has(uid), banned: bannedIds.has(uid) };
    }
  }));

  return jsonRes({ users });
}

async function handleBan(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }
  const { userId, secret } = body;
  if (secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
  if (!userId) return jsonRes({ error: "userId obrigatório" }, 400);

  const username = await env.DM_KV.get(`pending:${userId}`) || userId;
  await Promise.all([
    env.DM_KV.put(`banned:${userId}`, username),
    env.DM_KV.delete(`approved:${userId}`),
  ]);

  // Update account approved flag if account exists
  const accRaw = await env.DM_KV.get(`account:${userId}`);
  if (accRaw) {
    try {
      const acc = JSON.parse(accRaw);
      acc.approved = false;
      await env.DM_KV.put(`account:${userId}`, JSON.stringify(acc));
    } catch {}
  }

  return jsonRes({ ok: true });
}

const DEFAULT_PERMISSIONS = {
  membro:  ["overview", "fake-call", "orbs-auto", "nuke", "conversations"],
  pro:     ["overview", "call", "fake-call", "orbs-auto", "nuke", "conversations", "logs", "history"],
  elite:   ["overview", "call", "fake-call", "orbs-auto", "moderation", "investigate", "nuke", "conversations", "logs", "history"],
  master:  ["overview", "call", "fake-call", "clone", "orbs-auto", "moderation", "investigate", "nuke", "conversations", "logs", "history"],
};

async function getPermissions(env) {
  const raw = await env.DM_KV.get("config:permissions");
  try { return raw ? JSON.parse(raw) : DEFAULT_PERMISSIONS; } catch { return DEFAULT_PERMISSIONS; }
}

async function handleCheckApprovals(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.SECRET)
    return jsonRes({ error: "Não autorizado" }, 403);

  const [approvedList, rejectedList, bannedList, userKeys, pendingList] = await Promise.all([
    env.DM_KV.list({ prefix: "approved:" }),
    env.DM_KV.list({ prefix: "rejected:" }),
    env.DM_KV.list({ prefix: "banned:" }),
    env.DM_KV.list({ prefix: "user:" }),
    env.DM_KV.list({ prefix: "pending:" }),
  ]);

  const permissions = await getPermissions(env);

  const roleMap = {};
  const userPermsMap = {};
  await Promise.all(userKeys.keys.map(async k => {
    const uid = k.name.replace("user:", "");
    const [raw, permsRaw] = await Promise.all([
      env.DM_KV.get(k.name),
      env.DM_KV.get(`userperms:${uid}`),
    ]);
    try { const meta = JSON.parse(raw); roleMap[uid] = meta.role || "membro"; } catch {}
    if (permsRaw) { try { userPermsMap[uid] = JSON.parse(permsRaw); } catch {} }
  }));

  const approvedIds = new Set(approvedList.keys.map(k => k.name.replace("approved:", "")));
  const rejectedIds = new Set(rejectedList.keys.map(k => k.name.replace("rejected:", "")));

  const pendingUsers = await Promise.all(
    pendingList.keys
      .filter(k => {
        const uid = k.name.replace("pending:", "");
        return !approvedIds.has(uid) && !rejectedIds.has(uid);
      })
      .map(async k => {
        const uid = k.name.replace("pending:", "");
        const username = await env.DM_KV.get(k.name);
        return { id: uid, username: username || uid };
      })
  );

  return jsonRes({
    approved:    approvedList.keys.map(k => k.name.replace("approved:", "")),
    rejected:    rejectedList.keys.map(k => k.name.replace("rejected:", "")),
    banned:      bannedList.keys.map(k => k.name.replace("banned:", "")),
    pending:     pendingUsers,
    roles:       roleMap,
    userPerms:   userPermsMap,
    permissions,
  });
}

async function handleSetUserPerms(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }
  const { userId, tabs, secret } = body;
  if (secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
  if (!userId || !Array.isArray(tabs)) return jsonRes({ error: "userId e tabs obrigatórios" }, 400);
  await env.DM_KV.put(`userperms:${userId}`, JSON.stringify(tabs));
  return jsonRes({ ok: true });
}

async function handleSetRole(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }
  const { userId, role, secret } = body;
  if (secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
  if (!userId || !role) return jsonRes({ error: "userId e role obrigatórios" }, 400);
  const validRoles = ["membro", "pro", "elite", "master"];
  if (!validRoles.includes(role)) return jsonRes({ error: "Cargo inválido" }, 400);

  // Update user: metadata
  const raw = await env.DM_KV.get(`user:${userId}`);
  let meta = {};
  try { meta = JSON.parse(raw) || {}; } catch {}
  meta.role = role;
  await env.DM_KV.put(`user:${userId}`, JSON.stringify(meta), { expirationTtl: 60 * 60 * 24 * 365 });

  // Also update account: workerRole
  const accRaw = await env.DM_KV.get(`account:${userId}`);
  if (accRaw) {
    try {
      const acc = JSON.parse(accRaw);
      acc.workerRole = role;
      await env.DM_KV.put(`account:${userId}`, JSON.stringify(acc));
    } catch {}
  }

  return jsonRes({ ok: true });
}

async function handleResetAllAccounts(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }
  if (body.secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);

  const prefixes = ["account:", "acctname:", "user:", "pending:", "approved:", "rejected:", "banned:", "userperms:"];
  let totalDeleted = 0;

  for (const prefix of prefixes) {
    let cursor;
    do {
      const opts = cursor ? { prefix, cursor } : { prefix };
      const list = await env.DM_KV.list(opts);
      await Promise.all(list.keys.map(k => env.DM_KV.delete(k.name)));
      totalDeleted += list.keys.length;
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }

  return jsonRes({ ok: true, deleted: totalDeleted });
}

async function handlePermissions(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    if (url.searchParams.get("secret") !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
    return jsonRes({ permissions: await getPermissions(env) });
  }
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: "JSON inválido" }, 400); }
  const { permissions, secret } = body;
  if (secret !== env.SECRET) return jsonRes({ error: "Não autorizado" }, 403);
  await env.DM_KV.put("config:permissions", JSON.stringify(permissions));
  return jsonRes({ ok: true });
}

async function handleInteractions(request, env, ctx) {
  const { ok, body: rawBody } = await verifyDiscord(request, env.DISCORD_PUBLIC_KEY);
  if (!ok) return new Response("Assinatura inválida", { status: 401 });

  const payload = JSON.parse(rawBody);
  const { type, data, token: iTok, application_id: appId } = payload;

  if (type === 1) return jsonRes({ type: 1 });

  if (type === 3) {
    const [action, userId] = data.custom_id.split(":");

    ctx.waitUntil((async () => {
      const username = await env.DM_KV.get(`pending:${userId}`) || userId;
      let color, title, desc;

      if (action === "approve") {
        await Promise.all([
          env.DM_KV.put(`approved:${userId}`, username),
          env.DM_KV.delete(`rejected:${userId}`),
          env.DM_KV.delete(`pending:${userId}`),
        ]);
        // Update account.approved
        const raw = await env.DM_KV.get(`account:${userId}`);
        if (raw) {
          try {
            const acc = JSON.parse(raw);
            acc.approved = true;
            await env.DM_KV.put(`account:${userId}`, JSON.stringify(acc));
          } catch {}
        }
        color = 0x3ba55c; title = "✅ Aprovado!";
        desc  = `\`${username}\` agora tem acesso ao **Dark Moon**.`;
      } else {
        await Promise.all([
          env.DM_KV.put(`rejected:${userId}`, username),
          env.DM_KV.delete(`approved:${userId}`),
          env.DM_KV.delete(`pending:${userId}`),
        ]);
        // Update account.approved
        const raw = await env.DM_KV.get(`account:${userId}`);
        if (raw) {
          try {
            const acc = JSON.parse(raw);
            acc.approved = false;
            await env.DM_KV.put(`account:${userId}`, JSON.stringify(acc));
          } catch {}
        }
        color = 0xf04747; title = "❌ Rejeitado";
        desc  = `\`${username}\` não terá acesso ao app.`;
      }

      await fetch(`https://discord.com/api/v10/webhooks/${appId}/${iTok}/messages/@original`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        body: JSON.stringify({
          embeds: [{ title, color, description: desc }],
          components: [],
        }),
      });
    })());

    return jsonRes({ type: 6 });
  }

  return jsonRes({ type: 1 });
}

// ─── Router principal ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "GET"  && pathname === "/")                       return jsonRes({ ok: true, service: "DarkMoon Bot" });
    if (method === "POST" && pathname === "/account/register")       return handleRegisterAccount(request, env);
    if (method === "POST" && pathname === "/account/login")          return handleLoginAccount(request, env);
    if (method === "POST" && pathname === "/account/set-password")   return handleSetAccountPassword(request, env);
    if (method === "GET"  && pathname === "/accounts")               return handleListAccounts(request, env);
    if (method === "POST" && pathname === "/approve")                return handleApproveAccount(request, env);
    if (method === "POST" && pathname === "/reject")                 return handleRejectAccount(request, env);
    if (method === "POST" && pathname === "/notify")                 return handleNotify(request, env);
    if (method === "POST" && pathname === "/interactions")           return handleInteractions(request, env, ctx);
    if (method === "GET"  && pathname === "/check-approvals")        return handleCheckApprovals(request, env);
    if (method === "GET"  && pathname === "/users")                  return handleUsers(request, env);
    if (method === "POST" && pathname === "/ban")                    return handleBan(request, env);
    if (method === "POST" && pathname === "/set-role")               return handleSetRole(request, env);
    if (method === "POST" && pathname === "/user-perms")             return handleSetUserPerms(request, env);
    if (method === "GET"  && pathname === "/permissions")            return handlePermissions(request, env);
    if (method === "POST" && pathname === "/permissions")            return handlePermissions(request, env);
    if (method === "POST" && pathname === "/reset-all-accounts")    return handleResetAllAccounts(request, env);

    return new Response("Not Found", { status: 404 });
  },
};
