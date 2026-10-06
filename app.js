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
const APP_VERSION = "Version 4 · item-by-item ledger";
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
const photoName = r => cleanName(`${r.date} ${r.merchant} ${money(r.total, r.currency)}`) + ".jpg";
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

// ---------- ledger ----------
// One row per item. Tax gets its own row, and any gap between the items and the total
// becomes an "other charges" or "discounts" row, so every receipt adds up to what you paid.
function lineRows(r) {
  const total = r.total ?? 0, tax = r.tax ?? 0;
  const items = (r.items || []).filter(i => i && i.name && i.price != null && isFinite(i.price));
  const rows = items.length ? items.map(i => ({ item: i.name, price: i.price, tax: null }))
                            : [{ item: r.item || "Purchase", price: Math.round((total - tax) * 100) / 100, tax: null }];
  const diff = Math.round((total - tax - rows.reduce((a, x) => a + x.price, 0)) * 100) / 100;
  if (items.length && Math.abs(diff) >= 0.01) rows.push({ item: diff > 0 ? "Other charges (not itemized)" : "Discounts / adjustments", price: diff, tax: null });
  if (tax) rows.push({ item: "Tax (GST/HST)", price: null, tax });
  return rows;
}
function ledgerCSV(receiptsSorted) {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = [["Date", "Item", "Store", "Category", "Type", "Price", "Tax", "Currency", "Receipt total", "Receipt #", "Photo"]];
  receiptsSorted.forEach((r, ri) => {
    lineRows(r).forEach((x, i) => out.push([r.date, x.item, r.merchant, r.category, r.kind === "business" ? "Business" : "Personal",
      x.price != null ? x.price.toFixed(2) : "", x.tax != null ? x.tax.toFixed(2) : "", r.currency,
      i === 0 ? (r.total ?? 0).toFixed(2) : "", `#${ri + 1}`,
      i === 0 && r.photoUrl ? `=HYPERLINK("${r.photoUrl}","View photo")` : ""]));
  });
  const n = Math.max(out.length, 2), F = `$F$2:$F$${n}`, G = `$G$2:$G$${n}`, D = `$D$2:$D$${n}`, E = `$E$2:$E$${n}`, J = `$J$2:$J$${n}`;
  const mixed = new Set(receiptsSorted.map(r => r.currency)).size > 1;
  out.push([]);
  out.push(["ITEMS SUBTOTAL", "", "", "", "", `=SUM(${F})`, "", "", "", "", ""]);
  out.push(["TAX", "", "", "", "", "", `=SUM(${G})`, "", "", "", ""]);
  out.push([mixed ? "TOTAL SPENT (all currencies)" : "TOTAL SPENT", "", "", "", "", `=SUM(${F})+SUM(${G})`, "", "", "", `=COUNTUNIQUE(${J})&" receipts"`, ""]);
  out.push([]);
  out.push(["BY CATEGORY", "", "", "", "", "Items", "Tax", "", "Total", "Receipts", ""]);
  CATEGORIES.filter(c => receiptsSorted.some(r => r.category === c)).forEach(c =>
    out.push([c, "", "", "", "", `=SUMIF(${D},"${c}",${F})`, `=SUMIF(${D},"${c}",${G})`, "", `=SUMIF(${D},"${c}",${F})+SUMIF(${D},"${c}",${G})`, `=COUNTUNIQUEIFS(${J},${D},"${c}")`, ""]));
  out.push([]);
  out.push(["BY TYPE", "", "", "", "", "Items", "Tax", "", "Total", "Receipts", ""]);
  ["Personal", "Business"].forEach(k => out.push([k, "", "", "", "", `=SUMIF(${E},"${k}",${F})`, `=SUMIF(${E},"${k}",${G})`, "", `=SUMIF(${E},"${k}",${F})+SUMIF(${E},"${k}",${G})`, `=COUNTUNIQUEIFS(${J},${E},"${k}")`, ""]));
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
      try { const txt = await api("GET", `${DAPI}/files/${drive.dataId}?alt=media`, { as: "text" }); receipts = merge(receipts, JSON.parse(txt || "{}").receipts || []); }
      catch (e) { if (e.status === 404) drive.dataId = null; else if (!(e instanceof SyntaxError)) throw e; }
      saveLocal(); render();
    }
    for (const r of receipts) {
      if (r.deleted) {
        if (r.photoId && !r.photoTrashed) { try { await trash(r.photoId); } catch (e) { if (e.status !== 404 && e.status !== 403) throw e; } r.photoTrashed = true; saveLocal(); }
        continue;
      }
      const blob = await getPhoto(r.id);
      if (blob) {
        const folder = await ensureFolder(r.category), name = photoName(r);
        const f = await multipart({ name, parents: [folder] }, blob, blob.type || "image/jpeg");
        Object.assign(r, { photoId: f.id, photoUrl: f.webViewLink, photoCat: r.category, photoName: name, updatedAt: Date.now() });
        await delPhoto(r.id); saveLocal();
      } else if (r.photoId && (r.photoCat !== r.category || r.photoName !== photoName(r))) {
        const folder = await ensureFolder(r.category), name = photoName(r);
        const params = new URLSearchParams({ fields: "id" });
        if (r.photoCat !== r.category) {
          params.set("addParents", folder);
          const meta = await api("GET", `${DAPI}/files/${r.photoId}?fields=parents`).catch(() => null);
          if (meta?.parents?.length) params.set("removeParents", meta.parents.join(","));
        }
        try { await api("PATCH", `${DAPI}/files/${r.photoId}?` + params, jsonBody({ name })); }
        catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
        Object.assign(r, { photoCat: r.category, photoName: name, updatedAt: Date.now() }); saveLocal();
      }
    }
    for (const id of LS.get("trashLater", [])) { try { await trash(id); } catch (e) { if (e.code === "auth" || e.code === "offline") throw e; } }
    LS.set("trashLater", []);
    const data = new Blob([JSON.stringify({ app: ROOT_NAME, version: 1, updatedAt: Date.now(), receipts }, null, 1)], { type: "application/json" });
    if (drive.dataId) { try { await updateMedia(drive.dataId, data, "application/json"); } catch (e) { if (e.status === 404) drive.dataId = null; else throw e; } }
    if (!drive.dataId) { const f = await multipart({ name: DATA_NAME, parents: [drive.rootId], mimeType: "application/json" }, data, "application/json"); drive.dataId = f.id; }
    await writeLedger();
    drive.lastSync = Date.now(); drive.dirty = false; saveLocal();
  } catch (e) {
    if (e?.status === 404 && drive.rootId) { drive = { folders: {} }; saveLocal(); again = true; }   // folder was deleted: start fresh
    syncErr = e?.code === "auth" ? "auth" : e?.code === "offline" ? "offline" : (e?.message || "Google Drive refused the change.");
    drive.dirty = true; saveLocal();
  } finally {
    syncing = false; render();
    if (again) { again = false; setTimeout(sync, 400); }
  }
}
function setSync() {
  const dot = $("#syncDot"), msg = $("#syncMsg"), btn = $("#syncBtn");
  const unsynced = drive.dirty || receipts.some(r => !r.deleted && !r.photoId && r.hadPhoto);
  btn.hidden = true;
  if (!clientId) { dot.className = "dot err"; msg.textContent = "Saved on this device. Set up Google Drive to file your receipts."; return; }
  if (syncing) { dot.className = "dot busy"; msg.textContent = "Saving to Google Drive…"; return; }
  if (!hasToken()) { dot.className = "dot err"; msg.textContent = unsynced ? "Saved on this device. Connect Google Drive to file it." : "Connect Google Drive to sync."; btn.hidden = false; btn.textContent = "Connect"; return; }
  if (syncErr === "offline") { dot.className = "dot err"; msg.textContent = "You're offline. Receipts are saved here and will sync later."; btn.hidden = false; btn.textContent = "Try again"; return; }
  if (syncErr) { dot.className = "dot err"; msg.textContent = "Sync didn't finish: " + syncErr; btn.hidden = false; btn.textContent = "Try again"; return; }
  dot.className = "dot";
  msg.textContent = drive.lastSync ? `All filed. Last synced ${new Date(drive.lastSync).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}.` : "Connected.";
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
$("#fCategory").innerHTML = CATEGORIES.map(c => `<option>${esc(c)}</option>`).join("");
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
  const byCat = {}; cadM.forEach(r => byCat[r.category] = (byCat[r.category] || 0) + (r.total || 0));
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 4), mx = top[0]?.[1] || 1;
  $("#bars").innerHTML = top.length ? `<h2>Top categories this month</h2>` + top.map(([c, v]) => `<div class="bar"><span>${esc(c)}</span><span class="track"><i style="width:${Math.max(4, v / mx * 100)}%"></i></span><span class="num">${money(v)}</span></div>`).join("") : "";
  $("#bars").hidden = !top.length;
  $("#exportBtn").hidden = !all.length;
  $("#folderLink").hidden = !drive.rootUrl; if (drive.rootUrl) $("#folderLink").href = drive.rootUrl;
  $("#ledgerLink").hidden = !drive.ledgerUrl; if (drive.ledgerUrl) $("#ledgerLink").href = drive.ledgerUrl;

  const recent = all.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, RECENT);
  $("#recentNote").textContent = all.length > RECENT ? `${all.length - RECENT} more in your ledger` : "";
  $("#list").innerHTML = recent.length ? `<ul class="list">${recent.map(r => `<li><button class="row" type="button" data-id="${esc(r.id)}">
      <span class="tab ${r.kind === "business" ? "biz" : ""}"></span><span style="min-width:0"><div class="who">${esc(r.item || (r.items?.length ? r.items[0].name + (r.items.length > 1 ? ` + ${r.items.length - 1} more` : "") : "") || r.merchant || "Receipt")}</div>
        <div class="meta"><span class="num">${esc(r.date || "")}</span><span>${esc(r.item ? r.merchant : "")}</span><span class="pill ${r.kind === "business" ? "biz" : ""}">${esc(r.category)}</span>${r.needsCheck ? `<span class="pill warn">Check</span>` : ""}${r.hadPhoto && !r.photoId ? `<span class="pill warn">Not in Drive yet</span>` : ""}</div></span>
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
  const photo = await new Promise(r => draw(1600).toBlob(b => r(b || file), "image/jpeg", 0.8));
  // OCR copy: cropped to the receipt, larger, grayscale, contrast-stretched
  const box = findReceipt(draw(800));
  const full = draw(2200), sx = full.width, sy = full.height;
  const c = document.createElement("canvas");
  c.width = Math.round((box.x1 - box.x0) * sx); c.height = Math.round((box.y1 - box.y0) * sy);
  c.getContext("2d").drawImage(full, box.x0 * sx, box.y0 * sy, c.width, c.height, 0, 0, c.width, c.height);
  const ctx = c.getContext("2d"), img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
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
function learnedMap() {
  const m = {};
  live().slice().sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).forEach(r => { if (r.merchant) m[r.merchant.toLowerCase()] = { category: r.category, kind: r.kind }; });
  return m;
}

// ---------- edit sheet ----------
const form = { kind: "personal", editing: null, photo: null, lowConf: false, ocrText: "" };
function setKind(v) { form.kind = v; document.querySelectorAll("#fKind button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === v))); }
document.querySelectorAll("#fKind button").forEach(b => b.addEventListener("click", () => setKind(b.dataset.v)));
function itemRow(it = {}) {
  const d = document.createElement("div"); d.className = "irow";
  d.innerHTML = `<input class="iname" placeholder="Item" autocomplete="off" aria-label="Item name"><input class="iprice num" inputmode="decimal" placeholder="0.00" aria-label="Item price"><button type="button" class="iremove ghost" aria-label="Remove item">×</button>`;
  d.querySelector(".iname").value = it.name || "";
  d.querySelector(".iprice").value = it.price != null ? Number(it.price).toFixed(2) : "";
  $("#itemsList").appendChild(d);
  return d;
}
function setItems(items) { $("#itemsList").innerHTML = ""; (items || []).forEach(itemRow); checkItems(); }
function readItems() {
  return [...document.querySelectorAll("#itemsList .irow")].map(d => ({ name: d.querySelector(".iname").value.trim(), price: parseAmt(d.querySelector(".iprice").value) }))
    .filter(i => i.name && i.price != null);
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
$("#itemsList").addEventListener("click", e => { const b = e.target.closest(".iremove"); if (b) { b.closest(".irow").remove(); checkItems(); } });
$("#itemsList").addEventListener("input", checkItems);
["#fTotal", "#fTax", "#fCurrency"].forEach(id => $(id).addEventListener("input", checkItems));
function fillForm(r) {
  setItems(r.items || []);
  $("#fItem").value = r.item || ""; $("#fMerchant").value = r.merchant || ""; $("#fDate").value = r.date || todayISO();
  $("#fCategory").value = CATEGORIES.includes(r.category) ? r.category : "Other";
  $("#fTotal").value = r.total != null ? Number(r.total).toFixed(2) : ""; $("#fTax").value = r.tax != null ? Number(r.tax).toFixed(2) : "";
  $("#fCurrency").value = r.currency || "CAD"; setKind(r.kind || "personal");
  checkItems();
}
function readMsg(text, spinning, pct) {
  $("#readStatus").hidden = false; $("#readSpin").hidden = !spinning; $("#readMsg").textContent = text;
  $("#readBarWrap").hidden = pct == null; if (pct != null) $("#readBar").style.width = Math.round(pct * 100) + "%";
}
function openEdit({ title, receipt, photo, previewUrl }) {
  $("#editTitle").textContent = title;
  Object.assign(form, { editing: receipt || null, photo: photo || null, lowConf: false, ocrText: "" });
  const pv = $("#editPreview");
  if (previewUrl) { pv.src = previewUrl; pv.hidden = false; } else { pv.hidden = true; pv.removeAttribute("src"); }
  fillForm(receipt || {}); $("#readStatus").hidden = true; $("#ocrDetails").hidden = true; $("#saveBtn").disabled = false;
  form.readTok = null;
  $("#rereadBtn").hidden = !(receipt?.photoId);
  $("#editSheet").hidden = false;
}
const closeEdit = () => { $("#editSheet").hidden = true; form.photo = null; form.editing = null; form.readTok = null; };
$("#editClose").addEventListener("click", closeEdit);
$("#manualBtn").addEventListener("click", () => openEdit({ title: "Add a receipt" }));

// reread = true: reading a saved receipt's photo again from Drive. Only items (and empty fields) are filled,
// and the photo isn't uploaded again.
async function onPhoto(file, reread = false) {
  if (!file) return;
  if (!reread) openEdit({ title: "Check this receipt", previewUrl: URL.createObjectURL(file) });
  else { const pv = $("#editPreview"); pv.src = URL.createObjectURL(file); pv.hidden = false; }
  const tok = form.readTok = {};
  readMsg("Getting the photo ready…", true, null);
  let prepared;
  try { prepared = await prepare(file); } catch { readMsg("That photo couldn't be opened. Try another one, or type the details.", false, null); return; }
  if (form.readTok !== tok) return;
  if (!reread) form.photo = prepared.photo;
  $("#saveBtn").disabled = true;
  progressCb = m => {
    if (form.readTok !== tok) return;
    if (m.status === "recognizing text") readMsg("Reading the receipt…", true, m.progress);
    else if (/loading|initializ/.test(m.status)) readMsg("Setting up the reader (first time only)…", true, m.progress || 0);
  };
  try {
    const w = await getWorker();
    const { data } = await w.recognize(prepared.ocrCanvas);
    if (form.readTok !== tok || $("#editSheet").hidden) return;
    const r = parseReceipt(data.text, { today: todayISO(), learned: learnedMap(), confidence: data.confidence });
    form.ocrText = data.text;
    $("#ocrText").textContent = data.text.trim() || "(no text found)"; $("#ocrDetails").hidden = false;
    if (reread) {
      setItems(r.items);
      if (!$("#fTax").value && r.tax != null) $("#fTax").value = r.tax.toFixed(2);
      if (!$("#fTotal").value && r.total != null) $("#fTotal").value = r.total.toFixed(2);
      checkItems();
      readMsg(r.items.length ? `Found ${r.items.length} item${r.items.length > 1 ? "s" : ""}. Check them and save.` : "No item lines found on this photo. You can add them by hand.", false, null);
      return;
    }
    fillForm({ ...r, currency: "CAD" });
    form.lowConf = !r.confident;
    const unread = r.items.filter(i => i.name === "Unreadable item").length;
    readMsg(r.total == null ? "Couldn't find the total. Please fill in the details."
      : !r.confident ? "Some parts were hard to read. Please double-check the store, date and total."
      : r.items.length ? `Done. Found ${r.items.length} item${r.items.length > 1 ? "s" : ""}${unread ? `; ${unread} name${unread > 1 ? "s were" : " was"} too faint to read, so rename those` : ""}. Check them and save.`
      : "Done. No item lines found; add them below if you like.", false, null);
  } catch {
    readMsg(navigator.onLine ? "Couldn't read this one. Fill in the details below." : "The reader needs internet the first time. Fill in the details, or try again online.", false, null);
  } finally { if (form.readTok === tok) { $("#saveBtn").disabled = false; progressCb = null; } }
}
// "Read photo again" for a saved receipt whose photo is in Drive.
$("#rereadBtn").addEventListener("click", async () => {
  const r = form.editing; if (!r?.photoId) return;
  if (!hasToken()) { signIn().then(() => $("#rereadBtn").click(), () => toast("Connect Google Drive first.")); return; }
  readMsg("Fetching the photo from Google Drive…", true, null);
  try {
    const res = await fetch(`${DAPI}/files/${r.photoId}?alt=media`, { headers: { Authorization: "Bearer " + token.value } });
    if (!res.ok) throw res.status;
    onPhoto(await res.blob(), true);
  } catch { readMsg("Couldn't fetch the photo from Drive. Check your connection and try again.", false, null); }
});
$("#camInput").addEventListener("change", e => { onPhoto(e.target.files[0]); e.target.value = ""; });
$("#libInput").addEventListener("change", e => { onPhoto(e.target.files[0]); e.target.value = ""; });

$("#editForm").addEventListener("submit", async e => {
  e.preventDefault();
  const merchant = $("#fMerchant").value.trim(), total = parseAmt($("#fTotal").value);
  if (!merchant) { $("#fMerchant").focus(); return toast("Add the store name."); }
  if (total == null) { $("#fTotal").focus(); return toast("Add the total amount."); }
  // Ask Google for access now, while we're still inside the tap (browsers block popups otherwise).
  let auth = null;
  if (clientId && !hasToken() && navigator.onLine) auth = signIn(false).catch(() => null);
  const prev = form.editing, photo = form.photo, now = Date.now();
  const r = {
    ...(prev || {}), id: prev?.id || uid(),
    item: $("#fItem").value.trim(), items: readItems(), merchant, date: $("#fDate").value || todayISO(), total, tax: parseAmt($("#fTax").value),
    currency: $("#fCurrency").value, category: $("#fCategory").value, kind: form.kind,
    hadPhoto: !!(photo || prev?.hadPhoto), createdAt: prev?.createdAt || now, updatedAt: now,
    needsCheck: prev ? false : form.lowConf,
  };
  const oldPhotoId = photo && prev?.photoId ? prev.photoId : null;
  if (photo) { await putPhoto(r.id, photo); r.photoId = null; r.photoUrl = null; }
  receipts = receipts.filter(x => x.id !== r.id).concat(r);
  drive.dirty = true; saveLocal(); closeEdit(); render();
  if (oldPhotoId) { if (hasToken()) trash(oldPhotoId).catch(() => {}); else { const g = LS.get("trashLater", []); g.push(oldPhotoId); LS.set("trashLater", g); } }
  toast(prev ? "Updated." : "Saved.");
  if (auth) await auth;
  sync();
});

// ---------- detail ----------
let detailId = null;
function openDetail(id) {
  const r = live().find(x => x.id === id); if (!r) return;
  detailId = id; $("#delConfirm").hidden = true; $("#delBtn").hidden = false;
  $("#dTitle").textContent = r.item || r.merchant || "Receipt";
  const its = (r.items || []);
  $("#slip").innerHTML = (its.length ? `<div class="itemlist">${its.map(i => `<span>${esc(i.name)}</span><span>${money(i.price, r.currency)}</span>`).join("")}</div>` : "") + `<dl>${r.item ? `<dt>Purchase</dt><dd>${esc(r.item)}</dd>` : ""}<dt>Store</dt><dd>${esc(r.merchant)}</dd><dt>Date</dt><dd>${esc(r.date)}</dd><dt>Category</dt><dd>${esc(r.category)}</dd>
    <dt>Type</dt><dd>${r.kind === "business" ? "Business" : "Personal"}</dd>
    <dt>Tax</dt><dd>${r.tax != null ? money(r.tax, r.currency) : "—"}</dd><dt class="total">Total</dt><dd class="total">${money(r.total, r.currency)}</dd></dl>
    ${r.photoUrl ? `<p style="margin:14px 0 0;font-size:.88rem"><a href="${esc(r.photoUrl)}" target="_blank" rel="noopener">View photo in Google Drive</a></p>` : r.hadPhoto ? `<p class="small" style="margin:14px 0 0">The photo is saved on this device and goes to Drive at the next sync.</p>` : ""}`;
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
  await delPhoto(r.id);
  drive.dirty = true; saveLocal(); $("#detailSheet").hidden = true; render(); toast("Deleted.");
  if (auth) await auth;
  sync();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("#editSheet").hidden) closeEdit(); else { $("#detailSheet").hidden = true; $("#settingsSheet").hidden = true; } } });

// ---------- CSV download ----------
$("#exportBtn").addEventListener("click", () => {
  const rs = live().slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  let sp = 0, st = 0;
  const lines = [];
  rs.forEach((r, ri) => lineRows(r).forEach(x => { sp += x.price || 0; st += x.tax || 0;
    lines.push([r.date, x.item, r.merchant, r.category, r.kind === "business" ? "Business" : "Personal", x.price != null ? x.price.toFixed(2) : "", x.tax != null ? x.tax.toFixed(2) : "", r.currency, `#${ri + 1}`].map(q).join(",")); }));
  const csv = ["Date,Item,Store,Category,Type,Price,Tax,Currency,Receipt #", ...lines, "",
    ["ITEMS SUBTOTAL", "", "", "", "", sp.toFixed(2), "", "", ""].map(q).join(","),
    ["TAX", "", "", "", "", "", st.toFixed(2), "", ""].map(q).join(","),
    ["TOTAL SPENT", "", "", "", "", (sp + st).toFixed(2), "", "", `${rs.length} receipts`].map(q).join(",")].join("\n");
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
