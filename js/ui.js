"use strict";
/* J Finance: screens. Everything is drawn from S and book() in core.js. */

const app = document.getElementById("app");
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TYPES = {
  in: { label: "Money in", hint: "A payment into one of your accounts", icon: "↓" },
  out: { label: "Money out", hint: "A payment or spending from one of your accounts", icon: "↑" },
  transfer: { label: "Transfer", hint: "Between your own accounts, including salary or dividends from the company", icon: "⇄" },
  behalf: { label: "Paid on my behalf", hint: "Someone paid a third person for you. None of your accounts moved", icon: "↪" },
  iou: { label: "Owed", hint: "Someone owes you, or you owe them", icon: "≈" },
  opening: { label: "Opening balance", hint: "The starting balance of an account or a person", icon: "◎" },
};
const ACCOUNT_TYPES = { bank: "Bank account", wallet: "Wise / wallet", card: "Credit card", cash: "Cash", pension: "Pension", loan: "Loan or mortgage", other: "Other" };
const CASH_TYPES = new Set(["bank", "wallet", "card", "cash"]);
const PERSON_GROUPS = { family: "Family", client: "Client", partner: "Partner", supplier: "Supplier", tax: "Tax authority", other: "Other" };
const ENTITY_TYPES = { personal: "Personal", company: "Limited company", llp: "LLP" };
const TAGS = { deductible: "Tax-deductible", reimburse: "To reimburse", receipt: "Needs receipt" };

/* ================= Routing ================= */
function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map((p) => decodeURIComponent(p));
  return { name: parts[0] || "home", a: parts[1] || null, b: parts[2] || null, c: parts[3] || null };
}
const go = (h) => { if (location.hash === h) render(); else location.hash = h; };
/** Don't redraw under someone who's filling in a form or typing a search. */
const isBusy = () => !!document.querySelector(".content form[data-form]") || !!(document.activeElement && document.activeElement.closest && document.activeElement.closest(".content input, .content select, .content textarea"));

/* ================= Toasts ================= */
let toastT = 0;
function toast(text, err) {
  const el = document.getElementById("toast");
  el.textContent = text; el.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (el.className = "toast"), 2600);
}

/* ================= Formatting ================= */
const name = (id) => { const x = book().byId.get(id); return x ? x.name : "—"; };
const signCls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
/** Balances like { GBP: 1200, INR: 450000 } as "£12.00 · ₹4,500.00". */
function balText(bal, fallbackCur) {
  const parts = Object.entries(bal || {}).filter(([, v]) => v !== 0).map(([c, v]) => money(v, c));
  return parts.length ? parts.join(" · ") : money(0, fallbackCur || "GBP");
}
function balGBP(bal) {
  let total = 0, missing = false;
  for (const [c, v] of Object.entries(bal || {})) { const g = toGBP(v, c); if (g == null) missing = true; else total += g; }
  return { total, missing };
}
const relTime = (ms) => {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return fmtDate(isoOf(new Date(ms)));
};
function syncText() {
  if (!S.online) return { cls: "warn", text: `Offline · ${S.dirty.size ? "changes waiting" : "up to date"}` };
  if (S.syncing) return { cls: "", text: "Syncing…" };
  if (S.syncError) return { cls: "err", text: S.syncError };
  if (S.dirty.size) return { cls: "", text: "Changes waiting to sync" };
  return { cls: "ok", text: "Synced " + relTime(S.lastSyncAt) };
}
function updateStatus() {
  const t = syncText();
  for (const el of $$("[data-sync]")) {
    el.classList.remove("ok", "warn", "err");
    if (t.cls) el.classList.add(t.cls);
    el.innerHTML = `<span class="dot"></span><span>${esc(t.text)}</span>${S.syncError ? ` <button class="link" data-act="sync">Retry</button>` : ""}`;
  }
}

/* ================= Field builders ================= */
const opt = (v, label, sel, extra = "") => `<option value="${esc(v)}"${sel ? " selected" : ""}${extra}>${esc(label)}</option>`;
function accountSelect(nm, val, { label = "Account", required = true } = {}) {
  const b = book();
  const groups = b.entities.map((e) => {
    const accs = b.accounts.filter((a) => a.entityId === e.id && (!a.archived || a.id === val));
    return accs.length ? `<optgroup label="${esc(e.name)}">${accs.map((a) => opt(a.id, a.name, a.id === val, ` data-ent="${esc(a.entityId)}" data-curs="${esc(a.currencies.join(","))}"`)).join("")}</optgroup>` : "";
  }).join("");
  return field(label, `<select name="${nm}" data-account${required ? " required" : ""}><option value="">Choose…</option>${groups}</select>`);
}
function categorySelect(nm, val, { label = "Category", first = "expense", required = true } = {}) {
  const b = book();
  const grp = (g, title) => {
    const cs = b.categories.filter((c) => c.group === g && (!c.archived || c.id === val));
    return cs.length ? `<optgroup label="${title}">${cs.map((c) => opt(c.id, c.name, c.id === val)).join("")}</optgroup>` : "";
  };
  const order = first === "income" ? [grp("income", "Income"), grp("expense", "Spending")] : [grp("expense", "Spending"), grp("income", "Income")];
  return field(label, `<select name="${nm}"${required ? " required" : ""}><option value="">Choose…</option>${order.join("")}</select>`);
}
function personSelect(nm, val, { label = "Person", optional = false } = {}) {
  const b = book();
  const ps = b.people.filter((p) => !p.archived || p.id === val);
  return field(label, `<select name="${nm}" data-person><option value="">${optional ? "— none —" : "Choose…"}</option>${ps.map((p) => opt(p.id, p.name, p.id === val)).join("")}<option value="__new">＋ New person…</option></select>`);
}
function entityFields(entVal, divVal) {
  const b = book();
  return `<div class="grid2">${field("Belongs to", `<select name="entityId" data-entity>${b.entities.map((e) => opt(e.id, e.name, e.id === entVal)).join("")}</select>`)}
    ${field("Head / division", `<select name="divisionId" data-division data-val="${esc(divVal || "")}"></select>`)}</div>`;
}
function curSelect(nm, val, list = CURRENCIES, attrs = "") {
  return `<select name="${nm}" class="cur" ${attrs}>${list.map((c) => opt(c, c, c === val)).join("")}</select>`;
}
function amountField(label, nm, val, curName, curVal, { curOf = "", hint = "" } = {}) {
  return field(label, `<div class="amt-in">${curSelect(curName, curVal, CURRENCIES, curOf ? `data-cur-of="${curOf}"` : "")}<input name="${nm}" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(val || "")}"></div>`, hint);
}
function rateField(nm, curName, val) {
  return `<div class="rate" data-rate-of="${curName}" data-rate-name="${nm}" hidden>
    ${field("Exchange rate (1 GBP =)", `<input name="${nm}" inputmode="decimal" autocomplete="off" value="${esc(val || "")}">`, `<span data-rate-hint>Leave empty to use the day's rate.</span>`)}</div>`;
}
function field(label, control, hint = "") {
  return `<label class="field"><span class="lbl">${esc(label)}</span>${control}${hint ? `<span class="hint">${hint}</span>` : ""}</label>`;
}
function seg(nm, val, choices) {
  return `<div class="seg" role="radiogroup">${Object.entries(choices).map(([v, l]) => `<label><input type="radio" name="${nm}" value="${esc(v)}"${v === val ? " checked" : ""}><span>${esc(l)}</span></label>`).join("")}</div>`;
}
// Currency colours from the brand pill: £ purple, ₹ orange, € blue (USD has none, so it gets a neutral dot).
const curDot = (c) => `<i class="cur-dot cur-${esc(String(c).toLowerCase())}" aria-hidden="true"></i>`;
const curTags = (list) => `<span class="cur-tags">${(list || []).map((c) => `<span>${curDot(c)}${esc(c)}</span>`).join("")}</span>`;
const when = (cond, html) => `<div data-when="${cond}">${html}</div>`;

/* ================= Main render ================= */
function render() {
  if (S.phase === "start") { app.innerHTML = `<div class="center"><div class="spinner"></div></div>`; return; }
  if (S.phase === "connect") return renderConnect();
  if (S.phase === "create") return renderCreate();
  if (S.phase === "recovery") return renderRecovery();
  if (S.phase === "unlock") return renderUnlock();
  renderApp();
}
function renderSoft(dataChanged) {
  if (S.phase !== "app") return;
  if (dataChanged && !isBusy()) renderApp(); else updateStatus();
}

function shellNav(active) {
  const n = book().inbox.length;
  const link = (h, label, key, ico, count) => `<a href="#/${h}" class="${active === key ? "on" : ""}"><span class="ico">${ico}</span><span>${label}</span>${count ? `<span class="count">${count > 999 ? "999+" : count}</span>` : ""}</a>`;
  return {
    side: `<nav class="side" aria-label="Main">
      <div class="brand"><picture class="logo-mark"><source srcset="brand/logo-mark-reversed.svg" media="(prefers-color-scheme: dark)"><img src="brand/logo-mark.svg" alt=""></picture><span>J Finance</span></div>
      <a href="#/add" class="btn gold add-btn">＋ Add entry</a>
      ${link("home", "Home", "home", "⌂")}${link("inbox", "Inbox", "inbox", "⇩", n)}${link("activity", "Activity", "activity", "≡")}${link("forecast", "Forecast", "forecast", "↗")}${link("plan", "Recurring and invoices", "plan", "↻")}${link("tax", "Tax", "tax", "%")}${link("reports", "Reports", "reports", "▦")}${link("accounts", "Accounts", "accounts", "▤")}${link("people", "People", "people", "☺")}${link("more", "More", "more", "⋯")}
      <div class="side-foot"><div data-sync class="sync"></div><button class="btn ghost small" data-act="lock">Lock</button></div>
    </nav>`,
    tabs: `<nav class="tabbar" aria-label="Main">${link("home", "Home", "home", "⌂")}${link("activity", "Activity", "activity", "≡")}
      <a href="#/add" class="tab-add" aria-label="Add entry">＋</a>${link("inbox", "Inbox", "inbox", "⇩", n)}${link("more", "More", "more", "⋯")}</nav>`,
  };
}
function renderApp() {
  const r = route();
  const views = {
    home: viewHome, activity: viewActivity, accounts: viewAccounts, account: viewAccount, people: viewPeople, person: viewPerson,
    add: viewAdd, txn: viewTxn, more: viewMore, edit: viewEdit, inbox: viewInbox, import: viewImport, forecast: viewForecast, plan: viewPlan, invoices: viewInvoices, invoice: viewInvoice, tax: viewTax, reports: viewReports, receipts: viewReceipts, pack: viewPack,
  };
  const v = (views[r.name] || viewHome)(r);
  const active = { account: "accounts", person: "people", txn: "activity", edit: "more", add: "", import: "inbox", invoices: "plan", invoice: "plan" }[r.name] ?? r.name;
  const nav = shellNav(active);
  app.innerHTML = `<div class="shell">${nav.side}<main class="main">
    <header class="top">${v.back ? `<a class="back" href="${v.back}" aria-label="Back">‹</a>` : ""}<h1>${esc(v.title)}</h1>
      <div class="top-right"><div data-sync class="sync m-only-hide"></div><button class="btn ghost small m-only" data-act="lock" aria-label="Lock">🔒</button></div></header>
    <div class="content">${v.html}</div></main>${nav.tabs}</div>`;
  updateStatus();
  if (v.after) v.after();
  if (location.hash !== lastDrawn) { window.scrollTo(0, 0); lastDrawn = location.hash; }
}
let lastDrawn = "";

/* ================= Setup screens ================= */
function card(title, body) { return `<div class="setup"><div class="setup-card"><div class="setup-brand"><picture class="logo-mark"><source srcset="brand/logo-mark-reversed.svg" media="(prefers-color-scheme: dark)"><img src="brand/logo-mark.svg" alt=""></picture><span>J Finance</span></div><h1>${esc(title)}</h1>${body}</div></div>`; }
const msgHtml = () => (S.msg ? `<p class="msg ${S.msg.err ? "err" : ""}">${esc(S.msg.text)}</p>` : "");
function renderConnect() {
  const g = S.gh || {};
  app.innerHTML = card("Connect this device", `
    <p class="muted">Your data is kept, encrypted, in a private GitHub repository. Each device connects with its own access key.</p>
    <form data-form="connect" class="stack">
      ${field("GitHub username", `<input name="owner" autocapitalize="off" autocomplete="username" value="${esc(g.owner || CFG.githubOwner || "")}">`)}
      ${field("Data repository", `<input name="repo" autocapitalize="off" value="${esc(g.repo || CFG.githubRepo || "")}">`)}
      ${field("This device's access key", `<input name="token" type="password" autocomplete="off" placeholder="github_pat_…">`, "Paste the key you made for this device. It stays on this device only.")}
      ${msgHtml()}
      <button class="btn primary big">Connect</button>
    </form>`);
}
function renderCreate() {
  app.innerHTML = card("Choose your passphrase", `
    <p class="muted">This locks your data. Nobody can open it without the passphrase, not GitHub, not Claude, not anyone. Use at least four words, for example <i>maple river window forty</i>.</p>
    <form data-form="create" class="stack">
      ${field("Passphrase", `<input name="p1" type="password" autocomplete="new-password" minlength="12">`)}
      ${field("Type it again", `<input name="p2" type="password" autocomplete="new-password">`)}
      ${msgHtml()}
      <button class="btn primary big">Create my encrypted vault</button>
    </form>`);
}
function renderRecovery() {
  app.innerHTML = card("Your recovery key", `
    <p>If you ever forget your passphrase, this key is the only way back in. <b>Write it down</b> or save it in your Passwords app now. It won't be shown again.</p>
    <div class="recovery" id="rk">${esc(S.newRecovery || "")}</div>
    <button class="btn ghost" data-act="copyRecovery">Copy</button>
    <form data-form="recoveryDone" class="stack">
      <label class="check"><input type="checkbox" name="ok" required> I've saved my recovery key somewhere safe</label>
      <button class="btn primary big">Continue</button>
    </form>`);
}
function renderUnlock() {
  const useRec = S.unlockWithRecovery;
  app.innerHTML = card(useRec ? "Use your recovery key" : "Unlock J Finance", `
    <form data-form="unlock" class="stack">
      ${useRec ? field("Recovery key", `<input name="secret" autocapitalize="characters" autocomplete="off" placeholder="XXXX-XXXX-…">`)
               : field("Passphrase", `<input name="secret" type="password" autocomplete="current-password" autofocus>`)}
      ${msgHtml()}
      <button class="btn primary big">Unlock</button>
    </form>
    <p class="small-links"><button class="link" data-act="toggleRecovery">${useRec ? "Use my passphrase instead" : "Forgot it? Use the recovery key"}</button></p>`);
  setTimeout(() => { const i = $("input[name=secret]"); if (i) i.focus(); }, 50);
}

/* ================= Home ================= */
function viewHome() {
  const b = book();
  if (!b.accounts.length) {
    return { title: "Home", html: `<div class="card empty"><h2>Welcome</h2>
      <p>Start by loading your starter file. It sets up your entities, accounts, people and categories in one go.</p>
      <a class="btn primary" href="#/more/data">Load starter file</a>
      <p class="muted small">Or add accounts one by one in More › Accounts.</p></div>` };
  }
  let cashAll = 0, missingAll = false, netWorth = 0;
  const entityCards = b.entities.map((e) => {
    const accs = b.accounts.filter((a) => a.entityId === e.id && !a.archived);
    if (!accs.length) return "";
    let cash = 0, missing = false;
    const rows = accs.map((a) => {
      const bal = b.acctBal.get(a.id) || {};
      const g = balGBP(bal);
      if (CASH_TYPES.has(a.type)) { cash += g.total; missing = missing || g.missing; }
      netWorth += g.total;
      const foreign = Object.keys(bal).some((c) => c !== "GBP" && bal[c]);
      const low = a.minBalance != null && (bal[a.currencies[0]] || 0) < a.minBalance;
      return `<a class="row" href="#/account/${encodeURIComponent(a.id)}">
        <div class="row-main"><div class="row-title">${esc(a.name)}${low ? ` <span class="badge warn" title="Below the minimum you set">low</span>` : ""}</div>
          <div class="row-sub">${esc(ACCOUNT_TYPES[a.type] || "")}${a.joint ? " · joint" : ""} ${curTags(a.currencies)}</div></div>
        <div class="row-amt"><div class="${signCls(Object.values(bal).reduce((s, v) => s + v, 0))}">${balText(bal, a.currencies[0])}</div>
          ${foreign ? `<div class="row-sub">${g.missing ? "rate needed" : "≈ " + money(g.total, "GBP")}</div>` : ""}</div></a>`;
    }).join("");
    cashAll += cash; missingAll = missingAll || missing;
    return `<section class="card"><div class="card-head"><h2>${esc(e.name)}</h2><div class="card-total">${money(cash, "GBP")}${missing ? "*" : ""}</div></div><div class="list">${rows}</div></section>`;
  }).join("");

  let owed = 0, owe = 0;
  for (const [, bal] of b.personBal) for (const [c, v] of Object.entries(bal)) { const g = toGBP(v, c); if (g == null) continue; if (g > 0) owed += g; else owe += g; }
  netWorth += owed + owe;

  const icRows = [];
  for (const [k, v] of b.ic) {
    const [e1, e2] = k.split("|");
    if (v !== 0 && e1 < e2) {   // each pair is stored both ways; show it once
      const creditor = v > 0 ? e1 : e2, debtor = v > 0 ? e2 : e1;
      icRows.push(`<div class="row"><div class="row-main"><div class="row-title">${esc(name(debtor))} owes ${esc(name(creditor))}</div>
        <div class="row-sub">${isDirLoan(e1, e2) ? "Director's loan" : "Between your entities"}</div></div><div class="row-amt">${money(Math.abs(v), "GBP")}</div></div>`);
    }
  }
  const todos = b.todos.filter((t) => !t.done);
  let fc = null; try { fc = forecast(); } catch (e) { console.warn(e); }
  const warnCard = fc && fc.warnings.length ? `<a class="card banner warn-banner" href="#/forecast"><div><b>⚠ ${warnText(fc.warnings[0])}</b>${fc.warnings.length > 1 ? `<div class="muted small">and ${fc.warnings.length - 1} more account${fc.warnings.length > 2 ? "s" : ""}</div>` : ""}</div><span class="chev">›</span></a>` : "";
  const fcCard = fc && fc.events.length ? (() => { const low = fc.series.reduce((m, p) => (p.total < m.total ? p : m), fc.series[0]), next = fc.events.slice(0, 4);
    return `<section class="card"><div class="card-head"><h2>Next 3 months</h2><a href="#/forecast" class="link">Forecast</a></div>
      <div class="kpis"><div><div class="kpi-label">Lowest cash</div><div class="kpi">${money(low.total, "GBP", true)}</div><div class="muted small">${esc(fmtDate(low.date))}</div></div>
      <div><div class="kpi-label">In 3 months</div><div class="kpi">${money(fc.series[fc.series.length - 1].total, "GBP", true)}</div></div></div>
      <div class="list">${next.map((e) => `<a class="row" href="${e.ref}"><div class="row-main"><div class="row-title">${esc(e.label)}</div><div class="row-sub">${esc(fmtDate(e.date))}</div></div><div class="row-amt ${e.dir === "in" ? "pos" : e.dir === "out" ? "neg" : ""}">${e.dir === "in" ? "+" : e.dir === "out" ? "−" : ""}${money(e.amount, e.cur)}</div></a>`).join("")}</div></section>`; })() : "";
  const raiseCard = typeof toRaiseCard === "function" ? toRaiseCard() : "";
  const inboxCard = b.inbox.length ? `<a class="card banner" href="#/inbox"><div><b>${b.inbox.length} statement line${b.inbox.length === 1 ? "" : "s"} to review</b><div class="muted small">Confirm, match or ignore them in the Inbox.</div></div><span class="chev">›</span></a>` : "";
  const recent = b.txns.slice(0, 6).map((t) => txnRow(t)).join("");
  return {
    title: "Home",
    html: `<section class="hero">
        <div class="hero-label">Cash across your accounts, less card balances</div>
        <div class="hero-num">${money(cashAll, "GBP")}${missingAll ? "*" : ""}</div>
        <div class="hero-sub">Net worth ${money(netWorth, "GBP")} · includes pension, loans and money owed${S.rates ? ` · rates ${esc(fmtDate(S.rates.date))}` : ""}</div>
        ${missingAll ? `<div class="hero-sub">* Some foreign balances aren't converted yet: no exchange rate.</div>` : ""}
      </section>
      ${warnCard}${inboxCard}${raiseCard}
      <div class="cols">
        <div class="col">${entityCards}</div>
        <div class="col">
          ${fcCard}
          <section class="card"><div class="card-head"><h2>People</h2><a href="#/people" class="link">All</a></div>
            <div class="kpis"><div><div class="kpi-label">Owed to you</div><div class="kpi pos">${money(owed, "GBP")}</div></div>
            <div><div class="kpi-label">You owe</div><div class="kpi neg">${money(-owe, "GBP")}</div></div></div></section>
          ${icRows.length ? `<section class="card"><div class="card-head"><h2>Between your entities</h2></div><div class="list">${icRows.join("")}</div></section>` : ""}
          ${todos.length ? `<section class="card"><div class="card-head"><h2>To confirm</h2><a href="#/more/confirm" class="link">${todos.length}</a></div>
            <ul class="todo">${todos.slice(0, 4).map((t) => `<li>${esc(t.name)}</li>`).join("")}</ul></section>` : ""}
          <section class="card"><div class="card-head"><h2>Recent</h2><a href="#/activity" class="link">All</a></div>
            <div class="list">${recent || `<p class="muted pad">Nothing yet. Tap ＋ to add your first entry.</p>`}</div></section>
        </div>
      </div>`,
  };
}
function isDirLoan(e1, e2) {
  const t = (id) => (book().byId.get(id) || {}).type;
  return (t(e1) === "personal") !== (t(e2) === "personal");
}

/* ================= Transactions list ================= */
function txnRow(t, { forAccount, forPerson, running } = {}) {
  let amt = 0, cur = (t.headline && t.headline.cur) || "GBP";
  if (forAccount || forPerson) {
    const kind = forAccount ? "a" : "p", ref = forAccount || forPerson;
    const ls = t.lines.filter((l) => l.t === kind && l.ref === ref);
    cur = ls[0] ? ls[0].cur : cur; amt = ls.reduce((s, l) => s + l.amt, 0);
  } else amt = t.headline ? t.headline.amt : 0;
  const b = book();
  const sub = [fmtDate(t.date)];
  if (t.divisionId) sub.push(name(t.divisionId)); else if (t.entityId && b.entities.length > 1) sub.push(name(t.entityId));
  const showSign = forAccount || forPerson || t.type === "in" || t.type === "out";
  return `<a class="row" href="#/txn/${encodeURIComponent(t.id)}">
    <div class="row-ico t-${t.type}">${TYPES[t.type] ? TYPES[t.type].icon : "•"}</div>
    <div class="row-main"><div class="row-title">${esc(t.desc)}</div><div class="row-sub">${esc(sub.join(" · "))}${(t.tags || []).includes("receipt") ? ` <span class="badge">receipt</span>` : ""}</div></div>
    <div class="row-amt"><div class="${showSign ? signCls(amt) : ""}">${showSign && amt > 0 ? "+" : ""}${money(amt, cur)}</div>
      ${running ? `<div class="row-sub">${esc(running)}</div>` : ""}</div></a>`;
}
function viewActivity() {
  const b = book();
  return {
    title: "Activity",
    html: `<div class="filters"><input type="search" id="q" placeholder="Search descriptions, people, notes" autocomplete="off">
      <select id="fent"><option value="">All entities</option>${b.entities.map((e) => opt(e.id, e.name)).join("")}</select></div>
      <div id="txlist"></div>`,
    after() {
      const draw = () => {
        const q = $("#q").value.trim().toLowerCase(), fe = $("#fent").value;
        const rows = b.txns.filter((t) => (!fe || t.lines.some((l) => l.ent === fe)) &&
          (!q || [t.desc, t.note, t.personId && name(t.personId), ...t.lines.map((l) => l.t === "a" || l.t === "c" || l.t === "p" ? name(l.ref) : "")].join(" ").toLowerCase().includes(q)));
        let month = "", html = "";
        for (const t of rows.slice(0, 400)) {
          const m = t.date.slice(0, 7);
          if (m !== month) { if (month) html += `</div></section>`; month = m; html += `<section class="card"><div class="card-head"><h2>${esc(fmtMonth(t.date))}</h2></div><div class="list">`; }
          html += txnRow(t);
        }
        if (month) html += `</div></section>`;
        $("#txlist").innerHTML = html || `<div class="card empty"><p class="muted">${b.txns.length ? "Nothing matches." : "No entries yet."}</p></div>`;
      };
      $("#q").addEventListener("input", draw); $("#fent").addEventListener("change", draw); draw();
    },
  };
}

/* ================= Accounts ================= */
function viewAccounts() {
  const b = book();
  const html = b.entities.map((e) => {
    const accs = b.accounts.filter((a) => a.entityId === e.id);
    if (!accs.length) return "";
    return `<section class="card"><div class="card-head"><h2>${esc(e.name)}</h2></div><div class="list">${accs.map((a) => `
      <a class="row${a.archived ? " archived" : ""}" href="#/account/${encodeURIComponent(a.id)}"><div class="row-main"><div class="row-title">${esc(a.name)}</div>
      <div class="row-sub">${esc(ACCOUNT_TYPES[a.type] || "")}${a.archived ? " · archived" : ""} ${curTags(a.currencies)}</div></div>
      <div class="row-amt">${balText(b.acctBal.get(a.id), a.currencies[0])}</div></a>`).join("")}</div></section>`;
  }).join("");
  return { title: "Accounts", html: `${html}<a class="btn" href="#/edit/account/new">＋ Add account</a>` };
}
function runningList(txns, kind, ref) {
  const totals = {}, run = new Map();
  for (const t of [...txns].reverse()) {
    for (const l of t.lines) if (l.t === kind && l.ref === ref) totals[l.cur] = (totals[l.cur] || 0) + l.amt;
    run.set(t.id, balText({ ...totals }));
  }
  return txns.map((t) => txnRow(t, kind === "a" ? { forAccount: ref, running: run.get(t.id) } : { forPerson: ref, running: run.get(t.id) })).join("");
}
function viewAccount(r) {
  const b = book(), a = b.byId.get(r.a);
  if (!a || a.kind !== "account") return { title: "Account", back: "#/accounts", html: `<p class="muted">This account no longer exists.</p>` };
  const bal = b.acctBal.get(a.id) || {}, txs = b.acctTx.get(a.id) || [];
  const g = balGBP(bal);
  const liability = a.type === "card" || a.type === "loan";
  return {
    title: a.name, back: "#/accounts",
    html: `<section class="hero small"><div class="hero-label">${esc(name(a.entityId))} · ${esc(ACCOUNT_TYPES[a.type] || "")}${a.last4 ? " · ••" + esc(a.last4) : ""}${a.joint ? " · joint" : ""}</div>
      <div class="hero-num">${balText(bal, a.currencies[0])}</div>
      ${Object.keys(bal).some((c) => c !== "GBP" && bal[c]) ? `<div class="hero-sub">${g.missing ? "Exchange rate needed" : "≈ " + money(g.total, "GBP")}</div>` : ""}
      ${liability ? `<div class="hero-sub">A minus balance is what you owe.</div>` : ""}
      ${a.minBalance != null ? `<div class="hero-sub">Minimum you set: ${money(a.minBalance, a.currencies[0])}</div>` : ""}
      ${a.note ? `<div class="hero-sub">${esc(a.note)}</div>` : ""}${checkHtml(a.id)}</section>
      <div class="actions"><a class="btn" href="#/import" data-act="importFor" data-id="${esc(a.id)}">Import statement</a><a class="btn" href="#/add/in?account=${encodeURIComponent(a.id)}">Money in</a><a class="btn" href="#/add/out?account=${encodeURIComponent(a.id)}">Money out</a>
      ${txs.length ? "" : `<a class="btn" href="#/add/opening?account=${encodeURIComponent(a.id)}">Opening balance</a>`}<a class="btn ghost" href="#/edit/account/${encodeURIComponent(a.id)}">Edit</a></div>
      <section class="card"><div class="list">${runningList(txs, "a", a.id) || `<p class="muted pad">No entries yet.</p>`}</div></section>`,
  };
}

/* ================= People ================= */
function viewPeople() {
  const b = book();
  const rows = (filter) => b.people.filter(filter).map((p) => {
    const bal = b.personBal.get(p.id) || {}, total = Object.values(bal).reduce((s, v) => s + v, 0);
    return `<a class="row${p.archived ? " archived" : ""}" href="#/person/${encodeURIComponent(p.id)}"><div class="row-main"><div class="row-title">${esc(p.name)}</div>
      <div class="row-sub">${esc(PERSON_GROUPS[p.group] || "")}${total > 0 ? " · owes you" : total < 0 ? " · you owe" : ""}</div></div>
      <div class="row-amt ${signCls(total)}">${total ? balText(bal) : ""}</div></a>`;
  }).join("");
  const withBal = (p) => Object.values(b.personBal.get(p.id) || {}).some((v) => v);
  const active = rows((p) => withBal(p)), others = rows((p) => !withBal(p));
  return {
    title: "People",
    html: `${active ? `<section class="card"><div class="card-head"><h2>Open balances</h2></div><div class="list">${active}</div></section>` : ""}
      <section class="card"><div class="card-head"><h2>${active ? "Everyone else" : "Everyone"}</h2></div><div class="list">${others || `<p class="muted pad">No people yet.</p>`}</div></section>
      <a class="btn" href="#/edit/person/new">＋ Add person</a>`,
  };
}
function viewPerson(r) {
  const b = book(), p = b.byId.get(r.a);
  if (!p || p.kind !== "person") return { title: "Person", back: "#/people", html: `<p class="muted">This person no longer exists.</p>` };
  const bal = b.personBal.get(p.id) || {}, txs = b.personTx.get(p.id) || [];
  const parts = Object.entries(bal).filter(([, v]) => v);
  const q = encodeURIComponent(p.id);
  return {
    title: p.name, back: "#/people",
    html: `<section class="hero small"><div class="hero-label">${esc(PERSON_GROUPS[p.group] || "")}</div>
      ${parts.length ? parts.map(([c, v]) => `<div class="hero-num ${signCls(v)}">${money(Math.abs(v), c)}</div><div class="hero-sub">${v > 0 ? `${esc(p.name)} owes you` : `You owe ${esc(p.name)}`}</div>`).join("")
                     : `<div class="hero-num">Settled</div><div class="hero-sub">Nobody owes anybody.</div>`}
      ${p.note ? `<div class="hero-sub">${esc(p.note)}</div>` : ""}</section>
      <div class="actions"><a class="btn" href="#/add/behalf?payer=${q}">Paid on my behalf</a><a class="btn" href="#/add/iou?person=${q}">Owed</a>
      <a class="btn ghost" href="#/edit/person/${q}">Edit</a></div>
      <section class="card"><div class="list">${runningList(txs, "p", p.id) || `<p class="muted pad">No entries yet.</p>`}</div></section>`,
  };
}

/* ================= Adding and editing entries ================= */
function viewAdd(r) {
  if (r.a && TYPES[r.a.split("?")[0]]) return viewTxnForm(r.a.split("?")[0], null, new URLSearchParams(location.hash.split("?")[1] || ""));
  return {
    title: "Add entry", back: "#/home",
    html: `<div class="types">${Object.entries(TYPES).map(([k, t]) => `<a class="type" href="#/add/${k}"><span class="row-ico t-${k}">${t.icon}</span><span><b>${esc(t.label)}</b><span class="muted">${esc(t.hint)}</span></span></a>`).join("")}</div>`,
  };
}
function viewTxn(r) {
  const t = book().byId.get(r.a);
  if (!t || t.kind !== "txn") return { title: "Entry", back: "#/activity", html: `<p class="muted">This entry no longer exists.</p>` };
  return viewTxnForm(t.type, t);
}
function viewTxnForm(type, t, params = new URLSearchParams()) {
  const b = book();
  const f = t ? { ...t.form } : Object.fromEntries(params);
  const v = (k, d = "") => (f[k] ?? d);
  const date = v("date", t ? t.date : todayISO());
  const tags = t ? t.tags || [] : [];
  const defaultEnt = v("entityId", (b.byId.get(v("account")) || {}).entityId || "ent_personal");
  let body = "";
  switch (type) {
    case "in":
      body = `${accountSelect("account", v("account"), { label: "Into account" })}
        ${amountField("Amount received", "amount", v("amount"), "cur", v("cur", "GBP"), { curOf: "account" })}
        ${rateField("rate", "cur", v("rate"))}
        ${field("What is it?", seg("source", v("source", "category"), { category: "New income", person: "Someone paying back what they owed" }))}
        ${when("source:category", categorySelect("category", v("category"), { label: "Income category", first: "income", required: false }))}
        ${personSelect("person", v("person"), { label: "From", optional: true })}
        ${when("cur:INR", field("TDS deducted (if any)", `<input name="tds" inputmode="decimal" placeholder="0.00" value="${esc(v("tds"))}">`, "Tax held back by an Indian payer. The income is recorded gross."))}`;
      break;
    case "out":
      body = `${accountSelect("account", v("account"), { label: "From account" })}
        ${amountField("Amount paid", "amount", v("amount"), "cur", v("cur", "GBP"), { curOf: "account" })}
        ${rateField("rate", "cur", v("rate"))}
        ${field("What is it?", seg("dest", v("dest", "category"), { category: "Spending", person: "Paying or lending to a person" }))}
        ${when("dest:category", categorySelect("category", v("category"), { label: "Spending category", required: false }))}
        ${personSelect("person", v("person"), { label: "Paid to", optional: true })}`;
      break;
    case "transfer":
      body = `${accountSelect("from", v("from"), { label: "From account" })}
        ${amountField("Amount sent", "fromAmt", v("fromAmt"), "fromCur", v("fromCur", "GBP"), { curOf: "from" })}
        ${rateField("fromRate", "fromCur", v("fromRate"))}
        ${accountSelect("to", v("to"), { label: "To account" })}
        ${amountField("Amount received", "toAmt", v("toAmt"), "toCur", v("toCur", "GBP"), { curOf: "to", hint: "Leave empty if it's the same as the amount sent." })}
        ${rateField("toRate", "toCur", v("toRate"))}
        <div data-cross hidden>${field("Between your entities: what is it?", seg("nature", v("nature", "loan"), { loan: "Loan or repayment", salary: "Salary", dividend: "Dividend" }))}</div>`;
      break;
    case "behalf":
      body = `${personSelect("payer", v("payer"), { label: "Who paid" })}
        ${amountField("Amount", "amount", v("amount"), "cur", v("cur", "INR"))}
        ${rateField("rate", "cur", v("rate"))}
        ${field("Why did they pay it?", seg("basis", v("basis", "owed"), { owed: "From money they owed me", income: "It's my income from them" }))}
        ${when("basis:income", categorySelect("incomeCategory", v("incomeCategory"), { label: "Counts as income", first: "income", required: false }))}
        ${when("cur:INR", field("TDS deducted (if any)", `<input name="tds" inputmode="decimal" placeholder="0.00" value="${esc(v("tds"))}">`))}
        ${field("Who received it?", seg("recipientMode", v("recipientMode", "expense"), { expense: "A cost of mine (e.g. family support)", settle: "Someone I owed" }))}
        ${when("recipientMode:expense", categorySelect("category", v("category"), { label: "Spending category", required: false }))}
        ${personSelect("recipient", v("recipient"), { label: "Paid to", optional: true })}`;
      break;
    case "iou":
      body = `${field("Direction", seg("direction", v("direction", "theyOwe"), { theyOwe: "They owe me", iOwe: "I owe them" }))}
        ${personSelect("person", v("person"), { label: "Person" })}
        ${amountField("Amount", "amount", v("amount"), "cur", v("cur", "GBP"))}
        ${rateField("rate", "cur", v("rate"))}
        ${categorySelect("category", v("category"), { label: "For", first: "income" })}`;
      break;
    case "opening":
      body = `${field("Balance of", seg("target", v("target", "account"), { account: "An account", person: "A person" }))}
        ${when("target:account", accountSelect("account", v("account"), { label: "Account", required: false }))}
        ${when("target:person", personSelect("person", v("person"), { label: "Person" }))}
        ${amountField("Balance", "amount", v("amount"), "cur", v("cur", "GBP"), { curOf: "account", hint: "Use a minus for money owed: a card balance, or money you owe a person." })}
        ${rateField("rate", "cur", v("rate"))}`;
      break;
  }
  const html = `<form data-form="txn" data-live class="stack form-card" novalidate>
      <input type="hidden" name="type" value="${type}">${t ? `<input type="hidden" name="id" value="${esc(t.id)}">` : ""}${v("invoiceId") ? `<input type="hidden" name="invoiceId" value="${esc(v("invoiceId"))}">` : ""}
      <p class="muted">${esc(TYPES[type].hint)}.</p>
      ${field("Date", `<input type="date" name="date" value="${esc(date)}" required>`)}
      ${body}
      ${type === "transfer" ? "" : entityFields(defaultEnt, v("divisionId", t ? t.divisionId : ""))}
      ${field("Description", `<input name="desc" autocomplete="off" placeholder="Filled in for you if left empty" value="${esc(t ? t.desc : v("desc"))}">`)}
      <div class="tags">${Object.entries(TAGS).map(([k, l]) => `<label class="chip"><input type="checkbox" name="tags" value="${k}"${tags.includes(k) ? " checked" : ""}><span>${esc(l)}</span></label>`).join("")}</div>
      ${field("Note", `<textarea name="note" rows="2">${esc(t ? t.note : v("note"))}</textarea>`)}
      <p class="msg err" data-err hidden></p>
      <div class="actions"><button class="btn primary big">${t ? "Save changes" : "Save"}</button>
        ${t ? `<button type="button" class="btn ghost" data-act="dupTxn" data-id="${esc(t.id)}">Duplicate</button><button type="button" class="btn danger" data-act="delTxn" data-id="${esc(t.id)}">Delete</button>` : ""}</div>
      ${t && typeof receiptsBox === "function" ? receiptsBox(t) : ""}
      ${t && (t.stmtIds || []).length ? `<div class="muted small">From statement: ${t.stmtIds.map((id) => b.byId.get(id)).filter(Boolean).map((x) => `${esc(name(x.accountId))}, ${esc(fmtDate(x.date))}, “${esc(x.desc)}”`).join("; ")}</div>` : ""}
      ${t ? `<details class="lines"><summary>How it's recorded</summary>${linesTable(t)}</details>` : ""}
    </form>`;
  return { title: TYPES[type].label, back: t ? "#/activity" : "#/add", html, after: () => initLiveForm($("form[data-live]"), !!t) };
}
function linesTable(t) {
  const kind = { a: "Account", c: "Category", p: "Person", q: "Equity" };
  const ref = (l) => l.t === "q" ? (l.ref === "opening" ? "Opening balances" : l.ref === "dividends" ? "Dividends paid" : "Owed between entities: " + name(l.ref.slice(3))) : name(l.ref);
  return `<table class="tbl"><thead><tr><th>Entity</th><th>${"Line"}</th><th class="r">Amount</th><th class="r">GBP</th></tr></thead><tbody>${t.lines.map((l) => `<tr><td>${esc(name(l.ent))}</td><td>${esc(kind[l.t])}: ${esc(ref(l))}</td><td class="r">${money(l.amt, l.cur)}</td><td class="r">${money(l.gbp, "GBP")}</td></tr>`).join("")}</tbody></table>
    <p class="muted small">Positive lines add to an account, a cost or what someone owes you. Each entity's lines add up to zero.</p>`;
}

/* Live behaviour on entry forms: show the right fields, currencies, divisions and rates. */
function initLiveForm(form, editing) {
  if (!form) return;
  const els = form.elements;
  const val = (n) => { const e = els[n]; if (!e) return ""; if (e instanceof RadioNodeList) return e.value; return e.value; };
  const accountOf = (n) => book().byId.get(val(n));
  let entTouched = editing;
  const applyWhen = () => {
    for (const el of $$("[data-when]", form)) {
      const ok = el.dataset.when.split(";").every((cond) => { const [k, vs] = cond.split(":"); return vs.split(",").includes(val(k)); });
      el.hidden = !ok;
    }
  };
  const refreshCur = (accName) => {
    const a = accountOf(accName), sel = $(`select[data-cur-of="${accName}"]`, form);
    if (!sel) return;
    const isOpeningPerson = val("type") === "opening" && val("target") === "person";
    const list = a && !isOpeningPerson ? a.currencies : CURRENCIES, cur = sel.value;
    sel.innerHTML = list.map((c) => opt(c, c, c === cur)).join("");
    if (!list.includes(cur)) sel.value = list[0];
  };
  const refreshDivisions = () => {
    const sel = $("select[data-division]", form);
    if (!sel) return;
    const ent = val("entityId"), cur = sel.value || sel.dataset.val;
    const divs = book().divisions.filter((d) => d.entityId === ent && (!d.archived || d.id === cur));
    sel.innerHTML = `<option value="">— none —</option>` + divs.map((d) => opt(d.id, d.name, d.id === cur)).join("");
    sel.disabled = !divs.length;
  };
  const refreshRates = async () => {
    for (const box of $$("[data-rate-of]", form)) {
      const cur = val(box.dataset.rateOf);
      box.hidden = !cur || cur === "GBP";
      if (box.hidden) continue;
      const input = els[box.dataset.rateName], hint = $("[data-rate-hint]", box);
      const r = await rateFor(cur, val("date") || todayISO());
      input.placeholder = r ? String(r) : "";
      hint.textContent = r ? `Leave empty to use ${r} (the day's mid-market rate).` : "No rate available offline. Enter one.";
    }
  };
  const refreshCross = () => {
    const box = $("[data-cross]", form);
    if (!box) return;
    const A = accountOf("from"), B = accountOf("to");
    box.hidden = !(A && B && A.entityId !== B.entityId);
  };
  const onAccount = (nm) => {
    refreshCur(nm);
    const a = accountOf(nm);
    if (a && !entTouched && els.entityId && nm === "account") { els.entityId.value = a.entityId; refreshDivisions(); }
  };
  form.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.matches("select[data-person]") && el.value === "__new") {
      const nm = (prompt("Name of the new person or company:") || "").trim();
      if (!nm) { el.value = ""; return; }
      const p = put({ id: uid("per"), kind: "person", name: nm, group: "other" });
      for (const s of $$("select[data-person]", form)) {
        const keep = s === el ? p.id : s.value;
        s.innerHTML = `<option value="">Choose…</option>` + book().people.filter((x) => !x.archived).map((x) => opt(x.id, x.name, x.id === keep)).join("") + `<option value="__new">＋ New person…</option>`;
      }
      toast(`Added ${nm}`);
    }
    if (el.matches("select[data-account]")) onAccount(el.name);
    if (el.name === "entityId") { entTouched = true; refreshDivisions(); }
    if (el.name === "target") refreshCur("account");
    applyWhen(); refreshCross();
    if (["date", "cur", "fromCur", "toCur", "account", "from", "to", "target"].includes(el.name)) await refreshRates();
  });
  if (val("account")) refreshCur("account");
  if (val("from")) refreshCur("from");
  if (val("to")) refreshCur("to");
  refreshDivisions(); applyWhen(); refreshCross(); refreshRates();
}

/* ================= More, settings and editors ================= */
function viewMore(r) {
  const sub = r.a;
  if (sub === "data") return viewData();
  if (sub === "security") return viewSecurity();
  if (sub === "categories") return viewCategories();
  if (sub === "entities") return viewEntities();
  if (sub === "confirm") return viewConfirm();
  if (sub === "device") return viewDevice();
  if (sub === "rates") return viewRates();
  if (sub === "rules") return viewRules();
  const item = (h, t, s) => `<a class="row" href="#/${h}"><div class="row-main"><div class="row-title">${t}</div><div class="row-sub">${s}</div></div><div class="chev">›</div></a>`;
  return {
    title: "More",
    html: `<section class="card"><div class="list">
      ${item("forecast", "Forecast", "Your balances over the next 3 months")}
      ${item("plan", "Recurring items", "Bills, retainers, salaries, instalments")}
      ${item("invoices", "Invoices", "What's been invoiced, paid and overdue")}
      ${item("tax", "Tax", "Estimates, set-asides, dividends and deadlines")}
      ${item("reports", "Reports", "Income and spending, net worth, who owes what")}
      ${item("import", "Import statement", "CSV from your bank, or a file prepared from PDFs")}
      ${item("more/rules", "Rules", "How statement lines are recognised")}
      ${item("accounts", "Accounts", "Add, edit or archive accounts")}
      ${item("people", "People", "Clients, family, partners, suppliers")}
      ${item("more/categories", "Categories", "Income and spending categories")}
      ${item("more/entities", "Entities and divisions", "Personal, Hotel Alchemyst, Synarchy Partners")}
      ${item("more/rates", "Exchange rates", "Today's mid-market rates")}
      ${item("more/confirm", "To confirm", "Open questions from the design")}
      </div></section>
      <section class="card"><div class="list">
      ${item("receipts", "Receipts", "Attached and still to find")}
      ${item("pack", "Accountant pack", "Entries, profit and loss, invoices and receipts in one zip")}
      ${item("more/data", "Starter file and export", "Load your setup, or export a copy")}
      ${item("more/security", "Passphrase and recovery key", "Change them, or lock now")}
      ${item("more/device", "This device and sync", "Sync status, disconnect this device")}
      </div></section>
      <p class="muted small center-text">J Finance · Your data is encrypted on this device before it syncs.</p>`,
  };
}
function viewData() {
  return {
    title: "Starter file and export", back: "#/more",
    html: `<section class="card pad"><h2>Load the starter file</h2>
      <p>Choose <code>starter-data.json</code> from the <b>setup</b> folder on your Mac. It adds your entities, divisions, accounts, people and categories. Anything already here is left as it is, so it's safe to load it twice.</p>
      <label class="btn">Choose file…<input type="file" accept=".json,application/json" data-act-change="importFile" hidden></label></section>
      <section class="card pad"><h2>Export a readable copy</h2>
      <p>Downloads everything as a plain, <b>unencrypted</b> JSON file. Keep it somewhere private and delete it when you're done.</p>
      <button class="btn" data-act="export">Export</button></section>`,
  };
}
function viewSecurity() {
  return {
    title: "Passphrase and recovery key", back: "#/more",
    html: `<section class="card pad"><h2>Lock now</h2><p>The app also locks itself after 15 minutes without use, or 5 minutes in the background.</p><button class="btn" data-act="lock">Lock</button></section>
      <section class="card pad"><h2>Change passphrase</h2>
      <form data-form="changePass" class="stack">${field("New passphrase", `<input type="password" name="p1" autocomplete="new-password">`)}${field("Type it again", `<input type="password" name="p2" autocomplete="new-password">`)}
      <button class="btn">Change passphrase</button></form><p class="muted small">Other devices will need the new passphrase next time they unlock.</p></section>
      <section class="card pad"><h2>New recovery key</h2><p>Makes a new recovery key and stops the old one working.</p><button class="btn" data-act="newRecovery">Make a new recovery key</button></section>`,
  };
}
function viewDevice() {
  return {
    title: "This device and sync", back: "#/more",
    html: `<section class="card pad"><h2>Sync</h2><div data-sync class="sync"></div>
      <p class="muted">Connected to <b>${esc(S.gh ? S.gh.owner + "/" + S.gh.repo : "")}</b> as <b>${esc(deviceName())}</b>.</p>
      <button class="btn" data-act="sync">Sync now</button></section>
      <section class="card pad"><h2>Disconnect this device</h2><p>Removes the data and access key from this device. Your data stays safe on GitHub and on your other devices.</p>
      <button class="btn danger" data-act="forget">Disconnect</button></section>`,
  };
}
function viewRates() {
  const r = S.rates;
  return {
    title: "Exchange rates", back: "#/more",
    html: `<section class="card pad"><h2>1 GBP =</h2>${r ? `<div class="kpis">${["INR", "USD", "EUR"].map((c) => `<div><div class="kpi-label">${c}</div><div class="kpi">${esc(r[c])}</div></div>`).join("")}</div>
      <p class="muted">Mid-market reference rates for ${esc(fmtDate(r.date))}, the rate Wise uses before its fee. Each entry keeps the rate of its own date.</p>` : `<p>No rates yet.</p>`}
      <button class="btn" data-act="refreshRates">Refresh</button></section>`,
  };
}
function viewConfirm() {
  const b = book();
  return {
    title: "To confirm", back: "#/more",
    html: `<section class="card"><div class="list">${b.todos.map((t) => `<label class="row check-row"><input type="checkbox" data-act-change="todo" data-id="${esc(t.id)}"${t.done ? " checked" : ""}><div class="row-main"><div class="row-title${t.done ? " done" : ""}">${esc(t.name)}</div>${t.note ? `<div class="row-sub">${esc(t.note)}</div>` : ""}</div></label>`).join("") || `<p class="muted pad">Nothing to confirm.</p>`}</div></section>`,
  };
}
function viewCategories() {
  const b = book();
  const list = (g) => b.categories.filter((c) => c.group === g).map((c) => `<a class="row${c.archived ? " archived" : ""}" href="#/edit/category/${encodeURIComponent(c.id)}"><div class="row-main"><div class="row-title">${esc(c.name)}</div>${c.archived ? `<div class="row-sub">archived</div>` : ""}</div><div class="chev">›</div></a>`).join("");
  return {
    title: "Categories", back: "#/more",
    html: `<section class="card"><div class="card-head"><h2>Income</h2></div><div class="list">${list("income")}</div></section>
      <section class="card"><div class="card-head"><h2>Spending</h2></div><div class="list">${list("expense")}</div></section>
      <a class="btn" href="#/edit/category/new">＋ Add category</a>`,
  };
}
function viewEntities() {
  const b = book();
  return {
    title: "Entities and divisions", back: "#/more",
    html: b.entities.map((e) => `<section class="card"><div class="card-head"><h2>${esc(e.name)}</h2><a class="link" href="#/edit/entity/${encodeURIComponent(e.id)}">Edit</a></div>
      <div class="list">${b.divisions.filter((d) => d.entityId === e.id).map((d) => `<a class="row${d.archived ? " archived" : ""}" href="#/edit/division/${encodeURIComponent(d.id)}"><div class="row-main"><div class="row-title">${esc(d.name)}</div></div><div class="chev">›</div></a>`).join("")}
      <a class="row add-row" href="#/edit/division/new/${encodeURIComponent(e.id)}">＋ Add division</a></div></section>`).join("") + `<a class="btn" href="#/edit/entity/new">＋ Add entity</a>`,
  };
}
function viewEdit(r) {
  const kind = r.a, id = r.b, isNew = id === "new";
  const b = book(), x = isNew ? null : b.byId.get(id);
  if (!isNew && (!x || x.kind !== kind)) return { title: "Not found", back: "#/more", html: `<p class="muted">This item no longer exists.</p>` };
  const v = (k, d = "") => (x && x[k] != null ? x[k] : d);
  const archive = !isNew && !(x && x.system) ? `<label class="check"><input type="checkbox" name="archived"${v("archived") ? " checked" : ""}> Archived (hidden from choices, history kept)</label>` : "";
  const nameField = field("Name", `<input name="name" required autocomplete="off" value="${esc(v("name"))}">`);
  let body = "", title = "", back = "#/more";
  if (kind === "account") {
    title = isNew ? "New account" : "Edit account"; back = isNew ? "#/accounts" : `#/account/${encodeURIComponent(id)}`;
    const curs = v("currencies", ["GBP"]);
    body = `${nameField}
      <div class="grid2">${field("Belongs to", `<select name="entityId">${b.entities.map((e) => opt(e.id, e.name, e.id === v("entityId", "ent_personal"))).join("")}</select>`)}
      ${field("Type", `<select name="type">${Object.entries(ACCOUNT_TYPES).map(([k, l]) => opt(k, l, k === v("type", "bank"))).join("")}</select>`)}</div>
      ${field("Currencies it holds", `<div class="tags">${CURRENCIES.map((c) => `<label class="chip"><input type="checkbox" name="currencies" value="${c}"${curs.includes(c) ? " checked" : ""}><span>${curDot(c)}${c}</span></label>`).join("")}</div>`, "The first ticked currency is the main one.")}
      <div class="grid2">${field("Last 4 digits (optional)", `<input name="last4" inputmode="numeric" maxlength="4" pattern="\\d{4}" value="${esc(v("last4"))}">`, "Only to match statements. Never the full number.")}
      ${field("Warn me below (optional)", `<input name="minBalance" inputmode="decimal" value="${esc(minorToInput(x ? x.minBalance : null))}">`, "In the main currency.")}</div>
      <label class="check"><input type="checkbox" name="joint"${v("joint") ? " checked" : ""}> Joint account</label>
      ${field("Note", `<textarea name="note" rows="2">${esc(v("note"))}</textarea>`)}${archive}`;
  } else if (kind === "person") {
    title = isNew ? "New person" : "Edit person"; back = isNew ? "#/people" : `#/person/${encodeURIComponent(id)}`;
    body = `${nameField}${field("Group", `<select name="group">${Object.entries(PERSON_GROUPS).map(([k, l]) => opt(k, l, k === v("group", "other"))).join("")}</select>`)}
      ${field("Note", `<textarea name="note" rows="2">${esc(v("note"))}</textarea>`)}${archive}`;
  } else if (kind === "category") {
    title = isNew ? "New category" : "Edit category"; back = "#/more/categories";
    body = `${nameField}${field("Type", seg("group", v("group", "expense"), { expense: "Spending", income: "Income" }))}
      ${x && x.system ? `<p class="muted small">The app uses this category, so it can be renamed but not archived.</p>` : ""}${archive}`;
  } else if (kind === "entity") {
    title = isNew ? "New entity" : "Edit entity"; back = "#/more/entities";
    body = `${nameField}${field("Type", `<select name="type">${Object.entries(ENTITY_TYPES).map(([k, l]) => opt(k, l, k === v("type", "company"))).join("")}</select>`)}
      ${field("Note", `<textarea name="note" rows="2">${esc(v("note"))}</textarea>`)}`;
  } else if (kind === "division") {
    title = isNew ? "New division" : "Edit division"; back = "#/more/entities";
    const ent = isNew ? r.c : v("entityId");
    body = `${nameField}<input type="hidden" name="entityId" value="${esc(ent || "")}">
      <p class="muted">Part of ${esc(name(ent))}.</p>${archive}`;
  } else return { title: "Not found", back: "#/more", html: "" };
  return {
    title, back,
    html: `<form data-form="edit" data-kind="${kind}" data-id="${esc(isNew ? "" : id)}" class="stack form-card" novalidate>${body}
      <p class="msg err" data-err hidden></p><div class="actions"><button class="btn primary big">Save</button></div></form>`,
  };
}

/* ================= Forms ================= */
const FORMS = {
  async connect(form, fd) {
    const btn = $("button", form); btn.disabled = true; btn.textContent = "Connecting…";
    const res = await connectGitHub(String(fd.get("owner")).trim(), String(fd.get("repo")).trim(), String(fd.get("token")).trim());
    if (!res.ok) { S.msg = { text: res.msg, err: true }; return render(); }
    S.msg = null; S.phase = "start"; render(); await boot(); render();
  },
  async create(form, fd) {
    const p1 = String(fd.get("p1")), p2 = String(fd.get("p2"));
    if (p1.length < 12) { S.msg = { err: true, text: "Use at least 12 characters. Four ordinary words is ideal." }; return render(); }
    if (p1 !== p2) { S.msg = { err: true, text: "The two passphrases don't match." }; return render(); }
    const btn = $("button", form); btn.disabled = true; btn.textContent = "Setting up encryption…";
    try { S.newRecovery = await createVault(p1); S.msg = null; S.phase = "recovery"; }
    catch (e) { S.msg = { err: true, text: friendlyGh(e) }; }
    render();
  },
  async recoveryDone() {
    S.newRecovery = null;
    if (S.phase === "recovery") { S.phase = "app"; startIdleWatch(); location.hash = "#/home"; render(); sync(); fetchRates().then(() => renderSoft(true)); }
  },
  async unlock(form, fd) {
    const btn = $("button", form); btn.disabled = true; btn.textContent = "Unlocking…";
    const ok = await unlock(String(fd.get("secret")), !!S.unlockWithRecovery);
    if (!ok) { S.msg = { err: true, text: S.unlockWithRecovery ? "That recovery key didn't work." : "That passphrase didn't work." }; return render(); }
    const viaRecovery = !!S.unlockWithRecovery;
    S.msg = null; S.unlockWithRecovery = false; S.phase = "app"; startIdleWatch();
    if (viaRecovery) { location.hash = "#/more/security"; toast("Unlocked. Now set a new passphrase."); }
    render(); sync(); fetchRates().then(() => renderSoft(true));
  },
  async txn(form, fd) {
    const f = Object.fromEntries(fd); f.tags = fd.getAll("tags");
    const errEl = $("[data-err]", form), btn = $("button.primary", form);
    errEl.hidden = true; btn.disabled = true;
    try {
      const built = await buildTxn(f.type, f);
      const old = f.id ? book().byId.get(f.id) : null;
      const saved = put({ ...(old || {}), ...built, id: f.id || uid("t"), stmtIds: (old && old.stmtIds) || [], invoiceId: f.invoiceId || (old && old.invoiceId) || null });
      if (f.invoiceId && typeof linkPayment === "function") linkPayment(saved, f.invoiceId);
      toast("Saved");
      history.length > 1 && !f.id ? go(backFrom()) : go("#/activity");
    } catch (e) { errEl.textContent = e.message; errEl.hidden = false; btn.disabled = false; errEl.scrollIntoView({ block: "center", behavior: "smooth" }); }
  },
  async edit(form, fd) {
    const kind = form.dataset.kind, id = form.dataset.id || uid({ account: "acc", person: "per", category: "cat", entity: "ent", division: "div" }[kind]);
    const old = book().byId.get(id) || { id, kind };
    const errEl = $("[data-err]", form);
    const nm = String(fd.get("name") || "").trim();
    if (!nm) { errEl.textContent = "Give it a name."; errEl.hidden = false; return; }
    const rec = { ...old, id, kind, name: nm };
    if (fd.has("note")) rec.note = String(fd.get("note")).trim();
    if (!old.system) rec.archived = fd.get("archived") === "on";
    if (kind === "account") {
      const curs = fd.getAll("currencies");
      if (!curs.length) { errEl.textContent = "Tick at least one currency."; errEl.hidden = false; return; }
      const min = String(fd.get("minBalance") || "").trim(), minV = min ? parseMoney(min) : null;
      if (min && !Number.isFinite(minV)) { errEl.textContent = "Check the minimum balance."; errEl.hidden = false; return; }
      const l4 = String(fd.get("last4") || "").trim();
      if (l4 && !/^\d{4}$/.test(l4)) { errEl.textContent = "Last 4 digits should be four numbers."; errEl.hidden = false; return; }
      Object.assign(rec, { entityId: fd.get("entityId"), type: fd.get("type"), currencies: curs, last4: l4, minBalance: minV, joint: fd.get("joint") === "on" });
    }
    if (kind === "person") rec.group = fd.get("group");
    if (kind === "category") rec.group = fd.get("group");
    if (kind === "entity") rec.type = fd.get("type");
    if (kind === "division") rec.entityId = fd.get("entityId");
    put(rec);
    toast("Saved");
    go({ account: `#/account/${encodeURIComponent(id)}`, person: `#/person/${encodeURIComponent(id)}`, category: "#/more/categories", entity: "#/more/entities", division: "#/more/entities" }[kind]);
  },
  async changePass(form, fd) {
    const p1 = String(fd.get("p1")), p2 = String(fd.get("p2"));
    if (p1.length < 12) return toast("Use at least 12 characters.", true);
    if (p1 !== p2) return toast("The two passphrases don't match.", true);
    try { await changePassphrase(p1); form.reset(); toast("Passphrase changed"); } catch (e) { toast(friendlyGh(e), true); }
  },
};
let lastList = "#/home";
function backFrom() { return lastList; }
window.addEventListener("hashchange", () => {
  const n = route().name;
  if (["home", "activity", "account", "person", "accounts", "people"].includes(n)) lastList = location.hash;
});

/* ================= Actions ================= */
const ACTS = {
  importFor(el) { IMP = null; window.__importFor = el.dataset.id; go("#/import"); },
  lock() { lockNow(); },
  sync() { sync(); },
  toggleRecovery() { S.unlockWithRecovery = !S.unlockWithRecovery; S.msg = null; render(); },
  async copyRecovery() { try { await navigator.clipboard.writeText($("#rk").textContent); toast("Copied"); } catch { toast("Couldn't copy. Write it down instead.", true); } },
  delTxn(el) {
    if (el.dataset.armed !== "1") { el.dataset.armed = "1"; el.textContent = "Tap again to delete"; setTimeout(() => { el.dataset.armed = ""; el.textContent = "Delete"; }, 4000); return; }
    const t = book().byId.get(el.dataset.id);
    if (t) releaseLines(t);
    remove(el.dataset.id); toast((t && (t.stmtIds || []).length) ? "Deleted. Its statement lines are back in the Inbox." : "Deleted"); go("#/activity");
  },
  dupTxn(el) {
    const t = book().byId.get(el.dataset.id);
    if (!t) return;
    const copy = { ...t, id: uid("t"), date: todayISO(), createdAt: null, stmtIds: [], form: { ...t.form, date: todayISO() } };
    put(copy); toast("Duplicated with today's date"); go(`#/txn/${encodeURIComponent(copy.id)}`);
  },
  export() {
    const out = { app: "jays-money", kind: "export", exportedAt: new Date().toISOString(), items: [...S.items.values()] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `j-finance-export-${todayISO()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
  async newRecovery() {
    if (!confirm("Make a new recovery key? The old one will stop working.")) return;
    try { const k = await replaceRecoveryKey(); S.newRecovery = k; S.phase = "recovery"; render(); } catch (e) { toast(friendlyGh(e), true); }
  },
  async forget() {
    if (!confirm("Disconnect this device? Your data stays on GitHub and your other devices.")) return;
    await forgetDevice(); render();
  },
  async refreshRates() { S.rates = null; await fetchRates(); render(); toast(S.rates ? "Rates updated" : "Couldn't fetch rates", !S.rates); },
};
/** A file of ready-made entries (e.g. the company expense log). The app builds each entry itself.
    Skips entries already imported, and ones that look already recorded (same account, amount, within 3 days). */
async function importEntries(data) {
  const kinds = new Set(["account", "person", "category"]);
  const newItems = (data.items || []).filter((x) => x && x.id && kinds.has(x.kind) && !S.items.has(x.id) && !S.tomb[x.id]);
  if (newItems.length) putMany(newItems);
  const before = book();
  const keys = new Set(before.txns.map((t) => t.importKey).filter(Boolean));
  const recs = [], skippedKey = [], looksDup = [], failed = [];
  for (const e of data.entries || []) {
    if (e.key && keys.has(e.key)) { skippedKey.push(e); continue; }
    const acc = e.form.account, amt = parseMoney(e.form.amount) * (e.type === "out" ? -1 : 1);
    const dup = (before.acctTx.get(acc) || []).find((t) => Math.abs(Date.parse(t.date) - Date.parse(e.form.date)) <= 3 * 864e5 &&
      t.lines.some((l) => l.t === "a" && l.ref === acc && l.amt === amt));
    if (dup) { looksDup.push(`${fmtDate(e.form.date)} ${e.form.desc} ${money(Math.abs(amt), e.form.cur)} → already: ${dup.desc}`); continue; }
    try { recs.push({ ...(await buildTxn(e.type, e.form)), id: uid("t"), importKey: e.key || null }); }
    catch (err) { failed.push(`${e.form.desc}: ${err.message}`); }
  }
  if (recs.length) putMany(recs);
  const parts = [`Added ${recs.length} entr${recs.length === 1 ? "y" : "ies"}`];
  if (skippedKey.length) parts.push(`${skippedKey.length} already imported`);
  if (looksDup.length) parts.push(`${looksDup.length} looked already recorded`);
  if (failed.length) parts.push(`${failed.length} couldn't be added`);
  toast(parts.join(", "));
  if (looksDup.length || failed.length) console.info("Import details", { looksDup, failed });
  S.lastImportReport = { looksDup, failed };
  go("#/activity");
}
const CHANGE_ACTS = {
  async importFile(el) {
    const file = el.files && el.files[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { return toast("That file isn't valid JSON.", true); }
    if (data && data.app === "jays-money" && data.kind === "entries") return importEntries(data);
    if (!data || data.app !== "jays-money" || !Array.isArray(data.items)) return toast("That isn't a J Finance starter file.", true);
    const kinds = new Set(["entity", "division", "account", "person", "category", "todo", "txn", "rule", "sched", "invoice", "budget"]);
    const fresh = data.items.filter((x) => x && x.id && kinds.has(x.kind) && !S.items.has(x.id) && !S.tomb[x.id]);
    if (fresh.some((x) => x.kind === "txn" && !Array.isArray(x.lines))) return toast("The file has entries without lines.", true);
    putMany(fresh);
    toast(`Added ${fresh.length} item${fresh.length === 1 ? "" : "s"}${fresh.length < data.items.length ? `, skipped ${data.items.length - fresh.length} already here` : ""}`);
    go("#/home");
  },
  todo(el) { const t = book().byId.get(el.dataset.id); if (t) put({ ...t, done: el.checked }); },
};
app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || !ACTS[el.dataset.act]) return;
  e.preventDefault(); ACTS[el.dataset.act](el, e);
});
app.addEventListener("change", (e) => {
  const el = e.target.closest("[data-act-change]");
  if (el && CHANGE_ACTS[el.dataset.actChange]) CHANGE_ACTS[el.dataset.actChange](el, e);
});
app.addEventListener("submit", (e) => {
  const form = e.target;
  if (!form.dataset.form || !FORMS[form.dataset.form]) return;
  e.preventDefault();
  FORMS[form.dataset.form](form, new FormData(form));
});
window.addEventListener("hashchange", () => { if (S.phase === "app") render(); });

/* ================= Locking ================= */
let idleT = 0, hiddenAt = 0;
function bumpIdle() { if (S.phase !== "app") return; clearTimeout(idleT); idleT = setTimeout(lockNow, IDLE_LOCK_MS); }
function startIdleWatch() { bumpIdle(); }
async function lockNow() {
  if (S.phase !== "app") return;
  clearTimeout(idleT);
  await saveLocalNow();
  wipeMemory(); S.phase = "unlock"; S.msg = null; render();
}
for (const ev of ["pointerdown", "keydown", "touchstart"]) document.addEventListener(ev, bumpIdle, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); if (S.phase === "app") saveLocalNow(); }
  else if (S.phase === "app" && hiddenAt && Date.now() - hiddenAt > AWAY_LOCK_MS) lockNow();
  else if (S.phase === "app") sync();
});
window.addEventListener("online", () => { S.online = true; if (S.phase === "app") sync(); else updateStatus(); });
window.addEventListener("offline", () => { S.online = false; updateStatus(); });
setInterval(() => { if (S.phase === "app" && !document.hidden) sync(); }, 60000);
setInterval(updateStatus, 30000);

/* ================= Start ================= */
onChange = () => { saveLocal(); scheduleSync(2500); renderSoft(true); };
onSync = (changed) => renderSoft(changed);
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
render();
boot().then(render, (e) => { S.phase = "connect"; S.msg = { err: true, text: friendlyGh(e) }; render(); });
