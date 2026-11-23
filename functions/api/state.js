// Stores one learner's words and progress in Workers KV and merges what each device sends.
// functions/_middleware.js checks the login first and passes the signed-in user in data.user.

const MAX_BODY = 4 * 1024 * 1024;
const FUTURE_SLACK = 10 * 60 * 1000;
// Reads the body but stops as soon as it passes the limit (null), even without Content-Length.
export async function readLimited(request, limit) {
  if (Number(request.headers.get("Content-Length") || 0) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return new TextDecoder().decode(bytes);
}

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
// Optional fields: review schedule, daily tallies, settings and the learner's own hint.
// Keep in step with normalizeProgress in index.html.
const EXTRA_FIELDS = ["due", "ivl", "ease", "reps", "lapses", "seen", "reviews", "fresh", "newPerDay", "goal"];
function cleanEntry(e) {
  if (!isObject(e)) return null;
  const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const clean = { correct: n(e.correct), wrong: n(e.wrong), streak: n(e.streak), last: n(e.last), fav: e.fav === true };
  for (const field of EXTRA_FIELDS) if (Number.isSafeInteger(e[field]) && e[field] >= 0) clean[field] = e[field];
  if (typeof e.hint === "string" && e.hint.trim()) clean.hint = e.hint.trim().slice(0, 300);
  return clean;
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
const DAY_MS = 864e5;
// The same steps as nextSchedule in index.html, for answers sent by older app versions.
function legacySchedule(before, forgot, now) {
  const ivl0 = before.ivl || 0, ease0 = before.ease || 250, reps0 = before.reps || 0, lapses0 = before.lapses || 0;
  if (forgot) {
    return { due: now + 10 * 60e3, ivl: 0, ease: Math.max(130, ease0 - 20), reps: 0, lapses: lapses0 + (reps0 > 0 ? 1 : 0) };
  }
  const ivl = Math.min(365, reps0 === 0 ? (lapses0 ? 2 : 3) : reps0 === 1 ? Math.max(ivl0 + 1, 6) : Math.max(ivl0 + 1, Math.round(ivl0 * ease0 / 100)));
  return { due: now + ivl * DAY_MS, ivl, ease: Math.min(300, ease0 + 5), reps: reps0 + 1, lapses: lapses0 };
}
const SCHEDULE_FIELDS = ["due", "ivl", "ease", "reps", "lapses", "seen"];
// An entry from an older app version keeps the stored hint and schedule. If it records a newer
// answer (its "last" moved on), the schedule takes a step as the current app would: the old app
// resets the streak on "Не знаю" and raises it on "Знаю".
function adaptLegacy(entry, before, now) {
  if (!before) return entry;
  const next = { ...entry };
  if ("hint" in before) next.hint = before.hint;
  if (!("due" in before)) return next;
  for (const field of SCHEDULE_FIELDS) if (field in before) next[field] = before[field];
  if (entry.last > (before.last || 0)) Object.assign(next, legacySchedule(before, entry.streak === 0, now));
  return next;
}

// legacy: the incoming doc comes from an older app version (see adaptLegacy).
export function mergeDocs(stored, incoming, now, legacy = false) {
  const limit = now + FUTURE_SLACK;
  const clamp = t => Math.min(t, limit);

  const progress = {}, mtime = {};
  const progressTime = (doc, key) => {
    const t = own(doc.mtime, key);
    return Number.isFinite(t) ? t : own(doc.progress, key)?.last || 0;
  };
  for (const key of new Set([...Object.keys(stored.progress), ...Object.keys(incoming.progress),
    ...Object.keys(stored.mtime), ...Object.keys(incoming.mtime)])) {
    const rawIt = progressTime(incoming, key);
    const st = clamp(progressTime(stored, key)), it = clamp(rawIt);
    let entry;
    if (it > st) {
      entry = own(incoming.progress, key);
      if (entry && legacy) entry = adaptLegacy(entry, own(stored.progress, key), now);
      // A change stamped in the future came from a clock that runs ahead: move the review date it
      // set back by the same amount. (Older versions never set one; adaptLegacy uses server time.)
      const skew = rawIt - now;
      if (entry && !legacy && skew > FUTURE_SLACK && entry.due) entry = { ...entry, due: Math.max(0, entry.due - skew) };
    }
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

// Each device keeps its own record (state:<user>:<device>) and only ever writes that one, so two
// devices syncing at the same moment cannot overwrite each other. Every write stores the merge of
// all records the server saw plus the device's own changes, so a newer record already contains
// what older ones held. So each request reads a bounded number: the newest few, plus a few older
// ones folded in again as a safety net. Records are never deleted (one per browser; there are only ever a handful),
// so a write can never be lost to a cleanup racing with it.
const DEVICE = /^[a-z0-9]{16,40}$/;
const READ_NEWEST = 10;
const READ_OLDER = 3;

async function loadAll(env, user, device) {
  const prefix = `state:${user}:`;
  const records = [];
  let cursor;
  do {
    const page = await env.STATE.list({ prefix, cursor });
    for (const k of page.keys) records.push({ name: k.name, t: Number(k.metadata?.t) || 0 });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  records.sort((a, b) => b.t - a.t);
  const now = Date.now();
  const read = records.slice(0, READ_NEWEST).map(r => r.name);
  // A just-created record may not be listed yet; always include this device's own.
  if (device && !read.includes(prefix + device)) read.push(prefix + device);

  let all = cleanDoc({}), own = cleanDoc({});
  for (const key of read) {
    const doc = cleanDoc((await env.STATE.get(key, "json")) || {});
    if (key === prefix + device) own = doc;
    all = mergeDocs(all, doc, now);
  }
  for (const r of records.slice(READ_NEWEST, READ_NEWEST + READ_OLDER)) {
    if (r.name !== prefix + device) all = mergeDocs(all, cleanDoc((await env.STATE.get(r.name, "json")) || {}), now);
  }
  return { all, own };
}

export async function onRequest({ request, env, data }) {
  if (!data.user) return json({ error: "unauthorized" }, 401);

  if (request.method === "GET") {
    const { all } = await loadAll(env, data.user, null);
    return json({ doc: all, serverTime: Date.now() });
  }
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

  const raw = await readLimited(request, MAX_BODY);
  if (raw === null) return json({ error: "too large" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const device = body?.device;
  if (typeof device !== "string" || !DEVICE.test(device)) return json({ error: "bad device" }, 400);

  const { all, own } = await loadAll(env, data.user, device);
  // Older app versions (no format 3) do not know schedules and hints; mergeDocs adapts their entries.
  const merged = mergeDocs(all, cleanDoc(body?.doc), Date.now(), body?.format !== 3);
  if (JSON.stringify(merged) !== JSON.stringify(own)) {
    try {
      await env.STATE.put(`state:${data.user}:${device}`, JSON.stringify(merged), { metadata: { t: Date.now() } });
    } catch {
      return json({ error: "busy" }, 503);
    }
  }
  return json({ doc: merged, serverTime: Date.now() });
}
