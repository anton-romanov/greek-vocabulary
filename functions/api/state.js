// Stores one learner's words and progress in Workers KV and merges what each device sends.
// functions/_middleware.js checks the login first and passes the signed-in user in data.user.

const MAX_BODY = 4 * 1024 * 1024;
const FUTURE_SLACK = 10 * 60 * 1000;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const isObject = v => v && typeof v === "object" && !Array.isArray(v);
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);
const text = v => (typeof v === "string" ? v : "");

function times(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, t]) => Number.isFinite(t) && t >= 0));
}
function cleanWord(w) {
  if (!isObject(w) || !text(w.greek).trim() || !text(w.russian).trim()) return null;
  const verbs = Array.isArray(w.verbs)
    ? w.verbs.filter(isObject).map(v => ({ lemma: text(v.lemma), aorist: text(v.aorist), imperfect: text(v.imperfect) }))
    : [];
  return { greek: w.greek, russian: w.russian, topic: text(w.topic) || "Разное", note: text(w.note), verbs };
}
function cleanEntry(e) {
  if (!isObject(e)) return null;
  const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return { correct: n(e.correct), wrong: n(e.wrong), streak: n(e.streak), last: n(e.last), fav: e.fav === true };
}
function cleanDoc(doc) {
  const vocab = Array.isArray(doc?.vocab) ? doc.vocab.map(cleanWord).filter(Boolean) : [];
  const progress = {};
  if (isObject(doc?.progress)) {
    for (const [key, entry] of Object.entries(doc.progress)) {
      const clean = cleanEntry(entry);
      if (clean && key.includes("|")) progress[key] = clean;
    }
  }
  return { vocab, vtime: times(doc?.vtime), progress, mtime: times(doc?.mtime) };
}

const wordId = w => (w.greek + "|" + w.russian).normalize("NFC");

// Newer change wins per word and per progress entry; on a tie the stored version stays.
// A recorded time without an item is a deletion.
export function mergeDocs(stored, incoming, now) {
  const limit = now + FUTURE_SLACK;
  const clamp = t => Math.min(t, limit);

  const progress = {}, mtime = {};
  const progressTime = (doc, key) => {
    const t = own(doc.mtime, key);
    return Number.isFinite(t) ? t : own(doc.progress, key)?.last || 0;
  };
  for (const key of new Set([...Object.keys(stored.progress), ...Object.keys(incoming.progress),
    ...Object.keys(stored.mtime), ...Object.keys(incoming.mtime)])) {
    const st = clamp(progressTime(stored, key)), it = clamp(progressTime(incoming, key));
    let entry;
    if (it > st) entry = own(incoming.progress, key);
    else if (st > it) entry = own(stored.progress, key);
    else entry = own(stored.progress, key) ?? (Object.hasOwn(stored.mtime, key) ? undefined : own(incoming.progress, key));
    if (entry) progress[key] = entry;
    const t = Math.max(st, it);
    if (t) mtime[key] = t;
  }

  const byId = list => {
    const map = new Map();
    for (const w of list) if (!map.has(wordId(w))) map.set(wordId(w), w);
    return map;
  };
  const sm = byId(stored.vocab), im = byId(incoming.vocab), chosen = new Map(), vtime = {};
  for (const id of new Set([...sm.keys(), ...im.keys(), ...Object.keys(stored.vtime), ...Object.keys(incoming.vtime)])) {
    const sw = sm.get(id), iw = im.get(id);
    const st = clamp(Number.isFinite(own(stored.vtime, id)) ? stored.vtime[id] : 0);
    const it = clamp(Number.isFinite(own(incoming.vtime, id)) ? incoming.vtime[id] : 0);
    let word;
    if (it > st) word = iw;
    else if (st > it) word = sw;
    else word = sw ?? (Object.hasOwn(stored.vtime, id) && st ? undefined : iw);
    if (word) chosen.set(id, word);
    const t = Math.max(st, it);
    if (t) vtime[id] = t;
  }
  const vocab = [];
  for (const list of [stored.vocab, incoming.vocab]) {
    for (const w of list) {
      const id = wordId(w);
      if (chosen.has(id)) { vocab.push(chosen.get(id)); chosen.delete(id); }
    }
  }
  return { vocab, vtime, progress, mtime };
}

export async function onRequest({ request, env, data }) {
  if (!data.user) return json({ error: "unauthorized" }, 401);
  const key = "state:" + data.user;
  const stored = cleanDoc((await env.STATE.get(key, "json")) || {});

  if (request.method === "GET") return json({ doc: stored, serverTime: Date.now() });
  if (request.method !== "POST") return json({ error: "method" }, 405);

  // Only the app itself may write: a JSON body (which a plain cross-site form cannot send)
  // from this same origin.
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json" || (origin && origin !== new URL(request.url).origin) ||
      (site && site !== "same-origin")) {
    return json({ error: "forbidden" }, 403);
  }

  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY) return json({ error: "too large" }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: "too large" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }

  const incoming = cleanDoc(body?.doc);
  let base = stored, merged;
  // KV has no compare-and-swap: after writing, read back and merge again if another device
  // wrote in between, so neither device's changes are dropped.
  for (let attempt = 0; attempt < 3; attempt++) {
    merged = mergeDocs(base, incoming, Date.now());
    if (JSON.stringify(merged) === JSON.stringify(base)) break;
    await env.STATE.put(key, JSON.stringify(merged));
    await new Promise(resolve => setTimeout(resolve, 150 + Math.random() * 250));
    const after = cleanDoc((await env.STATE.get(key, "json")) || {});
    if (JSON.stringify(after) === JSON.stringify(merged)) break;
    base = mergeDocs(after, merged, Date.now());
  }
  return json({ doc: merged, serverTime: Date.now() });
}
