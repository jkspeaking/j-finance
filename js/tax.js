"use strict";
/* J Finance: tax estimates and reports.
   Estimates only: the accountants confirm. Rates are kept here, one block per tax year, with where they came from. */

const RATES_CHECKED = "UK rates checked on GOV.UK on 5 Nov 2026. Indian slabs from published summaries of Budget 2026; confirm with your CA.";
const P = (pounds) => Math.round(pounds * 100);
const UK_TAX = {   // keyed by the year the UK tax year starts (6 April)
  2025: { pa: P(12570), taper: P(100000), basic: P(37700), addl: P(125140), rates: [20, 40, 45], divAllow: P(500), div: [8.75, 33.75, 39.35] },
  2026: { pa: P(12570), taper: P(100000), basic: P(37700), addl: P(125140), rates: [20, 40, 45], divAllow: P(500), div: [10.75, 35.75, 39.35] },
};
const CORP_TAX = { small: 19, main: 25, lower: P(50000), upper: P(250000), fraction: 3 / 200 };
const NIC = { employerRate: 15, secondary: P(5000), employeeRate: 8, primary: P(12570), employmentAllowance: P(10500) };
const IN_SLABS = [[P(400000), 0], [P(800000), 5], [P(1200000), 10], [P(1600000), 15], [P(2000000), 20], [P(2400000), 25], [Infinity, 30]];
const IN_CESS = 4;
const YEAR_END = { ent_ha: "03-31", ent_syn: "06-30" };   // company year ends

/* ================= Periods ================= */
const PERIOD_KINDS = { uk: "UK tax year (6 Apr)", co: "Company year (1 Apr)", in: "Indian year (1 Apr)", cal: "Calendar year" };
function currentStart(kind, iso = todayISO()) {
  const [y, m] = iso.split("-").map(Number);
  if (kind === "uk") return taxYearStart(iso);
  if (kind === "cal") return y;
  return m >= 4 ? y : y - 1;
}
function periodRange(kind, y) {
  if (kind === "uk") return [`${y}-04-06`, `${y + 1}-04-05`];
  if (kind === "cal") return [`${y}-01-01`, `${y}-12-31`];
  return [`${y}-04-01`, `${y + 1}-03-31`];
}
const periodLabel = (kind, y) => (kind === "cal" ? String(y) : `${y}-${pad((y + 1) % 100)}`);
const inRange = (d, r) => d >= r[0] && d <= r[1];

/* ================= Totals ================= */
/** Category totals (GBP) for a period, optionally for one entity. Income is shown positive. */
function categoryTotals(range, ent) {
  const b = book(), out = new Map();
  for (const t of b.txns) {
    if (!inRange(t.date, range)) continue;
    for (const l of t.lines) {
      if (l.t !== "c" || (ent && l.ent !== ent)) continue;
      const c = b.byId.get(l.ref), sign = c && c.group === "income" ? -1 : 1;
      const k = l.ref + "|" + (t.divisionId || "");
      out.set(k, (out.get(k) || 0) + sign * l.gbp);
    }
  }
  return out;
}
const NOT_PROFIT = new Set(["cat_vat", "cat_ct", "cat_tax_uk", "cat_tax_in"]);   // tax payments aren't costs for profit
function companyYear(ent, y) {
  const b = book(), end = YEAR_END[ent] || "03-31", [em, ed] = end.split("-").map(Number);
  const startY = em >= 4 ? y : y;   // the year the company year starts in
  const range = em === 3 ? [`${startY}-04-01`, `${startY + 1}-03-31`] : [`${startY}-${pad(em === 12 ? 1 : em + 1)}-01`, `${startY + 1}-${end}`];
  let income = 0, costs = 0, dividends = 0, salaries = 0;
  const lines = [];
  for (const [k, v] of categoryTotals(range, ent)) {
    const [cat] = k.split("|"), c = b.byId.get(cat);
    if (!c || NOT_PROFIT.has(cat)) continue;
    if (c.group === "income") income += v; else costs += v;
    if (cat === CAT.salaries) salaries += v;
    lines.push({ cat, v });
  }
  for (const t of b.txns) if (inRange(t.date, range)) for (const l of t.lines) if (l.t === "q" && l.ref === "dividends" && l.ent === ent) dividends += l.gbp;
  let dla = 0;   // positive: the director owes the company
  for (const t of b.txns) if (t.date <= range[1]) for (const l of t.lines) if (l.t === "q" && l.ent === ent && l.ref === "ic:ent_personal") dla += l.gbp;
  const profit = income - costs;
  return { range, income, costs, profit, ct: corpTax(profit), dividends, salaries, dla, lines };
}
function corpTax(profit) {
  if (profit <= 0) return 0;
  const { lower, upper } = CORP_TAX;
  if (profit <= lower) return symRound(profit * 0.19);
  if (profit >= upper) return symRound(profit * 0.25);
  return symRound(profit * 0.25 - (upper - profit) * CORP_TAX.fraction);
}
/** UK income tax on non-savings income plus dividends (England), in whole pence. */
function ukTax(year, nonSav, div) {
  const R = UK_TAX[year] || UK_TAX[2026];
  let pa = R.pa;
  const total = nonSav + div;
  if (total > R.taper) pa = Math.max(0, pa - Math.floor((total - R.taper) / 2));
  const ns = Math.max(0, nonSav - pa), paLeft = Math.max(0, pa - nonSav), divT = Math.max(0, div - paLeft);
  const bands = [[R.basic, 0], [R.addl, 1], [Infinity, 2]];
  const bandTax = (from, amount, rates) => {
    let tax = 0, pos = from, left = amount;
    for (const [top, i] of bands) { if (left <= 0) break; if (pos >= top) continue; const take = Math.min(left, top - pos); tax += (take * rates[i]) / 100; pos += take; left -= take; }
    return tax;
  };
  const allowance = Math.min(R.divAllow, divT);
  const nsTax = bandTax(0, ns, R.rates);
  const divTax = bandTax(ns + allowance, divT - allowance, R.div);
  return { pa, nsTax: Math.round(nsTax), divTax: Math.round(divTax), total: Math.round(nsTax + divTax) };
}
/** Dividends someone can take before reaching the higher rate, given their salary. */
function basicRateRoom(year, salary) {
  const R = UK_TAX[year] || UK_TAX[2026];
  return Math.max(0, R.pa + R.basic - salary);
}
function indiaTax(incomeINR) {
  let tax = 0, prev = 0;
  for (const [top, r] of IN_SLABS) { if (incomeINR <= prev) break; tax += ((Math.min(incomeINR, top) - prev) * r) / 100; prev = top; }
  return Math.round(tax * (1 + IN_CESS / 100));
}
const INR_PER_GBP = () => (S.rates && S.rates.INR) || null;
/** Your personal position for a UK tax year: salary, dividends, Indian income, and tax estimates. */
function personalYear(y) {
  const b = book(), ukR = periodRange("uk", y);
  let salary = 0, dividends = 0, other = 0, indianGBP = 0, tdsGBP = 0;
  for (const t of b.txns) {
    if (!inRange(t.date, ukR)) continue;
    for (const l of t.lines) {
      if (l.t !== "c" || l.ent !== "ent_personal") continue;
      const c = b.byId.get(l.ref);
      if (l.ref === CAT.salaryIn) salary -= l.gbp;
      else if (l.ref === CAT.dividendIn) dividends -= l.gbp;
      else if (l.ref === CAT.tds) tdsGBP += l.gbp;
      else if (c && c.group === "income" && l.ref !== "cat_refund") {
        if (l.cur === "INR" || t.divisionId === "div_p_in") indianGBP -= l.gbp; else other -= l.gbp;
      }
    }
  }
  const withIndia = ukTax(y, salary + other + indianGBP, dividends), without = ukTax(y, salary + other, dividends);
  return { y, salary, dividends, other, indianGBP, tdsGBP, uk: withIndia, ukWithoutIndia: without, credit: Math.min(withIndia.total - without.total, tdsGBP) };
}
function indiaYear(y) {
  const b = book(), r = periodRange("in", y), inr = INR_PER_GBP();
  let income = 0, tds = 0;
  for (const t of b.txns) {
    if (!inRange(t.date, r)) continue;
    for (const l of t.lines) {
      if (l.t !== "c" || l.ent !== "ent_personal") continue;
      const c = b.byId.get(l.ref);
      const inINR = l.cur === "INR" ? l.amt : inr ? symRound(l.gbp * inr) : 0;
      if (l.ref === CAT.tds) tds += inINR;
      else if (c && c.group === "income" && (l.cur === "INR" || t.divisionId === "div_p_in")) income -= inINR;
    }
  }
  const tax = indiaTax(income);
  return { y, range: r, income, tds, tax, balance: tax - tds };
}
// Hotel Alchemyst left VAT on vatUntil (e.g. "2026-03-31"); no quarters after that date.
const vatUntil = () => (book().byId.get("ent_ha") || {}).vatUntil || "";
function vatQuarters(y) {
  const b = book(), out = [], until = vatUntil();
  const ends = [`${y}-06-30`, `${y}-09-30`, `${y}-12-31`, `${y + 1}-03-31`];
  let start = `${y}-04-01`;
  for (const end of ends) {
    let vat = 0, net = 0;
    for (const inv of b.invoices) {
      if (inv.entityId !== "ent_ha" || inv.status === "cancelled" || !inRange(inv.date, [start, end]) || !inv.vatRate) continue;
      const n = (inv.lines || []).reduce((s, l) => s + (l.amount || 0), 0); net += n; vat += symRound((n * inv.vatRate) / 100);
    }
    const due = addDays(addMonthsKeepDay(end, 1, 31), 7);
    if (!until || start <= until) out.push({ start, end, due, vat, net });
    start = addDays(end, 1);
  }
  return out;
}
function deadlines() {
  const today = todayISO(), y = currentStart("co"), list = [];
  const add = (date, what, who) => { if (date >= addDays(today, -30) && date <= addDays(today, 400)) list.push({ date, what, who }); };
  for (const yy of [y - 1, y]) {
    const ye = `${yy + 1}-03-31`;
    add(addMonthsKeepDay(ye, 9, 31), `Hotel Alchemyst accounts to ${fmtDate(ye)} due at Companies House`, "Hunt Ford");
    add(addDays(addMonthsKeepDay(ye, 9, 31), 1), `Hotel Alchemyst corporation tax for the year to ${fmtDate(ye)} due`, "Pay HMRC");
    add(addMonthsKeepDay(ye, 12, 31), `Hotel Alchemyst corporation tax return (CT600) for the year to ${fmtDate(ye)} due`, "Hunt Ford");
    for (const q of vatQuarters(yy)) add(q.due, `VAT return and payment for the quarter to ${fmtDate(q.end)}`, "Hunt Ford");
    add(`${yy + 1}-03-31`, "Synarchy Partners accounts to 30 June due (if not closed)", "Hunt Ford");
  }
  const ty = currentStart("uk");
  for (const t of [ty - 1, ty]) {
    add(`${t + 2}-01-31`, `Self Assessment for ${periodLabel("uk", t)}: return and balance due (and 1st payment on account for the next year)`, "Hunt Ford / you");
    add(`${t + 2}-07-31`, `2nd payment on account for ${periodLabel("uk", t + 1)}`, "You");
    add(`${t + 1}-07-31`, `Indian income tax return for FY ${periodLabel("in", t)} (usual date for non-audit cases)`, "Your CA");
  }
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

/* ================= Tax screen ================= */
function viewTax(r) {
  // Until the last year's accounts are due (31 Dec), open on that year: it's the one being filed.
  const b = book(), coY = r.a ? Number(r.a) : todayISO() <= `${currentStart("co")}-12-31` ? currentStart("co") - 1 : currentStart("co");
  const ha = companyYear("ent_ha", coY);
  const ent = b.byId.get("ent_ha") || {};
  const shareSusan = ent.shareSusan != null ? ent.shareSusan : 51, shareJay = 100 - shareSusan;
  const reserves = ent.reservesBF || 0;
  const available = Math.max(0, reserves + ha.profit - ha.ct - ha.dividends);
  const ty = currentStart("uk"), me = personalYear(ty), salaryEach = P(12000);
  const room = basicRateRoom(ty, salaryEach);
  const inY = currentStart("in"), ind = indiaYear(inY), inr = INR_PER_GBP();
  const vq = vatQuarters(currentStart("co"));
  const vatNow = vq.find((q) => inRange(todayISO(), [q.start, q.end])) || { vat: 0 };
  const setAside = [
    { label: `Corporation tax ${periodLabel("co", coY)} (est.)`, v: ha.ct },
    ...(vq.length ? [{ label: `VAT on invoices this quarter`, v: vatNow.vat }] : []),
    { label: `Your UK tax ${periodLabel("uk", ty)} (est.)`, v: Math.max(0, me.uk.total - me.credit) },
    { label: `Indian tax still due FY ${periodLabel("in", inY)} (est.)`, v: inr ? Math.max(0, symRound(ind.balance / inr)) : 0 },
  ];
  const plan = (pd) => {
    const s = symRound((pd * shareSusan) / 100), j = pd - s;
    const tS = ukTax(ty, salaryEach, s), tJ = ukTax(ty, salaryEach + me.other + me.indianGBP, j), tJ0 = ukTax(ty, salaryEach + me.other + me.indianGBP, 0);
    return { s, j, taxS: tS.divTax, taxJ: tJ.total - tJ0.total };
  };
  const proposed = S.divPlan != null ? S.divPlan : available;
  const pl = plan(proposed);
  const dl = deadlines().slice(0, 12);
  const row = (label, v, cls = "", sub = "") => `<tr><td>${label}${sub ? `<div class="muted small">${sub}</div>` : ""}</td><td class="r ${cls}">${money(v, "GBP")}</td></tr>`;
  const haTable = (h, title) => `<table class="tbl full"><thead><tr><th>${title}</th><th class="r">GBP</th></tr></thead><tbody>
      ${row("Income", h.income)}${row("Costs", -h.costs, "", h.salaries ? `includes salaries ${money(h.salaries, "GBP")}` : "")}${row("<b>Profit</b>", h.profit)}
      ${row("Corporation tax (estimate)", -h.ct, "", h.profit > CORP_TAX.lower ? "with marginal relief between £50k and £250k" : "19% small profits rate")}
      ${row("Dividends paid", -h.dividends)}
      ${row("Director's loan at year end", -h.dla, h.dla > 0 ? "neg" : "", h.dla > 0 ? "you owe the company" : h.dla < 0 ? "the company owes you" : "")}</tbody></table>`;
  return {
    title: "Tax",
    html: `<p class="msg">Estimates to plan with, not tax advice. Hunt Ford and your CA confirm the real figures. ${esc(RATES_CHECKED)}</p>
      <section class="card"><div class="card-head"><h2>Set aside</h2><span class="card-total">${money(setAside.reduce((s, x) => s + x.v, 0), "GBP")}</span></div>
        <div class="list">${setAside.map((x) => `<div class="row"><div class="row-main"><div class="row-title">${esc(x.label)}</div></div><div class="row-amt">${money(x.v, "GBP")}</div></div>`).join("")}</div></section>
      <div class="cols"><div class="col">
      <section class="card"><div class="card-head"><h2>Hotel Alchemyst</h2><div class="seg-mini"><a class="link" href="#/tax/${coY - 1}">‹ ${periodLabel("co", coY - 1)}</a> <b>${periodLabel("co", coY)}</b> <a class="link" href="#/tax/${coY + 1}">${periodLabel("co", coY + 1)} ›</a></div></div>
        <div class="pad-x tbl-wrap">${haTable(ha, "Year to " + fmtDate(ha.range[1]))}</div>
        ${ha.dla > P(10000) ? `<p class="pad msg err">You owe the company ${money(ha.dla, "GBP")} at the year end. Unless it's repaid or dealt with within 9 months, the company pays extra tax on it. See issues log item 5.</p>` : ""}
        <p class="pad muted small">Only as complete as what's recorded for the year. Ignores associated companies and capital allowances.</p></section>
      <section class="card pad"><h2>Dividend planner ${periodLabel("uk", ty)}</h2>
        <form data-form="divPlan" class="stack">
          <div class="grid2">${field("Available after tax", `<input readonly value="${esc(money(available, "GBP"))}">`, reserves ? "" : "Add profits kept from earlier years below.")}
            ${field("Dividend to pay", `<input name="amount" inputmode="decimal" value="${esc(minorToInput(proposed))}">`)}</div>
          <div class="grid2">${field("Susan's shares (%)", `<input name="share" inputmode="numeric" value="${shareSusan}">`, `You: ${shareJay}%`)}
            ${field("Profits kept from earlier years", `<input name="reserves" inputmode="decimal" value="${esc(minorToInput(reserves))}">`, "From the last accounts.")}</div>
          <button class="btn">Recalculate</button></form>
        <table class="tbl full"><thead><tr><th></th><th class="r">Susan</th><th class="r">You</th></tr></thead><tbody>
          <tr><td>Dividend</td><td class="r">${money(pl.s, "GBP")}</td><td class="r">${money(pl.j, "GBP")}</td></tr>
          <tr><td>Extra personal tax (est.)</td><td class="r">${money(pl.taxS, "GBP")}</td><td class="r">${money(pl.taxJ, "GBP")}</td></tr>
          <tr><td>Before the higher rate</td><td class="r" colspan="2">each of you can take about <b>${money(room, "GBP", true)}</b> in dividends this year with a £12,000 salary${me.indianGBP + me.other ? ", less your other income" : ""}</td></tr></tbody></table>
        <p class="muted small">Dividends follow the shareholding on the day they're paid, and must be declared properly. Dividend rates for ${periodLabel("uk", ty)}: ${UK_TAX[ty] ? UK_TAX[ty].div.slice(0, 2).join("% and ") + "%" : ""}.</p></section>
      </div><div class="col">
      <section class="card"><div class="card-head"><h2>You, UK ${periodLabel("uk", ty)}</h2></div><div class="pad-x tbl-wrap"><table class="tbl full"><tbody>
        ${row("Salary", me.salary)}${row("Dividends", me.dividends)}${row("Indian income (in GBP)", me.indianGBP, "", "taxable in the UK too, with credit for Indian tax")}${me.other ? row("Other income", me.other) : ""}
        ${row("UK tax before credit (est.)", me.uk.total)}${row("Credit for Indian tax (TDS so far)", -me.credit)}${row("<b>UK tax to pay (est.)</b>", Math.max(0, me.uk.total - me.credit))}</tbody></table></div>
        <p class="pad muted small">Due 31 January ${ty + 2}, plus payments on account if the bill is over £1,000.</p></section>
      <section class="card"><div class="card-head"><h2>India FY ${periodLabel("in", inY)}</h2></div><div class="pad-x tbl-wrap"><table class="tbl full"><tbody>
        <tr><td>Indian income</td><td class="r">${money(ind.income, "INR")}</td></tr><tr><td>Tax (new regime, no rebate as a non-resident, incl. 4% cess)</td><td class="r">${money(ind.tax, "INR")}</td></tr>
        <tr><td>TDS already deducted</td><td class="r">${money(-ind.tds, "INR")}</td></tr><tr><td><b>${ind.balance >= 0 ? "Still to pay (est.)" : "Refund due (est.)"}</b></td><td class="r">${money(Math.abs(ind.balance), "INR")}</td></tr></tbody></table></div>
        <p class="pad muted small">Your CA decides residency, the regime and what counts. Match TDS to Form 26AS.</p></section>
      ${!vq.length ? `<section class="card pad"><h2>VAT</h2><p class="muted small">Hotel Alchemyst left VAT on ${esc(fmtDate(vatUntil()))}. No VAT returns are due after that.</p></section>` : `<section class="card"><div class="card-head"><h2>VAT quarters ${periodLabel("co", currentStart("co"))}</h2></div><div class="pad-x tbl-wrap"><table class="tbl full"><thead><tr><th>Quarter to</th><th class="r">VAT on invoices</th><th class="r">Due</th></tr></thead><tbody>
        ${vq.map((q) => `<tr><td>${esc(fmtDate(q.end))}</td><td class="r">${money(q.vat, "GBP")}</td><td class="r">${esc(fmtDate(q.due))}</td></tr>`).join("")}</tbody></table></div>
        <p class="pad muted small">Only VAT charged on invoices recorded here (UK clients such as LEXeFISCAL). VAT you can reclaim on costs isn't tracked.</p></section>`}
      </div></div>
      <section class="card"><div class="card-head"><h2>Deadlines</h2></div><div class="list">${dl.map((d) => `<div class="row"><div class="row-main"><div class="row-title">${esc(d.what)}</div><div class="row-sub">${esc(d.who)}</div></div><div class="row-amt ${d.date < todayISO() ? "neg" : ""}">${esc(fmtDate(d.date))}</div></div>`).join("")}</div></section>`,
  };
}
FORMS.divPlan = async (form, fd) => {
  const amount = parseMoney(fd.get("amount")), share = Number(fd.get("share")), reserves = String(fd.get("reserves") || "").trim() ? parseMoney(fd.get("reserves")) : 0;
  if (!Number.isFinite(amount) || amount < 0) return toast("Check the dividend amount.", true);
  if (!(share >= 0 && share <= 100)) return toast("Shares should be between 0 and 100.", true);
  if (!Number.isFinite(reserves)) return toast("Check the earlier profits.", true);
  S.divPlan = amount;
  const ent = book().byId.get("ent_ha");
  if (ent && (ent.shareSusan !== share || (ent.reservesBF || 0) !== reserves)) put({ ...ent, shareSusan: share, reservesBF: reserves });
  renderApp();
};

/* ================= Reports ================= */
let REP = { kind: "uk", y: null, ent: "" };
function viewReports() {
  const b = book();
  if (REP.y == null) REP.y = currentStart(REP.kind);
  const range = periodRange(REP.kind, REP.y);
  const tot = categoryTotals(range, REP.ent || null);
  const byCat = new Map(), byDiv = new Map();
  for (const [k, v] of tot) { const [cat, div] = k.split("|"); byCat.set(cat, (byCat.get(cat) || 0) + v); const dk = div || "—"; const c = b.byId.get(cat); const d = byDiv.get(dk) || { in: 0, out: 0 }; if (c && c.group === "income") d.in += v; else d.out += v; byDiv.set(dk, d); }
  const cats = [...byCat].map(([id, v]) => ({ c: b.byId.get(id), v })).filter((x) => x.c && x.v);
  const inc = cats.filter((x) => x.c.group === "income").sort((a, c) => c.v - a.v), exp = cats.filter((x) => x.c.group !== "income").sort((a, c) => c.v - a.v);
  const sum = (arr) => arr.reduce((s, x) => s + x.v, 0);
  const catRows = (arr) => arr.map((x) => `<tr><td>${esc(x.c.name)}</td><td class="r">${money(x.v, "GBP")}</td></tr>`).join("");
  const months = Math.max(1, Math.round((Math.min(Date.parse(range[1]), Date.parse(todayISO())) - Date.parse(range[0])) / (30.44 * 864e5)));
  const budgets = b.budgets.map((bu) => ({ bu, c: b.byId.get(bu.categoryId), actual: byCat.get(bu.categoryId) || 0, plan: bu.monthly * months }));
  // Net worth today
  let cash = 0, pension = 0, debts = 0, owed = 0, owe = 0;
  for (const a of b.accounts) { const g = balGBP(b.acctBal.get(a.id)).total; if (a.type === "pension") pension += g; else if (a.type === "loan" || a.type === "card") debts += g; else cash += g; }
  for (const [, bal] of b.personBal) for (const [c, v] of Object.entries(bal)) { const g = toGBP(v, c) || 0; if (g > 0) owed += g; else owe += g; }
  const people = b.people.map((p) => { const bal = b.personBal.get(p.id) || {}; const g = Object.entries(bal).reduce((s, [c, v]) => s + (toGBP(v, c) || 0), 0); const last = (b.personTx.get(p.id) || [])[0]; return { p, bal, g, last }; }).filter((x) => x.g).sort((a, c) => c.g - a.g);
  const openInv = b.invoices.filter((i) => ["sent", "overdue", "part"].includes(invoiceStatus(i, b)));
  const years = []; for (let y = currentStart(REP.kind) - 2; y <= currentStart(REP.kind); y++) years.push(y);
  return {
    title: "Reports",
    html: `<div class="filters"><select data-rep="kind">${Object.entries(PERIOD_KINDS).map(([k, l]) => opt(k, l, k === REP.kind)).join("")}</select>
        <select data-rep="y">${years.map((y) => opt(y, periodLabel(REP.kind, y), y === REP.y)).join("")}</select>
        <select data-rep="ent"><option value="">All entities</option>${b.entities.map((e) => opt(e.id, e.name, e.id === REP.ent)).join("")}</select>
        <button class="btn" data-act="exportCsv">Export CSV</button></div>
      <p class="muted small">${esc(fmtDate(range[0]))} to ${esc(fmtDate(range[1]))}. Amounts in GBP at each entry's own exchange rate.</p>
      <section class="card"><div class="kpis"><div><div class="kpi-label">Income</div><div class="kpi">${money(sum(inc), "GBP")}</div></div>
        <div><div class="kpi-label">Spending</div><div class="kpi">${money(sum(exp), "GBP")}</div></div><div><div class="kpi-label">Net</div><div class="kpi ${signCls(sum(inc) - sum(exp))}">${money(sum(inc) - sum(exp), "GBP")}</div></div></div></section>
      <div class="cols"><div class="col">
        <section class="card"><div class="card-head"><h2>Income by category</h2></div><div class="pad-x tbl-wrap"><table class="tbl full"><tbody>${catRows(inc) || `<tr><td class="muted">None</td></tr>`}</tbody></table></div></section>
        <section class="card"><div class="card-head"><h2>Spending by category</h2></div><div class="pad-x tbl-wrap"><table class="tbl full"><tbody>${catRows(exp) || `<tr><td class="muted">None</td></tr>`}</tbody></table></div></section>
        <section class="card"><div class="card-head"><h2>By head / division</h2></div><div class="pad-x tbl-wrap"><table class="tbl full"><thead><tr><th></th><th class="r">Income</th><th class="r">Spending</th><th class="r">Net</th></tr></thead><tbody>
          ${[...byDiv].sort((a, c) => (c[1].in - c[1].out) - (a[1].in - a[1].out)).map(([d, x]) => `<tr><td>${esc(d === "—" ? "Not set" : name(d))}</td><td class="r">${money(x.in, "GBP")}</td><td class="r">${money(x.out, "GBP")}</td><td class="r">${money(x.in - x.out, "GBP")}</td></tr>`).join("")}</tbody></table></div></section>
      </div><div class="col">
        <section class="card"><div class="card-head"><h2>Net worth today</h2><span class="card-total">${money(cash + pension + debts + owed + owe, "GBP")}</span></div><div class="pad-x tbl-wrap"><table class="tbl full"><tbody>
          <tr><td>Cash and bank</td><td class="r">${money(cash, "GBP")}</td></tr><tr><td>Pension</td><td class="r">${money(pension, "GBP")}</td></tr>
          <tr><td>Cards and loans</td><td class="r">${money(debts, "GBP")}</td></tr><tr><td>Owed to you</td><td class="r">${money(owed, "GBP")}</td></tr><tr><td>You owe</td><td class="r">${money(owe, "GBP")}</td></tr></tbody></table></div>
          <p class="pad muted small">Across all entities. Money between your own entities cancels out. Enter mortgage and pension balances for a true figure.</p></section>
        <section class="card"><div class="card-head"><h2>Who owes what</h2></div><div class="list">${people.map((x) => `<a class="row" href="#/person/${encodeURIComponent(x.p.id)}"><div class="row-main"><div class="row-title">${esc(x.p.name)}</div><div class="row-sub">${x.g > 0 ? "owes you" : "you owe"}${x.last ? " · last entry " + esc(fmtDate(x.last.date)) : ""}</div></div><div class="row-amt ${signCls(x.g)}">${balText(x.bal)}</div></a>`).join("") || `<p class="muted pad">Nobody.</p>`}
          ${openInv.map((i) => { const days = Math.round((Date.parse(todayISO()) - Date.parse(i.dueDate)) / 864e5); return `<a class="row" href="#/invoice/${encodeURIComponent(i.id)}"><div class="row-main"><div class="row-title">Invoice ${esc(i.number)} · ${esc(name(i.personId))}</div><div class="row-sub">${days > 0 ? `${days} days overdue` : `due ${esc(fmtDate(i.dueDate))}`}</div></div><div class="row-amt">${money(invoiceTotal(i) - invoicePaid(i, b), i.cur)}</div></a>`; }).join("")}</div></section>
        <section class="card"><div class="card-head"><h2>Budgets</h2></div><div class="pad-x tbl-wrap"><table class="tbl full"><thead><tr><th></th><th class="r">Budget</th><th class="r">Actual</th><th></th></tr></thead><tbody>
          ${budgets.map((x) => `<tr><td>${esc(x.c ? x.c.name : "?")}<div class="muted small">${money(x.bu.monthly, "GBP")} a month × ${months}</div></td><td class="r">${money(x.plan, "GBP")}</td><td class="r ${x.actual > x.plan ? "neg" : ""}">${money(x.actual, "GBP")}</td><td><button class="btn small ghost" data-act="delBudget" data-id="${esc(x.bu.id)}" aria-label="Remove budget">×</button></td></tr>`).join("") || `<tr><td class="muted" colspan="4">No budgets. You said only software needs one.</td></tr>`}</tbody></table></div>
          <form data-form="budget" class="pad stack"><div class="grid2">${categorySelect("categoryId", "cat_software", { label: "Category", required: false })}${field("Monthly budget (GBP)", `<input name="monthly" inputmode="decimal" placeholder="0.00">`)}</div><button class="btn">Add budget</button></form></section>
      </div></div>`,
  };
}
app.addEventListener("change", (e) => {
  const el = e.target.closest("[data-rep]");
  if (!el) return;
  const k = el.dataset.rep;
  REP[k] = k === "y" ? Number(el.value) : el.value;
  if (k === "kind") REP.y = currentStart(REP.kind);
  renderApp();
});
FORMS.budget = async (form, fd) => {
  const m = parseMoney(fd.get("monthly"));
  if (!fd.get("categoryId") || !Number.isFinite(m) || m <= 0) return toast("Choose a category and a monthly amount.", true);
  put({ id: uid("bud"), kind: "budget", categoryId: fd.get("categoryId"), monthly: m, name: "Budget" });
  toast("Budget added");
};
Object.assign(ACTS, {
  delBudget(el) { remove(el.dataset.id); toast("Budget removed"); },
  exportCsv() {
    const range = periodRange(REP.kind, REP.y), rows = txnRows(range, REP.ent || null);
    downloadText(`j-finance-${periodLabel(REP.kind, REP.y)}${REP.ent ? "-" + name(REP.ent).replace(/\s+/g, "-") : ""}.csv`, toCSV(rows), "text/csv");
  },
});
/** One row per category or person line: what the accountant needs. */
function txnRows(range, ent) {
  const b = book(), rows = [["Date", "Description", "Entity", "Head / division", "Category or person", "Type", "Amount", "Currency", "GBP", "Rate", "Account", "Tags", "Receipts", "Note"]];
  for (const t of [...b.txns].reverse()) {
    if (!inRange(t.date, range)) continue;
    const accs = t.lines.filter((l) => l.t === "a").map((l) => name(l.ref)).join(" → ");
    const nRec = (b.receipts || []).filter((r) => r.txnId === t.id).length;
    for (const l of t.lines) {
      if (l.t === "a" || (ent && l.ent !== ent)) continue;
      const what = l.t === "q" ? (l.ref === "opening" ? "Opening balance" : l.ref === "dividends" ? "Dividends paid" : "Owed between entities: " + name(l.ref.slice(3))) : name(l.ref);
      rows.push([t.date, t.desc, name(l.ent), t.divisionId ? name(t.divisionId) : "", what, TYPE_LABEL[t.type] || t.type, (l.amt / 100).toFixed(2), l.cur, (l.gbp / 100).toFixed(2), l.rate, accs, (t.tags || []).join(" "), nRec, t.note || ""]);
    }
  }
  return rows;
}
const toCSV = (rows) => rows.map((r) => r.map((v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\r\n") + "\r\n";
function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
