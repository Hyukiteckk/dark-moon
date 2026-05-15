import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { randomUUID } from "crypto";
import { join } from "path";
import { DATA_ROOT } from "./paths.js";

const USERS_FILE = join(DATA_ROOT, "users.json");

function loadUsers() {
  if (!existsSync(USERS_FILE)) return { users: [] };
  try { return JSON.parse(readFileSync(USERS_FILE, "utf8")); } catch { return { users: [] }; }
}

function saveUsers(data) {
  writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function hashPassword(password, salt) {
  return createHash("sha512").update(salt + password).digest("hex");
}

export function fsSafeUserId(userId) {
  return String(userId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown";
}

export function registerUser(username, password) {
  const u = String(username || "").trim();
  const p = String(password || "");
  if (!u || u.length < 3) return { ok: false, error: "Username precisa ter pelo menos 3 caracteres." };
  if (!p || p.length < 4) return { ok: false, error: "Senha precisa ter pelo menos 4 caracteres." };

  const data = loadUsers();
  if (data.users.find((x) => x.username.toLowerCase() === u.toLowerCase())) {
    return { ok: false, error: "Username já em uso." };
  }

  const isFirst = data.users.length === 0;
  const salt = randomBytes(16).toString("hex");
  const user = {
    id: randomUUID(),
    username: u,
    passwordHash: hashPassword(p, salt),
    salt,
    role: (isFirst || u === "manager") ? "owner" : "user",
    approved: isFirst || u === "manager",
  };
  data.users.push(user);
  saveUsers(data);
  return { ok: true, user: { id: user.id, username: user.username, role: user.role, approved: user.approved } };
}

export function loginUser(username, password) {
  const u = String(username || "").trim();
  const p = String(password || "");
  const data = loadUsers();
  const user = data.users.find((x) => x.username.toLowerCase() === u.toLowerCase());
  if (!user) return { ok: false, error: "Usuário não encontrado." };
  if (hashPassword(p, user.salt) !== user.passwordHash) return { ok: false, error: "Senha incorreta." };
  if (!user.approved) return { ok: false, error: "Conta aguardando aprovação." };
  const isOwner = user.role === "owner" || user.username === "manager";
  return { ok: true, user: { id: user.id, username: user.username, role: isOwner ? "owner" : "user", approved: true } };
}

export function findUserById(id) {
  const data = loadUsers();
  const user = data.users.find((x) => x.id === id);
  if (!user) return null;
  const isOwner = user.role === "owner" || user.username === "manager";
  return { id: user.id, username: user.username, role: isOwner ? "owner" : "user", approved: Boolean(user.approved) };
}

export function listPendingUsers() {
  return loadUsers().users.filter((u) => !u.approved).map((u) => ({ id: u.id, username: u.username, role: u.role || "user" }));
}

export function listAllUsersSafe() {
  return loadUsers().users.map((u) => ({
    id: u.id, username: u.username,
    role: (u.role === "owner" || u.username === "manager") ? "owner" : "user",
    approved: Boolean(u.approved),
  }));
}

export function approveUser(userId) {
  const data = loadUsers();
  const user = data.users.find((x) => x.id === userId);
  if (!user) return { ok: false, error: "Usuário não encontrado." };
  user.approved = true;
  saveUsers(data);
  return { ok: true };
}

export function revokeUser(userId) {
  const data = loadUsers();
  const user = data.users.find((x) => x.id === userId);
  if (!user || user.role === "owner") return { ok: false, error: "Não é possível revogar esta conta." };
  user.approved = false;
  saveUsers(data);
  return { ok: true };
}

export function deleteUser(userId) {
  const data = loadUsers();
  const idx = data.users.findIndex((x) => x.id === userId);
  if (idx === -1) return { ok: false, error: "Usuário não encontrado." };
  if (data.users[idx].role === "owner") return { ok: false, error: "Não é possível apagar o owner." };
  data.users.splice(idx, 1);
  saveUsers(data);
  return { ok: true };
}
