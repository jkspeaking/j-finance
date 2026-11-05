"use strict";
/* J Finance: recurring items, invoices, the 3-month forecast and its warnings.
   Recurring items and invoices don't move money by themselves: they say what's expected.
   When the real payment arrives (usually through the Inbox) it's linked back, so it isn't expected twice. */

const FREQ = { monthly: "Monthly", quarterly: "Every 3 months", yearly: "Yearly", weekly: "Weekly", once: "Once" };
const DIRS = { in: "Money in", out: "Money out", transfer: "Transfer between my accounts", behalf: "Paid on my behalf (no account moves)" };
const FORECAST_DAYS = 92;

/* ================= Dates ================= */
function addMonthsKeepDay(iso, n, day) {
  const [y, m] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(Math.min(day, last))}`;
}
function addDays(iso, n) { const t = new Date(iso + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
const monthKey = (iso) => iso.slice(0, 7);

/* ================= Invoices ================= */
function invoicePaid(inv, b = book()) {
  let paid = 0;
  for (const id of inv.txnIds || []) {
    const t = b.byId.get(id);
    if (!t) continue;
    const l = t.lines.find((x) => x.t === "a" && x.amt > 0);
    if (!l) continue;
    if (l.cur === inv.cur) paid += l.amt;
    else if (inv.cur === "GBP") paid += l.gbp;
    else if (S.rates && S.rates[inv.cur]) paid += symRound(l.gbp * S.rates[inv.cur]);
  }
  return paid;
}
function invoiceTotal(inv) {
  const net = (inv.lines || []).reduce((s, l) => s + (l.amount || 0), 0);
  return net + symRound(net * (inv.vatRate || 0) / 100);
}
function invoiceStatus(inv, b = book()) {
  if (inv.status === "cancelled") return "cancelled";
  const total = invoiceTotal(inv), paid = invoicePaid(inv, b);
  if (total > 0 && paid >= total) return "paid";
  if (paid > 0) return "part";
  if (inv.status === "draft") return "draft";
  return inv.dueDate && inv.dueDate < todayISO() ? "overdue" : "sent";
}
const STATUS_LABEL = { draft: "Draft", sent: "Sent", part: "Part paid", paid: "Paid", overdue: "Overdue", cancelled: "Cancelled" };
function nextInvoiceNumber(dateIso) {
  const base = "INV-" + dateIso.slice(2, 4) + dateIso.slice(5, 7);
  const used = new Set(kindOf("invoice").map((i) => i.number));
  for (let n = 1; n < 100; n++) { const c = base + pad(n); if (!used.has(c)) return c; }
  return base + "99";
}
const kindOf = (k) => [...S.items.values()].filter((x) => x.kind === k);

/* ================= Recurring items ================= */
/** Amount already invoiced against a capped item (e.g. the Babylon course). */
function billedFor(schedId) {
  let n = 0;
  for (const inv of kindOf("invoice")) if (inv.status !== "cancelled") for (const l of inv.lines || []) if (l.schedId === schedId) n += l.amount || 0;
  return n;
}
function periodsInvoiced(schedId) {
  const set = new Set();
  for (const inv of kindOf("invoice")) if (inv.status !== "cancelled" && (inv.lines || []).some((l) => l.schedId === schedId)) set.add(inv.period || monthKey(inv.date));
  return set;
}
/** Every occurrence of a recurring item up to `to`, with what's already happened marked. */
function occurrences(s, to) {
  if (!s.start || s.paused) return [];
  const out = [], day = Number(s.start.slice(8, 10));
  const invoiced = s.invoice ? periodsInvoiced(s.id) : new Set();
  let left = s.cap != null ? s.cap - (s.capBefore || 0) - billedFor(s.id) : Infinity;
  const done = kindOf("txn").filter((t) => t.schedId === s.id).map((t) => t.date);
  const used = new Set();
  for (let i = 0; ; i++) {
    if (s.count != null && i >= s.count) break;
    const d = s.freq === "weekly" ? addDays(s.start, 7 * i) : s.freq === "once" ? (i ? null : s.start)
      : addMonthsKeepDay(s.start, i * ({ monthly: 1, quarterly: 3, yearly: 12 }[s.freq] || 1), day);
    if (!d || d > to || (s.end && d > s.end)) break;
    const covered = invoiced.has(monthKey(d));
    let amount = s.amount;
    if (!covered && s.cap != null) { amount = Math.min(s.amount, left); if (amount <= 0) break; left -= amount; }
    const cd = s.invoice ? addDays(d, s.dueDays != null ? Number(s.dueDays) : 9) : d;
    const hit = done.findIndex((x, k) => !used.has(k) && Math.abs(Date.parse(x) - Date.parse(cd)) <= 7 * 864e5);
    if (hit >= 0) used.add(hit);
    out.push({ s, date: d, cashDate: s.invoice ? addDays(d, s.dueDays != null ? Number(s.dueDays) : 9) : d, amount, covered, done: hit >= 0, period: monthKey(d) });
  }
  return out;
}
function schedLabel(s) {
  const amt = money(s.amount, s.cur);
  const left = s.count != null ? ` · ${s.count} in total from ${fmtDate(s.start)}` : s.cap != null ? ` · until ${money(s.cap, s.cur)} is reached` : "";
  return `${amt} ${FREQ[s.freq].toLowerCase()}${left}`;
}

/* ================= Forecast ================= */
/** Expected movements from today to +92 days. Anything expected in the last 10 days that hasn't shown up counts as due today. */
function expectedEvents() {
  const b = book(), today = todayISO(), to = addDays(today, FORECAST_DAYS), from = addDays(today, -10), ev = [];
  for (const s of b.scheds) {
    for (const o of occurrences(s, to)) {
      if (o.done || o.covered || o.cashDate < from) continue;
      ev.push({ date: o.cashDate < today ? today : o.cashDate, late: o.cashDate < today, label: s.name, amount: o.amount, cur: s.cur, dir: s.dir, accountId: s.accountId, toAccountId: s.toAccountId, ref: "#/plan/" + encodeURIComponent(s.id) });
    }
  }
  for (const inv of b.invoices) {
    const st = invoiceStatus(inv, b);
    if (!["sent", "overdue", "part", "draft"].includes(st)) continue;
    const due = inv.dueDate || inv.date;
    if (due > to) continue;
    ev.push({ date: due < today ? today : due, late: due < today, label: `Invoice ${inv.number} · ${name(inv.personId)}`, amount: invoiceTotal(inv) - invoicePaid(inv, b), cur: inv.cur, dir: "in", accountId: inv.accountId, ref: "#/invoice/" + encodeURIComponent(inv.id) });
  }
  return ev.sort((a, c) => a.date.localeCompare(c.date));
}
function forecast() {
  const b = book(), today = todayISO(), events = expectedEvents();
  const accs = b.accounts.filter((a) => !a.archived && a.type !== "pension");
  const bal = new Map(accs.map((a) => [a.id, { ...(b.acctBal.get(a.id) || {}) }]));
  const rows = new Map(accs.map((a) => [a.id, { acc: a, start: { ...(b.acctBal.get(a.id) || {}) }, low: null, lowDate: null, items: [] }]));
  const cashGBP = () => accs.filter((a) => CASH_TYPES.has(a.type)).reduce((s, a) => s + balGBP(bal.get(a.id)).total, 0);
  const series = [{ date: today, total: cashGBP(), items: [] }];
  const touch = (accId, cur, delta, e) => {
    const m = bal.get(accId); if (!m) return;
    m[cur] = (m[cur] || 0) + delta;
    const r = rows.get(accId); r.items.push({ ...e, delta, cur, after: m[cur] });
    const main = r.acc.currencies[0];
    if (cur === main && (r.low == null || m[cur] < r.low)) { r.low = m[cur]; r.lowDate = e.date; }
  };
  for (const a of accs) { const r = rows.get(a.id); r.low = (r.start[a.currencies[0]] || 0); r.lowDate = today; }
  let day = today, dayItems = [];
  const flush = () => { const last = series[series.length - 1]; if (last.date === day) { last.total = cashGBP(); last.items.push(...dayItems); } else series.push({ date: day, total: cashGBP(), items: dayItems }); dayItems = []; };
  for (const e of events) {
    if (e.date !== day) { flush(); day = e.date; }
    if (e.dir === "in") touch(e.accountId, e.cur, e.amount, e);
    else if (e.dir === "out") touch(e.accountId, e.cur, -e.amount, e);
    else if (e.dir === "transfer") { touch(e.accountId, e.cur, -e.amount, e); const to = b.byId.get(e.toAccountId); if (to) touch(to.id, to.currencies.includes(e.cur) ? e.cur : to.currencies[0], e.amount, e); }
    dayItems.push(e);
  }
  flush();
  const end = addDays(today, FORECAST_DAYS);
  if (series[series.length - 1].date < end) series.push({ date: end, total: cashGBP(), items: [] });
  const warnings = [];
  for (const r of rows.values()) {
    const a = r.acc, min = a.minBalance != null ? a.minBalance : ["bank", "wallet"].includes(a.type) ? 0 : null;
    if (min == null || r.low == null) continue;
    if (r.low < min) warnings.push({ acc: a, low: r.low, date: r.lowDate, min, cur: a.currencies[0] });
  }
  return { series, rows: [...rows.values()], events, warnings, end: bal };
}

/* ================= Chart ================= */
function warnText(w) {
  const where = w.date <= todayISO() ? `is at <b>${money(w.low, w.cur)}</b> now` : `is expected to drop to <b>${money(w.low, w.cur)}</b> on ${esc(fmtDate(w.date))}`;
  return `<b>${esc(w.acc.name)}</b> ${where}${w.min ? `, below the ${money(w.min, w.cur)} you set` : ""}.`;
}
function cashChart(series, W = 720) {
  if (series.length < 2) return "";
  const H = W < 500 ? 200 : 240, L = 52, R = 14, T = 16, B = 28;
  const t0 = Date.parse(series[0].date), t1 = Date.parse(series[series.length - 1].date);
  const vals = series.map((p) => p.total);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi === lo) hi = lo + 100;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = (iso) => L + ((Date.parse(iso) - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  // Balances change in steps: hold each value until the next change.
  let d = `M${x(series[0].date)},${y(series[0].total)}`;
  for (let i = 1; i < series.length; i++) d += `H${x(series[i].date)}V${y(series[i].total)}`;
  const ticks = []; for (let v = lo; v <= hi + 1; v += step) ticks.push(v);
  const months = []; const s0 = new Date(t0);
  for (let k = 1; k <= 4; k++) { const m = new Date(Date.UTC(s0.getUTCFullYear(), s0.getUTCMonth() + k, 1)); if (m.getTime() <= t1) months.push(m.toISOString().slice(0, 10)); }
  const low = series.reduce((m, p) => (p.total < m.total ? p : m), series[0]);
  const lastP = series[series.length - 1];
  const compact = (v) => { const a = Math.abs(v / 100); const s = a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1000 ? Math.round(a / 1000) + "K" : String(Math.round(a)); return (v < 0 ? "-£" : "£") + s; };
  return `<figure class="chart" data-chart>
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cash across your accounts over the next three months, lowest ${money(low.total, "GBP", true)} on ${fmtDate(low.date)}">
      ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join("")}
      ${lo < 0 ? `<line class="zero" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>` : ""}
      ${months.map((m) => `<text class="tick" x="${x(m)}" y="${H - 8}" text-anchor="middle">${new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(m))}</text>`).join("")}
      <path class="area" d="${d}V${y(Math.max(lo, 0))}H${x(series[0].date)}Z"/>
      <path class="line" d="${d}"/>
      <circle class="dot" cx="${x(low.date)}" cy="${y(low.total)}" r="4.5"/>
      <text class="lbl" x="${Math.min(x(low.date) + 8, W - R - 110)}" y="${y(low.total) + (y(low.total) > H - B - 20 ? -10 : 16)}">Lowest ${compact(low.total)} · ${fmtDate(low.date).replace(/ \d{4}$/, "")}</text>
      <circle class="dot" cx="${x(lastP.date)}" cy="${y(lastP.total)}" r="4.5"/>
      <line class="cross" data-cross-line x1="0" x2="0" y1="${T}" y2="${H - B}" hidden/>
      <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" data-hit/>
    </svg>
    <div class="tip" data-tip hidden></div>
    <figcaption class="muted small">Cash across your accounts, less card balances, in GBP at today's rates. Pension and loans aren't included.</figcaption>
  </figure>`;
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1)))), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function wireChart(series, W) {
  const fig = $("[data-chart]");
  if (!fig) return;
  const svg = $("svg", fig), hit = $("[data-hit]", fig), line = $("[data-cross-line]", fig), tip = $("[data-tip]", fig);
  const L = 52, R = 14, t0 = Date.parse(series[0].date), t1 = Date.parse(series[series.length - 1].date);
  const show = (clientX) => {
    const box = svg.getBoundingClientRect(), vx = ((clientX - box.left) / box.width) * W;
    const t = t0 + ((vx - L) / (W - L - R)) * (t1 - t0);
    let p = series[0];
    for (const q of series) if (Date.parse(q.date) <= t) p = q;
    const px = L + ((Date.parse(p.date) - t0) / (t1 - t0 || 1)) * (W - L - R);
    line.setAttribute("x1", px); line.setAttribute("x2", px); line.hidden = false;
    tip.innerHTML = `<b>${esc(fmtDate(p.date))}</b><div>${money(p.total, "GBP")}</div>${p.items.slice(0, 4).map((e) => `<div class="muted">${esc(e.label)}: ${e.dir === "out" ? "−" : e.dir === "in" ? "+" : ""}${money(e.amount, e.cur)}</div>`).join("")}${p.items.length > 4 ? `<div class="muted">+${p.items.length - 4} more</div>` : ""}`;
    tip.hidden = false;
    const left = (px / W) * box.width;
    tip.style.left = Math.min(Math.max(left - 90, 0), box.width - 190) + "px";
  };
  hit.addEventListener("pointermove", (e) => show(e.clientX));
  hit.addEventListener("pointerdown", (e) => show(e.clientX));
  hit.addEventListener("pointerleave", () => { line.hidden = true; tip.hidden = true; });
}

/* ================= Screens ================= */
function viewForecast() {
  const f = forecast();
  const rows = f.rows.filter((r) => r.items.length || Object.values(r.start).some((v) => v));
  const table = rows.map((r) => {
    const a = r.acc, cur = a.currencies[0], now = r.start[cur] || 0, endBal = (f.end.get(a.id) || {})[cur] || 0;
    const warn = f.warnings.find((w) => w.acc.id === a.id);
    return `<tr><td><a class="link" href="#/account/${encodeURIComponent(a.id)}">${esc(a.name)}</a></td><td class="r">${money(now, cur)}</td>
      <td class="r">${warn ? `<span class="badge warn">⚠ low</span> ` : ""}${money(r.low, cur)}<div class="muted small">${esc(fmtDate(r.lowDate))}</div></td><td class="r">${money(endBal, cur)}</td></tr>`;
  }).join("");
  const upcoming = f.events.slice(0, 60).map((e) => `<a class="row" href="${e.ref}"><div class="row-main"><div class="row-title">${esc(e.label)}</div>
      <div class="row-sub">${esc(fmtDate(e.date))}${e.late ? " · expected already, not seen yet" : ""} · ${esc(e.dir === "behalf" ? "no account moves" : name(e.accountId))}${e.dir === "transfer" ? " → " + esc(name(e.toAccountId)) : ""}</div></div>
      <div class="row-amt ${e.dir === "in" ? "pos" : e.dir === "out" ? "neg" : ""}">${e.dir === "in" ? "+" : e.dir === "out" ? "−" : ""}${money(e.amount, e.cur)}</div></a>`).join("");
  return {
    title: "Forecast",
    html: `${f.warnings.length ? `<section class="card pad warn-card">${f.warnings.map((w) => `<p>⚠ ${warnText(w)}</p>`).join("")}</section>` : ""}
      <section class="card pad"><h2 class="chart-title">Cash over the next 3 months</h2><div id="chartBox"></div></section>
      <section class="card"><div class="card-head"><h2>By account, next 3 months</h2></div>
        <div class="pad-x tbl-wrap"><table class="tbl full"><thead><tr><th>Account</th><th class="r">Today</th><th class="r">Lowest</th><th class="r">In 3 months</th></tr></thead><tbody>${table}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h2>Expected</h2><a class="link" href="#/plan">Recurring items</a></div><div class="list">${upcoming || `<p class="muted pad">Nothing expected yet.</p>`}</div></section>
      <p class="muted small">The forecast starts from today's balances and adds your recurring items and unpaid invoices. Anything already recorded isn't counted again.</p>`,
    after: () => {
      const box = $("#chartBox"); if (!box) return;
      const w = Math.max(280, Math.floor(box.clientWidth));
      box.innerHTML = cashChart(f.series, w) || `<p class="muted">Add recurring items and invoices to see the forecast.</p>`;
      wireChart(f.series, w);
    },
  };
}
function viewPlan(r) {
  if (r.a) return viewSched(r.a);
  const b = book();
  const group = (dir) => b.scheds.filter((s) => s.dir === dir).map((s) => {
    const next = occurrences(s, addDays(todayISO(), 400)).find((o) => !o.done && !o.covered && o.date >= addDays(todayISO(), -10));
    return `<a class="row${s.paused ? " archived" : ""}" href="#/plan/${encodeURIComponent(s.id)}"><div class="row-main"><div class="row-title">${esc(s.name)}${s.invoice ? ` <span class="badge">invoice</span>` : ""}${s.check ? ` <span class="badge warn">check</span>` : ""}</div>
      <div class="row-sub">${esc(schedLabel(s))} · ${esc(s.dir === "behalf" ? name(s.personId) : name(s.accountId))}</div></div>
      <div class="row-amt"><div class="row-sub">${s.paused ? "paused" : next ? "next " + esc(fmtDate(next.date)) : "finished"}</div></div></a>`;
  }).join("");
  const sec = (dir) => { const h = group(dir); return h ? `<section class="card"><div class="card-head"><h2>${DIRS[dir]}</h2></div><div class="list">${h}</div></section>` : ""; };
  return {
    title: "Recurring items",
    html: `<div class="actions"><a class="btn primary" href="#/plan/new">＋ Add recurring item</a><a class="btn" href="#/invoices">Invoices</a><a class="btn" href="#/forecast">Forecast</a></div>
      ${sec("in")}${sec("out")}${sec("transfer")}${sec("behalf")}
      ${b.scheds.length ? "" : `<div class="card empty"><p class="muted">No recurring items yet. Load <code>plan-2026-11.json</code> from More › Starter file, or add them one by one.</p></div>`}`,
  };
}
function viewSched(id) {
  const b = book(), isNew = id === "new", s = isNew ? { dir: "out", freq: "monthly", cur: "GBP", start: todayISO() } : b.byId.get(id);
  if (!s) return { title: "Not found", back: "#/plan", html: `<p class="muted">This item no longer exists.</p>` };
  const v = (k, d = "") => (s[k] != null ? s[k] : d);
  const occ = isNew ? [] : occurrences(s, addDays(todayISO(), 400)).filter((o) => o.date >= addDays(todayISO(), -40)).slice(0, 8);
  return {
    title: isNew ? "New recurring item" : "Recurring item", back: "#/plan",
    html: `<form data-form="sched" data-live class="stack form-card" novalidate><input type="hidden" name="id" value="${esc(isNew ? "" : s.id)}">
      ${field("Name", `<input name="name" required value="${esc(v("name"))}" placeholder="e.g. Mortgage, Babylon retainer">`)}
      ${field("What is it?", seg("dir", v("dir"), { in: "Money in", out: "Money out", transfer: "Transfer", behalf: "Paid on my behalf" }))}
      ${amountField("Amount each time", "amount", minorToInput(s.amount), "cur", v("cur", "GBP"))}
      <div class="grid2">${field("How often", `<select name="freq">${Object.entries(FREQ).map(([k, l]) => opt(k, l, k === v("freq"))).join("")}</select>`)}
        ${field("Next date", `<input type="date" name="start" value="${esc(v("start"))}">`, "The next time it's due. Later dates follow on the same day of the month.")}</div>
      <div class="grid2">${field("How many times in total, from that date (optional)", `<input name="count" inputmode="numeric" value="${esc(v("count"))}" placeholder="leave empty if it doesn't end">`)}
        ${field("Or stop on (optional)", `<input type="date" name="end" value="${esc(v("end"))}">`)}</div>
      <details${s.cap != null ? " open" : ""}><summary class="muted small">Instalments towards a total (like the Babylon course)</summary>
        <div class="grid2">${field("Total to collect", `<input name="cap" inputmode="decimal" value="${esc(minorToInput(s.cap))}">`)}${field("Already invoiced before this app", `<input name="capBefore" inputmode="decimal" value="${esc(minorToInput(s.capBefore))}">`)}</div>
        <p class="muted small">The last instalment is reduced so the total is never exceeded.</p></details>
      ${when("dir:in,out,transfer", accountSelect("accountId", v("accountId"), { label: "Account", required: false }))}
      ${when("dir:transfer", accountSelect("toAccountId", v("toAccountId"), { label: "To account", required: false }))}
      ${when("dir:transfer", field("Between your entities, it's", seg("nature", v("nature", "loan"), { loan: "Loan or repayment", salary: "Salary", dividend: "Dividend" })))}
      ${when("dir:in,out,behalf", personSelect("personId", v("personId"), { label: "Person or company", optional: true }))}
      ${when("dir:in,out,behalf", categorySelect("categoryId", v("categoryId"), { label: "Category", first: s.dir === "in" ? "income" : "expense", required: false }))}
      ${entityFields(v("entityId", "ent_personal"), v("divisionId"))}
      ${when("dir:in", `<label class="check"><input type="checkbox" name="invoice"${s.invoice ? " checked" : ""}> I send an invoice for this each time</label>
        ${field("Days from invoice to due date", `<input name="dueDays" inputmode="numeric" value="${esc(v("dueDays", 9))}">`)}`)}
      ${field("Note", `<textarea name="note" rows="2">${esc(v("note"))}</textarea>`)}
      <label class="check"><input type="checkbox" name="paused"${s.paused ? " checked" : ""}> Paused</label>
      ${s.check ? `<label class="check"><input type="checkbox" name="checked"> I've checked these details</label>` : ""}
      <p class="msg err" data-err hidden></p>
      <div class="actions"><button class="btn primary big">Save</button>${isNew ? "" : `<button type="button" class="btn danger" data-act="delSched" data-id="${esc(s.id)}">Delete</button>`}</div>
    </form>
    ${occ.length ? `<section class="card"><div class="card-head"><h2>Coming up</h2></div><div class="list">${occ.map((o) => `<div class="row"><div class="row-main"><div class="row-title">${esc(fmtDate(o.date))}</div><div class="row-sub">${o.done ? "✓ recorded" : o.covered ? "✓ invoiced" : o.date < todayISO() ? "expected, not seen yet" : "expected"}</div></div><div class="row-amt">${money(o.amount, s.cur)}</div></div>`).join("")}</div></section>` : ""}`,
    after: () => initLiveForm($("form[data-form=sched]"), !isNew),
  };
}
function viewInvoices() {
  const b = book();
  const groups = { overdue: [], sent: [], part: [], draft: [], paid: [], cancelled: [] };
  for (const inv of b.invoices) groups[invoiceStatus(inv, b)].push(inv);
  const row = (inv) => { const st = invoiceStatus(inv, b); return `<a class="row" href="#/invoice/${encodeURIComponent(inv.id)}"><div class="row-main"><div class="row-title">${esc(inv.number)} · ${esc(name(inv.personId))}</div>
    <div class="row-sub">${esc(fmtDate(inv.date))} · due ${esc(fmtDate(inv.dueDate))} · ${esc(name(inv.entityId))}</div></div>
    <div class="row-amt"><div>${money(invoiceTotal(inv), inv.cur)}</div><div class="row-sub"><span class="badge ${st === "overdue" ? "warn" : ""}">${STATUS_LABEL[st]}</span></div></div></a>`; };
  const sec = (k, title) => groups[k].length ? `<section class="card"><div class="card-head"><h2>${title}</h2></div><div class="list">${groups[k].map(row).join("")}</div></section>` : "";
  return {
    title: "Invoices",
    html: `${toRaiseCard()}<div class="actions"><a class="btn primary" href="#/invoice/new">＋ New invoice</a><a class="btn" href="#/plan">Recurring items</a></div>
      ${sec("overdue", "Overdue")}${sec("sent", "Sent, waiting for payment")}${sec("part", "Part paid")}${sec("draft", "Drafts")}${sec("paid", "Paid")}${sec("cancelled", "Cancelled")}
      ${b.invoices.length ? "" : `<div class="card empty"><p class="muted">No invoices recorded yet.</p></div>`}`,
  };
}
/** Invoices that should go out this month (and last month, if missed), grouped by client. */
function invoicesToRaise() {
  const b = book(), today = todayISO(), thisM = monthKey(today), lastM = monthKey(addDays(thisM + "-01", -1)), groups = new Map();
  for (const s of b.scheds.filter((x) => x.invoice && x.dir === "in")) {
    for (const o of occurrences(s, addDays(thisM + "-01", 40))) {
      if (o.covered || o.done || (o.period !== thisM && o.period !== lastM)) continue;
      const k = `${s.personId}|${s.entityId}|${o.period}`;
      const g = groups.get(k) || { personId: s.personId, entityId: s.entityId, period: o.period, items: [] };
      g.items.push(o); groups.set(k, g);
    }
  }
  return [...groups.values()];
}
function toRaiseCard() {
  const list = invoicesToRaise();
  if (!list.length) return "";
  return `<section class="card pad banner-card"><h2>Invoices to send</h2>${list.map((g) => {
    const total = g.items.reduce((s, o) => s + o.amount, 0), cur = g.items[0].s.cur;
    return `<div class="row"><div class="row-main"><div class="row-title">${esc(name(g.personId))} · ${esc(fmtMonth(g.period + "-01"))}</div>
      <div class="row-sub">${esc(g.items.map((o) => o.s.name).join(" + "))}</div></div><div class="row-amt">${money(total, cur)}</div>
      <a class="btn small" href="#/invoice/new?client=${encodeURIComponent(g.personId)}&ent=${encodeURIComponent(g.entityId)}&period=${g.period}&scheds=${encodeURIComponent(g.items.map((o) => o.s.id).join(","))}">Create</a></div>`;
  }).join("")}</section>`;
}
function viewInvoice(r) {
  const b = book(), id = (r.a || "").split("?")[0], isNew = id === "new";
  let inv = isNew ? null : b.byId.get(id);
  if (!isNew && !inv) return { title: "Not found", back: "#/invoices", html: `<p class="muted">This invoice no longer exists.</p>` };
  if (isNew) {
    const q = new URLSearchParams(location.hash.split("?")[1] || "");
    const scheds = (q.get("scheds") || "").split(",").map((x) => b.byId.get(x)).filter(Boolean);
    const period = q.get("period") || monthKey(todayISO()), date = period === monthKey(todayISO()) ? todayISO() : period + "-01";
    const first = scheds[0] || {};
    const lines = scheds.map((s) => { const o = occurrences(s, addDays(period + "-01", 40)).find((x) => x.period === period); return { desc: s.name + " · " + fmtMonth(period + "-01"), amount: o ? o.amount : s.amount, schedId: s.id }; });
    inv = { personId: q.get("client") || "", entityId: q.get("ent") || first.entityId || "ent_ha", accountId: first.accountId || "", cur: first.cur || "GBP", date, dueDate: addDays(date, first.dueDays != null ? Number(first.dueDays) : 9),
      number: nextInvoiceNumber(date), lines, vatRate: 0, status: "sent", categoryId: first.categoryId || "", divisionId: first.divisionId || "", period };
  }
  const v = (k, d = "") => (inv[k] != null ? inv[k] : d);
  const lines = [...(inv.lines || [])]; while (lines.length < 4) lines.push({});
  const st = isNew ? null : invoiceStatus(inv, b), paid = isNew ? 0 : invoicePaid(inv, b);
  const pays = (inv.txnIds || []).map((x) => b.byId.get(x)).filter(Boolean);
  const payQ = !isNew ? `#/add/in?account=${encodeURIComponent(inv.accountId || "")}&cur=${inv.cur}&amount=${minorToInput(invoiceTotal(inv) - paid)}&category=${encodeURIComponent(inv.categoryId || "")}&person=${encodeURIComponent(inv.personId || "")}&entityId=${encodeURIComponent(inv.entityId || "")}&divisionId=${encodeURIComponent(inv.divisionId || "")}&invoiceId=${encodeURIComponent(inv.id)}&desc=${encodeURIComponent("Payment of " + inv.number)}` : "";
  return {
    title: isNew ? "New invoice" : "Invoice " + inv.number, back: "#/invoices",
    html: `${!isNew ? `<section class="hero small"><div class="hero-label">${esc(name(inv.personId))} · ${esc(name(inv.entityId))}</div><div class="hero-num">${money(invoiceTotal(inv), inv.cur)}</div>
        <div class="hero-sub"><span class="badge ${st === "overdue" ? "warn" : ""}">${STATUS_LABEL[st]}</span> ${paid ? `· paid ${money(paid, inv.cur)}` : ""} · due ${esc(fmtDate(inv.dueDate))}</div>
        ${pays.length ? `<div class="hero-sub">Payments: ${pays.map((t) => `<a class="link" href="#/txn/${encodeURIComponent(t.id)}">${esc(fmtDate(t.date))}</a>`).join(", ")}</div>` : ""}
        ${inv.replacedBy ? `<div class="hero-sub">Replaced by <a class="link" href="#/invoice/${encodeURIComponent(inv.replacedBy)}">${esc(name(inv.replacedBy))}</a></div>` : ""}</section>
        <div class="actions">${st !== "paid" && st !== "cancelled" ? `<a class="btn primary" href="${payQ}">Record payment</a>` : ""}</div>` : ""}
      <form data-form="invoice" data-live class="stack form-card" novalidate><input type="hidden" name="id" value="${esc(isNew ? "" : inv.id)}"><input type="hidden" name="period" value="${esc(v("period", monthKey(v("date", todayISO()))))}">
        <div class="grid2">${field("Invoice number", `<input name="number" value="${esc(v("number"))}">`)}${field("Status", `<select name="status">${opt("sent", "Sent", v("status") === "sent")}${opt("draft", "Draft (not sent yet)", v("status") === "draft")}${opt("cancelled", "Cancelled / replaced", v("status") === "cancelled")}</select>`)}</div>
        ${personSelect("personId", v("personId"), { label: "Client" })}
        <div class="grid2">${field("Issued by", `<select name="entityId" data-entity>${b.entities.map((e) => opt(e.id, e.name, e.id === v("entityId"))).join("")}</select>`)}${field("Head / division", `<select name="divisionId" data-division data-val="${esc(v("divisionId"))}"></select>`)}</div>
        <div class="grid2">${field("Invoice date", `<input type="date" name="date" value="${esc(v("date"))}">`)}${field("Due date", `<input type="date" name="dueDate" value="${esc(v("dueDate"))}">`)}</div>
        <div class="grid2">${field("Currency", curSelect("cur", v("cur", "GBP")))}${field("VAT", `<select name="vatRate">${opt(0, "No VAT", !inv.vatRate)}${opt(20, "20%", inv.vatRate === 20)}</select>`)}</div>
        ${field("Lines", `<div class="inv-lines">${lines.map((l, i) => `<div class="inv-line"><input name="ld${i}" placeholder="Description" value="${esc(l.desc || "")}"><input name="la${i}" inputmode="decimal" placeholder="0.00" value="${esc(minorToInput(l.amount))}"><input type="hidden" name="ls${i}" value="${esc(l.schedId || "")}"></div>`).join("")}</div>`, "Empty lines are ignored.")}
        ${accountSelect("accountId", v("accountId"), { label: "To be paid into", required: false })}
        ${categorySelect("categoryId", v("categoryId"), { label: "Income category", first: "income", required: false })}
        ${!isNew ? field("Replaced by (optional)", `<select name="replacedBy"><option value="">— none —</option>${b.invoices.filter((x) => x.id !== inv.id).map((x) => opt(x.id, `${x.number} · ${name(x.personId)}`, x.id === inv.replacedBy)).join("")}</select>`, "For invoices re-issued under another entity, like the Synarchy ones.") : ""}
        ${field("Note", `<textarea name="note" rows="2">${esc(v("note"))}</textarea>`)}
        <p class="msg err" data-err hidden></p>
        <div class="actions"><button class="btn primary big">Save</button>${isNew ? "" : `<button type="button" class="btn danger" data-act="delInvoice" data-id="${esc(inv.id)}">Delete</button>`}</div>
      </form>
      <p class="muted small">This records the invoice so payments can be tracked and forecast. It doesn't send anything or create a PDF: keep sending invoices as you do now.</p>`,
    after: () => initLiveForm($("form[data-form=invoice]"), true),
  };
}

/* ================= Inbox: invoices and recurring items ================= */
/** Called by the Inbox: does this statement line pay an invoice, or match a recurring item? */
function planSuggestion(line, b) {
  if (line.amt > 0) {
    for (const inv of b.invoices) {
      const st = invoiceStatus(inv, b);
      if (!["sent", "overdue", "part", "draft"].includes(st) || inv.cur !== line.cur) continue;
      if (invoiceTotal(inv) - invoicePaid(inv, b) !== line.amt) continue;
      const days = (Date.parse(line.date) - Date.parse(inv.date)) / 864e5;
      if (days < -5 || days > 120) continue;
      return { mode: "category", category: inv.categoryId, person: inv.personId, entityId: inv.entityId, divisionId: inv.divisionId, invoiceId: inv.id, label: `Pays invoice ${inv.number} · ${name(inv.personId)}` };
    }
  }
  for (const s of b.scheds) {
    if (s.accountId !== line.accountId || s.cur !== line.cur || (s.dir === "in") !== line.amt > 0 || !["in", "out"].includes(s.dir)) continue;
    const o = occurrences(s, addDays(line.date, 10)).find((x) => !x.done && x.amount === Math.abs(line.amt) && Math.abs(Date.parse(x.cashDate) - Date.parse(line.date)) <= 6 * 864e5);
    if (o) return { mode: s.personId && !s.categoryId ? "person" : "category", category: s.categoryId, person: s.personId, entityId: s.entityId, divisionId: s.divisionId, schedId: s.id, label: `${s.name} (recurring)` };
  }
  return null;
}

/* ================= Forms and actions ================= */
FORMS.sched = async (form, fd) => {
  const errEl = $("[data-err]", form), fail = (m) => { errEl.textContent = m; errEl.hidden = false; };
  const f = Object.fromEntries(fd);
  const amount = parseMoney(f.amount), cap = String(f.cap || "").trim() ? parseMoney(f.cap) : null, capBefore = String(f.capBefore || "").trim() ? parseMoney(f.capBefore) : 0;
  if (!String(f.name || "").trim()) return fail("Give it a name.");
  if (!Number.isFinite(amount) || amount <= 0) return fail("Enter the amount.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.start || "")) return fail("Enter the next date.");
  if (["in", "out", "transfer"].includes(f.dir) && !f.accountId) return fail("Choose the account.");
  if (f.dir === "transfer" && !f.toAccountId) return fail("Choose the account it goes to.");
  if (cap != null && !Number.isFinite(cap)) return fail("Check the total.");
  const old = f.id ? book().byId.get(f.id) : null;
  const rec = {
    ...(old || {}), id: f.id || uid("sch"), kind: "sched", name: f.name.trim(), dir: f.dir, amount, cur: f.cur, freq: f.freq, start: f.start,
    count: String(f.count || "").trim() ? Number(f.count) : null, end: f.end || null, cap, capBefore,
    accountId: f.accountId || null, toAccountId: f.toAccountId || null, personId: f.personId || null, categoryId: f.categoryId || null,
    entityId: f.entityId || "ent_personal", divisionId: f.divisionId || null, nature: f.dir === "transfer" ? f.nature || "loan" : null, invoice: f.invoice === "on" && f.dir === "in", dueDays: Number(f.dueDays || 9),
    note: String(f.note || "").trim(), paused: f.paused === "on",
  };
  if (f.checked === "on") rec.check = false;
  put(rec); toast("Saved"); go("#/plan");
};
FORMS.invoice = async (form, fd) => {
  const errEl = $("[data-err]", form), fail = (m) => { errEl.textContent = m; errEl.hidden = false; };
  const f = Object.fromEntries(fd), lines = [];
  for (let i = 0; i < 4; i++) {
    const d = String(f["ld" + i] || "").trim(), a = String(f["la" + i] || "").trim();
    if (!d && !a) continue;
    const amt = parseMoney(a);
    if (!Number.isFinite(amt)) return fail(`Check the amount on line ${i + 1}.`);
    lines.push({ desc: d, amount: amt, ...(f["ls" + i] ? { schedId: f["ls" + i] } : {}) });
  }
  if (!f.personId) return fail("Choose the client.");
  if (!lines.length) return fail("Add at least one line.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || "")) return fail("Enter the invoice date.");
  const old = f.id ? book().byId.get(f.id) : null;
  const rec = { ...(old || {}), id: f.id || uid("inv"), kind: "invoice", name: f.number, number: String(f.number || "").trim(), status: f.status, personId: f.personId,
    entityId: f.entityId, divisionId: f.divisionId || null, date: f.date, dueDate: f.dueDate || f.date, cur: f.cur, vatRate: Number(f.vatRate || 0), lines,
    accountId: f.accountId || null, categoryId: f.categoryId || null, replacedBy: f.replacedBy || null, note: String(f.note || "").trim(),
    period: f.period || monthKey(f.date), txnIds: (old && old.txnIds) || [] };
  put(rec); toast("Invoice saved"); go("#/invoice/" + encodeURIComponent(rec.id));
};
Object.assign(ACTS, {
  delSched(el) { if (!confirm("Delete this recurring item? Entries already recorded stay.")) return; remove(el.dataset.id); toast("Deleted"); go("#/plan"); },
  delInvoice(el) {
    if (!confirm("Delete this invoice record? Payments already recorded stay.")) return;
    remove(el.dataset.id); toast("Deleted"); go("#/invoices");
  },
});
/** Link a payment entry to its invoice (called after an entry is saved or a statement line is confirmed). */
function linkPayment(txn, invoiceId) {
  const inv = invoiceId && book().byId.get(invoiceId);
  if (!inv || !txn) return;
  put({ ...inv, txnIds: [...new Set([...(inv.txnIds || []), txn.id])] });
}
