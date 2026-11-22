// Prints the APP_PASSWORD_HASH value for a password read from stdin.
// Usage: printf '%s' 'my password' | node tools/hash-password.mjs
import { webcrypto as crypto } from "node:crypto";
const b64url = b => Buffer.from(b).toString("base64url");
let password = "";
for await (const chunk of process.stdin) password += chunk;
const iterations = 100000; // the most Cloudflare Workers allow for PBKDF2
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
process.stdout.write(`pbkdf2$${iterations}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`);
