const DISCORD_API = "https://discord.com/api/v10";

const SUPER_PROPS = Buffer.from(JSON.stringify({
  os: "Windows",
  browser: "Chrome",
  device: "",
  system_locale: "pt-BR",
  browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  browser_version: "124.0.0.0",
  os_version: "10",
  referrer: "",
  referring_domain: "",
  referrer_current: "",
  referring_domain_current: "",
  release_channel: "stable",
  client_build_number: 328563,
  client_event_source: null,
})).toString("base64");

const BASE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "X-Super-Properties": SUPER_PROPS,
  "X-Discord-Locale": "pt-BR",
  "X-Discord-Timezone": "America/Sao_Paulo",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Origin": "https://discord.com",
  "Referer": "https://discord.com/login",
};

async function discordPost(endpoint, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${DISCORD_API}${endpoint}`, {
      method: "POST",
      signal: controller.signal,
      headers: BASE_HEADERS,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    console.log(`[Discord API] ${endpoint} → ${response.status}: ${text.slice(0, 300)}`);
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loginWithDiscord(login, password) {
  const { ok, status, data } = await discordPost("/auth/login", {
    login: String(login || "").trim(),
    password: String(password || ""),
    undelete: false,
    captcha_key: null,
    login_source: null,
    gift_code_sku_id: null,
  });

  if (data.token) return { ok: true, token: data.token, mfa: false };
  if (data.mfa && data.ticket) return {
    ok: true, mfa: true,
    ticket: data.ticket,
    sms: Boolean(data.sms),
    loginInstanceId: data.login_instance_id || null,
  };
  if (data.captcha_key) return { ok: false, error: "Discord exigiu CAPTCHA. Tente fazer login pelo Discord web primeiro e depois tente novamente." };

  const msg = data.message || data.errors?.login?._errors?.[0]?.message
    || data.errors?.password?._errors?.[0]?.message || `Erro ${status}`;
  return { ok: false, error: msg };
}

export async function loginWithMfa(ticket, code, loginInstanceId) {
  const cleanCode = String(code || "").replace(/\D/g, "");
  console.log(`[MFA] Enviando código "${cleanCode}" com ticket "${String(ticket).slice(0, 30)}..." loginInstanceId="${loginInstanceId}"`);

  const body = {
    code: cleanCode,
    ticket: String(ticket || "").trim(),
  };
  if (loginInstanceId) body.login_instance_id = loginInstanceId;

  const { ok, status, data } = await discordPost("/auth/mfa/totp", body);

  if (ok && data.token) return { ok: true, token: data.token };

  const msg = data.message || data.errors?.code?._errors?.[0]?.message
    || data.errors?.totp?._errors?.[0]?.message || `Erro Discord ${status}`;
  return { ok: false, error: msg };
}

export async function getDiscordUserInfo(token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${DISCORD_API}/users/@me`, {
      signal: controller.signal,
      headers: {
        Authorization: token,
        "User-Agent": BASE_HEADERS["User-Agent"],
      },
    });
    if (!response.ok) throw new Error(`Discord retornou ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}
