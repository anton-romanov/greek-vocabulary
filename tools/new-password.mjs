// Makes a new random password and the APP_PASSWORD_HASH value for it.
// Usage: node tools/new-password.mjs  -> line 1: password, line 2: hash
// The password is always generated here (about 82 bits), never chosen by hand: that strength is
// what makes online guessing hopeless, so the login needs no attempt counters or slow hashing.
import { webcrypto as crypto } from "node:crypto";
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
const pick = () => { const b = new Uint32Array(1); do crypto.getRandomValues(b); while (b[0] >= 4294967292); return alphabet[b[0] % 36]; };
const password = Array.from({ length: 4 }, () => Array.from({ length: 4 }, pick).join("")).join("-");
const salt = crypto.getRandomValues(new Uint8Array(16));
const digest = await crypto.subtle.digest("SHA-256", Buffer.concat([salt, Buffer.from(password)]));
const b64url = b => Buffer.from(b).toString("base64url");
process.stdout.write(`${password}\nsha256$${b64url(salt)}$${b64url(new Uint8Array(digest))}\n`);
