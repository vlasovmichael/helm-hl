// ─────────────────────────────────────────────────
//  Dashboard Auth — session cookies + login/logout
// ─────────────────────────────────────────────────
// Доступ снаружи идёт через Cloudflare Tunnel + Access; этот слой — второй
// рубеж (Basic-style логин с HMAC-сессией), включается только когда заданы
// DASHBOARD_USER + DASHBOARD_PASS. Без них дашборд открыт (локальный доступ).

import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AUTH_USER = process.env.DASHBOARD_USER || "";
const AUTH_PASS = process.env.DASHBOARD_PASS || "";
export const AUTH_ENABLED = AUTH_USER.length > 0 && AUTH_PASS.length > 0;

const SESSION_SECRET = crypto
  .createHash("sha256")
  .update(`${AUTH_PASS}::hl-dashboard-session-v1`)
  .digest();
const SESSION_COOKIE = "hl-session";
const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Vite-сборка фронта (npm run build:dash). login.html попадает сюда как отдельный entry.
const PUBLIC_DIR = join(__dirname, "dist");

function signSession(user, expiresAt) {
  const payload = `${user}:${expiresAt}`;
  const h = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("hex");
  return `${expiresAt}.${h}`;
}

function verifySession(token, user) {
  if (!token || typeof token !== "string") return false;
  const idx = token.indexOf(".");
  if (idx === -1) return false;
  const expiresAt = parseInt(token.slice(0, idx), 10);
  const sig = token.slice(idx + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`${user}:${expiresAt}`)
    .digest("hex");
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function constantTimeStringEqual(a, b) {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  const cookies = parseCookies(req);
  return verifySession(cookies[SESSION_COOKIE], AUTH_USER);
}

const PUBLIC_PATHS = new Set(["/login", "/styles.css", "/favicon.ico"]);

export function authGate(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (isAuthenticated(req)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const next_ = encodeURIComponent(req.originalUrl || "/");
  res.redirect(302, `/login?next=${next_}`);
}

export function handleLoginGet(req, res) {
  if (!AUTH_ENABLED) return res.redirect(302, "/");
  if (isAuthenticated(req)) return res.redirect(302, "/");
  res.sendFile(join(PUBLIC_DIR, "login.html"));
}

export function handleLoginPost(req, res) {
  if (!AUTH_ENABLED) return res.redirect(302, "/");
  const user = (req.body?.user || "").toString();
  const pass = (req.body?.pass || "").toString();
  const userOk =
    user.length === AUTH_USER.length &&
    constantTimeStringEqual(user, AUTH_USER);
  const passOk =
    pass.length === AUTH_PASS.length &&
    constantTimeStringEqual(pass, AUTH_PASS);
  if (!userOk || !passOk)
    return res.status(401).json({ error: "Invalid username or password." });
  const expiresAt = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const token = signSession(AUTH_USER, expiresAt);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`,
  );
  res.status(204).end();
}

export function handleLogout(_req, res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  res.redirect(302, "/login");
}
