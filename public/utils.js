function $(id) { return document.getElementById(id); }

function api(path, body, method) {
  const opts = {
    method: body !== undefined ? (method || "POST") : "GET",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(path, opts).then((r) => r.json());
}

function showResult(el, msg, type = "ok") {
  if (!el) return;
  el.className = `result-box ${type}`;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function hideResult(el) {
  if (el) el.classList.add("hidden");
}

function setLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) btn.dataset.orig = btn.textContent;
  btn.textContent = loading ? "Aguarde..." : (btn.dataset.orig || btn.textContent);
}

function avatarUrl(userId, hash, size = 64) {
  if (!hash) return null;
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=${size}`;
}

function initials(name) {
  if (!name) return "?";
  return name.split(/[\s#]/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

function renderAvatar(container, userId, avatarHash, name, size = 34) {
  const url = avatarUrl(userId, avatarHash, size * 2);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = name || "avatar";
    img.onerror = () => { container.textContent = initials(name); };
    container.appendChild(img);
  } else {
    container.textContent = initials(name);
  }
}
