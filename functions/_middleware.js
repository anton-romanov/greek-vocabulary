// Login and password in front of the whole site.
// The login is checked once, then a signed cookie keeps this browser signed in for a year.
// Settings (Pages secrets): APP_LOGIN, APP_PASSWORD_HASH ("sha256$salt$hash", base64url; made by tools/new-password.mjs),
// SESSION_SECRET (any long random string). Changing SESSION_SECRET or the password signs every
// browser out; deleting one session:<id> record in KV signs out just that device.

import { readLimited } from "./api/state.js";

const COOKIE = "gv_session";
const SESSION_DAYS = 400;
const GENERATED_PASSWORD = /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/;
const PUBLIC = new Set(["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"]);

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")
  .padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// The password is a generated ~82-bit random string (tools/new-password.mjs), so a single
// salted SHA-256 is enough: guessing it online is hopeless without attempt counters, and a
// cheap check cannot be used to burn the site's CPU budget.
async function passwordMatches(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "sha256" || !salt || !hash) return false;
  const saltBytes = fromB64url(salt), input = enc.encode(password);
  const data = new Uint8Array(saltBytes.length + input.length);
  data.set(saltBytes); data.set(input, saltBytes.length);
  return sameBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), fromB64url(hash));
}
// Changing the password changes the signing key, which signs every browser out.
async function signingKey(env) {
  return crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET + "|" + env.APP_PASSWORD_HASH),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// A session is "<login>.<issued>.<id>.<signature>". It lasts SESSION_DAYS from sign-in and is
// never extended. Each one also has a record session:<id> in KV (with the device's user agent),
// so a lost device can be signed out alone by deleting its record in the Cloudflare dashboard.
async function makeSession(env, login, request) {
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await env.STATE.put("session:" + id, JSON.stringify({
    login, at: new Date().toISOString(), device: (request.headers.get("User-Agent") || "").slice(0, 200),
  }), { expirationTtl: SESSION_DAYS * 86400 });
  const body = b64url(enc.encode(login)) + "." + Math.floor(Date.now() / 1000) + "." + id;
  const sig = await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(body));
  return body + "." + b64url(sig);
}

async function readSession(env, request) {
  const cookie = (request.headers.get("Cookie") || "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
  if (!cookie) return null;
  const [user, issued, id, sig] = cookie.slice(COOKIE.length + 1).split(".");
  if (!user || !issued || !id || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await signingKey(env), fromB64url(sig),
      enc.encode(user + "." + issued + "." + id));
    const age = Date.now() / 1000 - Number(issued);
    if (!ok || !(age >= -300 && age < SESSION_DAYS * 86400)) return null;
    const login = new TextDecoder().decode(fromB64url(user));
    if (login !== env.APP_LOGIN) return null;
    if ((await env.STATE.get("session:" + id)) === null) return null;
    return { login };
  } catch {
    return null;
  }
}

const sessionCookie = value =>
  `${COOKIE}=${value}; Path=/; Max-Age=${value ? SESSION_DAYS * 86400 : 0}; HttpOnly; Secure; SameSite=Lax`;

function withFrameProtection(response) {
  const protectedResponse = new Response(response.body, response);
  protectedResponse.headers.set("X-Frame-Options", "DENY");
  if (!protectedResponse.headers.has("Content-Security-Policy")) {
    protectedResponse.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  }
  return protectedResponse;
}

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function loginPage(error = "", login = "") {
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Ελληνικά — вход</title>
<link rel="manifest" href="manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Ελληνικά">
<link rel="apple-touch-icon" href="icon-192.png">
<style>
:root{--bg:#f6f7f3;--card:#fff;--ink:#17211b;--muted:#6d786f;--line:#dfe5df;--accent:#2d6a4f;--bad:#9b3d3d;--shadow:0 10px 30px rgba(20,40,25,.08)}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif}
body{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))}
form{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:26px 22px;display:grid;gap:12px}
h1{margin:0 0 4px;font-size:28px;letter-spacing:-.02em}
p{margin:0;color:var(--muted)}
label{display:grid;gap:5px;font-weight:650;font-size:14px}
input{font:inherit;font-size:16px;width:100%;border:1px solid var(--line);border-radius:13px;padding:13px 12px;background:#fff;color:var(--ink)}
button{font:inherit;font-size:16px;font-weight:750;min-height:50px;border:0;border-radius:15px;background:var(--accent);color:#fff;margin-top:6px}
.error{color:var(--bad);font-weight:650}
</style></head>
<body><form method="post" action="/login">
<h1>Ελληνικά</h1>
<p>Мои слова. Войдите один раз — дальше этот браузер запомнит вас.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<label>Логин<input name="login" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required value="${escapeHtml(login)}"></label>
<label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Войти</button>
</form></body></html>`;
  // 401 so the service worker never caches this page as the app.
  return new Response(html, {
    status: 401,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (!env.APP_LOGIN || !env.APP_PASSWORD_HASH || !env.SESSION_SECRET) {
    return new Response("Вход не настроен", { status: 503 });
  }

  if (url.pathname === "/login" && request.method === "POST") {
    const raw = await readLimited(request, 4096);
    if (raw === null) return loginPage("Неверный логин или пароль");
    const form = new URLSearchParams(raw);
    const login = String(form?.get("login") || "").trim();
    const password = String(form?.get("password") || "");
    // Only passwords in the generated format are accepted, so a weak hand-picked one never works.
    const ok = GENERATED_PASSWORD.test(password) && (await passwordMatches(password, env.APP_PASSWORD_HASH)) && login === env.APP_LOGIN;
    if (!ok) return loginPage("Неверный логин или пароль", login);
    return new Response(null, {
      status: 303,
      headers: { Location: "/", "Set-Cookie": sessionCookie(await makeSession(env, login, request)), "Cache-Control": "no-store" },
    });
  }
  if (PUBLIC.has(url.pathname)) return next();

  const session = await readSession(env, request);
  if (!session) {
    if (url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    return loginPage();
  }

  context.data.user = session.login;
  const response = withFrameProtection(await next());
  return response;
}
