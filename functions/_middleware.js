// Login and password in front of the whole site.
// The login is checked once, then a signed cookie keeps this browser signed in for a year.
// Settings (Pages secrets): APP_LOGIN, APP_PASSWORD_HASH ("pbkdf2$iterations$salt$hash", base64url),
// SESSION_SECRET (any long random string).

const COOKIE = "gv_session";
const SESSION_DAYS = 400;
const RENEW_AFTER = 24 * 60 * 60;
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

async function passwordMatches(password, stored) {
  const [scheme, iterations, salt, hash] = String(stored || "").split("$");
  if (scheme !== "pbkdf2" || !salt || !hash) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64url(salt), iterations: Number(iterations) }, key, 256);
  return sameBytes(new Uint8Array(bits), fromB64url(hash));
}

// Changing the password changes the signing key, which signs every browser out.
async function signingKey(env) {
  return crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET + "|" + env.APP_PASSWORD_HASH),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeSession(env, login) {
  const body = b64url(enc.encode(login)) + "." + Math.floor(Date.now() / 1000);
  const sig = await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(body));
  return body + "." + b64url(sig);
}

async function readSession(env, request) {
  const cookie = (request.headers.get("Cookie") || "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
  if (!cookie) return null;
  const [user, issued, sig] = cookie.slice(COOKIE.length + 1).split(".");
  if (!user || !issued || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await signingKey(env), fromB64url(sig),
      enc.encode(user + "." + issued));
    const age = Date.now() / 1000 - Number(issued);
    if (!ok || !(age >= -300 && age < SESSION_DAYS * 86400)) return null;
    const login = new TextDecoder().decode(fromB64url(user));
    return login === env.APP_LOGIN ? { login, age } : null;
  } catch {
    return null;
  }
}

const sessionCookie = value =>
  `${COOKIE}=${value}; Path=/; Max-Age=${value ? SESSION_DAYS * 86400 : 0}; HttpOnly; Secure; SameSite=Lax`;

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
    const form = await request.formData().catch(() => null);
    const login = String(form?.get("login") || "").trim();
    const password = String(form?.get("password") || "");
    const ok = (await passwordMatches(password, env.APP_PASSWORD_HASH)) && login === env.APP_LOGIN;
    if (!ok) return loginPage("Неверный логин или пароль", login);
    return new Response(null, {
      status: 303,
      headers: { Location: "/", "Set-Cookie": sessionCookie(await makeSession(env, login)), "Cache-Control": "no-store" },
    });
  }
  if (url.pathname === "/logout") {
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": sessionCookie("") } });
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
  const response = await next();
  // Keep the browser signed in while it is in use.
  if (session.age > RENEW_AFTER) {
    const renewed = new Response(response.body, response);
    renewed.headers.append("Set-Cookie", sessionCookie(await makeSession(env, session.login)));
    return renewed;
  }
  return response;
}
