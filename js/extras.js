"use strict";
/* J Finance: receipts and the accountant pack.
   Each receipt is shrunk (photos), encrypted on this device and stored as its own file in the private repository:
   receipts/<id>.json. The pack is a plain (unencrypted) zip you hand to the accountants. */

const MAX_RECEIPT = 8 * 1024 * 1024;

/* ================= Receipts ================= */
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
}
async function attachReceipt(txnId, file) {
  if (!navigator.onLine) throw new Error("Connect to the internet to add a receipt.");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf && !/^image\//.test(file.type)) throw new Error("Choose a photo or a PDF.");
  const blob = isPdf ? file : await shrinkImage(file);
  if (blob.size > MAX_RECEIPT) throw new Error("That file is over 8 MB. Try a smaller scan.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const id = uid("rcpt"), path = `receipts/${id}.json`;
  const env = await seal({ name: file.name, mime: isPdf ? "application/pdf" : "image/jpeg", data: bytesToB64(bytes) }, S.dek);
  const r = await writeFile(path, JSON.stringify(env), `Add receipt from ${deviceName()}`);
  if (!r.ok) throw await ghErr(r);
  try { await idbSet("rc:" + id, env); } catch {}
  const t = book().byId.get(txnId);
  const recs = [{ id, kind: "receipt", txnId, name: file.name.slice(0, 80) || (isPdf ? "receipt.pdf" : "receipt.jpg"), mime: isPdf ? "application/pdf" : "image/jpeg", size: blob.size, path }];
  if (t && (t.tags || []).includes("receipt")) recs.push({ ...t, tags: t.tags.filter((x) => x !== "receipt") });
  putMany(recs);
}
async function receiptBlob(rec) {
  let env = null;
  try { env = await idbGet("rc:" + rec.id); } catch {}
  if (!env) {
    const f = await readFile(rec.path);
    if (!f) throw new Error("This receipt's file isn't on GitHub.");
    env = JSON.parse(f.text);
    try { await idbSet("rc:" + rec.id, env); } catch {}
  }
  const d = await unseal(env, S.dek);
  return new Blob([b64ToBytes(d.data)], { type: d.mime });
}
async function deleteReceiptFile(rec) {
  try {
    const f = await readFile(rec.path);
    if (f) await gh(contentsPath(rec.path), { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Remove receipt", sha: f.sha }) });
  } catch {}
  try { await idbDel("rc:" + rec.id); } catch {}
}
function receiptsBox(t) {
  const list = book().receipts.filter((r) => r.txnId === t.id);
  return `<div class="field"><span class="lbl">Receipts</span>
    <div class="tags">${list.map((r) => `<span class="chip rc"><button type="button" class="link" data-act="openReceipt" data-id="${esc(r.id)}">${r.mime === "application/pdf" ? "📄" : "🧾"} ${esc(r.name)}</button>
      <button type="button" class="link danger-link" data-act="delReceipt" data-id="${esc(r.id)}" aria-label="Remove receipt">×</button></span>`).join("")}
    <label class="btn small">＋ Photo or PDF<input type="file" accept="image/*,application/pdf" data-act-change="addReceipt" data-id="${esc(t.id)}" hidden></label></div>
    <span class="hint">Encrypted before it leaves this device.</span></div>`;
}
function showOverlay(html) {
  closeOverlay();
  const el = document.createElement("div");
  el.className = "overlay"; el.innerHTML = `<div class="overlay-box">${html}<button class="btn" data-close>Close</button></div>`;
  el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-close]")) closeOverlay(); });
  document.body.appendChild(el);
}
function closeOverlay() { const o = $(".overlay"); if (o) { $$("img", o).forEach((i) => URL.revokeObjectURL(i.src)); o.remove(); } }

/** Entries that should have a receipt: tagged "Needs receipt", or a company cost without one. */
function missingReceipts(range) {
  const b = book(), have = new Set(b.receipts.map((r) => r.txnId));
  return b.txns.filter((t) => inRange(t.date, range) && !have.has(t.id) &&
    ((t.tags || []).includes("receipt") || t.lines.some((l) => l.t === "c" && l.ent === "ent_ha" && l.gbp > 0 && !NOT_PROFIT.has(l.ref) && l.ref !== CAT.salaries && l.ref !== CAT.fx)));
}
function viewReceipts(r) {
  const y = r.a ? Number(r.a) : todayISO() <= `${currentStart("co")}-12-31` ? currentStart("co") - 1 : currentStart("co");
  const range = periodRange("co", y), miss = missingReceipts(range), b = book();
  const haveN = b.receipts.filter((x) => { const t = b.byId.get(x.txnId); return t && inRange(t.date, range); }).length;
  return {
    title: "Receipts", back: "#/more",
    html: `<div class="filters"><a class="btn ghost" href="#/receipts/${y - 1}">‹ ${periodLabel("co", y - 1)}</a><b class="center-text">${periodLabel("co", y)}</b><a class="btn ghost" href="#/receipts/${y + 1}">${periodLabel("co", y + 1)} ›</a></div>
      <section class="card"><div class="kpis"><div><div class="kpi-label">Receipts attached</div><div class="kpi">${haveN}</div></div><div><div class="kpi-label">Still to find</div><div class="kpi ${miss.length ? "neg" : ""}">${miss.length}</div></div></div></section>
      <section class="card"><div class="card-head"><h2>Still to find</h2></div><p class="pad-x muted small">Company costs without a receipt, and anything tagged "Needs receipt". Open one and tap ＋ Photo or PDF.</p>
        <div class="list">${miss.slice(0, 300).map((t) => txnRow(t)).join("") || `<p class="muted pad">All done.</p>`}</div></section>`,
  };
}

/* ================= Accountant pack ================= */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
/** A plain zip (files stored, not compressed), built here so nothing extra is loaded. */
function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff, dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const nameB = enc.encode(f.name), data = f.bytes, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, nameB.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nameB, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nameB.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cenSize = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cenSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/zip" });
}
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "entry";
let PACK = { ent: "ent_ha", kind: "co", y: null };
function viewPack() {
  const b = book();
  if (PACK.y == null) PACK.y = todayISO() <= `${currentStart("co")}-12-31` ? currentStart("co") - 1 : currentStart("co");
  const range = periodRange(PACK.kind, PACK.y);
  const txs = b.txns.filter((t) => inRange(t.date, range) && t.lines.some((l) => l.ent === PACK.ent && l.t !== "a"));
  const rc = b.receipts.filter((x) => txs.some((t) => t.id === x.txnId));
  const years = []; for (let y = currentStart(PACK.kind) - 2; y <= currentStart(PACK.kind); y++) years.push(y);
  return {
    title: "Accountant pack", back: "#/more",
    html: `<section class="card pad"><h2>What's in it</h2>
      <p>One zip file for your accountants or bookkeeper: every entry as a spreadsheet (CSV), a profit and loss summary, the director's loan movements, the invoices, and the receipts, named to match the entries.</p>
      <div class="filters"><select data-pack="ent">${b.entities.map((e) => opt(e.id, e.name, e.id === PACK.ent)).join("")}</select>
        <select data-pack="kind">${Object.entries(PERIOD_KINDS).map(([k, l]) => opt(k, l, k === PACK.kind)).join("")}</select>
        <select data-pack="y">${years.map((y) => opt(y, periodLabel(PACK.kind, y), y === PACK.y)).join("")}</select></div>
      <p class="muted">${esc(fmtDate(range[0]))} to ${esc(fmtDate(range[1]))}: <b>${txs.length}</b> entries, <b>${rc.length}</b> receipts.</p>
      <p class="msg">The pack is <b>not encrypted</b>. Send it only to your accountants, and delete your copy afterwards.</p>
      <div class="actions" style="margin-top:12px"><button class="btn primary" data-act="buildPack"${txs.length ? "" : " disabled"}>Build the pack</button></div></section>`,
  };
}
app.addEventListener("change", (e) => {
  const el = e.target.closest("[data-pack]");
  if (!el) return;
  PACK[el.dataset.pack] = el.dataset.pack === "y" ? Number(el.value) : el.value;
  if (el.dataset.pack === "kind") PACK.y = currentStart(PACK.kind);
  renderApp();
});
async function buildPack() {
  const b = book(), range = periodRange(PACK.kind, PACK.y), ent = PACK.ent, entName = name(ent), label = periodLabel(PACK.kind, PACK.y);
  const files = [], txt = (n, s) => files.push({ name: n, bytes: enc.encode(s) });
  const rows = txnRows(range, ent);
  // Receipts
  const txs = b.txns.filter((t) => inRange(t.date, range) && t.lines.some((l) => l.ent === ent && l.t !== "a"));
  const recs = b.receipts.filter((x) => txs.some((t) => t.id === x.txnId));
  const names = new Map(); let failed = 0, k = 0;
  for (const rc of recs) {
    k++; toast(`Fetching receipts ${k} of ${recs.length}…`);
    const t = b.byId.get(rc.txnId);
    const fname = `receipts/${t.date}_${slug(t.desc)}_${rc.id.slice(-4)}.${rc.mime === "application/pdf" ? "pdf" : "jpg"}`;
    try { files.push({ name: fname, bytes: new Uint8Array(await (await receiptBlob(rc)).arrayBuffer()) }); names.set(t.id, [...(names.get(t.id) || []), fname]); }
    catch { failed++; }
  }
  rows[0].push("Receipt files");
  for (let i = 1; i < rows.length; i++) { const t = txs.find((x) => x.date === rows[i][0] && x.desc === rows[i][1]); rows[i].push(t ? (names.get(t.id) || []).join(" ") : ""); }
  txt("transactions.csv", toCSV(rows));
  // Profit and loss
  const pl = [["Category", "Type", "GBP"]];
  let inc = 0, cost = 0;
  for (const [k2, v] of categoryTotals(range, ent)) {
    const c = b.byId.get(k2.split("|")[0]);
    if (!c || !v) continue;
    pl.push([c.name + (k2.split("|")[1] ? " · " + name(k2.split("|")[1]) : ""), c.group === "income" ? "Income" : NOT_PROFIT.has(c.id) ? "Tax payment (not a cost)" : "Cost", (v / 100).toFixed(2)]);
    if (c.group === "income") inc += v; else if (!NOT_PROFIT.has(c.id)) cost += v;
  }
  pl.push([], ["Income", "", (inc / 100).toFixed(2)], ["Costs", "", (cost / 100).toFixed(2)], ["Profit", "", ((inc - cost) / 100).toFixed(2)]);
  if (ent === "ent_ha" && PACK.kind === "co") pl.push(["Corporation tax (app estimate)", "", (corpTax(inc - cost) / 100).toFixed(2)]);
  txt("profit-and-loss.csv", toCSV(pl));
  // Money between your entities (director's loan)
  const dl = [["Date", "Description", "With", "Amount GBP (+ they owe this entity, − this entity owes them)"]];
  for (const t of [...b.txns].reverse()) if (inRange(t.date, range)) for (const l of t.lines) if (l.t === "q" && l.ent === ent && l.ref.startsWith("ic:")) dl.push([t.date, t.desc, name(l.ref.slice(3)), (l.gbp / 100).toFixed(2)]);
  txt("between-entities.csv", toCSV(dl));
  // Invoices
  const iv = [["Number", "Date", "Due", "Client", "Status", "Net", "VAT", "Total", "Currency", "Paid", "Replaced by", "Note"]];
  for (const i of b.invoices.filter((x) => x.entityId === ent && inRange(x.date, range))) {
    const net = (i.lines || []).reduce((s, l) => s + (l.amount || 0), 0), tot = invoiceTotal(i);
    iv.push([i.number, i.date, i.dueDate, name(i.personId), STATUS_LABEL[invoiceStatus(i, b)], (net / 100).toFixed(2), ((tot - net) / 100).toFixed(2), (tot / 100).toFixed(2), i.cur, (invoicePaid(i, b) / 100).toFixed(2), i.replacedBy ? name(i.replacedBy) : "", i.note || ""]);
  }
  txt("invoices.csv", toCSV(iv));
  txt("README.txt", `J Finance: accountant pack\r\n${entName}, ${PERIOD_KINDS[PACK.kind]} ${label} (${range[0]} to ${range[1]})\r\nMade ${new Date().toLocaleString("en-GB")}\r\n\r\n` +
    `transactions.csv      every entry, one row per category or person line, with GBP values and the exchange rate used\r\n` +
    `profit-and-loss.csv   totals by category and division\r\nbetween-entities.csv  director's loan and other money between Jay's entities\r\n` +
    `invoices.csv          invoices issued in the period\r\nreceipts/             receipts, named date_description_id\r\n\r\nThis file is not encrypted. Keep it private.\r\n`);
  downloadBlob(`${slug(entName)}-accountant-pack-${label}.zip`, makeZip(files));
  toast(`Pack ready: ${rows.length - 1} rows, ${recs.length - failed} receipts${failed ? `, ${failed} couldn't be fetched` : ""}`, !!failed);
}
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ================= Actions ================= */
Object.assign(CHANGE_ACTS, {
  async addReceipt(el) {
    const file = el.files && el.files[0];
    if (!file) return;
    toast("Encrypting and uploading…");
    try { await attachReceipt(el.dataset.id, file); toast("Receipt added"); renderApp(); }
    catch (e) { toast(e.message || friendlyGh(e), true); }
  },
});
Object.assign(ACTS, {
  async openReceipt(el) {
    const rec = book().byId.get(el.dataset.id);
    if (!rec) return;
    try {
      const blob = await receiptBlob(rec), url = URL.createObjectURL(blob);
      if (rec.mime === "application/pdf") { showOverlay(`<p><b>${esc(rec.name)}</b></p><a class="btn primary" href="${url}" target="_blank" rel="noopener">Open PDF</a>`); }
      else showOverlay(`<img src="${url}" alt="Receipt: ${esc(rec.name)}">`);
    } catch (e) { toast(e.message || "Couldn't open the receipt.", true); }
  },
  async delReceipt(el) {
    const rec = book().byId.get(el.dataset.id);
    if (!rec || !confirm("Remove this receipt?")) return;
    remove(rec.id); await deleteReceiptFile(rec); toast("Receipt removed"); renderApp();
  },
  async buildPack(el) { el.disabled = true; try { await buildPack(); } catch (e) { toast(e.message || "Couldn't build the pack.", true); } el.disabled = false; },
});
