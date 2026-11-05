"use strict";
/* J Finance: core.
   Helpers, encryption, on-device storage, GitHub sync and the ledger. No outside libraries.
   Nothing leaves this device unencrypted, except requests for public exchange rates. */

const CFG = window.JAYS_MONEY_CONFIG || {};
const API = new URL(CFG.apiBase || "https://api.github.com", location.href).href.replace(/\/$/, "");
const RATES_API = (CFG.ratesApi || "https://api.frankfurter.dev/v1").replace(/\/$/, "");
const CURRENCIES = ["GBP", "INR", "USD", "EUR"];
const LOCALE = { GBP: "en-GB", INR: "en-IN", USD: "en-US", EUR: "en-IE" };
const KDF_ITER = CFG.kdfIterations || 600000;
const RECOVERY_ITER = 100000;
const IDLE_LOCK_MS = 15 * 60 * 1000;
const AWAY_LOCK_MS = 5 * 60 * 1000;

// Categories the app relies on. They are created automatically and can be renamed, not deleted.
const CAT = { tds: "cat_tds", fx: "cat_fx", salaries: "cat_salaries", salaryIn: "cat_salary_in", dividendIn: "cat_dividend_in" };
const SYSTEM_ITEMS = [
  { id: "ent_personal", kind: "entity", name: "Personal", type: "personal", order: 1 },
  { id: CAT.salaryIn, kind: "category", name: "Salary received", group: "income", system: true, order: 80 },
  { id: CAT.dividendIn, kind: "category", name: "Dividends received", group: "income", system: true, order: 81 },
  { id: CAT.salaries, kind: "category", name: "Salaries paid", group: "expense", system: true, order: 80 },
  { id: CAT.tds, kind: "category", name: "TDS deducted (India)", group: "expense", system: true, order: 90 },
  { id: CAT.fx, kind: "category", name: "Transfer fees & exchange differences", group: "expense", system: true, order: 91 },
];
const TYPE_LABEL = { in: "Money in", out: "Money out", transfer: "Transfer", behalf: "Paid on my behalf", iou: "Owed", opening: "Opening balance" };

/* ================= Small helpers ================= */
const store = {
  get(k, d) { try { const v = localStorage.getItem("jm." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("jm." + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("jm." + k); } catch {} },
};
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoOf(new Date());
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const symRound = (x) => Math.sign(x) * Math.round(Math.abs(x));
/** UK tax year that a date falls in, by its starting year: 6 April 2026 to 5 April 2027 is 2026. */
function taxYearStart(iso) { const [y, m, d] = iso.split("-").map(Number); return m > 4 || (m === 4 && d >= 6) ? y : y - 1; }
const tyLabel = (y) => `${y}-${pad((y + 1) % 100)}`;
const DATE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const MONTH_FMT = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const fmtDate = (iso) => (iso ? DATE_FMT.format(new Date(iso + "T00:00:00Z")) : "");
const fmtMonth = (iso) => MONTH_FMT.format(new Date(iso.slice(0, 7) + "-01T00:00:00Z"));

/** "1,234.5" -> 123450 (whole pence/paise/cents). NaN when it isn't a money amount. */
function parseMoney(s) {
  const t = String(s ?? "").replace(/[,\s£₹$€]/g, "");
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(t);
  if (!m || (m[2] === "" && !m[3])) return NaN;
  const v = Number(m[2] || 0) * 100 + Number((m[3] || "").padEnd(2, "0"));
  return m[1] ? -v : v;
}
const minorToInput = (n) => (n == null || !Number.isFinite(n) ? "" : (n / 100).toFixed(2));
const moneyFmt = {};
function money(minor, cur = "GBP", whole = false) {
  const k = cur + (whole ? "w" : "");
  const f = moneyFmt[k] || (moneyFmt[k] = new Intl.NumberFormat(LOCALE[cur] || "en-GB", {
    style: "currency", currency: cur, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }));
  return f.format((minor || 0) / 100);
}
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Macintosh/.test(ua)) return "Mac";
  return "browser";
}

/* ================= Encryption =================
   A random data key encrypts everything. That key is stored in keyring.json twice, each copy locked:
   once with your passphrase and once with your recovery key. Changing the passphrase only re-locks the key. */
const enc = new TextEncoder(), dec = new TextDecoder();
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64ToBytes = (b) => Uint8Array.from(atob(String(b).replace(/\s/g, "")), (c) => c.charCodeAt(0));
const textToB64 = (s) => bytesToB64(enc.encode(s));
const b64ToText = (b) => dec.decode(b64ToBytes(b));

async function lockKeyFrom(secret, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base,
    { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}
async function wrapDataKey(dataKey, secret, iterations) {
  const salt = rand(16), iv = rand(12);
  const lock = await lockKeyFrom(secret, salt, iterations);
  const wrapped = await crypto.subtle.wrapKey("raw", dataKey, lock, { name: "AES-GCM", iv });
  return { kdf: "PBKDF2-SHA256", iterations, salt: bytesToB64(salt), iv: bytesToB64(iv), key: bytesToB64(new Uint8Array(wrapped)) };
}
async function unwrapDataKey(slot, secret) {
  const lock = await lockKeyFrom(secret, b64ToBytes(slot.salt), slot.iterations);
  return crypto.subtle.unwrapKey("raw", b64ToBytes(slot.key), lock, { name: "AES-GCM", iv: b64ToBytes(slot.iv) },
    { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}
async function seal(obj, key) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { app: "jays-money", sealed: 1, iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ct)) };
}
async function unseal(env, key) {
  if (!env || env.sealed !== 1) throw new Error("This file isn't a J Finance encrypted file.");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.data));
  return JSON.parse(dec.decode(pt));
}
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 32 characters (160 random bits), shown in groups of four. */
function newRecoveryKey() {
  let bits = 0, val = 0, out = "";
  for (const x of rand(20)) {
    val = ((val << 8) | x) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{4}/g).join("-");
}
const normRecovery = (s) => String(s || "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1").replace(/[^0-9A-Z]/g, "");

/* ================= On-device storage =================
   The working copy lives in IndexedDB, encrypted with the same data key. */
let dbP = null;
function idb() {
  return dbP || (dbP = new Promise((res, rej) => {
    const r = indexedDB.open("jays-money", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", mode), q = fn(tx.objectStore("kv"));
    tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error);
  });
}
const idbGet = (k) => idbDo("readonly", (s) => s.get(k));
const idbSet = (k, v) => idbDo("readwrite", (s) => s.put(v, k));
const idbDel = (k) => idbDo("readwrite", (s) => s.delete(k));

/* ================= State ================= */
const S = {
  phase: "start",            // start | connect | create | recovery | unlock | app
  gh: store.get("gh", null), // { owner, repo }
  keyring: null,
  dek: null,                 // the data key, only in memory while unlocked
  items: new Map(),          // every record, by id
  tomb: {},                  // id -> when it was deleted
  dirty: new Map(),          // data file -> change counter, for files GitHub doesn't have yet
  meta: { files: {} },       // data file -> { sha } last seen on GitHub
  syncing: false, syncError: null, keyBad: false, lastSyncAt: null, online: navigator.onLine,
  rates: store.get("ratesLatest", null),
  msg: null, newRecovery: null,
};
let ver = 0;
const acct = () => (S.gh ? `${S.gh.owner}/${S.gh.repo}`.toLowerCase() : "none");
const token = () => store.get("ghToken", "");
/** Transactions and statement lines go in one file per UK tax year; everything else in core. */
const fileOf = (r) => (r.kind === "txn" || r.kind === "stmt" ? "ledger-" + tyLabel(taxYearStart(r.date)) : "core");
async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const markDirty = (key) => S.dirty.set(key, (S.dirty.get(key) || 0) + 1);

let saveT = 0;
function saveLocal() { clearTimeout(saveT); saveT = setTimeout(saveLocalNow, 300); }
async function saveLocalNow() {
  clearTimeout(saveT);
  if (!S.dek) return;
  const snap = {
    items: Object.fromEntries(S.items), tomb: S.tomb, dirty: Object.fromEntries(S.dirty),
    meta: S.meta, lastSyncAt: S.lastSyncAt,
  };
  try { await idbSet("state:" + acct(), await seal(snap, S.dek)); } catch (e) { console.warn("Couldn't save on this device", e); }
}
async function loadLocal() {
  let env = null;
  try { env = await idbGet("state:" + acct()); } catch {}
  const s = env ? await unseal(env, S.dek) : {};
  S.items = new Map(Object.entries(s.items || {}));
  S.tomb = s.tomb || {};
  S.dirty = new Map(Object.entries(s.dirty || {}));
  S.meta = s.meta || { files: {} };
  S.lastSyncAt = s.lastSyncAt || null;
  ver++;
}
function wipeMemory() {
  S.dek = null; S.items = new Map(); S.tomb = {}; S.dirty = new Map(); S.meta = { files: {} };
  memo = null; ver++;
}

/* ================= Changing records ================= */
let onChange = () => {};
function stamp(rec, now) {
  const old = S.items.get(rec.id);
  if (old) markDirty(fileOf(old));
  const r = { ...rec, createdAt: rec.createdAt || (old && old.createdAt) || now, updatedAt: now, by: deviceName() };
  S.items.set(r.id, r); delete S.tomb[r.id]; markDirty(fileOf(r));
  return r;
}
function put(rec) { const r = stamp(rec, Date.now()); ver++; onChange(); return r; }
function putMany(recs) { let now = Date.now(); for (const r of recs) stamp(r, now++); ver++; onChange(); }
function remove(id) {
  const old = S.items.get(id);
  if (!old) return;
  S.items.delete(id); S.tomb[id] = Date.now();
  markDirty(fileOf(old)); markDirty("core");
  ver++; onChange();
}
function ensureSystem() {
  const missing = SYSTEM_ITEMS.filter((x) => !S.items.has(x.id) && !S.tomb[x.id]);
  if (missing.length) putMany(missing);
}

/* ================= GitHub ================= */
class GhError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const repoPath = (g = S.gh) => `/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}`;
const contentsPath = (p) => repoPath() + "/contents/" + p.split("/").map(encodeURIComponent).join("/");
function gh(path, opts = {}, tok = token()) {
  return fetch(API + path, {
    ...opts, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
    headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + tok, ...(opts.headers || {}) },
  });
}
async function ghErr(r) {
  let m = ""; try { m = (await r.json()).message || ""; } catch {}
  return new GhError(r.status, m || "GitHub replied " + r.status);
}
function friendlyGh(e) {
  const m = String((e && e.message) || "");
  if (e && e.status === 401) return "GitHub didn't accept this device's access key. It may have expired.";
  if (e && e.status === 403 && /rate limit/i.test(m)) return "GitHub is limiting requests. It will try again shortly.";
  if (e && e.status === 403) return "The access key can't save changes. It needs Contents: Read and write.";
  if (e && e.status === 404) return "Can't find the data repository. Check the key still has access to it.";
  if (e instanceof TypeError || /fetch|network/i.test(m)) return "Can't reach GitHub right now.";
  return m || "Sync failed.";
}
async function readFile(path) {
  const r = await gh(contentsPath(path));
  if (r.status === 404) return null;
  if (!r.ok) throw await ghErr(r);
  const j = await r.json();
  if (j.encoding === "base64" && j.content) return { text: b64ToText(j.content), sha: j.sha };
  const r2 = await gh(repoPath() + "/git/blobs/" + j.sha, { headers: { Accept: "application/vnd.github.raw+json" } });  // files over 1 MB
  if (!r2.ok) throw await ghErr(r2);
  return { text: await r2.text(), sha: j.sha };
}
async function writeFile(path, text, message, sha) {
  const r = await gh(contentsPath(path), {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: textToB64(text), ...(sha ? { sha } : {}) }),
  });
  return r;
}
async function writePlain(path, text, message) {
  const cur = await readFile(path);
  const r = await writeFile(path, text, message, cur && cur.sha);
  if (!r.ok) throw await ghErr(r);
}
async function listData() {
  const r = await gh(contentsPath("data"));
  if (r.status === 404) return new Map();
  if (!r.ok) throw await ghErr(r);
  const arr = await r.json();
  return new Map((Array.isArray(arr) ? arr : []).filter((f) => f.type === "file" && /\.json$/.test(f.name)).map((f) => [f.name.replace(/\.json$/, ""), f.sha]));
}

/* ================= Sync =================
   Each data file is read, merged record by record (the newest change wins; deletions are kept as markers),
   and written back if this device changed anything in it. Every write is a commit, so GitHub keeps history. */
function applyFile(data) {
  let n = 0;
  for (const [id, ts] of Object.entries(data.deleted || {})) {
    if ((S.tomb[id] || 0) >= ts) continue;
    S.tomb[id] = ts;
    const loc = S.items.get(id);
    if (loc && (loc.updatedAt || 0) <= ts) { S.items.delete(id); n++; }
  }
  for (const [id, r] of Object.entries(data.items || {})) {
    if ((S.tomb[id] || 0) >= (r.updatedAt || 0)) continue;
    const loc = S.items.get(id);
    if (loc && (loc.updatedAt || 0) >= (r.updatedAt || 0)) continue;
    S.items.set(id, { ...r, id }); n++;
  }
  if (n) ver++;
  return n;
}
function buildFile(key) {
  const items = {};
  for (const [id, r] of S.items) if (fileOf(r) === key) items[id] = r;
  const out = { app: "jays-money", format: 1, file: key, savedAt: new Date().toISOString(), items };
  if (key === "core") {
    const cutoff = Date.now() - 400 * 864e5; out.deleted = {};
    for (const [id, ts] of Object.entries(S.tomb)) if (ts > cutoff && !S.items.has(id)) out.deleted[id] = ts;
  }
  return out;
}
async function pullFile(key) {
  const f = await readFile(`data/${key}.json`);
  if (!f) { delete S.meta.files[key]; return 0; }
  let data;
  try { data = await unseal(JSON.parse(f.text), S.dek); }
  catch { throw new GhError(0, `data/${key}.json on GitHub can't be opened, so sync is paused. If it was edited by hand, undo that change on GitHub.`); }
  S.meta.files[key] = { sha: f.sha };
  return applyFile(data);
}
async function pushFile(key, gen) {
  const path = `data/${key}.json`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const sha = S.meta.files[key] && S.meta.files[key].sha;
    const text = JSON.stringify(await seal(buildFile(key), S.dek)) + "\n";
    const r = await writeFile(path, text, `${key}: changes from ${deviceName()}`, sha);
    if (r.status === 409 || r.status === 422) { await pullFile(key); continue; }   // changed elsewhere: merge and try again
    if (!r.ok) throw await ghErr(r);
    const j = await r.json();
    S.meta.files[key] = { sha: j.content && j.content.sha };
    if (S.dirty.get(key) === gen) S.dirty.delete(key);
    return;
  }
  throw new GhError(0, "Another device kept changing the same data. Tap Retry.");
}
let syncTimer = 0, syncP = null, onSync = () => {};
function scheduleSync(ms = 1500) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
function sync() { if (syncP) return syncP; syncP = doSync().finally(() => { syncP = null; }); return syncP; }
async function doSync() {
  if (S.phase !== "app" || !S.dek || !S.gh) return;
  if (!navigator.onLine) { S.online = false; onSync(false); return; }
  S.online = true; S.syncing = true; S.syncError = null; onSync(false);
  let changed = 0;
  try {
    const remote = await listData();
    const keys = [...remote.keys()].sort((a, b) => (a === "core" ? -1 : b === "core" ? 1 : a.localeCompare(b)));
    for (const key of keys) {
      if (S.meta.files[key] && S.meta.files[key].sha === remote.get(key)) continue;
      changed += await pullFile(key);
    }
    for (const key of Object.keys(S.meta.files)) {
      if (remote.has(key)) continue;
      delete S.meta.files[key];
      if ([...S.items.values()].some((r) => fileOf(r) === key)) markDirty(key);   // removed on GitHub: put it back
    }
    for (const [key, gen] of [...S.dirty]) await pushFile(key, gen);
    S.lastSyncAt = Date.now(); S.keyBad = false;
  } catch (e) {
    S.syncError = friendlyGh(e); S.keyBad = !!(e && e.status === 401);
  }
  S.syncing = false;
  await saveLocalNow();
  onSync(changed > 0);
  if (S.dirty.size && navigator.onLine && !S.syncError) scheduleSync(1500);
}

/* ================= Connecting, creating and unlocking ================= */
const README_TEXT = `# J Finance data

This private repository holds the data for J Finance.

- \`keyring.json\` holds the data key, locked with the passphrase and, separately, with the recovery key.
- \`data/\` holds the records, **encrypted** (AES-256-GCM). They can only be opened in the app.

Do not edit these files by hand, and never make this repository public.
`;
async function connectGitHub(owner, repo, tok) {
  if (!owner || !repo || !tok) return { msg: "Fill in all three boxes.", err: true };
  if (!navigator.onLine) return { msg: "You're offline. Connect to the internet once to set this up.", err: true };
  let r;
  try { r = await gh(repoPath({ owner, repo }), {}, tok); }
  catch { return { msg: "Can't reach GitHub. Check your connection and try again.", err: true }; }
  if (r.status === 401) return { msg: "GitHub didn't accept that access key. Check you copied all of it.", err: true };
  if (r.status === 404 || r.status === 403) return { msg: `Can't find ${owner}/${repo}, or the key doesn't have access to it.`, err: true };
  if (!r.ok) return { msg: "GitHub replied " + r.status + ". Try again in a moment.", err: true };
  const j = await r.json();
  if (!j.private) return { msg: `${owner}/${repo} is public. Make it private on GitHub (Settings › General › Change visibility), then connect again.`, err: true };
  store.set("ghToken", tok);
  S.gh = { owner: (j.owner && j.owner.login) || owner, repo: j.name || repo };
  store.set("gh", S.gh);
  return { ok: true };
}
async function fetchKeyring() {
  const f = await readFile("keyring.json");
  if (!f) return null;
  const kr = JSON.parse(f.text);
  if (kr.app !== "jays-money" || !kr.pass || !kr.recovery) throw new GhError(0, "keyring.json in the repository isn't a J Finance key file.");
  store.set("keyring." + acct(), kr);
  return kr;
}
/** Decide which screen to show when the app opens. */
async function boot() {
  if (!S.gh || !token()) { S.phase = "connect"; return; }
  S.keyring = store.get("keyring." + acct(), null);
  if (navigator.onLine) {
    try {
      const kr = await fetchKeyring();
      if (kr) S.keyring = kr;
      else if (!S.keyring) {
        const data = await listData();
        if (data.size) { S.phase = "connect"; S.msg = { err: true, text: "The repository has data but no keyring.json, so it can't be opened. Restore keyring.json from GitHub's history." }; return; }
        S.phase = "create"; return;
      }
    } catch (e) {
      if (!S.keyring) { S.phase = "connect"; S.msg = { err: true, text: friendlyGh(e) }; return; }
    }
  }
  S.phase = S.keyring ? "unlock" : "connect";
}
async function createVault(pass) {
  const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const recovery = newRecoveryKey();
  const kr = {
    app: "jays-money", format: 1, created: new Date().toISOString(),
    about: "The data key, locked twice: with the passphrase and with the recovery key. Without one of them the data can't be opened.",
    pass: await wrapDataKey(dek, pass, KDF_ITER),
    recovery: await wrapDataKey(dek, normRecovery(recovery), RECOVERY_ITER),
  };
  await writePlain("keyring.json", JSON.stringify(kr, null, 2) + "\n", "Set up J Finance encryption");
  try { await writePlain("README.md", README_TEXT, "Explain this repository"); } catch {}
  store.set("keyring." + acct(), kr);
  S.keyring = kr; S.dek = dek;
  S.items = new Map(); S.tomb = {}; S.dirty = new Map(); S.meta = { files: {} };
  ensureSystem();
  return recovery;
}
async function unlock(secret, useRecovery) {
  const slot = useRecovery ? S.keyring.recovery : S.keyring.pass;
  try { S.dek = await unwrapDataKey(slot, useRecovery ? normRecovery(secret) : secret); }
  catch { return false; }
  await loadLocal();
  ensureSystem();
  return true;
}
async function saveKeyring(kr) {
  await writePlain("keyring.json", JSON.stringify(kr, null, 2) + "\n", "Update J Finance keyring");
  S.keyring = kr; store.set("keyring." + acct(), kr);
}
async function changePassphrase(pass) {
  await saveKeyring({ ...S.keyring, pass: await wrapDataKey(S.dek, pass, KDF_ITER), changed: new Date().toISOString() });
}
async function replaceRecoveryKey() {
  const recovery = newRecoveryKey();
  await saveKeyring({ ...S.keyring, recovery: await wrapDataKey(S.dek, normRecovery(recovery), RECOVERY_ITER), changed: new Date().toISOString() });
  return recovery;
}
async function forgetDevice() {
  try { await idbDel("state:" + acct()); } catch {}
  store.del("keyring." + acct()); store.del("ghToken");
  wipeMemory(); S.keyring = null; S.phase = "connect";
}

/* ================= Exchange rates =================
   Daily mid-market reference rates (ECB, via Frankfurter): 1 GBP = x INR / USD / EUR.
   Only the date and currency codes are sent. */
async function fetchRates(iso) {
  const key = !iso || iso >= todayISO() ? "latest" : iso;
  const cache = store.get("rates", {});
  if (key !== "latest" && cache[key]) return cache[key];
  if (key === "latest" && S.rates && S.rates.fetched > Date.now() - 6 * 3600e3) return S.rates;
  try {
    const r = await fetch(`${RATES_API}/${key}?from=GBP&to=INR,USD,EUR`, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!r.ok) throw new Error();
    const j = await r.json();
    const out = { date: j.date, ...j.rates, fetched: Date.now() };
    if (key === "latest") { S.rates = out; store.set("ratesLatest", out); }
    else {
      cache[key] = out;
      const ks = Object.keys(cache).sort(); while (ks.length > 500) delete cache[ks.shift()];
      store.set("rates", cache);
    }
    return out;
  } catch { return key === "latest" ? S.rates : cache[key] || S.rates; }
}
async function rateFor(cur, iso) { if (cur === "GBP") return 1; const r = await fetchRates(iso); return (r && r[cur]) || null; }
/** Today's GBP value of an amount, or null if there's no rate yet. */
function toGBP(minor, cur) { if (cur === "GBP") return minor; const r = S.rates && S.rates[cur]; return r ? symRound(minor / r) : null; }

/* ================= The ledger =================
   Every transaction has lines that balance: positive lines are debits (money in an account, spending, money owed to you),
   negative lines are credits (income, money you owe, money leaving an account).
   Line kinds: a = account, c = category, p = person, q = equity (opening balances, dividends, money between your entities).
   Each line belongs to an entity, and each entity's lines balance on their own. */
function ln(t, ref, cur, amt, rate, ent) {
  return { t, ref, cur, amt, rate, gbp: cur === "GBP" ? amt : symRound(amt / rate), ent };
}
function fixRounding(lines) {
  const residual = lines.reduce((s, l) => s + l.gbp, 0);
  if (!residual) return;
  if (Math.abs(residual) > lines.length) throw new Error("This entry doesn't balance. Check the amounts.");
  const big = lines.reduce((m, l) => (Math.abs(l.gbp) > Math.abs(m.gbp) ? l : m), lines[0]);
  big.gbp -= residual;
}
/** When money crosses between two of your entities (say the company pays a personal bill), record who now owes whom. */
function addInterEntity(lines) {
  const sums = new Map();
  for (const l of lines) sums.set(l.ent, (sums.get(l.ent) || 0) + l.gbp);
  const off = [...sums].filter(([, v]) => v !== 0);
  if (!off.length) return lines;
  if (off.length !== 2) throw new Error("This entry involves more than two entities. Split it into two entries.");
  const [[e1, v1], [e2, v2]] = off;
  return [...lines, ln("q", "ic:" + e2, "GBP", -v1, 1, e1), ln("q", "ic:" + e1, "GBP", -v2, 1, e2)];
}

async function buildTxn(type, f) {
  const b = book();
  const need = (ok, msg) => { if (!ok) throw new Error(msg); };
  const date = f.date || todayISO();
  need(/^\d{4}-\d{2}-\d{2}$/.test(date), "Pick a date.");
  const get = (id, kind) => { const x = id && b.byId.get(id); return x && x.kind === kind ? x : null; };
  const amount = (name, label, allowNeg) => {
    const v = parseMoney(f[name]);
    need(Number.isFinite(v) && v !== 0, `Enter the ${label}.`);
    need(allowNeg || v > 0, `The ${label} should be more than zero.`);
    return v;
  };
  const optional = (name, label) => {
    if (!String(f[name] || "").trim()) return 0;
    const v = parseMoney(f[name]); need(Number.isFinite(v) && v >= 0, `Check the ${label}.`); return v;
  };
  const rateOf = async (cur, manual) => {
    if (cur === "GBP") return 1;
    const m = parseFloat(String(manual || "").replace(/,/g, ""));
    if (m > 0) return m;
    const r = await rateFor(cur, date);
    need(r, `There's no exchange rate for ${cur} yet. Enter one in the Rate box.`);
    return r;
  };
  const curFor = (acc, cur) => { const c = cur || acc.currencies[0]; need(acc.currencies.includes(c), `${acc.name} doesn't hold ${c}.`); return c; };
  const anyCur = (cur) => { need(CURRENCIES.includes(cur), "Choose a currency."); return cur; };

  let ent = get(f.entityId, "entity") ? f.entityId : "ent_personal";
  let personId = get(f.person, "person") ? f.person : null;
  const lines = [];
  let headline = null, names = [];

  switch (type) {
    case "in": {
      const a = get(f.account, "account"); need(a, "Choose the account the money went into.");
      const cur = curFor(a, f.cur), amt = amount("amount", "amount"), tds = optional("tds", "TDS amount"), rate = await rateOf(cur, f.rate);
      lines.push(ln("a", a.id, cur, amt, rate, a.entityId));
      if (tds) lines.push(ln("c", CAT.tds, cur, tds, rate, ent));
      if (f.source === "person") { need(personId, "Choose who paid you."); lines.push(ln("p", personId, cur, -(amt + tds), rate, ent)); }
      else { need(get(f.category, "category"), "Choose what kind of income this is."); lines.push(ln("c", f.category, cur, -(amt + tds), rate, ent)); }
      headline = { amt, cur }; names = [personId && b.byId.get(personId).name, a.name];
      break;
    }
    case "out": {
      const a = get(f.account, "account"); need(a, "Choose the account the money left.");
      const cur = curFor(a, f.cur), amt = amount("amount", "amount"), rate = await rateOf(cur, f.rate);
      lines.push(ln("a", a.id, cur, -amt, rate, a.entityId));
      if (f.dest === "person") { need(personId, "Choose who you paid."); lines.push(ln("p", personId, cur, amt, rate, ent)); }
      else { need(get(f.category, "category"), "Choose what it was for."); lines.push(ln("c", f.category, cur, amt, rate, ent)); }
      headline = { amt: -amt, cur }; names = [personId ? b.byId.get(personId).name : b.byId.get(f.category).name];
      break;
    }
    case "transfer": {
      const A = get(f.from, "account"), B = get(f.to, "account");
      need(A, "Choose the account the money came from."); need(B, "Choose the account it went to."); need(A.id !== B.id, "Pick two different accounts.");
      const fc = curFor(A, f.fromCur), tc = curFor(B, f.toCur), fa = amount("fromAmt", "amount sent");
      const ta = String(f.toAmt || "").trim() ? amount("toAmt", "amount received") : fc === tc ? fa : need(false, "Enter the amount received.");
      const lf = ln("a", A.id, fc, -fa, await rateOf(fc, f.fromRate), A.entityId);
      const lt = ln("a", B.id, tc, ta, await rateOf(tc, f.toRate), B.entityId);
      lines.push(lt, lf);
      const gFrom = -lf.gbp, gTo = lt.gbp;
      ent = A.entityId;
      const cross = A.entityId !== B.entityId;
      if (cross && f.nature === "salary") lines.push(ln("c", CAT.salaries, "GBP", gFrom, 1, A.entityId), ln("c", CAT.salaryIn, "GBP", -gTo, 1, B.entityId));
      else if (cross && f.nature === "dividend") lines.push(ln("q", "dividends", "GBP", gFrom, 1, A.entityId), ln("c", CAT.dividendIn, "GBP", -gTo, 1, B.entityId));
      else if (gFrom !== gTo) lines.push(ln("c", CAT.fx, "GBP", gFrom - gTo, 1, A.entityId));
      headline = { amt: fa, cur: fc }; names = [A.name + " → " + B.name];
      break;
    }
    case "behalf": {
      const payer = get(f.payer, "person"); need(payer, "Choose who paid.");
      const cur = anyCur(f.cur), amt = amount("amount", "amount"), tds = optional("tds", "TDS amount"), rate = await rateOf(cur, f.rate);
      if (f.basis === "income") { need(get(f.incomeCategory, "category"), "Choose what kind of income this counts as."); lines.push(ln("c", f.incomeCategory, cur, -(amt + tds), rate, ent)); }
      else lines.push(ln("p", payer.id, cur, -(amt + tds), rate, ent));
      if (tds) lines.push(ln("c", CAT.tds, cur, tds, rate, ent));
      const rec = get(f.recipient, "person");
      if (f.recipientMode === "settle") { need(rec, "Choose who received the money."); need(rec.id !== payer.id, "The payer and the person paid can't be the same."); lines.push(ln("p", rec.id, cur, amt, rate, ent)); }
      else { need(get(f.category, "category"), "Choose what the payment was for."); lines.push(ln("c", f.category, cur, amt, rate, ent)); }
      personId = payer.id;
      headline = { amt, cur }; names = [payer.name + " paid " + (rec ? rec.name : b.byId.get(f.category).name)];
      break;
    }
    case "iou": {
      need(personId, "Choose the person.");
      const cur = anyCur(f.cur), amt = amount("amount", "amount"), rate = await rateOf(cur, f.rate);
      need(get(f.category, "category"), "Choose what it's for.");
      if (f.direction === "iOwe") lines.push(ln("c", f.category, cur, amt, rate, ent), ln("p", personId, cur, -amt, rate, ent));
      else lines.push(ln("p", personId, cur, amt, rate, ent), ln("c", f.category, cur, -amt, rate, ent));
      headline = { amt: f.direction === "iOwe" ? -amt : amt, cur };
      names = [f.direction === "iOwe" ? "I owe " + b.byId.get(personId).name : b.byId.get(personId).name + " owes me"];
      break;
    }
    case "opening": {
      const amt = amount("amount", "balance", true);
      if (f.target === "person") {
        need(personId, "Choose the person."); const cur = anyCur(f.cur), rate = await rateOf(cur, f.rate);
        lines.push(ln("p", personId, cur, amt, rate, ent), ln("q", "opening", cur, -amt, rate, ent));
        headline = { amt, cur }; names = [b.byId.get(personId).name];
      } else {
        const a = get(f.account, "account"); need(a, "Choose the account.");
        const cur = curFor(a, f.cur), rate = await rateOf(cur, f.rate);
        ent = a.entityId; personId = null;
        lines.push(ln("a", a.id, cur, amt, rate, ent), ln("q", "opening", cur, -amt, rate, ent));
        headline = { amt, cur }; names = [a.name];
      }
      break;
    }
    default: throw new Error("Unknown entry type.");
  }
  fixRounding(lines);
  const div = get(f.divisionId, "division");
  const form = {};
  for (const [k, v] of Object.entries(f)) if (!["id", "type"].includes(k)) form[k] = v;
  const desc = String(f.desc || "").trim() || [TYPE_LABEL[type], ...names.filter(Boolean)].join(" · ");
  return {
    kind: "txn", type, date, desc, entityId: ent, divisionId: div && div.entityId === ent ? div.id : null,
    personId, tags: f.tags || [], note: String(f.note || "").trim(), headline, form, lines: addInterEntity(lines),
  };
}

let memoVer = -1, memo = null;
function book() {
  if (memoVer === ver && memo) return memo;
  const all = [...S.items.values()];
  const kind = (k) => all.filter((x) => x.kind === k);
  const byOrder = (a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.name).localeCompare(String(b.name));
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const txns = kind("txn").sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  const acctBal = new Map(), personBal = new Map(), ic = new Map(), acctTx = new Map(), personTx = new Map();
  const add = (map, id, cur, amt) => { const m = map.get(id) || {}; m[cur] = (m[cur] || 0) + amt; map.set(id, m); };
  const link = (map, id, t) => { const arr = map.get(id) || []; if (arr[arr.length - 1] !== t) arr.push(t); map.set(id, arr); };
  for (const t of txns) for (const l of t.lines || []) {
    if (l.t === "a") { add(acctBal, l.ref, l.cur, l.amt); link(acctTx, l.ref, t); }
    else if (l.t === "p") { add(personBal, l.ref, l.cur, l.amt); link(personTx, l.ref, t); }
    else if (l.t === "q" && l.ref.startsWith("ic:")) { const k = l.ent + "|" + l.ref.slice(3); ic.set(k, (ic.get(k) || 0) + l.gbp); }
  }
  // Statement lines, oldest first, in the order the bank listed them.
  const stmts = kind("stmt").sort((a, b) => a.date.localeCompare(b.date) || (a.seq || 0) - (b.seq || 0));
  const stmtByAcct = new Map();
  for (const s of stmts) { const arr = stmtByAcct.get(s.accountId) || []; arr.push(s); stmtByAcct.set(s.accountId, arr); }
  memo = {
    byId: S.items, txns, acctBal, personBal, ic, acctTx, personTx, stmts, stmtByAcct,
    inbox: stmts.filter((s) => s.status === "new"),
    rules: kind("rule").sort((a, b) => (b.match || "").length - (a.match || "").length),
    scheds: kind("sched").sort(byName), budgets: kind("budget"), receipts: kind("receipt"), invoices: kind("invoice").sort((a, b) => String(b.date).localeCompare(String(a.date))),
    entities: kind("entity").sort(byOrder), divisions: kind("division").sort(byOrder),
    accounts: kind("account").sort(byOrder), people: kind("person").sort(byName),
    categories: kind("category").sort(byOrder), todos: kind("todo").sort(byOrder),
  };
  memoVer = ver;
  return memo;
}
