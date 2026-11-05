"use strict";
/* J Finance: statement import, the Inbox, and checks against statement balances.
   Imported lines land in the Inbox. Each one is confirmed (which creates an entry), matched to an
   entry you already made, paired with the other side of a transfer, or ignored. Rules learnt from
   your choices suggest what to do with similar lines next time. */

/* ================= Reading files ================= */
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const sample = text.split(/\r?\n/).slice(0, 20).join("\n");
  const count = (d) => sample.split(d).length - 1;
  const delim = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') { q = true; continue; }
    if (c === delim) { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ""));
}
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const r = rows[i].map((x) => x.toLowerCase());
    if (r.some((x) => /date/.test(x)) && r.some((x) => /amount|debit|credit|withdrawal|deposit|paid|money/.test(x))) return i;
  }
  return 0;
}
function guessMap(h, acc) {
  const find = (re, not) => h.findIndex((x) => re.test(x) && !(not && not.test(x)));
  const m = {};
  m.date = find(/^(transaction |txn |tran |posting |booking )?date$/i);
  if (m.date < 0) m.date = find(/date/i, /value/i);
  if (m.date < 0) m.date = find(/date/i);
  m.desc = find(/description|narration|particulars|details|merchant|payee name|memo|remarks/i);
  m.desc2 = find(/payment reference|^reference$|^ref/i);
  if (m.desc2 === m.desc) m.desc2 = -1;
  m.amount = find(/^amount$|^amount\s*\(|^amount\s*[a-z]{3}$|^value$|transaction amount/i);
  m.debit = find(/debit|withdrawal|money out|paid out|^dr$/i, /credit card|dr\s*\/\s*cr/i);
  m.credit = find(/credit|deposit|money in|paid in|^cr$/i, /credit card|dr\s*\/\s*cr/i);
  m.drcr = find(/^(dr\s*\/\s*cr|cr\s*\/\s*dr|debit\s*\/\s*credit|type)$/i);
  m.cur = find(/currency/i);
  m.balance = find(/balance/i);
  if (m.amount >= 0) { m.debit = -1; m.credit = -1; }
  m.order = "dmy";
  m.flip = acc && acc.type === "card";
  m.fixedCur = acc ? acc.currencies[0] : "GBP";
  return m;
}
const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoParts(y, m, d) {
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}
function parseDate(s, order) {
  s = String(s || "").trim();
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return isoParts(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]+(\d{2,4})/.exec(s))) { const mo = MON3[m[2].slice(0, 3).toLowerCase()]; return mo ? isoParts(+m[3], mo, +m[1]) : null; }
  if ((m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(s))) { const mo = MON3[m[1].slice(0, 3).toLowerCase()]; return mo ? isoParts(+m[3], mo, +m[2]) : null; }
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) {
    const a = +m[1], b = +m[2];
    return order === "mdy" ? isoParts(+m[3], a, b) : isoParts(+m[3], b, a);
  }
  return null;
}
function detectOrder(values) {
  let dmy = false, mdy = false;
  for (const v of values) { const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(String(v).trim()); if (!m) continue; if (+m[1] > 12) dmy = true; if (+m[2] > 12) mdy = true; }
  return mdy && !dmy ? "mdy" : "dmy";
}
/** "£1,234.56", "(12.00)", "12.00 DR", "-5" -> whole pence/paise; NaN if it isn't an amount; 0 when empty. */
function looseAmount(s) {
  let t = String(s ?? "").trim();
  if (!t) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\bDR\.?$/i.test(t)) { neg = true; t = t.replace(/\bDR\.?$/i, ""); }
  t = t.replace(/\bCR\.?$/i, "").replace(/[£₹$€\s]|GBP|INR|USD|EUR|Rs\.?/gi, "");
  if (t.startsWith("+")) t = t.slice(1);
  const v = parseMoney(t);
  return Number.isFinite(v) ? (neg ? -Math.abs(v) : v) : NaN;
}
function csvToLines(rows, hdr, m, acc) {
  const body = rows.slice(hdr + 1), out = [], bad = [];
  body.forEach((r, i) => {
    const date = parseDate(r[m.date], m.order);
    const desc = [r[m.desc], m.desc2 >= 0 ? r[m.desc2] : ""].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
    let amt;
    if (m.amount >= 0) amt = looseAmount(r[m.amount]);
    else amt = looseAmount(r[m.credit]) - looseAmount(r[m.debit]);
    if (m.drcr >= 0 && m.amount >= 0) { const t = String(r[m.drcr] || "").toUpperCase(); if (/^D/.test(t)) amt = -Math.abs(amt); else if (/^C/.test(t)) amt = Math.abs(amt); }
    if (m.flip) amt = -amt;
    const cur = m.cur >= 0 && CURRENCIES.includes(String(r[m.cur]).toUpperCase()) ? String(r[m.cur]).toUpperCase() : m.fixedCur;
    const bal = m.balance >= 0 ? looseAmount(r[m.balance]) : NaN;
    if (!date || !Number.isFinite(amt) || amt === 0) { if (r.some((x) => x)) bad.push(i + hdr + 2); return; }
    out.push({ date, desc: desc || "(no description)", amt, cur, balance: m.balance >= 0 && String(r[m.balance] || "").trim() && Number.isFinite(bal) ? (m.flip ? -bal : bal) : undefined, seq: i });
  });
  // Banks list newest first or oldest first; store oldest first.
  if (out.length > 1 && out[0].date > out[out.length - 1].date) { out.reverse(); out.forEach((l, k) => (l.seq = k)); }
  const wrongCur = out.filter((l) => acc && !acc.currencies.includes(l.cur)).length;
  return { lines: out, bad, wrongCur };
}
function jsonToLines(data) {
  const lines = []; let seq = 0;
  for (const st of data.statements || []) {
    for (const l of st.lines || []) lines.push({ date: l.date, desc: l.desc, amt: l.amount, cur: data.currency || "GBP", balance: l.balance, seq: seq++ });
    if (lines.length && st.endBalance != null && lines[lines.length - 1].balance == null) lines[lines.length - 1].balance = st.endBalance;
  }
  const first = (data.statements || [])[0];
  return { lines, opening: first && first.startBalance != null ? { date: first.startDate || (first.lines[0] || {}).date, amount: first.startBalance } : null };
}
function maskDigits(s) { return String(s).replace(/\d{4,}(\d{4})/g, "••$1"); }

/* ================= Staging and importing ================= */
/** Lines already in the app (same account, date, amount and currency) are skipped, even if the bank worded them differently. */
function splitDuplicates(accId, lines) {
  const have = new Map();
  for (const s of book().stmtByAcct.get(accId) || []) { const k = `${s.date}|${s.amt}|${s.cur}`; have.set(k, (have.get(k) || 0) + 1); }
  const seen = new Map(), fresh = [], dup = [];
  for (const l of lines) {
    const k = `${l.date}|${l.amt}|${l.cur}`, n = (seen.get(k) || 0) + 1; seen.set(k, n);
    (n <= (have.get(k) || 0) ? dup : fresh).push(l);
  }
  return { fresh, dup };
}
async function commitImport(acc, lines, source, opening) {
  const recs = [], occ = new Map(), now = Date.now();
  for (const l of lines) {
    const key = `${acc.id}|${l.date}|${l.amt}|${l.cur}|${l.desc}`;
    let n = (occ.get(key) || 0) + 1, id;
    for (;; n++) { id = "st_" + (await sha256hex(key + "|" + n)).slice(0, 24); if (!S.items.has(id) && !recs.some((r) => r.id === id)) break; }
    occ.set(key, n);
    recs.push({ id, kind: "stmt", accountId: acc.id, date: l.date, desc: maskDigits(l.desc), amt: l.amt, cur: l.cur,
      ...(l.balance != null ? { balance: l.balance } : {}), seq: now + (l.seq || 0), source, status: "new" });
  }
  if (opening) {
    const t = await buildTxn("opening", { date: opening.date, target: "account", account: acc.id, cur: opening.cur || acc.currencies[0], amount: minorToInput(opening.amount), entityId: acc.entityId, desc: "Opening balance · " + acc.name + " (from statement)" });
    recs.push({ ...t, id: uid("t") });
  }
  putMany(recs);
  return recs.length;
}

/* ================= Suggestions and rules ================= */
const daysApart = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
const PREFIX = /^(on-line banking bill payment to|online banking bill payment to|internet banking transfer to|direct debit to|direct credit from|card payment to|card purchase|bill payment to|bill payment from|received from|standing order to|faster payment to|faster payment from|payment to|payment from)\s+/i;
/** A short phrase to recognise similar lines: "Direct Debit to EE Limited Ref: Q45…" -> "ee limited". */
function keywordOf(desc) {
  let s = String(desc).replace(PREFIX, "").split(/ Ref:| · | On \d{1,2} | at VISA| \d{1,2} [A-Z][a-z]{2}\b/)[0];
  s = s.replace(/[*#].*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  return s.split(" ").slice(0, 3).join(" ");
}
const cleanDesc = (d) => String(d).split(/ Ref: /)[0].replace(/\s+/g, " ").trim().slice(0, 90);
function suggestFor(line, b = book()) {
  // 1. An entry you already made for this account, same amount, within 4 days.
  for (const t of b.acctTx.get(line.accountId) || []) {
    if (t.type === "opening" || daysApart(t.date, line.date) > 4) continue;
    if ((t.stmtIds || []).some((id) => { const s = b.byId.get(id); return s && s.accountId === line.accountId; })) continue;
    if (t.lines.some((l) => l.t === "a" && l.ref === line.accountId && l.cur === line.cur && l.amt === line.amt)) return { mode: "match", txnId: t.id, label: "Matches: " + t.desc };
  }
  // 2. The other side of a transfer, waiting in another account's inbox.
  for (const s of b.inbox) {
    if (s.accountId === line.accountId || s.cur !== line.cur || s.amt !== -line.amt || daysApart(s.date, line.date) > 4) continue;
    const [fromId, toId] = line.amt < 0 ? [line.accountId, s.accountId] : [s.accountId, line.accountId];
    const sch = (b.scheds || []).find((x) => x.dir === "transfer" && x.accountId === fromId && x.toAccountId === toId && x.amount === Math.abs(line.amt));
    const nature = sch ? sch.nature || "loan" : "loan";
    return { mode: "transfer", other: s.accountId, pairId: s.id, nature, schedId: sch ? sch.id : null,
      label: (line.amt < 0 ? "Transfer to " : "Transfer from ") + name(s.accountId) + (nature !== "loan" ? ` · ${nature}` : "") + " (both sides found)" };
  }
  // 3. An unpaid invoice it pays, or a recurring item it matches.
  const planned = typeof planSuggestion === "function" ? planSuggestion(line, b) : null;
  if (planned) return planned;
  // 4. Your rules: the longest matching phrase wins.
  const d = line.desc.toLowerCase();
  for (const r of b.rules) {
    if (r.accountId && r.accountId !== line.accountId) continue;
    if (r.dir && (r.dir === "in") !== line.amt > 0) continue;
    if (r.match && d.includes(r.match)) return { ...r.set, rule: r.id, label: ruleLabel(r.set, line) };
  }
  return null;
}
function ruleLabel(set, line) {
  if (!set) return "";
  if (set.mode === "ignore") return "Ignore";
  if (set.mode === "transfer") return (line && line.amt > 0 ? "Transfer from " : "Transfer to ") + name(set.other);
  if (set.mode === "person") return (line && line.amt > 0 ? "From " : "To ") + name(set.person);
  const bits = [name(set.category)];
  if (set.person) bits.push(name(set.person));
  if (set.divisionId) bits.push(name(set.divisionId)); else if (set.entityId && line && set.entityId !== (book().byId.get(line.accountId) || {}).entityId) bits.push(name(set.entityId));
  return bits.join(" · ");
}
/** Turn a statement line and a decision into an entry (or a match, or an ignore). */
async function settle(line, dec) {
  const b = book(), acc = b.byId.get(line.accountId);
  if (!acc) throw new Error("This line's account no longer exists.");
  const amt = minorToInput(Math.abs(line.amt)), upd = [];
  let txn = null;
  if (dec.mode === "ignore") upd.push({ ...line, status: "ignored" });
  else if (dec.mode === "match") {
    const t = b.byId.get(dec.txnId);
    if (!t) throw new Error("Choose the entry it matches.");
    upd.push({ ...t, stmtIds: [...new Set([...(t.stmtIds || []), line.id])] }, { ...line, status: "done", txnId: t.id });
  } else {
    const base = { date: line.date, desc: dec.desc || cleanDesc(line.desc), entityId: dec.entityId || acc.entityId, divisionId: dec.divisionId || "", tags: dec.tags || [], note: dec.note != null ? dec.note : "Statement: " + line.desc };
    let type, f;
    if (dec.mode === "transfer") {
      const other = b.byId.get(dec.other);
      if (!other || other.kind !== "account" || other.id === acc.id) throw new Error("Choose the other account.");
      const pair = dec.pairId ? b.byId.get(dec.pairId) : null;
      const otherCur = pair ? pair.cur : dec.otherCur || (other.currencies.includes(line.cur) ? line.cur : other.currencies[0]);
      const otherAmt = pair ? minorToInput(Math.abs(pair.amt)) : dec.otherAmt || (otherCur === line.cur ? amt : "");
      type = "transfer";
      f = line.amt < 0
        ? { ...base, from: acc.id, fromCur: line.cur, fromAmt: amt, to: other.id, toCur: otherCur, toAmt: otherAmt, nature: dec.nature || "loan" }
        : { ...base, from: other.id, fromCur: otherCur, fromAmt: otherAmt, to: acc.id, toCur: line.cur, toAmt: amt, nature: dec.nature || "loan" };
      if (!f.fromAmt) throw new Error(`Enter how much left ${other.name}.`);
    } else {
      type = line.amt > 0 ? "in" : "out";
      f = { ...base, account: acc.id, cur: line.cur, amount: amt, [line.amt > 0 ? "source" : "dest"]: dec.mode === "person" ? "person" : "category", category: dec.category || "", person: dec.person || "" };
    }
    const built = await buildTxn(type, f);
    const stmtIds = [line.id, ...(dec.mode === "transfer" && dec.pairId ? [dec.pairId] : [])];
    txn = { ...built, id: uid("t"), stmtIds, schedId: dec.schedId || null, invoiceId: dec.invoiceId || null };
    upd.push(txn, { ...line, status: "done", txnId: txn.id });
    if (dec.mode === "transfer" && dec.pairId) upd.push({ ...b.byId.get(dec.pairId), status: "done", txnId: txn.id });
  }
  if (dec.remember && String(dec.remember).trim() && dec.mode !== "match") {
    const set = { mode: dec.mode };
    for (const k of ["category", "person", "entityId", "divisionId", "other", "nature"]) if (dec[k]) set[k] = dec[k];
    upd.push({ id: uid("rule"), kind: "rule", match: String(dec.remember).trim().toLowerCase(), accountId: line.accountId, dir: line.amt > 0 ? "in" : "out", set });
  }
  putMany(upd);
  if (txn && dec.invoiceId && typeof linkPayment === "function") linkPayment(txn, dec.invoiceId);
  return txn;
}
/** Put an entry's statement lines back in the Inbox (used when the entry is deleted). */
function releaseLines(t) {
  const back = (t.stmtIds || []).map((id) => book().byId.get(id)).filter(Boolean).map((s) => ({ ...s, status: "new", txnId: null }));
  if (back.length) putMany(back);
}

/* ================= Statement checks ================= */
/** For each currency: the latest balance the bank printed, and what the app shows for the end of that day. */
function statementChecks(accId) {
  const b = book(), lines = b.stmtByAcct.get(accId) || [], out = [];
  const curs = [...new Set(lines.map((s) => s.cur))];
  for (const cur of curs) {
    const withBal = lines.filter((s) => s.cur === cur && s.balance != null);
    if (!withBal.length) continue;
    const last = withBal[withBal.length - 1];
    let app = 0;
    for (const t of b.acctTx.get(accId) || []) if (t.date <= last.date) for (const l of t.lines) if (l.t === "a" && l.ref === accId && l.cur === cur) app += l.amt;
    const pending = lines.filter((s) => s.cur === cur && s.status === "new" && s.date <= last.date).length;
    out.push({ cur, date: last.date, stated: last.balance, app, pending });
  }
  return out;
}
function checkHtml(accId) {
  return statementChecks(accId).map((c) => {
    const ok = c.app === c.stated;
    return `<div class="check-line ${ok ? "ok" : c.pending ? "" : "warn"}">${ok ? "✓" : "•"} Statement balance on ${esc(fmtDate(c.date))}: <b>${money(c.stated, c.cur)}</b>.
      ${ok ? "The app agrees." : c.pending ? `${c.pending} line${c.pending === 1 ? "" : "s"} still in the Inbox.` : `The app shows ${money(c.app, c.cur)}: a difference of ${money(c.stated - c.app, c.cur)}.`}</div>`;
  }).join("");
}

/* ================= Import screen ================= */
let IMP = null;   // the file being imported: { name, kind, accId, rows, hdr, map, data }
function viewImport() {
  const b = book();
  const accOpts = b.accounts.filter((a) => !a.archived).map((a) => opt(a.id, `${a.name} (${name(a.entityId)})`, IMP && IMP.accId === a.id)).join("");
  let body = `<section class="card pad"><h2>1. Choose a statement file</h2>
    <p class="muted">A CSV exported from your bank or card, or an import file I've prepared from your PDF statements (in <code>setup/imports</code>). Nothing leaves this device.</p>
    <label class="btn">Choose file…<input type="file" accept=".csv,.json,.txt,text/csv,application/json" data-act-change="pickStatement" hidden></label>
    ${IMP ? `<p class="small">Selected: <b>${esc(IMP.name)}</b></p>` : ""}</section>`;
  if (IMP) {
    const acc = b.byId.get(IMP.accId);
    body += `<section class="card pad"><h2>2. Which account is it?</h2>
      <select data-act-change="impAccount"><option value="">Choose…</option>${accOpts}</select></section>`;
    if (acc) {
      let parsed;
      if (IMP.kind === "json") parsed = jsonToLines(IMP.data);
      else parsed = csvToLines(IMP.rows, IMP.hdr, IMP.map, acc);
      const { fresh, dup } = splitDuplicates(acc.id, parsed.lines);
      if (IMP.kind === "csv") body += mappingCard(IMP, parsed);
      const hasHistory = (b.acctTx.get(acc.id) || []).some((t) => fresh.length && t.date <= fresh[0].date);
      let opening = parsed.opening || null;
      if (!opening && parsed.lines.length && parsed.lines[0].balance != null) opening = { date: parsed.lines[0].date, amount: parsed.lines[0].balance - parsed.lines[0].amt, cur: parsed.lines[0].cur };
      IMP.opening = opening && !hasHistory && !(b.stmtByAcct.get(acc.id) || []).length ? opening : null;
      const sum = fresh.reduce((s, l) => s + l.amt, 0);
      body += `<section class="card pad"><h2>${IMP.kind === "csv" ? "4" : "3"}. Import</h2>
        <p><b>${fresh.length}</b> new line${fresh.length === 1 ? "" : "s"}${dup.length ? `, <b>${dup.length}</b> already in the app (skipped)` : ""}${parsed.lines.length ? `, from ${esc(fmtDate(parsed.lines[0].date))} to ${esc(fmtDate(parsed.lines[parsed.lines.length - 1].date))}` : ""}.
        Net movement ${money(sum, acc.currencies[0])}.</p>
        ${parsed.wrongCur ? `<p class="msg err">${parsed.wrongCur} line(s) are in a currency ${esc(acc.name)} doesn't hold. Add the currency to the account first.</p>` : ""}
        ${parsed.bad && parsed.bad.length ? `<p class="muted small">Skipped ${parsed.bad.length} row(s) that had no date or amount (rows ${esc(parsed.bad.slice(0, 8).join(", "))}${parsed.bad.length > 8 ? "…" : ""}).</p>` : ""}
        ${IMP.opening ? `<label class="check"><input type="checkbox" id="impOpening" checked> Also set the opening balance: ${money(IMP.opening.amount, IMP.opening.cur || acc.currencies[0])} on ${esc(fmtDate(IMP.opening.date))}</label>` : ""}
        <div class="actions" style="margin-top:12px"><button class="btn primary" data-act="doImport"${fresh.length && !parsed.wrongCur ? "" : " disabled"}>Import ${fresh.length} line${fresh.length === 1 ? "" : "s"} to the Inbox</button></div></section>`;
      IMP.fresh = fresh;
    }
  }
  return { title: "Import statement", back: "#/inbox", html: body };
}
function mappingCard(imp, parsed) {
  const h = imp.rows[imp.hdr] || [];
  const colSel = (key, label, allowNone = true) => field(label, `<select data-map="${key}">${allowNone ? opt(-1, "— none —", imp.map[key] < 0) : ""}${h.map((c, i) => opt(i, c || `Column ${i + 1}`, imp.map[key] === i)).join("")}</select>`);
  const preview = parsed.lines.slice(0, 8).map((l) => `<tr><td>${esc(fmtDate(l.date))}</td><td>${esc(l.desc.slice(0, 48))}</td><td class="r ${signCls(l.amt)}">${money(l.amt, l.cur)}</td><td class="r">${l.balance != null ? money(l.balance, l.cur) : ""}</td></tr>`).join("");
  return `<section class="card pad"><h2>3. Check the columns</h2>
    <p class="muted small">I've guessed which column is which. Fix any that are wrong; the preview updates.</p>
    <div class="grid2">${colSel("date", "Date", false)}${colSel("desc", "Description", false)}</div>
    <div class="grid2">${colSel("amount", "Amount (one column, + in / − out)")}${colSel("desc2", "Extra description")}</div>
    <div class="grid2">${colSel("credit", "Money in (if separate)")}${colSel("debit", "Money out (if separate)")}</div>
    <div class="grid2">${colSel("cur", "Currency")}${colSel("balance", "Balance")}</div>
    <div class="grid2">${field("Date format", `<select data-map="order">${opt("dmy", "Day first (31/01/2026)", imp.map.order === "dmy")}${opt("mdy", "Month first (01/31/2026)", imp.map.order === "mdy")}</select>`)}
      ${field("Currency if there's no column", `<select data-map="fixedCur">${CURRENCIES.map((c) => opt(c, c, imp.map.fixedCur === c)).join("")}</select>`)}</div>
    <label class="check"><input type="checkbox" data-map="flip"${imp.map.flip ? " checked" : ""}> Positive amounts are spending (usual for credit cards such as Amex)</label>
    <table class="tbl"><thead><tr><th>Date</th><th>Description</th><th class="r">Amount</th><th class="r">Balance</th></tr></thead><tbody>${preview || `<tr><td colspan="4" class="muted">No rows read yet. Check the columns.</td></tr>`}</tbody></table></section>`;
}

/* ================= Inbox ================= */
function viewInbox(r) {
  if (r.a === "line") return viewLine(r.b);
  const b = book(), filter = r.a || "";
  const lines = b.inbox.filter((s) => !filter || s.accountId === filter);
  const sugg = new Map(lines.map((s) => [s.id, suggestFor(s, b)]));
  const nSugg = [...sugg.values()].filter(Boolean).length;
  const byAcct = new Map();
  for (const s of lines) { const arr = byAcct.get(s.accountId) || []; arr.push(s); byAcct.set(s.accountId, arr); }
  const counts = new Map(); for (const s of b.inbox) counts.set(s.accountId, (counts.get(s.accountId) || 0) + 1);
  const cards = [...byAcct].map(([accId, arr]) => `<section class="card"><div class="card-head"><h2>${esc(name(accId))}</h2><span class="muted small">${arr.length} to review</span></div>
    <div class="pad-x">${checkHtml(accId)}</div>
    <div class="list">${arr.slice(0, 250).map((s) => inboxRow(s, sugg.get(s.id))).join("")}</div>
    ${arr.length > 250 ? `<p class="muted pad small">Showing the oldest 250. Work through these and the rest appear.</p>` : ""}</section>`).join("");
  return {
    title: "Inbox",
    html: `<div class="actions"><a class="btn primary" href="#/import">＋ Import statement</a>
        ${nSugg ? `<button class="btn" data-act="acceptAll" data-filter="${esc(filter)}">Accept all ${nSugg} suggestions</button>` : ""}
        ${b.rules.length ? `<a class="btn ghost" href="#/more/rules">Rules (${b.rules.length})</a>` : ""}</div>
      ${counts.size > 1 ? `<div class="filters"><select data-act-change="inboxFilter"><option value="">All accounts (${b.inbox.length})</option>${[...counts].map(([id, n]) => opt(id, `${name(id)} (${n})`, id === filter)).join("")}</select></div>` : ""}
      ${cards || `<div class="card empty"><h2>All clear</h2><p class="muted">Nothing to review. Import a statement to bring in more lines.</p></div>`}`,
  };
}
function inboxRow(s, sug) {
  return `<div class="row inbox-row">
    <a class="row-main" href="#/inbox/line/${encodeURIComponent(s.id)}"><div class="row-title">${esc(s.desc)}</div>
      <div class="row-sub">${esc(fmtDate(s.date))} · ${sug ? `<span class="sugg">→ ${esc(sug.label)}</span>` : `<span class="needs">Needs you</span>`}</div></a>
    <div class="row-amt ${signCls(s.amt)}">${s.amt > 0 ? "+" : ""}${money(s.amt, s.cur)}</div>
    ${sug ? `<button class="btn small tick" data-act="acceptLine" data-id="${esc(s.id)}" aria-label="Accept suggestion">✓</button>` : `<a class="btn small ghost tick" href="#/inbox/line/${encodeURIComponent(s.id)}" aria-label="Review">›</a>`}
  </div>`;
}
function viewLine(id) {
  const b = book(), s = b.byId.get(id);
  if (!s || s.kind !== "stmt") return { title: "Line", back: "#/inbox", html: `<p class="muted">This line no longer exists.</p>` };
  const acc = b.byId.get(s.accountId);
  if (s.status !== "new") {
    const t = s.txnId && b.byId.get(s.txnId);
    return {
      title: "Statement line", back: "#/inbox",
      html: `<section class="card pad"><div class="row-title">${esc(s.desc)}</div><p class="muted">${esc(fmtDate(s.date))} · ${esc(acc ? acc.name : "")} · <b class="${signCls(s.amt)}">${money(s.amt, s.cur)}</b></p>
        <p>${s.status === "ignored" ? "You chose to ignore this line." : t ? `Recorded as <a class="link" href="#/txn/${encodeURIComponent(t.id)}">${esc(t.desc)}</a>.` : "Recorded."}</p>
        ${s.status === "ignored" ? `<button class="btn" data-act="unignore" data-id="${esc(s.id)}">Put back in the Inbox</button>` : ""}</section>`,
    };
  }
  const sug = suggestFor(s, b) || { mode: "category" };
  const isIn = s.amt > 0;
  const cands = (b.acctTx.get(s.accountId) || []).filter((t) => t.type !== "opening" && daysApart(t.date, s.date) <= 10 && !(t.stmtIds || []).some((x) => (b.byId.get(x) || {}).accountId === s.accountId));
  const modes = { category: isIn ? "Income" : "Spending", person: isIn ? "From a person" : "To a person", transfer: "Transfer", ...(cands.length ? { match: "Already entered" } : {}), ignore: "Ignore" };
  const ent = sug.entityId || (acc && acc.entityId) || "ent_personal";
  const otherAcc = sug.other ? b.byId.get(sug.other) : null;
  const html = `<section class="card pad"><div class="row-title wrap">${esc(s.desc)}</div>
      <p class="muted">${esc(fmtDate(s.date))} · ${esc(acc ? acc.name : "")}${s.balance != null ? ` · balance after: ${money(s.balance, s.cur)}` : ""}</p>
      <div class="hero-num ${signCls(s.amt)}">${isIn ? "+" : ""}${money(s.amt, s.cur)}</div>
      ${sug.label ? `<p class="small sugg">Suggested: ${esc(sug.label)}</p>` : ""}</section>
    <form data-form="line" data-live class="stack form-card" novalidate>
      <input type="hidden" name="id" value="${esc(s.id)}"><input type="hidden" name="pairId" value="${esc(sug.pairId || "")}">
      <input type="hidden" name="schedId" value="${esc(sug.schedId || "")}"><input type="hidden" name="invoiceId" value="${esc(sug.invoiceId || "")}">
      ${field("What is it?", seg("mode", sug.mode in modes ? sug.mode : "category", modes))}
      ${when("mode:category", categorySelect("category", sug.category, { label: isIn ? "Income category" : "Spending category", first: isIn ? "income" : "expense", required: false }))}
      ${when("mode:category,person", personSelect("person", sug.person, { label: isIn ? "From" : "Paid to", optional: true }))}
      ${when("mode:transfer", `${accountSelect("other", sug.other || "", { label: isIn ? "Came from account" : "Went to account", required: false })}
        <div data-other-amt${sug.pairId ? " hidden" : ""}>${field(isIn ? "Amount that left the other account" : "Amount that arrived in the other account",
          `<div class="amt-in">${curSelect("otherCur", otherAcc ? (otherAcc.currencies.includes(s.cur) ? s.cur : otherAcc.currencies[0]) : s.cur, CURRENCIES, 'data-cur-of="other"')}<input name="otherAmt" inputmode="decimal" placeholder="${esc(minorToInput(Math.abs(s.amt)))}"></div>`, "Leave empty if it's the same amount and currency.")}</div>
        ${field("If it's between your entities", seg("nature", sug.nature || "loan", { loan: "Loan or repayment", salary: "Salary", dividend: "Dividend" }))}`)}
      ${cands.length ? when("mode:match", field("Which entry?", `<div class="stack-tight">${cands.map((t, k) => `<label class="check"><input type="radio" name="txnId" value="${esc(t.id)}"${t.id === sug.txnId || (!sug.txnId && k === 0) ? " checked" : ""}> ${esc(fmtDate(t.date))} · ${esc(t.desc)}</label>`).join("")}</div>`)) : ""}
      ${when("mode:category,person,transfer", entityFields(ent, sug.divisionId || ""))}
      ${when("mode:category,person,transfer", field("Description", `<input name="desc" value="${esc(cleanDesc(s.desc))}">`))}
      ${when("mode:category,person,transfer,ignore", field("Remember for lines containing", `<input name="remember" autocapitalize="off" placeholder="leave empty to not remember" value="${sug.rule ? "" : esc(keywordOf(s.desc))}">`, sug.rule ? "A rule already covers this line." : "Next time, lines with this phrase on this account get the same suggestion."))}
      <p class="msg err" data-err hidden></p>
      <div class="actions"><button class="btn primary big">Confirm</button></div>
    </form>`;
  return {
    title: "Review line", back: "#/inbox", html,
    after() {
      const form = $("form[data-form=line]");
      initLiveForm(form, !!sug.entityId);
      form.addEventListener("change", (e) => { if (e.target.name === "other") { form.elements.pairId.value = ""; $("[data-other-amt]", form).hidden = false; } });
    },
  };
}
function viewRules() {
  const b = book();
  return {
    title: "Rules", back: "#/inbox",
    html: `<p class="muted">Rules suggest what to do with statement lines. They never act on their own: you still confirm each line, or tap Accept all.</p>
      <section class="card"><div class="list">${b.rules.map((r) => `<div class="row"><div class="row-main"><div class="row-title">"${esc(r.match)}"</div>
        <div class="row-sub">${esc(r.accountId ? name(r.accountId) : "Any account")} · ${r.dir === "in" ? "money in" : r.dir === "out" ? "money out" : "in or out"} → ${esc(ruleLabel(r.set, { amt: r.dir === "in" ? 1 : -1, accountId: r.accountId }))}</div></div>
        <button class="btn small danger" data-act="delRule" data-id="${esc(r.id)}">Delete</button></div>`).join("") || `<p class="muted pad">No rules yet. They're created when you confirm lines with "Remember" filled in.</p>`}</div></section>`,
  };
}

/* ================= Actions ================= */
Object.assign(CHANGE_ACTS, {
  async pickStatement(el) {
    const file = el.files && el.files[0];
    if (!file) return;
    const text = await file.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (data) {
      if (data.app !== "jays-money" || data.kind !== "statement") return toast("That JSON file isn't a J Finance statement file.", true);
      IMP = { name: file.name, kind: "json", data, accId: book().byId.has(data.accountId) ? data.accountId : window.__importFor || "" };
    } else {
      const rows = parseCSV(text);
      if (rows.length < 2) return toast("Couldn't find any rows in that file.", true);
      const hdr = findHeader(rows);
      IMP = { name: file.name, kind: "csv", rows, hdr, accId: "" };
      IMP.sig = (rows[hdr] || []).join("|").toLowerCase();
      const saved = book().accounts.find((a) => a.importMap && a.importMap.sig === IMP.sig);
      const pre = window.__importFor && book().byId.get(window.__importFor);
      if (saved) { IMP.accId = saved.id; IMP.map = { ...saved.importMap.map }; }
      else { IMP.accId = pre ? pre.id : ""; IMP.map = guessMap(rows[hdr] || [], pre || null); }
      const dates = rows.slice(hdr + 1, hdr + 60).map((r) => r[IMP.map.date]);
      if (!saved) IMP.map.order = detectOrder(dates);
    }
    renderApp();
  },
  impAccount(el) {
    IMP.accId = el.value;
    const acc = book().byId.get(el.value);
    if (acc && IMP.kind === "csv" && !(acc.importMap && acc.importMap.sig === IMP.sig)) { IMP.map.flip = acc.type === "card"; if (IMP.map.cur < 0) IMP.map.fixedCur = acc.currencies[0]; }
    renderApp();
  },
  inboxFilter(el) { go("#/inbox/" + encodeURIComponent(el.value)); },
});
app.addEventListener("change", (e) => {
  const el = e.target.closest("[data-map]");
  if (!el || !IMP) return;
  const k = el.dataset.map;
  IMP.map[k] = el.type === "checkbox" ? el.checked : ["order", "fixedCur"].includes(k) ? el.value : Number(el.value);
  if (k === "amount" && IMP.map.amount >= 0) { IMP.map.debit = -1; IMP.map.credit = -1; }
  if ((k === "debit" || k === "credit") && IMP.map[k] >= 0) IMP.map.amount = -1;
  renderApp();
});
Object.assign(ACTS, {
  async doImport(el) {
    const acc = book().byId.get(IMP && IMP.accId);
    if (!acc || !IMP.fresh) return;
    el.disabled = true;
    try {
      const withOpening = IMP.opening && $("#impOpening") && $("#impOpening").checked ? { ...IMP.opening, cur: IMP.opening.cur || acc.currencies[0] } : null;
      if (IMP.kind === "csv") put({ ...acc, importMap: { sig: IMP.sig, map: IMP.map } });
      const n = IMP.fresh.length;
      await commitImport(acc, IMP.fresh, IMP.name, withOpening);
      IMP = null; window.__importFor = null;
      toast(`Imported ${n} line${n === 1 ? "" : "s"}`);
      go("#/inbox/" + encodeURIComponent(acc.id));
    } catch (e) { el.disabled = false; toast(e.message, true); }
  },
  async acceptLine(el) {
    const s = book().byId.get(el.dataset.id), sug = s && suggestFor(s);
    if (!sug) return go(`#/inbox/line/${encodeURIComponent(el.dataset.id)}`);
    try { await settle(s, sug); toast("Done"); }
    catch (e) { toast(e.message, true); go(`#/inbox/line/${encodeURIComponent(s.id)}`); }
  },
  async acceptAll(el) {
    el.disabled = true;
    let ok = 0, failed = 0;
    for (;;) {
      const b = book();
      const next = b.inbox.filter((s) => !el.dataset.filter || s.accountId === el.dataset.filter).find((s) => !acceptAllSkip.has(s.id) && suggestFor(s, b));
      if (!next) break;
      try { await settle(next, suggestFor(next)); ok++; } catch { acceptAllSkip.add(next.id); failed++; }
    }
    acceptAllSkip.clear();
    toast(`Accepted ${ok}${failed ? `; ${failed} need you` : ""}`);
    renderApp();
  },
  unignore(el) { const s = book().byId.get(el.dataset.id); if (s) { put({ ...s, status: "new" }); go("#/inbox"); } },
  delRule(el) { remove(el.dataset.id); toast("Rule deleted"); },
});
const acceptAllSkip = new Set();
FORMS.line = async (form, fd) => {
  const errEl = $("[data-err]", form), btn = $("button.primary", form);
  errEl.hidden = true; btn.disabled = true;
  const s = book().byId.get(fd.get("id"));
  const dec = Object.fromEntries(fd);
  try {
    if (dec.mode === "person" && !dec.person) throw new Error(s.amt > 0 ? "Choose who paid you." : "Choose who you paid.");
    if (dec.mode === "category" && !dec.category) throw new Error("Choose a category.");
    await settle(s, dec);
    toast("Done");
    const next = book().inbox.find((x) => x.accountId === s.accountId);
    go(next ? `#/inbox/line/${encodeURIComponent(next.id)}` : "#/inbox");
  } catch (e) { errEl.textContent = e.message; errEl.hidden = false; btn.disabled = false; }
};
