/* Tomi's Shoebox — standalone receipt app.
   Receipts are saved on this device first, then filed in Google Drive:
     Tomi's Shoebox/            (folder this app creates)
       <Category>/<date store amount>.jpg
       Shoebox Ledger           (Google Sheet, rebuilt on every change)
       shoebox-data.json        (the receipt list, shared by phone and laptop)
*/
(() => {
"use strict";
const BUILT_IN_CLIENT_ID = "551594370383-j0skc5pb0vb67jgmgqm6rohgfslv1pou.apps.googleusercontent.com";
const ROOT_NAME = "Tomi's Shoebox", DATA_NAME = "shoebox-data.json", LEDGER_NAME = "Shoebox Ledger";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const DAPI = "https://www.googleapis.com/drive/v3", UAPI = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder", SHEET = "application/vnd.google-apps.spreadsheet";
const RECENT = 5;
const APP_VERSION = "Version 8 · PDF reading fixed";
const { parseReceipt, CATEGORIES } = window.ShoeboxParse;
const $ = s => document.querySelector(s);

// ---------- storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem("shoebox." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("shoebox." + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("shoebox." + k); } catch {} },
};
let idbP = null;
function idb() {
  if (!idbP) idbP = new Promise((res, rej) => {
    const r = indexedDB.open("shoebox", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("photos");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return idbP;
}
async function photoStore(mode, fn) {
  try { const db = await idb(); return await new Promise((res, rej) => { const tx = db.transaction("photos", mode); const q = fn(tx.objectStore("photos")); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }); }
  catch { return null; }
}
const putPhoto = (id, blob) => photoStore("readwrite", s => s.put(blob, id));
const getPhoto = id => photoStore("readonly", s => s.get(id));
const delPhoto = id => photoStore("readwrite", s => s.delete(id));

let receipts = LS.get("receipts", []);
let drive = LS.get("drive", { folders: {} });
let token = LS.get("token", null);
const saveLocal = () => { LS.set("receipts", receipts); LS.set("drive", drive); };
const live = () => receipts.filter(r => !r.deleted);

// ---------- helpers ----------
const todayISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const money = (n, cur = "CAD") => { try { return new Intl.NumberFormat("en-CA", { style: "currency", currency: cur }).format(n || 0); } catch { return (n || 0).toFixed(2) + " " + cur; } };
const parseAmt = v => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? Math.round(n * 100) / 100 : null; };
const monthName = k => { const [y, m] = k.split("-").map(Number); return y && m ? new Date(y, m - 1, 1).toLocaleDateString("en-CA", { month: "long", year: "numeric" }) : ""; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const cleanName = s => String(s || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
const baseName = r => cleanName(`${r.date} ${r.merchant} ${money(r.total, r.currency)}`);

// ---------- photos & files on a receipt ----------
// r.attachments = [{ key, type, origName, driveId, url, parent, fileName, pending }]
// A new photo/file waits on this device (IndexedDB, under its key) with pending: true until it's uploaded.
const isImage = t => /^image\//.test(t || "");
const isPdf = t => t === "application/pdf";
const readable = a => isImage(a.type) || isPdf(a.type);
const extOf = a => (isImage(a.type) ? "jpg" : isPdf(a.type) ? "pdf" : ((a.origName || "").match(/\.([A-Za-z0-9]{1,6})$/)?.[1] || "file")).toLowerCase();
const atts = r => r.attachments || [];
function migrate(r) {
  if (r.attachments) return r;
  r.attachments = [];
  if (r.photoId) r.attachments.push({ key: r.id, type: "image/jpeg", driveId: r.photoId, url: r.photoUrl, fileName: r.photoName, trashed: !!r.photoTrashed });
  else if (r.hadPhoto && !r.deleted) r.attachments.push({ key: r.id, type: "image/jpeg", pending: true });
  ["photoId", "photoUrl", "photoName", "photoCat", "photoTrashed"].forEach(k => delete r[k]);
  return r;
}
receipts.forEach(migrate);
const receiptLink = r => atts(r).length > 1 ? (r.folderUrl || atts(r)[0]?.url) : atts(r)[0]?.url;
const attLabel = (a, i, n) => isImage(a.type) ? (n > 1 ? `Photo ${i + 1}` : "Photo") : (a.origName || (isPdf(a.type) ? "PDF" : "File"));
const qstr = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
let toastT; const toast = m => { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3000); };
const appURL = () => location.origin + location.pathname.replace(/index\.html$/, "");

// ---------- client id ----------
let clientId = BUILT_IN_CLIENT_ID || LS.get("clientId", "");
(() => {
  const p = new URLSearchParams(location.search), c = p.get("client");
  if (c) { clientId = c.trim(); LS.set("clientId", clientId); p.delete("client"); history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : "") + location.hash); }
})();

// ---------- Google sign-in ----------
const hasToken = () => !!(token && token.value && token.exp > Date.now() + 60e3);
function setToken(value, expiresIn) {
  token = { value, exp: Date.now() + (Number(expiresIn) || 3599) * 1000 };
  LS.set("token", token); LS.set("consented", true);
}
// Returning from the redirect sign-in (used when a popup can't open, e.g. some phone home-screen apps).
(() => {
  if (!location.hash.includes("access_token")) return;
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("state") === "shoebox" && h.get("access_token")) setToken(h.get("access_token"), h.get("expires_in"));
  history.replaceState(null, "", location.pathname + location.search);
})();

let tokenClient = null, authWaiters = [];
function initTokenClient() {
  if (tokenClient || !clientId || !window.google?.accounts?.oauth2) return !!tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId, scope: SCOPE,
    callback: resp => {
      const w = authWaiters; authWaiters = [];
      if (resp.access_token) { setToken(resp.access_token, resp.expires_in); w.forEach(f => f.res()); }
      else w.forEach(f => f.rej({ code: "auth", message: resp.error || "sign-in cancelled" }));
      renderAccount();
    },
    error_callback: err => {
      const w = authWaiters; authWaiters = [];
      if (err?.type === "popup_failed_to_open" && w.some(f => f.allowRedirect)) { redirectSignIn(); return; }
      w.forEach(f => f.rej({ code: "auth", message: err?.type || "sign-in cancelled" }));
      renderAccount();
    },
  });
  return true;
}
function redirectSignIn() {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: appURL(), response_type: "token", scope: SCOPE, include_granted_scopes: "true", state: "shoebox" });
  location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + q;
}
// Must be called directly inside a tap/click so the browser allows the Google popup.
function signIn(allowRedirect = true) {
  if (!clientId) { showSetup(true); return Promise.reject({ code: "setup" }); }
  if (!initTokenClient()) { if (allowRedirect) { redirectSignIn(); return new Promise(() => {}); } return Promise.reject({ code: "auth" }); }
  return new Promise((res, rej) => {
    authWaiters.push({ res, rej, allowRedirect });
    tokenClient.requestAccessToken({ prompt: LS.get("consented", false) ? "" : "consent" });
  });
}
function signOut() {
  if (token?.value && window.google?.accounts?.oauth2) { try { google.accounts.oauth2.revoke(token.value, () => {}); } catch {} }
  token = null; LS.del("token"); LS.set("consented", false); renderAccount(); setSync();
}

// ---------- Drive REST ----------
async function api(method, url, { body, headers, as } = {}) {
  if (!hasToken()) throw { code: "auth" };
  let r;
  try { r = await fetch(url, { method, headers: { Authorization: "Bearer " + token.value, ...(headers || {}) }, body }); }
  catch { throw { code: "offline" }; }
  if (r.status === 401) { token = null; LS.del("token"); throw { code: "auth" }; }
  if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch {} throw { code: "http", status: r.status, message: m || r.statusText }; }
  if (as === "text") return r.text();
  return r.status === 204 ? null : r.json();
}
const jsonBody = o => ({ body: JSON.stringify(o), headers: { "Content-Type": "application/json; charset=UTF-8" } });
async function findOne(q) {
  const r = await api("GET", `${DAPI}/files?` + new URLSearchParams({ q: q + " and trashed = false", fields: "files(id,name,webViewLink)", pageSize: "1", spaces: "drive" }));
  return r.files?.[0] || null;
}
const createFolder = (name, parent) => api("POST", `${DAPI}/files?fields=id,webViewLink`, jsonBody({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }));
function multipart(meta, blob, type) {
  const b = "shoebox" + uid();
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(meta), `\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${b}--`]);
  return api("POST", `${UAPI}/files?uploadType=multipart&fields=id,webViewLink`, { body, headers: { "Content-Type": `multipart/related; boundary=${b}` } });
}
const updateMedia = (id, blob, type) => api("PATCH", `${UAPI}/files/${id}?uploadType=media&fields=id,webViewLink`, { body: blob, headers: { "Content-Type": type } });
const trash = id => api("PATCH", `${DAPI}/files/${id}?fields=id`, jsonBody({ trashed: true }));
async function trashSafe(id) { try { await trash(id); } catch (e) { if (e.code === "auth" || e.code === "offline") throw e; } }
async function moveRename(id, parent, name, knownParent) {
  const params = new URLSearchParams({ fields: "id" });
  if (knownParent !== parent) {
    params.set("addParents", parent);
    const old = knownParent || (await api("GET", `${DAPI}/files/${id}?fields=parents`).catch(() => null))?.parents?.join(",");
    if (old && old !== parent) params.set("removeParents", old);
  }
  try { await api("PATCH", `${DAPI}/files/${id}?` + params, jsonBody({ name })); }
  catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
}
// Small files go up in one request; big ones (long PDFs, videos) use Drive's resumable upload.
async function upload(meta, blob, type) {
  if (blob.size < 4.5e6) return multipart(meta, blob, type);
  if (!hasToken()) throw { code: "auth" };
  let r;
  try {
    r = await fetch(`${UAPI}/files?uploadType=resumable&fields=id,webViewLink`, { method: "POST", headers: { Authorization: "Bearer " + token.value, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type }, body: JSON.stringify(meta) });
  } catch { throw { code: "offline" }; }
  if (r.status === 401) { token = null; LS.del("token"); throw { code: "auth" }; }
  const loc = r.headers.get("Location");
  if (!r.ok || !loc) throw { code: "http", status: r.status, message: "Google Drive didn't accept the upload." };
  try { r = await fetch(loc, { method: "PUT", headers: { "Content-Type": type }, body: blob }); } catch { throw { code: "offline" }; }
  if (!r.ok) throw { code: "http", status: r.status, message: "The upload didn't finish." };
  return r.json();
}

async function ensureRoot() {
  if (!drive.rootId) {
    const f = (await findOne(`name = '${qstr(ROOT_NAME)}' and mimeType = '${FOLDER}' and 'root' in parents`)) || (await createFolder(ROOT_NAME));
    drive = { folders: {}, rootId: f.id, rootUrl: f.webViewLink };
  }
  if (!drive.dataId) { const f = await findOne(`name = '${DATA_NAME}' and '${drive.rootId}' in parents`); if (f) drive.dataId = f.id; }
  if (!drive.ledgerId) { const f = await findOne(`name = '${qstr(LEDGER_NAME)}' and mimeType = '${SHEET}' and '${drive.rootId}' in parents`); if (f) { drive.ledgerId = f.id; drive.ledgerUrl = f.webViewLink; } }
  saveLocal();
}
async function ensureFolder(cat) {
  if (drive.folders?.[cat]) return drive.folders[cat];
  const f = (await findOne(`name = '${qstr(cat)}' and mimeType = '${FOLDER}' and '${drive.rootId}' in parents`)) || (await createFolder(cat, drive.rootId));
  drive.folders = { ...(drive.folders || {}), [cat]: f.id }; saveLocal();
  return f.id;
}

// ---------- categories: built-in + your own ----------
function allCategories() {
  const mine = new Set(LS.get("customCats", []));
  receipts.forEach(r => { if (!r.deleted) { mine.add(r.category); (r.items || []).forEach(i => i.category && mine.add(i.category)); } });
  CATEGORIES.forEach(c => mine.delete(c)); mine.delete(undefined); mine.delete("");
  const base = CATEGORIES.filter(c => c !== "Other");
  return [...base, ...[...mine].sort((a, b) => a.localeCompare(b)), "Other"];
}
function catOptions(selected, { same = false } = {}) {
  const cats = allCategories();
  if (selected && !cats.includes(selected)) cats.splice(cats.length - 1, 0, selected);
  return (same ? `<option value="">Same as receipt</option>` : "") +
    cats.map(c => `<option${c === selected ? " selected" : ""}>${esc(c)}</option>`).join("") +
    `<option value="__new__">＋ New category…</option>`;
}

// ---------- ledger ----------
// One row per item. Tax gets its own row, and any gap between the items and the total
// becomes an "other charges" or "discounts" row, so every receipt adds up to what you paid.
// One row per item. Tax gets its own row (split across the item categories in proportion), and any gap
// between the items and the total becomes an "other charges" or "discounts" row, so every receipt adds up to what you paid.
function lineRows(r) {
  const total = r.total ?? 0, tax = r.tax ?? 0, rc = r.category || "Other";
  const items = (r.items || []).filter(i => i && i.name && i.price != null && isFinite(i.price));
  // A discount with no category of its own comes off the receipt's biggest item category.
  const spend = {}; items.forEach(i => { if (i.price > 0) { const c = i.category || rc; spend[c] = (spend[c] || 0) + i.price; } });
  const mainCat = Object.keys(spend).sort((a, b) => spend[b] - spend[a])[0] || rc;
  const rows = items.length ? items.map(i => ({ item: i.name, price: i.price, tax: null, cat: i.category || (i.price < 0 ? mainCat : rc) }))
                            : [{ item: r.item || "Purchase", price: Math.round((total - tax) * 100) / 100, tax: null, cat: rc }];
  const diff = Math.round((total - tax - rows.reduce((a, x) => a + x.price, 0)) * 100) / 100;
  if (items.length && Math.abs(diff) >= 0.01) rows.push({ item: diff > 0 ? "Other charges (not itemized)" : "Discounts / adjustments", price: diff, tax: null, cat: rc });
  if (tax) {
    const byCat = {};
    rows.forEach(x => { if (x.price > 0) byCat[x.cat] = (byCat[x.cat] || 0) + x.price; });
    const cats = Object.keys(byCat), base = cats.reduce((a, c) => a + byCat[c], 0);
    if (cats.length <= 1 || base <= 0) rows.push({ item: "Tax (GST/HST)", price: null, tax, cat: cats[0] || rc });
    else {
      let left = Math.round(tax * 100);
      const parts = cats.map(c => ({ c, cents: Math.floor(Math.round(tax * 100) * byCat[c] / base) }));
      parts.forEach(pt => left -= pt.cents);
      parts.sort((a, b) => byCat[b.c] - byCat[a.c])[0].cents += left;
      parts.forEach(pt => pt.cents && rows.push({ item: `Tax (GST/HST) on ${pt.c}`, price: null, tax: pt.cents / 100, cat: pt.c }));
    }
  }
  return rows;
}
// Totals per category (items + their tax) for a set of receipts.
function categoryTotals(rs) {
  const t = {};
  rs.forEach(r => lineRows(r).forEach(x => { t[x.cat] = (t[x.cat] || 0) + (x.price || 0) + (x.tax || 0); }));
  Object.keys(t).forEach(k => { t[k] = Math.round(t[k] * 100) / 100; if (!t[k]) delete t[k]; });
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
}
function ledgerCSV(receiptsSorted) {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const blank = n => Array(n).fill("");
  const out = [["Date", "Item", "Store", "Category", "Type", "Price", "Tax", "Currency", "Receipt total", "Receipt #", "Photo / file", "Year"]];
  receiptsSorted.forEach((r, ri) => {
    lineRows(r).forEach((x, i) => out.push([r.date, x.item, r.merchant, x.cat, r.kind === "business" ? "Business" : "Personal",
      x.price != null ? x.price.toFixed(2) : "", x.tax != null ? x.tax.toFixed(2) : "", r.currency,
      i === 0 ? (r.total ?? 0).toFixed(2) : "", `#${ri + 1}`,
      i === 0 && receiptLink(r) ? `=HYPERLINK("${receiptLink(r)}","${atts(r).length > 1 ? `View ${atts(r).length} files` : isImage(atts(r)[0].type) ? "View photo" : "View file"}")` : "", (r.date || "").slice(0, 4)]));
  });
  const n = Math.max(out.length, 2), R = c => `$${c}$2:$${c}$${n}`;
  const F = R("F"), G = R("G"), D = R("D"), E = R("E"), J = R("J"), L = R("L");
  const mixed = new Set(receiptsSorted.map(r => r.currency)).size > 1;
  const years = [...new Set(receiptsSorted.map(r => (r.date || "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const cats = allCategories().filter(c => receiptsSorted.some(r => lineRows(r).some(x => x.cat === c)));
  for (const y of years) {
    const yc = `${L},"${y}"`;
    out.push([]);
    out.push([`${y} TOTAL SPENT${mixed ? " (all currencies)" : ""}`, ...blank(4), `=SUMIFS(${F},${yc})+SUMIFS(${G},${yc})`, "", "", "", `=COUNTUNIQUEIFS(${J},${yc})&" receipts"`, "", ""]);
    out.push([`${y} BY CATEGORY`, ...blank(4), "Items", "Tax", "", "Total", "Receipts", "", ""]);
    cats.filter(c => receiptsSorted.some(r => (r.date || "").startsWith(y) && lineRows(r).some(x => x.cat === c))).forEach(c => out.push([c, ...blank(4), `=SUMIFS(${F},${yc},${D},"${c}")`, `=SUMIFS(${G},${yc},${D},"${c}")`, "",
      `=SUMIFS(${F},${yc},${D},"${c}")+SUMIFS(${G},${yc},${D},"${c}")`, `=COUNTUNIQUEIFS(${J},${yc},${D},"${c}")`, "", ""]));
    out.push([`${y} BY TYPE`, ...blank(4), "Items", "Tax", "", "Total", "Receipts", "", ""]);
    ["Personal", "Business"].forEach(k => out.push([k, ...blank(4), `=SUMIFS(${F},${yc},${E},"${k}")`, `=SUMIFS(${G},${yc},${E},"${k}")`, "",
      `=SUMIFS(${F},${yc},${E},"${k}")+SUMIFS(${G},${yc},${E},"${k}")`, `=COUNTUNIQUEIFS(${J},${yc},${E},"${k}")`, "", ""]));
  }
  if (years.length > 1) {
    out.push([]);
    out.push([`ALL YEARS TOTAL SPENT${mixed ? " (all currencies)" : ""}`, ...blank(4), `=SUM(${F})+SUM(${G})`, "", "", "", `=COUNTUNIQUE(${J})&" receipts"`, "", ""]);
  }
  return out.map(r => r.map(q).join(",")).join("\n");
}
async function writeLedger() {
  const rows = live().slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const csv = new Blob([ledgerCSV(rows)], { type: "text/csv" });
  if (drive.ledgerId) {
    try { const f = await updateMedia(drive.ledgerId, csv, "text/csv"); if (f?.webViewLink) drive.ledgerUrl = f.webViewLink; return; }
    catch (e) { if (e.code !== "http") throw e; }
  }
  const old = drive.ledgerId;
  const f = await multipart({ name: LEDGER_NAME, mimeType: SHEET, parents: [drive.rootId] }, csv, "text/csv");
  drive.ledgerId = f.id; drive.ledgerUrl = f.webViewLink;
  if (old) { try { await trash(old); } catch {} }
}

// ---------- sync ----------
function merge(local, remote) {
  const m = new Map(local.map(r => [r.id, r]));
  for (const r of remote) { const l = m.get(r.id); if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) m.set(r.id, r); }
  return [...m.values()];
}
let syncing = false, again = false, syncErr = null;
async function sync() {
  if (!clientId || !hasToken()) { setSync(); return; }
  if (syncing) { again = true; return; }
  syncing = true; syncErr = null; setSync();
  try {
    await ensureRoot();
    if (drive.dataId) {
      try { const txt = await api("GET", `${DAPI}/files/${drive.dataId}?alt=media`, { as: "text" }); receipts = merge(receipts, JSON.parse(txt || "{}").receipts || []); receipts.forEach(migrate); }
      catch (e) { if (e.status === 404) drive.dataId = null; else if (!(e instanceof SyntaxError)) throw e; }
      saveLocal(); render();
    }
    for (const r of receipts) {
      migrate(r);
      const list = atts(r);
      if (r.deleted) {
        for (const a of list) if (a.driveId && !a.trashed) { await trashSafe(a.driveId); a.trashed = true; saveLocal(); }
        if (r.folderId && !r.folderTrashed) { await trashSafe(r.folderId); r.folderTrashed = true; saveLocal(); }
        continue;
      }
      if (r.removed?.length) { for (const id of r.removed) await trashSafe(id); r.removed = []; saveLocal(); }
      if (!list.length) { if (r.folderId) { await trashSafe(r.folderId); ["folderId", "folderUrl", "folderCat", "folderName"].forEach(k => delete r[k]); saveLocal(); } continue; }
      const base = baseName(r), catFolder = await ensureFolder(r.category), multi = list.length > 1;
      let parent = catFolder;
      // A receipt with several photos/files gets its own folder inside the category folder.
      if (multi) {
        if (!r.folderId) { const f = await createFolder(base, catFolder); Object.assign(r, { folderId: f.id, folderUrl: f.webViewLink, folderCat: r.category, folderName: base, updatedAt: Date.now() }); saveLocal(); }
        else if (r.folderCat !== r.category || r.folderName !== base) { await moveRename(r.folderId, catFolder, base, r.folderCat === r.category ? catFolder : undefined); Object.assign(r, { folderCat: r.category, folderName: base, updatedAt: Date.now() }); saveLocal(); }
        parent = r.folderId;
      }
      for (let i = 0; i < list.length; i++) {
        const a = list[i], name = (multi ? `${base} (${i + 1} of ${list.length})` : base) + "." + extOf(a);
        if (a.pending) {
          const blob = await getPhoto(a.key);
          if (!blob) continue;                                   // saved on another device; it uploads from there
          const f = await upload({ name, parents: [parent] }, blob, a.type || blob.type || "application/octet-stream");
          Object.assign(a, { driveId: f.id, url: f.webViewLink, parent, fileName: name, pending: false }); r.updatedAt = Date.now();
          await delPhoto(a.key); saveLocal();
        } else if (a.driveId && (a.parent !== parent || a.fileName !== name)) {
          await moveRename(a.driveId, parent, name, a.parent);
          Object.assign(a, { parent, fileName: name }); r.updatedAt = Date.now(); saveLocal();
        }
      }
      if (!multi && r.folderId) { await trashSafe(r.folderId); ["folderId", "folderUrl", "folderCat", "folderName"].forEach(k => delete r[k]); r.updatedAt = Date.now(); saveLocal(); }
    }
    for (const id of LS.get("trashLater", [])) { try { await trash(id); } catch (e) { if (e.code === "auth" || e.code === "offline") throw e; } }
    LS.set("trashLater", []);
    const data = new Blob([JSON.stringify({ app: ROOT_NAME, version: 1, updatedAt: Date.now(), receipts }, null, 1)], { type: "application/json" });
    if (drive.dataId) { try { await updateMedia(drive.dataId, data, "application/json"); } catch (e) { if (e.status === 404) drive.dataId = null; else throw e; } }
    if (!drive.dataId) { const f = await multipart({ name: DATA_NAME, parents: [drive.rootId], mimeType: "application/json" }, data, "application/json"); drive.dataId = f.id; }
    await writeLedger();
    drive.lastSync = Date.now(); drive.dirty = false; saveLocal();
    setTimeout(backfillItems, 300);
  } catch (e) {
    if (e?.status === 404 && drive.rootId) { drive = { folders: {} }; saveLocal(); again = true; }   // folder was deleted: start fresh
    syncErr = e?.code === "auth" ? "auth" : e?.code === "offline" ? "offline" : (e?.message || "Google Drive refused the change.");
    drive.dirty = true; saveLocal();
  } finally {
    syncing = false; render();
    if (again) { again = false; setTimeout(sync, 400); }
  }
}
// Receipts saved before item reading existed have no item list. Read their photos from Drive
// in the background (one at a time) and add the items, then re-sync so the ledger is itemized.
let backfilling = false, backfillMsg = "";
async function backfillItems() {
  if (backfilling || !hasToken() || !window.Tesseract) return;
  const todo = live().filter(r => r.items === undefined && atts(r).some(a => a.driveId && readable(a)));
  if (!todo.length) return;
  backfilling = true;
  let done = 0;
  try {
    for (const r of todo) {
      backfillMsg = `Listing the items on ${todo.length === 1 ? "a saved receipt" : `saved receipts (${done + 1} of ${todo.length})`}…`; setSync();
      const texts = [];
      for (const a of atts(r).filter(a => a.driveId && readable(a))) {
        const blob = await driveBlob(a.driveId);
        if (blob) texts.push((await textFrom(blob, a.type)).text);
      }
      const cur = receipts.find(x => x.id === r.id);
      if (!cur || cur.deleted || cur.items !== undefined) continue;
      if (!texts.length) { Object.assign(cur, { items: [], updatedAt: Date.now() }); saveLocal(); continue; }
      const popts = { today: todayISO(), learned: learnedMap(), categories: allCategories() };
      const p = parseReceipt(joinParts(texts), popts);
      if (texts.length > 1) p.items = itemsFromParts(texts, popts);
      const itemSum = p.items.reduce((a, i) => a + i.price, 0);
      // If the photo's tax makes the items add up exactly and the saved tax doesn't, the saved tax was a misread.
      const fixTax = p.tax != null && cur.total != null && Math.abs(itemSum + p.tax - cur.total) < 0.005 && Math.abs(itemSum + (cur.tax || 0) - cur.total) >= 0.005;
      Object.assign(cur, { items: p.items, ...(fixTax ? { tax: p.tax } : {}), needsCheck: cur.needsCheck || p.items.some(i => i.name === "Unreadable item"), updatedAt: Date.now() });
      drive.dirty = true; saveLocal(); render(); done++;
    }
  } catch {} finally {
    backfilling = false; backfillMsg = "";
    if (done) { toast(`Listed the items on ${done} saved receipt${done > 1 ? "s" : ""}.`); sync(); } else setSync();
  }
}
async function driveBlob(id) {
  if (!hasToken()) return null;
  try {
    const res = await fetch(`${DAPI}/files/${id}?alt=media`, { headers: { Authorization: "Bearer " + token.value } });
    if (res.status === 401) { token = null; LS.del("token"); return null; }
    return res.ok ? await res.blob() : null;
  } catch { return null; }
}
function setSync() {
  const dot = $("#syncDot"), msg = $("#syncMsg"), btn = $("#syncBtn");
  const unsynced = drive.dirty || receipts.some(r => !r.deleted && atts(r).some(a => a.pending));
  btn.hidden = true;
  if (!clientId) { dot.className = "dot err"; msg.textContent = "Saved on this device. Set up Google Drive to file your receipts."; return; }
  if (syncing) { dot.className = "dot busy"; msg.textContent = "Saving to Google Drive…"; return; }
  if (backfilling) { dot.className = "dot busy"; msg.textContent = backfillMsg; return; }
  if (!hasToken()) { dot.className = "dot err"; msg.textContent = unsynced ? "Saved on this device. Connect Google Drive to file it." : "Connect Google Drive to sync."; btn.hidden = false; btn.textContent = "Connect"; return; }
  if (syncErr === "offline") { dot.className = "dot err"; msg.textContent = "You're offline. Receipts are saved here and will sync later."; btn.hidden = false; btn.textContent = "Try again"; return; }
  if (syncErr) { dot.className = "dot err"; msg.textContent = "Sync didn't finish: " + syncErr; btn.hidden = false; btn.textContent = "Try again"; return; }
  dot.className = "dot";
  msg.textContent = drive.lastSync ? `All filed. Last synced ${new Date(drive.lastSync).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`.replace(/\.?$/, ".") : "Connected.";
  btn.hidden = false; btn.textContent = "Sync now";
}
// Called from taps: get a token if needed (popup must open inside the tap), then sync.
function syncFromTap() {
  if (!clientId) return showSetup(true);
  if (hasToken()) return sync();
  signIn().then(sync, e => { if (e?.code !== "setup") toast("Google sign-in didn't finish. Tap Connect to try again."); });
}
$("#syncBtn").addEventListener("click", syncFromTap);

// ---------- account / setup ----------
function renderAccount() {
  const dot = $("#acctDot"), txt = $("#acctText");
  if (!clientId) { dot.className = "dot err"; txt.textContent = "Set up Google Drive"; }
  else if (hasToken()) { dot.className = "dot"; txt.textContent = "Google Drive connected"; }
  else { dot.className = "dot err"; txt.textContent = "Connect Google Drive"; }
  $("#driveInfo").textContent = drive.rootId ? `Filing into "${ROOT_NAME}" in your Drive.` + (hasToken() ? "" : " Signed out on this device.") : "Not connected yet.";
}
function showSetup(open) {
  $("#setupCard").hidden = !!clientId;
  $("#originHint").textContent = location.origin;
  if (open) { $("#setupCard").hidden = false; $("#guide").open = true; $("#setupCard").scrollIntoView({ behavior: "smooth", block: "start" }); }
}
$("#accountChip").addEventListener("click", () => {
  if (!clientId) return showSetup(true);
  if (hasToken()) { openSettings(); return; }
  syncFromTap();
});
$("#saveClientBtn").addEventListener("click", () => {
  const v = $("#clientIdInput").value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { $("#clientIdInput").focus(); return toast("That doesn't look like a Client ID. It ends in .apps.googleusercontent.com"); }
  clientId = v; LS.set("clientId", v); tokenClient = null;
  showSetup(false); renderAccount(); setSync();
  syncFromTap();
});

// ---------- settings ----------
function openSettings() {
  $("#setupLink").value = clientId ? appURL() + "?client=" + encodeURIComponent(clientId) : "Set up Google Drive first.";
  $("#clientIdEdit").value = clientId;
  renderAccount();
  $("#settingsSheet").hidden = false;
}
$("#settingsBtn").addEventListener("click", openSettings);
$("#settingsClose").addEventListener("click", () => $("#settingsSheet").hidden = true);
$("#copyLinkBtn").addEventListener("click", async () => {
  const el = $("#setupLink");
  try { await navigator.clipboard.writeText(el.value); toast("Link copied. Open it on your other device."); }
  catch { el.select(); toast("Select the link and copy it."); }
});
$("#clientIdSave").addEventListener("click", () => {
  const v = $("#clientIdEdit").value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) return toast("That doesn't look like a Client ID.");
  clientId = v; LS.set("clientId", v); tokenClient = null; signOut(); showSetup(false); toast("Saved. Tap Connect to sign in.");
});
$("#disconnectBtn").addEventListener("click", () => { signOut(); $("#settingsSheet").hidden = true; toast("Signed out on this device."); });

// ---------- install ----------
let installEvt = null;
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function showInstall() {
  if (standalone() || LS.get("installDismissed", false)) { $("#installBar").hidden = true; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (installEvt) { $("#installText").textContent = "Install Shoebox so it opens like a normal app."; $("#installBtn").hidden = false; $("#installBar").hidden = false; }
  else if (ios) { $("#installText").innerHTML = "To add Shoebox to your Home Screen, tap <b>Share</b> then <b>Add to Home Screen</b>."; $("#installBtn").hidden = true; $("#installBar").hidden = false; }
}
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; showInstall(); });
addEventListener("appinstalled", () => { $("#installBar").hidden = true; toast("Shoebox is installed."); });
$("#installBtn").addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $("#installBar").hidden = true; });
$("#installDismiss").addEventListener("click", () => { LS.set("installDismissed", true); $("#installBar").hidden = true; });

// ---------- render ----------
function render() {
  const all = live();
  const nowM = todayISO().slice(0, 7), year = nowM.slice(0, 4);
  const thisM = all.filter(r => (r.date || "").startsWith(nowM));
  const cadM = thisM.filter(r => r.currency === "CAD");
  $("#mLabel").textContent = monthName(nowM);
  $("#lblDate").textContent = new Date().toLocaleDateString("en-CA", { month: "short", year: "numeric" }).toUpperCase();
  $("#lblCount").textContent = all.length;
  $("#lblMonth").textContent = thisM.length;
  const first = all.map(r => r.date).filter(Boolean).sort()[0];
  $("#lblSince").textContent = first ? new Date(first + "T12:00").toLocaleDateString("en-CA", { month: "short", year: "2-digit" }).replace(".", "") : "New";
  $("#mTotal").textContent = money(cadM.reduce((a, r) => a + (r.total || 0), 0));
  const other = thisM.length - cadM.length;
  $("#mCount").textContent = thisM.length ? `${thisM.length} receipt${thisM.length > 1 ? "s" : ""}${other ? ` · ${other} in other currencies` : ""}` : "No receipts yet";
  const biz = all.filter(r => r.kind === "business" && (r.date || "").startsWith(year) && r.currency === "CAD");
  $("#bizTotal").textContent = money(biz.reduce((a, r) => a + (r.total || 0), 0));
  $("#bizCount").textContent = `${biz.length} business receipt${biz.length === 1 ? "" : "s"} in ${year}`;
  const thisY = all.filter(r => (r.date || "").startsWith(year)), cadY = thisY.filter(r => r.currency === "CAD");
  $("#yLabel").textContent = `Spent in ${year}`;
  $("#yTotal").textContent = money(cadY.reduce((a, r) => a + (r.total || 0), 0));
  const otherY = thisY.length - cadY.length;
  $("#yCount").textContent = thisY.length ? `${thisY.length} receipt${thisY.length > 1 ? "s" : ""}${otherY ? ` · ${otherY} in other currencies not included` : ""}` : "No receipts yet this year";
  const cats = categoryTotals(cadY), mx = cats[0]?.[1] || 1;
  $("#bars").innerHTML = cats.length ? `<h2>${year} by category</h2>` + cats.map(([c, v]) => `<div class="bar"><span>${esc(c)}</span><span class="track"><i style="width:${Math.max(3, Math.max(0, v) / mx * 100)}%"></i></span><span class="num">${money(v)}</span></div>`).join("") : "";
  $("#bars").hidden = !cats.length;
  $("#exportBtn").hidden = !all.length;
  $("#folderLink").hidden = !drive.rootUrl; if (drive.rootUrl) $("#folderLink").href = drive.rootUrl;
  $("#ledgerLink").hidden = !drive.ledgerUrl; if (drive.ledgerUrl) $("#ledgerLink").href = drive.ledgerUrl;

  const recent = all.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, RECENT);
  $("#recentNote").textContent = all.length > RECENT ? `${all.length - RECENT} more in your ledger` : "";
  $("#list").innerHTML = recent.length ? `<ul class="list">${recent.map(r => `<li><button class="row" type="button" data-id="${esc(r.id)}">
      <span class="tab ${r.kind === "business" ? "biz" : ""}"></span><span style="min-width:0"><div class="who">${esc(r.item || (r.items?.length ? r.items[0].name + (r.items.length > 1 ? ` + ${r.items.length - 1} more` : "") : "") || r.merchant || "Receipt")}</div>
        <div class="meta"><span class="num">${esc(r.date || "")}</span><span>${esc(r.item ? r.merchant : "")}</span><span class="pill ${r.kind === "business" ? "biz" : ""}">${esc(r.category)}</span>${r.needsCheck ? `<span class="pill warn">Check</span>` : ""}${atts(r).some(a => a.pending) ? `<span class="pill warn">Not in Drive yet</span>` : ""}${atts(r).length > 1 ? `<span class="pill">${atts(r).length} files</span>` : ""}</div></span>
      <span class="amt">${money(r.total, r.currency)}</span></button></li>`).join("")}</ul>`
    : `<div class="empty"><strong>Nothing in the box yet</strong>Only your last five receipts show here. Everything else lives in your Drive folder and ledger.</div>`;
  renderAccount(); setSync();
}
$("#list").addEventListener("click", e => { const b = e.target.closest(".row"); if (b) openDetail(b.dataset.id); });

// ---------- photo → text ----------
let workerP = null, progressCb = null;
function getWorker() {
  if (!workerP) {
    if (!window.Tesseract) return Promise.reject(new Error("reader not loaded"));
    workerP = Tesseract.createWorker("eng", 1, { logger: m => progressCb && progressCb(m) }).catch(e => { workerP = null; throw e; });
  }
  return workerP;
}
async function prepare(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { bmp = await createImageBitmap(file); }
  const draw = max => { const s = Math.min(1, max / Math.max(bmp.width, bmp.height)); const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); return c; };
  const photo = await new Promise(r => draw(2000).toBlob(b => r(b || file), "image/jpeg", 0.82));
  // OCR copy: cropped to the receipt, larger, grayscale, contrast-stretched
  // Cut out the receipt first, then enlarge just that part (in one high-quality step) so its longer side is 2200px.
  const box = findReceipt(draw(800));
  const bx = box.x0 * bmp.width, by = box.y0 * bmp.height, bw = (box.x1 - box.x0) * bmp.width, bh = (box.y1 - box.y0) * bmp.height;
  const k = Math.min(2200 / Math.max(bw, bh), 3);
  const c = document.createElement("canvas");
  c.width = Math.round(bw * k); c.height = Math.round(bh * k);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, bx, by, bw, bh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  let lo = 255, hi = 0; const g = new Uint8ClampedArray(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; g[j] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = Math.min(255, Math.max(0, (g[j] - lo) * 255 / span)); d[i] = d[i + 1] = d[i + 2] = v; }
  ctx.putImageData(img, 0, 0);
  return { photo, ocrCanvas: c };
}
// Find the receipt in a photo by where the printed text is (works on any background and lighting).
// Returns the box as fractions of the image: {x0, y0, x1, y1}.
function findReceipt(c) {
  try {
    const w = c.width, h = c.height, d = c.getContext("2d").getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // local mean via integral image (7x7 box), ink = clearly darker than its surroundings
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
    const r = 3, colInk = new Float32Array(w), ink = new Uint8Array(w * h);
    for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
      const x0 = x - r, y0 = y - r, x1 = x + r + 1, y1 = y + r + 1;
      const mean = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / 49;
      if (mean - g[y * w + x] > 18) { ink[y * w + x] = 1; colInk[x]++; }
    }
    const smooth = (v, k) => { const o = new Float32Array(v.length); let acc = 0; for (let i = 0; i < v.length + k; i++) { if (i < v.length) acc += v[i]; if (i >= k) acc -= v[i - k]; const j = i - (k >> 1); if (j >= 0 && j < v.length) o[j] = acc / k; } return o; };
    const cs = smooth(Array.from(colInk, v => v / h), Math.max(3, Math.round(w / 40)));
    const cmax = Math.max(...cs); if (cmax <= 0) throw 0;
    const t = Math.max(cmax * 0.25, 0.01), gap = Math.round(w / 20);
    let best = null, start = -1, last = -1, sum = 0;
    for (let x = 0; x <= w; x++) {
      const on = x < w && cs[x] > t;
      if (on) { if (start < 0 || x - last > gap) { if (start >= 0 && (!best || sum > best.sum)) best = { a: start, b: last, sum }; start = x; sum = 0; } last = x; sum += cs[x]; }
    }
    if (start >= 0 && (!best || sum > best.sum)) best = { a: start, b: last, sum };
    const rowInk = new Float32Array(h);
    for (let y = 0; y < h; y++) { let n = 0; for (let x = best.a; x <= best.b; x++) n += ink[y * w + x]; rowInk[y] = n / (best.b - best.a + 1); }
    const rs = smooth(rowInk, Math.max(3, Math.round(h / 60))), rmax = Math.max(...rs), tr = Math.max(rmax * 0.12, 0.005);
    let y0 = rs.findIndex(v => v > tr), y1 = h - 1 - [...rs].reverse().findIndex(v => v > tr);
    const px = Math.round(w * 0.03);
    const box = { x0: Math.max(0, best.a - px) / w, x1: Math.min(w, best.b + px) / w, y0: Math.max(0, y0 - px) / h, y1: Math.min(h, y1 + px) / h };
    if (box.x1 - box.x0 < 0.15 || box.y1 - box.y0 < 0.15) throw 0;      // too small: don't trust it
    return box;
  } catch { return { x0: 0, y0: 0, x1: 1, y1: 1 }; }
}
// Text from one photo or PDF. Digital PDFs (e-receipts) are read directly; scanned ones are read like photos.
async function textFrom(blob, type, onPage) {
  if (isPdf(type)) {
    const pdfjs = await loadPdfJs();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let doc;
    try { doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise; }
    catch (e) {
      if (e?.name === "PasswordException") throw new Error("this PDF is password-protected");
      // Some phones can't start the background reader; read on the main thread instead.
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
      doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false, disableWorker: true }).promise;
    }
    const out = [];
    for (let n = 1; n <= Math.min(doc.numPages, 12); n++) {
      onPage && onPage(n, doc.numPages);
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const rows = [];
      tc.items.forEach(it => { if (!it.str.trim()) return; const y = Math.round(it.transform[5]); let row = rows.find(r => Math.abs(r.y - y) <= 3); if (!row) rows.push(row = { y, parts: [] }); row.parts.push({ x: it.transform[4], s: it.str }); });
      let text = rows.sort((a, b) => b.y - a.y).map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(" ").replace(/\s+/g, " ").trim()).join("\n");
      if (text.replace(/\s/g, "").length < 25) {                   // a scanned page: read the picture
        const vp = page.getViewport({ scale: 2.2 }), c = document.createElement("canvas");
        c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        text = (await (await getWorker()).recognize(c)).data.text;
      }
      out.push(text);
    }
    return { text: out.join("\n"), confidence: 90 };
  }
  const prepared = await prepare(blob);
  const { data } = await (await getWorker()).recognize(prepared.ocrCanvas);
  return { text: data.text, confidence: data.confidence };
}
let pdfP = null;
function loadPdfJs() {
  if (!pdfP) pdfP = new Promise((res, rej) => {
    const s = document.createElement("script");
    // The PDF reader ships with the app (same site), which iPhones need for its background worker.
    s.src = "vendor/pdf.min.js";
    s.onload = () => {
      if (!window.pdfjsLib) { pdfP = null; rej(new Error("PDF reader didn't start")); return; }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
      res(window.pdfjsLib);
    };
    s.onerror = () => { pdfP = null; rej(new Error("PDF reader didn't load")); };
    document.head.appendChild(s);
  });
  return pdfP;
}
// Join the text of several photos of one long receipt. People overlap the photos a little,
// so lines repeated at the end of one photo and the start of the next are dropped.
function joinParts(texts) {
  const norm = l => l.toLowerCase().replace(/[^a-z0-9]/g, "");
  const similar = (a, b) => {
    a = norm(a); b = norm(b); if (!a || !b) return false; if (a === b) return true;
    if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.3) return false;
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n] <= Math.max(a.length, b.length) * 0.25;
  };
  let lines = [];
  texts.forEach((t, k) => {
    const next = t.split(/\r?\n/).filter(l => l.trim());
    if (k && lines.length) {
      let best = 0;
      for (let ov = Math.min(12, lines.length, next.length); ov >= 1; ov--) {
        const tail = lines.slice(-ov), head = next.slice(0, ov);
        if (tail.every((l, i) => similar(l, head[i]))) { best = ov; break; }
      }
      if (!best) {   // the overlap may start a few lines into the new photo (the top edge is often cut off)
        for (let skip = 1; skip <= 3 && !best; skip++) for (let ov = Math.min(12, lines.length, next.length - skip); ov >= 2; ov--) {
          if (lines.slice(-ov).every((l, i) => similar(l, next[skip + i]))) { best = ov + skip; break; }
        }
      }
      lines = lines.concat(next.slice(best));
    } else lines = lines.concat(next);
  });
  return lines.join("\n");
}
// Items across several photos of one long receipt. Where photos overlap, the same items appear at the end of one
// and the start of the next; they're matched by their run of prices (more reliable than the blurry names).
function itemsFromParts(texts, opts) {
  const lists = texts.map(t => parseReceipt(t, opts).items);
  const better = (x, y) => (x.name === "Unreadable item" || (y.name !== "Unreadable item" && y.name.length > x.name.length + 3)) ? { ...x, name: y.name } : x;
  const close = (a, b) => Math.abs(a.price - b.price) < 0.005;
  const nameish = (a, b) => { const n = s => s.toLowerCase().replace(/[^a-z]/g, ""); const x = n(a.name), y = n(b.name); return x && y && (x.includes(y) || y.includes(x)); };
  return lists.reduce((acc, next) => {
    if (!acc.length) return next.slice();
    let best = null;
    for (let skip = 0; skip <= 2 && !best; skip++) {               // the new photo's first line may be cut off
      for (let k = Math.min(acc.length, next.length - skip); k >= 1; k--) {
        const tail = acc.slice(-k), head = next.slice(skip, skip + k);
        const miss = tail.filter((x, i) => !close(x, head[i])).length;
        if ((k >= 2 && miss === 0) || (k >= 4 && miss <= 1) || (k === 1 && miss === 0 && nameish(tail[0], head[0]))) { best = { k, skip }; break; }
      }
    }
    if (!best) return acc.concat(next);
    const { k, skip } = best, start = acc.length - k;
    return acc.slice(0, start).concat(acc.slice(start).map((x, i) => close(x, next[skip + i]) ? better(x, next[skip + i]) : x), next.slice(skip + k));
  }, []);
}
function learnedMap() {
  const m = {};
  live().slice().sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).forEach(r => { if (r.merchant) m[r.merchant.toLowerCase()] = { category: r.category, kind: r.kind }; });
  return m;
}

// ---------- edit sheet ----------
const form = { kind: "personal", editing: null, atts: [], removed: [], lowConf: false, ocrText: "" };
function setKind(v) { form.kind = v; document.querySelectorAll("#fKind button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === v))); }
document.querySelectorAll("#fKind button").forEach(b => b.addEventListener("click", () => setKind(b.dataset.v)));
function itemRow(it = {}) {
  const d = document.createElement("div"); d.className = "irow";
  d.innerHTML = `<input class="iname" placeholder="Item" autocomplete="off" aria-label="Item name">
    <span class="iprice-wrap"><button type="button" class="isign" aria-label="Make this a discount (switch plus or minus)">±</button><input class="iprice num" inputmode="decimal" placeholder="0.00" aria-label="Item price"></span>
    <button type="button" class="iremove ghost" aria-label="Remove item">×</button>
    <select class="icat" aria-label="Item category">${catOptions(it.category || "", { same: true })}</select>`;
  d.querySelector(".iname").value = it.name || "";
  d.querySelector(".iprice").value = it.price != null ? Number(it.price).toFixed(2) : "";
  d.querySelector(".icat").value = it.category || "";
  markSign(d);
  $("#itemsList").appendChild(d);
  return d;
}
function markSign(d) { const v = parseAmt(d.querySelector(".iprice").value); d.classList.toggle("neg", v != null && v < 0); }
function setItems(items) { $("#itemsList").innerHTML = ""; (items || []).forEach(itemRow); checkItems(); }
function readItems() {
  return [...document.querySelectorAll("#itemsList .irow")].map(d => {
    const it = { name: d.querySelector(".iname").value.trim(), price: parseAmt(d.querySelector(".iprice").value) };
    const c = d.querySelector(".icat").value; if (c && c !== "__new__") it.category = c;
    return it;
  }).filter(i => i.name && i.price != null);
}
function checkItems() {
  const items = readItems(), el = $("#itemsCheck");
  if (!items.length) { el.textContent = "No items: the ledger shows one line for this receipt."; el.classList.remove("off"); return; }
  const total = parseAmt($("#fTotal").value), tax = parseAmt($("#fTax").value) || 0, cur = $("#fCurrency").value;
  const sum = Math.round((items.reduce((a, i) => a + i.price, 0) + tax) * 100) / 100;
  if (total == null) { el.textContent = `Items + tax = ${money(sum, cur)}`; el.classList.remove("off"); return; }
  const diff = Math.round((total - sum) * 100) / 100;
  el.textContent = Math.abs(diff) < 0.01 ? `Items + tax = ${money(sum, cur)} ✓ matches the total` : `Items + tax = ${money(sum, cur)}. The ${money(Math.abs(diff), cur)} difference is listed as ${diff > 0 ? "other charges" : "a discount"}.`;
  el.classList.toggle("off", Math.abs(diff) >= 0.01);
}
$("#addItemBtn").addEventListener("click", () => { itemRow().querySelector(".iname").focus(); checkItems(); });
$("#addDiscountBtn").addEventListener("click", () => { const d = itemRow({ name: "Discount" }); d.querySelector(".iprice").value = "-"; d.querySelector(".iprice").focus(); markSign(d); checkItems(); });
$("#itemsList").addEventListener("click", e => {
  const b = e.target.closest(".iremove"); if (b) { b.closest(".irow").remove(); checkItems(); return; }
  const sg = e.target.closest(".isign");
  if (sg) {
    const row = sg.closest(".irow"), inp = row.querySelector(".iprice"), v = inp.value.trim();
    inp.value = v.startsWith("-") ? v.slice(1) : "-" + v;
    markSign(row); checkItems(); inp.focus();
  }
});
$("#itemsList").addEventListener("input", e => { const row = e.target.closest(".irow"); if (row) markSign(row); checkItems(); });
$("#itemsList").addEventListener("change", e => { if (e.target.classList.contains("icat") && e.target.value === "__new__") askNewCategory(e.target); });
// New category: an inline text box (no pop-ups), then the new name appears in every category list.
let newCatTarget = null;
function askNewCategory(sel) {
  newCatTarget = sel; sel.dataset.prev = sel.dataset.prev || "";
  $("#newCatRow").hidden = false; $("#newCatInput").value = ""; $("#newCatInput").focus();
}
function finishNewCategory(save) {
  const sel = newCatTarget; newCatTarget = null; $("#newCatRow").hidden = true;
  if (!sel) return;
  const name = $("#newCatInput").value.trim().replace(/\s+/g, " ").slice(0, 40);
  if (save && name) {
    const existing = allCategories().find(c => c.toLowerCase() === name.toLowerCase());
    const finalName = existing || name.charAt(0).toUpperCase() + name.slice(1);
    if (!existing) { const mine = LS.get("customCats", []); mine.push(finalName); LS.set("customCats", mine); }
    refreshCategorySelects();
    sel.value = finalName;
    toast(existing ? `"${finalName}" is already a category.` : `Added "${finalName}".`);
  } else sel.value = sel.dataset.prev || (sel.id === "fCategory" ? "Other" : "");
  checkItems();
}
function refreshCategorySelects() {
  const f = $("#fCategory"), keep = f.value;
  f.innerHTML = catOptions(keep === "__new__" ? "" : keep); if (keep !== "__new__") f.value = keep;
  document.querySelectorAll("#itemsList .icat").forEach(sel => { const v = sel.value; sel.innerHTML = catOptions(v === "__new__" ? "" : v, { same: true }); if (v !== "__new__") sel.value = v; });
}
$("#newCatAdd").addEventListener("click", () => finishNewCategory(true));
$("#newCatCancel").addEventListener("click", () => finishNewCategory(false));
$("#newCatInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); finishNewCategory(true); } if (e.key === "Escape") { e.stopPropagation(); finishNewCategory(false); } });
$("#fCategory").addEventListener("focus", e => e.target.dataset.prev = e.target.value);
$("#fCategory").addEventListener("change", e => { if (e.target.value === "__new__") askNewCategory(e.target); else e.target.dataset.prev = e.target.value; });
document.addEventListener("focusin", e => { if (e.target.classList?.contains("icat")) e.target.dataset.prev = e.target.value; });
["#fTotal", "#fTax", "#fCurrency"].forEach(id => $(id).addEventListener("input", checkItems));
function fillForm(r) {
  setItems(r.items || []);
  $("#fItem").value = r.item || ""; $("#fMerchant").value = r.merchant || ""; $("#fDate").value = r.date || todayISO();
  $("#fCategory").innerHTML = catOptions(r.category || "Other"); $("#fCategory").value = r.category || "Other";
  $("#newCatRow").hidden = true; newCatTarget = null;
  $("#fTotal").value = r.total != null ? Number(r.total).toFixed(2) : ""; $("#fTax").value = r.tax != null ? Number(r.tax).toFixed(2) : "";
  $("#fCurrency").value = r.currency || "CAD"; setKind(r.kind || "personal");
  checkItems();
}
function readMsg(text, spinning, pct) {
  $("#readStatus").hidden = false; $("#readSpin").hidden = !spinning; $("#readMsg").textContent = text;
  $("#readBarWrap").hidden = pct == null; if (pct != null) $("#readBar").style.width = Math.round(pct * 100) + "%";
}
function openEdit({ title, receipt }) {
  $("#editTitle").textContent = title;
  Object.assign(form, { editing: receipt || null, lowConf: false, ocrText: "", removed: [], readTok: null,
    atts: atts(receipt || {}).map(a => ({ ...a })) });
  fillForm(receipt || {}); $("#readStatus").hidden = true; $("#ocrDetails").hidden = true; $("#saveBtn").disabled = false;
  renderAtts();
  $("#editSheet").hidden = false;
}
const closeEdit = () => { $("#editSheet").hidden = true; (form.atts || []).forEach(a => a.preview && URL.revokeObjectURL(a.preview)); form.atts = []; form.editing = null; form.readTok = null; };
$("#editClose").addEventListener("click", closeEdit);
$("#manualBtn").addEventListener("click", () => openEdit({ title: "Add a receipt" }));

function renderAtts() {
  const list = form.atts || [], n = list.length;
  $("#attList").innerHTML = list.map((a, i) => {
    const pic = a.preview && isImage(a.type);
    return `<div class="att${pic ? " pic" : ""}"${pic ? ` style="background-image:url('${a.preview}')"` : ""}>
      ${pic ? "" : `<span class="att-icon">${isImage(a.type) ? "IMG" : isPdf(a.type) ? "PDF" : esc(extOf(a).toUpperCase().slice(0, 4))}</span>`}
      <span class="att-name">${esc(attLabel(a, i, n))}${a.driveId && !a.preview ? " · in Drive" : ""}</span>
      <button type="button" class="att-x" data-i="${i}" aria-label="Remove ${esc(attLabel(a, i, n))}">×</button></div>`;
  }).join("");
  $("#attEmpty").hidden = n > 0;
  $("#rereadBtn").hidden = !(form.editing && list.some(a => a.driveId && readable(a)));
}
$("#attList").addEventListener("click", e => {
  const b = e.target.closest(".att-x"); if (!b) return;
  const [a] = form.atts.splice(+b.dataset.i, 1);
  if (a?.driveId) form.removed.push(a.driveId);
  if (a?.preview) URL.revokeObjectURL(a.preview);
  renderAtts();
  if (a && readable(a) && form.atts.some(readable)) readAll(false);
});
// Add photos and files to the receipt being edited. Photos are shrunk to a sharp, small JPEG.
async function addFiles(fileList) {
  const files = [...(fileList || [])]; if (!files.length) return;
  for (const f of files) {
    let type = f.type || "application/octet-stream", blob = f;
    if (isImage(type) && !/svg/.test(type)) {
      try { blob = (await prepare(f)).photo; type = "image/jpeg"; } catch { /* keep the original if it can't be decoded here */ }
    } else if (/\.pdf$/i.test(f.name) || /pdf/i.test(f.type)) type = "application/pdf";
    form.atts.push({ key: uid(), type, origName: f.name, blob, preview: URL.createObjectURL(blob), pending: true });
  }
  renderAtts();
  if (form.atts.some(readable)) readAll(false);
  else readMsg(`Attached ${files.length === 1 ? `"${files[0].name}"` : `${files.length} files`}. Fill in the details below.`, false, null);
}
// Read every photo/PDF on this receipt in order, as one receipt.
async function readAll(refetch) {
  const tok = form.readTok = {};
  const list = form.atts.filter(readable);
  if (!list.length) return;
  $("#saveBtn").disabled = true;
  progressCb = null;
  try {
    const texts = [];
    let conf = 100;
    for (let i = 0; i < list.length; i++) {
      const a = list[i], lab = list.length > 1 ? ` ${i + 1} of ${list.length}` : "";
      if (a.text && !refetch) { texts.push(a.text); continue; }
      let blob = a.blob;
      if (!blob && a.driveId) { readMsg(`Fetching ${isPdf(a.type) ? "the PDF" : "photo" + lab} from Google Drive…`, true, null); blob = await driveBlob(a.driveId); }
      if (form.readTok !== tok) return;
      if (!blob) { readMsg("Couldn't fetch the saved photos from Google Drive. Connect Google Drive and try again.", false, null); return; }
      progressCb = m => {
        if (form.readTok !== tok) return;
        if (m.status === "recognizing text") readMsg(`Reading ${isPdf(a.type) ? "the PDF" : "photo" + lab}…`, true, m.progress);
        else if (/loading|initializ/.test(m.status)) readMsg("Setting up the reader (first time only)…", true, m.progress || 0);
      };
      readMsg(`Reading ${isPdf(a.type) ? "the PDF" : "photo" + lab}…`, true, null);
      const res = await textFrom(blob, a.type, (p, n) => n > 1 && readMsg(`Reading PDF page ${p} of ${n}…`, true, null));
      if (form.readTok !== tok) return;
      a.text = res.text; conf = Math.min(conf, res.confidence ?? 100);
      texts.push(res.text);
    }
    if (form.readTok !== tok || $("#editSheet").hidden) return;
    const text = joinParts(texts);
    const popts = { today: todayISO(), learned: learnedMap(), confidence: conf, categories: allCategories() };
    const r = parseReceipt(text, popts);
    if (texts.length > 1) r.items = itemsFromParts(texts, popts);
    form.ocrText = text;
    $("#ocrText").textContent = text.trim() || "(no text found)"; $("#ocrDetails").hidden = false;
    const parts = list.length > 1 ? ` from ${list.length} ${list.every(a => isImage(a.type)) ? "photos" : "files"}` : "";
    if (form.editing) {     // a saved receipt: refresh the items, fill only empty fields
      setItems(r.items);
      if (!$("#fTax").value && r.tax != null) $("#fTax").value = r.tax.toFixed(2);
      if (!$("#fTotal").value && r.total != null) $("#fTotal").value = r.total.toFixed(2);
      checkItems();
      readMsg(r.items.length ? `Found ${r.items.length} item${r.items.length > 1 ? "s" : ""}${parts}. Check them and save.` : "No item lines found. You can add them by hand.", false, null);
      return;
    }
    const keep = { item: $("#fItem").value, kind: form.kind };
    fillForm({ ...r, currency: "CAD", item: keep.item || r.item, kind: r.kind });
    form.lowConf = !r.confident;
    const unread = r.items.filter(i => i.name === "Unreadable item").length;
    readMsg(r.total == null ? (list.length > 1 || form.atts.length > 1 ? "Couldn't find the total yet. If the receipt continues, add the next photo; otherwise fill it in." : "Couldn't find the total. If the receipt is long, add another photo of the rest; otherwise fill it in.")
      : !r.confident ? "Some parts were hard to read. Please double-check the store, date and total."
      : r.items.length ? `Done. Found ${r.items.length} item${r.items.length > 1 ? "s" : ""}${parts}${unread ? `; ${unread} name${unread > 1 ? "s were" : " was"} too faint to read, so rename those` : ""}. Check them and save.`
      : "Done. No item lines found; add them below if you like.", false, null);
  } catch (e) {
    const why = e?.message ? ` (${String(e.message).slice(0, 120)})` : "";
    if (form.readTok === tok) readMsg(!navigator.onLine ? "The reader needs internet the first time. Fill in the details, or try again online."
      : list.some(a => isPdf(a.type)) ? `Couldn't read this PDF${why}. It's still attached; fill in the details below, or send a screenshot of this message to Claude.`
      : `Couldn't read this one${why}. Fill in the details below.`, false, null);
  } finally { if (form.readTok === tok) { $("#saveBtn").disabled = false; progressCb = null; } }
}
$("#rereadBtn").addEventListener("click", () => {
  if (!hasToken() && form.atts.some(a => !a.blob)) { signIn().then(() => readAll(true), () => toast("Connect Google Drive first.")); return; }
  readAll(true);
});
const startWith = files => { if (!files?.length) return; openEdit({ title: "Check this receipt" }); addFiles(files); };
$("#camInput").addEventListener("change", e => { startWith([...e.target.files]); e.target.value = ""; });
$("#libInput").addEventListener("change", e => { startWith([...e.target.files]); e.target.value = ""; });
$("#fileInput").addEventListener("change", e => { startWith([...e.target.files]); e.target.value = ""; });
$("#addCamInput").addEventListener("change", e => { addFiles([...e.target.files]); e.target.value = ""; });
$("#addFileInput").addEventListener("change", e => { addFiles([...e.target.files]); e.target.value = ""; });

$("#editForm").addEventListener("submit", async e => {
  e.preventDefault();
  const merchant = $("#fMerchant").value.trim(), total = parseAmt($("#fTotal").value);
  if (!merchant) { $("#fMerchant").focus(); return toast("Add the store name."); }
  if (total == null) { $("#fTotal").focus(); return toast("Add the total amount."); }
  // Ask Google for access now, while we're still inside the tap (browsers block popups otherwise).
  let auth = null;
  if (clientId && !hasToken() && navigator.onLine) auth = signIn(false).catch(() => null);
  const prev = form.editing, now = Date.now();
  const r = {
    ...(prev || {}), id: prev?.id || uid(),
    item: $("#fItem").value.trim(), items: readItems(), merchant, date: $("#fDate").value || todayISO(), total, tax: parseAmt($("#fTax").value),
    currency: $("#fCurrency").value, category: $("#fCategory").value === "__new__" ? "Other" : $("#fCategory").value, kind: form.kind,
    hadPhoto: form.atts.length > 0, createdAt: prev?.createdAt || now, updatedAt: now,
    needsCheck: prev ? false : form.lowConf,
  };
  for (const a of form.atts) if (a.blob) await putPhoto(a.key, a.blob);
  r.attachments = form.atts.map(({ blob, preview, text, ...a }) => a);
  r.removed = [...(prev?.removed || []), ...form.removed];
  // photos removed before they were ever uploaded: drop them from this device
  for (const a of atts(prev || {})) if (a.pending && !r.attachments.some(b => b.key === a.key)) await delPhoto(a.key);
  receipts = receipts.filter(x => x.id !== r.id).concat(r);
  drive.dirty = true; saveLocal(); closeEdit(); render();
  toast(prev ? "Updated." : "Saved.");
  if (auth) await auth;
  sync();
});

// ---------- detail ----------
function attLinks(r) {
  const list = atts(r); if (!list.length) return "";
  const links = list.map((a, i) => a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(attLabel(a, i, list.length))}</a>` : `<span class="small">${esc(attLabel(a, i, list.length))} (on this device, goes to Drive at the next sync)</span>`);
  const all = list.length > 1 && r.folderUrl ? `<a href="${esc(r.folderUrl)}" target="_blank" rel="noopener">Open all ${list.length} in Google Drive</a> · ` : "";
  return `<p class="attlinks">${all}${links.join(" · ")}</p>`;
}
let detailId = null;
function openDetail(id) {
  const r = live().find(x => x.id === id); if (!r) return;
  detailId = id; $("#delConfirm").hidden = true; $("#delBtn").hidden = false;
  $("#dTitle").textContent = r.item || r.merchant || "Receipt";
  const its = (r.items || []);
  $("#slip").innerHTML = (its.length ? `<div class="itemlist">${its.map(i => `<span>${esc(i.name)}</span><span>${money(i.price, r.currency)}</span>`).join("")}</div>` : "") + `<dl>${r.item ? `<dt>Purchase</dt><dd>${esc(r.item)}</dd>` : ""}<dt>Store</dt><dd>${esc(r.merchant)}</dd><dt>Date</dt><dd>${esc(r.date)}</dd><dt>Category</dt><dd>${esc(r.category)}</dd>
    <dt>Type</dt><dd>${r.kind === "business" ? "Business" : "Personal"}</dd>
    <dt>Tax</dt><dd>${r.tax != null ? money(r.tax, r.currency) : "—"}</dd><dt class="total">Total</dt><dd class="total">${money(r.total, r.currency)}</dd></dl>
    ${attLinks(r)}`;
  $("#detailSheet").hidden = false;
}
$("#detailClose").addEventListener("click", () => $("#detailSheet").hidden = true);
$("#editBtn").addEventListener("click", () => { const r = live().find(x => x.id === detailId); $("#detailSheet").hidden = true; if (r) openEdit({ title: "Edit receipt", receipt: r }); });
$("#delBtn").addEventListener("click", () => { $("#delConfirm").hidden = false; $("#delBtn").hidden = true; });
$("#delNo").addEventListener("click", () => { $("#delConfirm").hidden = true; $("#delBtn").hidden = false; });
$("#delYes").addEventListener("click", async () => {
  const r = receipts.find(x => x.id === detailId); if (!r) return;
  let auth = null;
  if (clientId && !hasToken() && navigator.onLine) auth = signIn(false).catch(() => null);
  Object.assign(r, { deleted: true, updatedAt: Date.now() });
  for (const a of atts(r)) if (a.pending) await delPhoto(a.key);
  drive.dirty = true; saveLocal(); $("#detailSheet").hidden = true; render(); toast("Deleted.");
  if (auth) await auth;
  sync();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("#editSheet").hidden) closeEdit(); else { $("#detailSheet").hidden = true; $("#settingsSheet").hidden = true; } } });

// ---------- CSV download ----------
$("#exportBtn").addEventListener("click", () => {
  const rs = live().slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [], byYear = {};
  rs.forEach((r, ri) => lineRows(r).forEach(x => {
    const y = (r.date || "").slice(0, 4); byYear[y] = (byYear[y] || 0) + (x.price || 0) + (x.tax || 0);
    lines.push([r.date, x.item, r.merchant, x.cat, r.kind === "business" ? "Business" : "Personal", x.price != null ? x.price.toFixed(2) : "", x.tax != null ? x.tax.toFixed(2) : "", r.currency, `#${ri + 1}`].map(q).join(","));
  }));
  const yearLines = Object.keys(byYear).sort().reverse().flatMap(y => [
    ["", `${y} TOTAL SPENT`, "", "", "", byYear[y].toFixed(2), "", "", ""].map(q).join(","),
    ...categoryTotals(rs.filter(r => (r.date || "").startsWith(y))).map(([c, v]) => ["", `${y} · ${c}`, "", c, "", v.toFixed(2), "", "", ""].map(q).join(","))]);
  const csv = ["Date,Item,Store,Category,Type,Price,Tax,Currency,Receipt #", ...lines, "", ...yearLines].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `shoebox-receipts-${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

// ---------- boot ----------
showSetup(false); render(); showInstall();
// Updates: look for a new version whenever the app is opened or brought back, and switch to it straight away
// (unless a receipt is open on screen, then on the next open).
if ("serviceWorker" in navigator) {
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    if (!$("#editSheet").hidden) { LS.set("reloadPending", true); return; }
    reloading = true; location.reload();
  });
  addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (LS.get("reloadPending", false) && $("#editSheet").hidden) { LS.set("reloadPending", false); location.reload(); return; }
      reg.update().catch(() => {});
    });
  }).catch(() => {}));
}
$("#appVersion").textContent = APP_VERSION;
const whenGis = setInterval(() => { if (window.google?.accounts?.oauth2) { clearInterval(whenGis); initTokenClient(); } }, 300);
setTimeout(() => clearInterval(whenGis), 20000);
if (hasToken()) sync();
addEventListener("online", () => { if (hasToken()) sync(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); if (hasToken()) sync(); } });
})();
