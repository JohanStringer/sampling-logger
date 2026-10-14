'use strict';
/* Micro Sampling Logger
   Phone mode  : field capture. Data in IndexedDB. Changes mark an excursion "dirty".
   Laptop mode : library. Data in a folder you choose (e.g. NAS), one sub-folder per excursion.
   Transfer    : the phone builds a package ZIP of dirty excursions; the laptop imports it and
                 replaces those excursions completely. Texts: js/texts.js + local overrides. */

const APP_VERSION = '0.3.5';
const FORMAT = 'micro-sampling-logger';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const now = () => new Date().toISOString();
const pad2 = n => String(n).padStart(2, '0');
const IS_ARTIFACT = !!(window.claude && typeof window.claude.use === 'function');
const HAS_FS = typeof window.showDirectoryPicker === 'function' && !IS_ARTIFACT;
const PHOTO_KEYS = ['container', 'specimen', 'context'];

const state = {
  mode: 'phone', exc: null, settings: { lang: null, photoMax: 2560, mode: null }, urls: new Map(),
  saveTimer: null, gps: null, rec: null, map: null, installEvt: null, pendingHandle: null,
};
const isLaptop = () => state.mode === 'laptop';
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;

/* ---------------- Phone storage (IndexedDB, memory fallback) ---------------- */
const Store = (() => {
  const mem = { excursions: new Map(), photos: new Map(), kv: new Map() };
  let dbp = null, useMem = false;
  const memApi = m => ({
    get: k => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: (v, k) => { m.set(k, structuredClone(v)); },
    delete: k => { m.delete(k); },
    getAll: () => [...m.values()].map(v => structuredClone(v)),
  });
  function open() {
    if (useMem) return Promise.resolve(null);
    if (!dbp) dbp = new Promise(res => {
      try {
        const r = indexedDB.open('micro-sampling-logger', 1);
        r.onupgradeneeded = () => ['excursions', 'photos', 'kv'].forEach(n => { if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); });
        r.onsuccess = () => res(r.result);
        r.onerror = () => { useMem = true; res(null); };
      } catch (e) { useMem = true; res(null); }
    });
    return dbp;
  }
  async function op(store, mode, fn) {
    const d = await open();
    if (!d) return fn(memApi(mem[store]));
    return new Promise((res, rej) => {
      const tx = d.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      let out;
      if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => res(out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  return {
    listExc: () => op('excursions', 'readonly', s => s.getAll()),
    getExc: id => op('excursions', 'readonly', s => s.get(id)),
    putExc: e => op('excursions', 'readwrite', s => s.put(e, e.id)),
    delExc: id => op('excursions', 'readwrite', s => s.delete(id)),
    getPhoto: id => op('photos', 'readonly', s => s.get(id)),
    putPhoto: (id, b) => op('photos', 'readwrite', s => s.put(b, id)),
    delPhoto: id => op('photos', 'readwrite', s => s.delete(id)),
    kvGet: k => op('kv', 'readonly', s => s.get(k)),
    kvSet: (k, v) => op('kv', 'readwrite', s => s.put(v, k)),
    isMemory: () => useMem,
  };
})();

/* ---------------- Exchange format (same on disk, in packages and in the laptop library) ---------------- */
const folderName = e => `${(e.created || now()).slice(0, 10)}_${slug(e.title) || 'excursion'}_${e.id.replace(/-/g, '').slice(0, 8)}`;
// pathOf(photoRef) -> relative path inside the excursion folder (e.g. "photos/L01_S01_container.jpg")
function toJson(e, pathOf, extra = {}) {
  return {
    format: FORMAT, version: 1, app: APP_VERSION, saved: now(), ...extra,
    excursion: {
      id: e.id, title: e.title, goal: e.goal || '', created: e.created, updated: e.updated,
      locations: e.locations.map((l, i) => ({
        id: l.id, number: i + 1, title: l.title, description: l.description || '', gps: l.gps || null,
        created: l.created, updated: l.updated, photos: l.photos.map(pathOf).filter(Boolean),
        samples: l.samples.map((s, k) => ({
          id: s.id, number: k + 1, title: s.title, notes: s.notes || '', created: s.created, updated: s.updated,
          container: pathOf(s.container), specimen: pathOf(s.specimen), context: pathOf(s.context),
        })),
      })),
    },
  };
}
// refOf(path) -> photo reference in the running app
function fromJson(x, refOf) {
  return {
    id: x.id, title: x.title, goal: x.goal || '', created: x.created, updated: x.updated,
    locations: (x.locations || []).map(l => ({
      id: l.id, title: l.title, description: l.description || '', gps: l.gps || null, created: l.created, updated: l.updated,
      photos: (l.photos || []).map(refOf).filter(Boolean),
      samples: (l.samples || []).map(s => ({
        id: s.id, title: s.title, notes: s.notes || '', created: s.created, updated: s.updated,
        container: refOf(s.container), specimen: refOf(s.specimen), context: refOf(s.context),
      })),
    })),
  };
}
const photoName = (li, si, kind, j) => `L${pad2(li + 1)}` + (si != null ? `_S${pad2(si + 1)}_${kind}` : `_location_${j + 1}`);

/* ---------------- Laptop library (folder via File System Access API) ---------------- */
async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(data); await w.close();
}
const Lib = {
  root: null, cache: new Map(),
  async scan() {
    this.cache.clear();
    for await (const [name, h] of this.root.entries()) {
      if (h.kind !== 'directory') continue;
      try {
        const f = await (await h.getFileHandle('excursion.json')).getFile();
        const data = JSON.parse(await f.text());
        if (data.format !== FORMAT || !data.excursion) continue;
        const e = fromJson(data.excursion, p => (p ? `${name}|${p}` : null));
        e.library = data.library || {};
        this.cache.set(e.id, { folder: name, exc: e });
      } catch (err) { /* not an excursion folder */ }
    }
  },
  async listExc() { await this.scan(); return [...this.cache.values()].map(c => structuredClone(c.exc)); },
  async getExc(id) { if (!this.cache.has(id)) await this.scan(); const c = this.cache.get(id); return c ? structuredClone(c.exc) : undefined; },
  async putExc(e) {
    const c = this.cache.get(e.id); const folder = c ? c.folder : folderName(e);
    const dir = await this.root.getDirectoryHandle(folder, { create: true });
    await writeFile(dir, 'excursion.json', JSON.stringify(toJson(e, r => (r ? r.split('|')[1] : null), { library: e.library || {} }), null, 2));
    this.cache.set(e.id, { folder, exc: structuredClone(e) });
  },
  async delExc(id) { const c = this.cache.get(id); if (c) await this.root.removeEntry(c.folder, { recursive: true }); this.cache.delete(id); },
  async getPhoto(ref) {
    const [folder, path] = ref.split('|'); const parts = path.split('/');
    let h = await this.root.getDirectoryHandle(folder);
    for (const p of parts.slice(0, -1)) h = await h.getDirectoryHandle(p);
    return (await h.getFileHandle(parts[parts.length - 1])).getFile();
  },
  folderOf(id) { const c = this.cache.get(id); return c && c.folder; },
};
const D = () => (isLaptop() ? Lib : Store);

async function ensureLibrary() {
  if (Lib.root) return true;
  const h = await Store.kvGet('libHandle'); if (!h) return false;
  try { if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') { Lib.root = h; return true; } } catch (e) {}
  state.pendingHandle = h; return false;
}
async function chooseLibrary() {
  try {
    const h = await window.showDirectoryPicker({ id: 'msl-library', mode: 'readwrite' });
    await Store.kvSet('libHandle', h); Lib.root = h; state.pendingHandle = null; Lib.cache.clear();
    toast(t('lib.connected', { name: h.name })); route();
  } catch (e) { if (e && e.name !== 'AbortError') toast(t('lib.pickFailed'), 'warn'); }
}
async function reconnectLibrary() {
  const h = state.pendingHandle; if (!h) return chooseLibrary();
  try { if (await h.requestPermission({ mode: 'readwrite' }) === 'granted') { Lib.root = h; state.pendingHandle = null; route(); return; } } catch (e) {}
  toast(t('lib.permissionDenied'), 'warn');
}

/* ---------------- Texts (i18n) ---------------- */
const BASE_LANGS = [
  { code: 'en', name: 'English', speech: 'en-GB' },
  { code: 'nl', name: 'Nederlands', speech: 'nl-NL' },
  { code: 'fr', name: 'Français', speech: 'fr-FR' },
  { code: 'de', name: 'Deutsch', speech: 'de-DE' },
];
const I18N = { langs: [...BASE_LANGS], lang: 'en', over: {}, edit: false };
function t(id, vars) {
  const o = I18N.over[id], d = TEXTS[id];
  let s = (o && o[I18N.lang]) || (d && d[I18N.lang]) || (o && o.en) || (d && d.en) || id;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  return s;
}
const tt = (id, vars) => `<span data-t="${id}">${esc(t(id, vars))}</span>`;
function textValue(id, lang) {
  const o = I18N.over[id];
  if (o && o[lang] != null) return o[lang];
  return (TEXTS[id] && TEXTS[id][lang]) || '';
}
function setText(id, lang, val) {
  const def = (TEXTS[id] && TEXTS[id][lang]) || '';
  I18N.over[id] = I18N.over[id] || {};
  if (val === def) delete I18N.over[id][lang]; else I18N.over[id][lang] = val;
  if (!Object.keys(I18N.over[id]).length) delete I18N.over[id];
}
const allTextIds = () => [...new Set([...Object.keys(TEXTS), ...Object.keys(I18N.over)])].sort();
const curLang = () => I18N.langs.find(l => l.code === I18N.lang) || I18N.langs[0];
async function saveTexts() { await Store.kvSet('texts', I18N.over); await Store.kvSet('extraLangs', I18N.langs.filter(l => !BASE_LANGS.some(b => b.code === l.code))); }

/* ---------------- Icons ---------------- */
const IC = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  gear: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  vial: '<path d="M9 3h6M10 3v12a2 2 0 0 0 4 0V3"/><path d="M10 10h4"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  folder: '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5M20 20v-4h-4"/>',
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;

/* ---------------- UI helpers ---------------- */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg; el.setAttribute('role', 'status');
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2800);
  setTimeout(() => el.remove(), 3300);
}
function modal(html, cls = '') {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap ' + cls; wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => { if (e.target === wrap && !wrap.dataset.locked) close(); });
  return { el: wrap, close };
}
function confirmDlg(msg, okLabel, danger = true, cancelLabel) {
  return new Promise(res => {
    const m = modal(`<p class="modal-msg">${esc(msg)}</p>
      <div class="modal-actions"><button class="btn ghost" data-a="no">${esc(cancelLabel || t('common.cancel'))}</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${esc(okLabel)}</button></div>`, 'no-edit');
    m.el.dataset.locked = '1';
    m.el.addEventListener('click', e => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      m.close(); res(a.dataset.a === 'yes');
    });
  });
}
const fmtDate = iso => { try { return new Intl.DateTimeFormat(I18N.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch (e) { return iso || ''; } };
const fmtDay = iso => { try { return new Intl.DateTimeFormat(I18N.lang, { dateStyle: 'medium' }).format(new Date(iso)); } catch (e) { return (iso || '').slice(0, 10); } };
function slug(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40); }
function pickFile(accept) {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.style.display = 'none';
    document.body.appendChild(i); i.onchange = () => { res(i.files[0]); i.remove(); }; i.click();
  });
}

/* ---------------- Photos ---------------- */
async function photoURL(ref) {
  if (!ref) return '';
  if (state.urls.has(ref)) return state.urls.get(ref);
  let b = null; try { b = await D().getPhoto(ref); } catch (e) {}
  if (!b) return '';
  const u = URL.createObjectURL(b); state.urls.set(ref, u); return u;
}
function hydratePhotos(root = document) {
  $$('img[data-photo]', root).forEach(async img => { const u = await photoURL(img.dataset.photo); if (u) img.src = u; else img.classList.add('missing'); });
}
function pickPhotos({ camera = true, multiple = false } = {}) {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'image/*';
    if (camera) i.setAttribute('capture', 'environment');
    if (multiple) i.multiple = true;
    i.style.display = 'none'; document.body.appendChild(i);
    i.onchange = () => { res([...i.files]); i.remove(); };
    i.click();
  });
}
async function processPhoto(file) {
  const max = +state.settings.photoMax;
  if (!max) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (s === 1 && file.type === 'image/jpeg') { bmp.close(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.88));
  } catch (e) { return file; }
}
async function storePhoto(file) { const blob = await processPhoto(file); const id = uid(); await Store.putPhoto(id, blob); return id; }
async function removePhoto(id) {
  if (!id) return;
  await Store.delPhoto(id);
  if (state.urls.has(id)) { URL.revokeObjectURL(state.urls.get(id)); state.urls.delete(id); }
}
function viewPhoto(ref, { onDelete, onReplace } = {}) {
  const m = modal(`<div class="viewer-img"><img data-photo="${esc(ref)}" alt=""></div>
    <div class="viewer-bar">
      <button class="btn ghost" data-a="close">${icon('x')}${tt('common.close')}</button>
      ${onReplace ? `<button class="btn ghost" data-a="replace">${icon('camera')}${tt('photo.retake')}</button>` : ''}
      ${onDelete ? `<button class="btn ghost danger-text" data-a="del">${icon('trash')}${tt('common.delete')}</button>` : ''}
    </div>`, 'viewer');
  hydratePhotos(m.el);
  m.el.addEventListener('click', async e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'close') m.close();
    if (a.dataset.a === 'replace') { m.close(); onReplace(); }
    if (a.dataset.a === 'del' && await confirmDlg(t('photo.confirmDelete'), t('common.delete'))) { m.close(); onDelete(); }
  });
}

/* ---------------- Dictation (phone) ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function stopDictation() { if (state.rec) { try { state.rec.stop(); } catch (e) {} state.rec = null; } }
function dictate(field, btn) {
  if (state.rec) { const same = state.rec._btn === btn; stopDictation(); if (same) return; }
  if (!SR) { toast(t('dict.unsupported')); field.focus(); return; }
  const r = new SR();
  r.lang = curLang().speech; r.interimResults = true; r.continuous = false; r._btn = btn;
  const base = field.value; const sep = base && !/\s$/.test(base) ? ' ' : '';
  r.onresult = e => {
    let txt = ''; for (const res of e.results) txt += res[0].transcript;
    if (txt && (!base.trim() || /[.!?]\s*$/.test(base))) txt = txt[0].toUpperCase() + txt.slice(1);
    field.value = base + sep + txt; field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  r.onerror = e => {
    const key = e.error === 'not-allowed' ? 'dict.denied' : e.error === 'service-not-allowed' ? 'dict.noService'
      : e.error === 'no-speech' ? 'dict.noSpeech' : e.error === 'network' ? 'dict.network' : 'dict.error';
    toast(`${t(key)} (${e.error})`, 'warn');
  };
  r.onend = () => { btn.classList.remove('rec'); if (state.rec === r) state.rec = null; };
  state.rec = r; btn.classList.add('rec');
  try { r.start(); } catch (e) { btn.classList.remove('rec'); state.rec = null; toast(t('dict.error'), 'warn'); }
}

/* ---------------- GPS (phone) ---------------- */
const toFix = p => ({ lat: +p.coords.latitude.toFixed(7), lon: +p.coords.longitude.toFixed(7), acc: Math.round(p.coords.accuracy), alt: p.coords.altitude != null ? Math.round(p.coords.altitude) : null, time: new Date(p.timestamp).toISOString() });
function startGPS(onUpdate, onDone) {
  if (!navigator.geolocation) { onDone(null, 'unsupported'); return null; }
  let best = null, finished = false, wid = null;
  const finish = err => {
    if (finished) return; finished = true;
    if (wid != null) navigator.geolocation.clearWatch(wid); clearTimeout(timer); onDone(best, best ? null : err);
  };
  const timer = setTimeout(() => finish('timeout'), 25000);
  wid = navigator.geolocation.watchPosition(p => {
    const g = toFix(p);
    if (!best || g.acc <= best.acc) { best = g; onUpdate(best); }
    if (g.acc <= 6) finish();
  }, err => { if (err.code === 1) finish('denied'); /* no signal yet: keep trying until the timer ends */ }, { enableHighAccuracy: true, maximumAge: 0 });
  return { stop: () => finish('stopped') };
}
// Keeps the GPS receiver warm while you work inside an excursion on the phone,
// so a new location gets an accurate fix straight away.
const Warm = {
  wid: null, last: null, error: null,
  start() {
    if (isLaptop() || this.wid != null) return;
    if (!navigator.geolocation) { this.error = 'unsupported'; renderGpsBox(); return; }
    this.wid = navigator.geolocation.watchPosition(
      p => { this.last = toFix(p); if (this.error) { this.error = null; renderGpsBox(); } },
      err => { this.error = err.code === 1 ? 'denied' : 'unavailable'; renderGpsBox(); },
      { enableHighAccuracy: true, maximumAge: 0 });
  },
  stop() { if (this.wid != null) { navigator.geolocation.clearWatch(this.wid); this.wid = null; } },
  fresh() { return this.last && Date.now() - Date.parse(this.last.time) < 20000 ? this.last : null; },
};
function stopGPS() { if (state.gps) { state.gps.stop(); state.gps = null; } }

/* ---------------- Saving ---------------- */
function touch(...objs) {
  const n = now(); objs.forEach(o => { if (o) o.updated = n; });
  if (!state.exc) return;
  state.exc.updated = n;
  if (isLaptop()) { state.exc.library = state.exc.library || {}; state.exc.library.laptopEdited = n; }
  else state.exc.dirty = true;
}
function scheduleSave() { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(flushSave, isLaptop() ? 800 : 400); }
async function flushSave() {
  clearTimeout(state.saveTimer); state.saveTimer = null;
  if (!state.exc || !state.excChanged) return;
  state.excChanged = false;
  try {
    await D().putExc(state.exc);
    const s = $('#saved'); if (s) { s.classList.add('on'); clearTimeout(s._t); s._t = setTimeout(() => s.classList.remove('on'), 1200); }
  } catch (e) { console.error(e); state.excChanged = true; toast(t('err.save'), 'warn'); }
}
function changed(...objs) { touch(...objs); state.excChanged = true; scheduleSave(); }
async function changedNow(...objs) { touch(...objs); state.excChanged = true; await flushSave(); }
function bindFields(obj, ...touchObjs) {
  $$('[data-bind]', $('#main')).forEach(el => {
    el.addEventListener('input', () => {
      obj[el.dataset.bind] = el.value; changed(obj, ...touchObjs);
      if (el.dataset.live) { const h = $('#hdr-title'); if (h) h.textContent = el.value.trim() || el.dataset.fallback || ''; }
    });
  });
}
async function loadExc(id) {
  if (state.exc && state.exc.id === id) return state.exc;
  await flushSave();
  state.exc = await D().getExc(id) || null; state.excChanged = false;
  return state.exc;
}

/* ---------------- Shell rendering ---------------- */
function shell({ title, back, crumb, actions = [], bottom = [], mainCls = '' }) {
  $('#hdr').innerHTML = `
    ${back ? `<a class="hbtn" href="${back}" aria-label="${esc(t('nav.back'))}">${icon('back')}</a>` : `<span class="brand-dot" aria-hidden="true"></span>`}
    <div class="htext"><div class="hcrumb">${crumb || ''}</div><h1 id="hdr-title">${title}</h1></div>
    <span id="saved" class="saved" aria-live="polite">${icon('check')}${tt('common.saved')}</span>
    ${actions.map(a => `<a class="hbtn" href="${a.href}" aria-label="${esc(a.label)}">${icon(a.icon)}</a>`).join('')}`;
  const main = $('#main'); main.className = mainCls; window.scrollTo(0, 0);
  const bar = $('#bottom');
  bar.innerHTML = `<div class="bottom-in">${bottom.map((b, i) => `<button class="btn ${b.primary ? 'primary' : 'ghost'} ${b.grow ? 'grow' : ''}" data-b="${i}">${b.icon ? icon(b.icon) : ''}${b.html}</button>`).join('')}</div>`;
  bar.hidden = !bottom.length;
  document.body.classList.toggle('has-bottom', !!bottom.length);
  $$('[data-b]', bar).forEach(el => el.addEventListener('click', () => bottom[+el.dataset.b].onclick()));
  return main;
}
const micBtn = target => (isLaptop() ? '' : `<button type="button" class="mic" data-mic="${target}" aria-label="${esc(t('dict.button'))}">${icon('mic')}</button>`);
function field({ id, bind, label, value, placeholder, multiline, optional, live, fallback }) {
  const ph = placeholder ? `placeholder="${esc(placeholder)}"` : '';
  const input = multiline
    ? `<textarea id="${id}" data-bind="${bind}" rows="3" ${ph}>${esc(value)}</textarea>`
    : `<input id="${id}" data-bind="${bind}" ${live ? 'data-live="1"' : ''} ${fallback ? `data-fallback="${esc(fallback)}"` : ''} value="${esc(value)}" ${ph} autocomplete="off">`;
  return `<div class="field"><label for="${id}">${label}${optional ? ` <span class="opt">${tt('common.optional')}</span>` : ''}</label>
    <div class="field-row">${input}${micBtn(id)}</div></div>`;
}
function wireMics(root = $('#main')) { $$('[data-mic]', root).forEach(b => b.addEventListener('click', () => dictate($('#' + b.dataset.mic), b))); }
const counts = e => ({ locs: e.locations.length, samples: e.locations.reduce((n, l) => n + l.samples.length, 0) });
const gmapsOne = g => `https://www.google.com/maps/search/?api=1&query=${g.lat},${g.lon}`;
function gmapsRoute(locs) {
  const pts = locs.filter(l => l.gps).slice(0, 10).map(l => `${l.gps.lat},${l.gps.lon}`);
  if (!pts.length) return null;
  if (pts.length === 1) return gmapsOne({ lat: pts[0].split(',')[0], lon: pts[0].split(',')[1] });
  const wp = pts.slice(1, -1).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${pts[0]}&destination=${pts[pts.length - 1]}${wp ? '&waypoints=' + encodeURIComponent(wp) : ''}&travelmode=walking`;
}
const fmtCoord = g => `${(+g.lat).toFixed(5)}, ${(+g.lon).toFixed(5)}`;
function statusPill(e) {
  if (isLaptop()) {
    const lib = e.library || {};
    if (lib.laptopEdited && (!lib.importedAt || lib.laptopEdited > lib.importedAt)) return `<span class="pill info">${tt('status.correctedHere')}</span>`;
    return lib.importedAt ? `<span class="pill ok">${tt('status.imported')}</span>` : '';
  }
  return e.dirty ? `<span class="pill warn">${tt('status.dirty')}</span>` : `<span class="pill ok">${tt('status.sent')}</span>`;
}

/* ---------------- Views ---------------- */
async function viewHome() {
  state.exc = null;
  if (isLaptop() && !await ensureLibrary()) return viewLibrarySetup();
  let list = [];
  try { list = (await D().listExc()).sort((a, b) => (b.created || '').localeCompare(a.created || '')); }
  catch (e) { console.error(e); toast(t('lib.readFailed'), 'warn'); }
  const dirty = list.filter(e => e.dirty);
  const bottom = isLaptop()
    ? [{ html: tt('lib.importPackage'), icon: 'upload', primary: true, grow: true, onclick: importPackageLaptop }]
    : [{ html: tt('home.newExcursion'), icon: 'plus', primary: true, grow: true, onclick: newExcursion }];
  const main = shell({
    title: tt('app.name'), crumb: isLaptop() ? `${icon('folder', 'tiny')}${esc(Lib.root.name)}` : '',
    actions: [...(isLaptop() ? [{ href: '#/refresh', icon: 'refresh', label: t('lib.refresh') }] : []), { href: '#/settings', icon: 'gear', label: t('nav.settings') }],
    bottom, mainCls: 'home',
  });
  const send = !isLaptop() && list.length ? `<div class="send-card ${dirty.length ? '' : 'calm'}">
      <div><div class="send-title">${tt(dirty.length ? 'sync.pending' : 'sync.allSent', { n: dirty.length })}</div>
      <div class="hint">${tt(dirty.length ? 'sync.pendingHint' : 'sync.allSentHint')}</div></div>
      ${dirty.length ? `<button class="btn primary" id="h-send">${icon('send')}${tt('sync.send')}</button>` : ''}</div>` : '';
  if (!list.length) {
    main.innerHTML = `<div class="empty">
      <div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div>
      <h2>${tt(isLaptop() ? 'lib.emptyTitle' : 'home.emptyTitle')}</h2><p>${tt(isLaptop() ? 'lib.emptyBody' : 'home.emptyBody')}</p></div>`;
    return;
  }
  main.innerHTML = `${send}<h2 class="sec">${tt('home.listTitle')} <span class="count">${list.length}</span></h2>
    <ul class="list">${list.map(e => { const c = counts(e); return `<li><a class="row" href="#/e/${e.id}">
      <div class="row-main"><div class="row-title">${esc(e.title || t('exc.untitled'))}</div>
      <div class="row-meta">${esc(fmtDay(e.created))} · ${esc(t('count.locations', { n: c.locs }))} · ${esc(t('count.samples', { n: c.samples }))}</div></div>
      ${statusPill(e)}${icon('chev', 'chev')}</a></li>`; }).join('')}</ul>`;
  const s = $('#h-send'); if (s) s.addEventListener('click', () => sendPackage(dirty.map(e => e.id)));
}

function viewLibrarySetup() {
  const main = shell({ title: tt('app.name'), actions: [{ href: '#/settings', icon: 'gear', label: t('nav.settings') }] });
  const h = state.pendingHandle;
  main.innerHTML = `<div class="empty setup">
    <div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div>
    <h2>${tt(h ? 'lib.reconnectTitle' : 'lib.setupTitle')}</h2>
    <p>${h ? tt('lib.reconnectBody', { name: h.name }) : tt('lib.setupBody')}</p>
    ${HAS_FS ? `<div class="setup-actions">
      ${h ? `<button class="btn primary" id="lib-re">${icon('folder')}${tt('lib.reconnect', { name: h.name })}</button>` : ''}
      <button class="btn ${h ? 'ghost' : 'primary'}" id="lib-pick">${icon('folder')}${tt('lib.choose')}</button></div>
      <p class="hint">${tt('lib.nasHint')}</p>`
      : `<p class="hint warn-text">${tt('lib.unsupported')}</p>`}
  </div>`;
  const re = $('#lib-re'); if (re) re.addEventListener('click', reconnectLibrary);
  const pk = $('#lib-pick'); if (pk) pk.addEventListener('click', chooseLibrary);
}

async function newExcursion() {
  const e = { id: uid(), title: '', goal: '', created: now(), updated: now(), dirty: true, locations: [] };
  await Store.putExc(e); state.exc = e;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (err) {}
  location.hash = `#/e/${e.id}`;
}

async function viewExcursion(eid) {
  const e = await loadExc(eid); if (!e) return notFound();
  const c = counts(e); const L = isLaptop();
  const main = shell({
    title: esc(e.title || t('exc.untitled')), back: '#/', crumb: tt('exc.label'),
    bottom: L ? [] : [{ html: tt('loc.add'), icon: 'plus', primary: true, grow: true, onclick: () => addLocation(e) }],
  });
  main.innerHTML = `
    ${L ? '' : '<div id="gpsbox"></div>'}
    <section class="card">
      ${field({ id: 'f-title', bind: 'title', label: tt('exc.title'), value: e.title, live: true, fallback: t('exc.untitled'), placeholder: t('common.autoPh') })}
      ${field({ id: 'f-goal', bind: 'goal', label: tt('exc.goal'), value: e.goal, multiline: true, optional: true, placeholder: t('exc.goalPh') })}
      <div class="meta-line">${tt('common.created')}: ${esc(fmtDate(e.created))} ${statusPill(e)}</div>
      ${L && e.library && e.library.importedAt ? `<div class="meta-line">${tt('lib.importedAt', { date: fmtDate(e.library.importedAt) })} · <span class="mono">${esc(Lib.folderOf(e.id) || '')}</span></div>` : ''}
    </section>
    <div class="tools">
      ${mapTool(`#/e/${e.id}/map`, 'exc.mapAll', e.locations.some(l => l.gps))}
      <button class="tool" id="t-gm" ${e.locations.some(l => l.gps) ? '' : 'disabled'}>${icon('ext')}${tt('exc.googleRoute')}</button>
      ${L ? '' : `<button class="tool" id="t-exp">${icon('send')}${tt('sync.sendThis')}</button>`}
    </div>
    <h2 class="sec">${tt('loc.listTitle')} <span class="count">${c.locs}</span></h2>
    ${e.locations.length ? `<ul class="list ${L ? 'grid' : ''}">${e.locations.map((l, i) => `<li><a class="row" href="#/e/${e.id}/l/${l.id}">
      <span class="idx">${i + 1}</span>
      ${l.photos[0] ? `<img class="thumb" data-photo="${esc(l.photos[0])}" alt="">` : ''}
      <div class="row-main"><div class="row-title">${esc(locTitle(l, i))}</div>
      <div class="row-meta">${l.gps ? `<span class="mono">${fmtCoord(l.gps)}</span>` : `<span class="danger-text">${esc(t('gps.none'))}</span>`} · ${esc(t('count.samples', { n: l.samples.length }))}</div></div>
      ${icon('chev', 'chev')}</a></li>`).join('')}</ul>`
      : `<p class="hint">${tt(L ? 'loc.emptyHintLaptop' : 'loc.emptyHint')}</p>`}
    <div class="danger-zone"><button class="btn ghost danger-text" id="t-del">${icon('trash')}${tt(L ? 'exc.deleteLaptop' : 'exc.delete')}</button></div>`;
  bindFields(e); wireMics(); hydratePhotos(main); renderGpsBox();
  $('#t-gm').addEventListener('click', () => {
    const u = gmapsRoute(e.locations);
    if (!u) return toast(t('map.noPoints'));
    if (e.locations.filter(l => l.gps).length > 10) toast(t('map.routeLimit'));
    window.open(u, '_blank', 'noopener');
  });
  const ex = $('#t-exp'); if (ex) ex.addEventListener('click', () => sendPackage([e.id]));
  $('#t-del').addEventListener('click', async () => {
    if (!await confirmDlg(t(L ? 'exc.confirmDeleteLaptop' : 'exc.confirmDelete', { title: e.title }), t('common.delete'))) return;
    if (!L) for (const l of e.locations) await deleteLocationPhotos(l);
    await D().delExc(e.id); state.exc = null; location.hash = '#/';
  });
}

const locTitle = (l, i) => l.title.trim() || t('loc.defaultTitle', { n: i + 1 });
const mapTool = (href, label, enabled, attr = '') => (enabled
  ? `<a class="tool" href="${href}" ${attr}>${icon('map')}${tt(label)}</a>`
  : `<button class="tool" disabled ${attr}>${icon('map')}${tt(label)}</button>`);

// A title left empty gets an automatic one once something is added below it.
async function autoTitleExcursion(e) {
  if (e.title.trim()) return;
  const all = (await Store.listExc()).sort((a, b) => (a.created || '').localeCompare(b.created || ''));
  const n = all.findIndex(x => x.id === e.id) + 1 || all.length + 1;
  e.title = t('exc.autoTitle', { n });
}
function autoTitleLocation(e, l) { if (!l.title.trim()) l.title = t('loc.defaultTitle', { n: e.locations.indexOf(l) + 1 }); }
function nextSampleNumber(e) {
  let max = 0, count = 0;
  e.locations.forEach(l => l.samples.forEach(s => { count++; const m = /^\s*(\d+)/.exec(s.title); if (m) max = Math.max(max, +m[1]); }));
  return Math.max(max, count) + 1;
}

async function addLocation(e) {
  await autoTitleExcursion(e);
  const l = { id: uid(), title: '', description: '', gps: null, photos: [], samples: [], created: now(), updated: now() };
  e.locations.push(l); await changedNow(l);
  captureLocationGPS(e.id, l.id);
  location.hash = `#/e/${e.id}/l/${l.id}`;
}

// Records the position of a new location in the background; keeps running when you move on to a sample.
function captureLocationGPS(excId, locId) {
  const apply = async g => {
    const e = state.exc && state.exc.id === excId ? state.exc : await Store.getExc(excId);
    const l = e && e.locations.find(x => x.id === locId); if (!l) return;
    if (l.gps && l.gps.acc < g.acc) return; // keep the more accurate fix
    l.gps = g; l.updated = now(); e.updated = now(); e.dirty = true;
    if (e === state.exc) { state.excChanged = true; await flushSave(); } else await Store.putExc(e);
    renderGpsBox();
    const btn = $(`[data-maploc="${locId}"]`);
    if (btn && btn.tagName === 'BUTTON') btn.outerHTML = mapTool(`#/e/${excId}/l/${locId}/map`, 'loc.showOnMap', true, `data-maploc="${locId}"`);
  };
  stopGPS();
  const warm = Warm.fresh(); if (warm) apply(warm);
  state.gpsLoc = locId;
  state.gps = startGPS(g => { apply(g); }, (g, err) => {
    state.gps = null; state.gpsLoc = null;
    if (!g && !warm && err !== 'stopped') {
      if (err === 'denied') Warm.error = 'denied';
      if (!$(`#gpsbox[data-loc="${locId}"]`)) toast(t(err === 'denied' ? 'gps.denied' : err === 'unsupported' ? 'gps.unsupported' : 'gps.notRecorded'), 'warn');
    }
    renderGpsBox();
  });
  renderGpsBox();
}

// Red warning (phone only): this location has no coordinates yet, or GPS is unavailable.
function renderGpsBox() {
  const box = $('#gpsbox'); if (!box || isLaptop()) return;
  const lid = box.dataset.loc;
  const l = lid && state.exc && state.exc.locations.find(x => x.id === lid);
  let html = '';
  if (l && !l.gps) {
    html = state.gps && state.gpsLoc === lid
      ? `<div class="gpsbox info">${icon('crosshair')}<div class="gpsbox-text">${tt('gps.measuring')}</div></div>`
      : `<div class="gpsbox alert" role="alert">${icon('crosshair')}<div class="gpsbox-text"><b>${tt('gps.missingTitle')}</b>
          <span>${tt(Warm.error === 'denied' ? 'gps.denied' : 'gps.missingBody')}</span></div>
          <button class="btn small" id="gps-again">${icon('crosshair')}${tt('gps.measureAgain')}</button></div>`;
  } else if (!l && Warm.error) {
    html = `<div class="gpsbox alert" role="alert">${icon('crosshair')}<div class="gpsbox-text"><b>${tt('gps.unavailableTitle')}</b>
      <span>${tt(Warm.error === 'denied' ? 'gps.denied' : 'gps.waitForSignal')}</span></div></div>`;
  }
  box.innerHTML = html;
  const again = $('#gps-again');
  if (again) again.addEventListener('click', () => { if (state.exc) captureLocationGPS(state.exc.id, lid); });
}
async function deleteLocationPhotos(l) {
  for (const p of l.photos) await removePhoto(p);
  for (const s of l.samples) for (const k of PHOTO_KEYS) await removePhoto(s[k]);
}

async function viewLocation(eid, lid) {
  const e = await loadExc(eid); if (!e) return notFound();
  const idx = e.locations.findIndex(x => x.id === lid); const l = e.locations[idx]; if (!l) return notFound();
  const L = isLaptop();
  const main = shell({
    title: esc(locTitle(l, idx)), back: `#/e/${e.id}`, crumb: `${tt('loc.label')} ${idx + 1} · ${esc(e.title || t('exc.untitled'))}`,
    bottom: L ? [] : [{ html: tt('sample.add'), icon: 'plus', primary: true, grow: true, onclick: () => addSample(e, l) }],
  });
  main.innerHTML = `
    ${L ? '' : `<div id="gpsbox" data-loc="${l.id}"></div>`}
    <div class="cols"><div>
    <section class="card">
      ${field({ id: 'f-title', bind: 'title', label: tt('loc.title'), value: l.title, live: true, fallback: t('loc.defaultTitle', { n: idx + 1 }), placeholder: t('common.autoPh') })}
      ${field({ id: 'f-desc', bind: 'description', label: tt('loc.description'), value: l.description, multiline: true, optional: true, placeholder: t('loc.descriptionPh') })}
    </section>
    <div class="tools">${mapTool(`#/e/${e.id}/l/${l.id}/map`, 'loc.showOnMap', !!l.gps, `data-maploc="${l.id}"`)}</div>
    </div><div>
    <h2 class="sec">${tt('loc.photos')} <span class="opt">${tt('common.optional')}</span></h2>
    <div class="photo-grid" id="lphotos">
      ${l.photos.map(p => `<button class="ph" data-p="${esc(p)}"><img data-photo="${esc(p)}" alt=""></button>`).join('')}
      ${L ? (l.photos.length ? '' : `<p class="hint">${tt('photo.none')}</p>`) : `<button class="ph add" id="lp-cam">${icon('camera')}<span>${tt('photo.take')}</span></button>
      <button class="ph add alt" id="lp-gal">${icon('image')}<span>${tt('photo.gallery')}</span></button>`}
    </div>
    </div></div>
    <h2 class="sec">${tt('sample.listTitle')} <span class="count">${l.samples.length}</span></h2>
    ${l.samples.length ? `<ul class="list ${L ? 'grid' : ''}">${l.samples.map(s => {
      const thumb = s.container || s.specimen || s.context;
      const n = PHOTO_KEYS.filter(k => s[k]).length;
      return `<li><a class="row" href="#/e/${e.id}/l/${l.id}/s/${s.id}">
        ${thumb ? `<img class="thumb" data-photo="${esc(thumb)}" alt="">` : `<span class="thumb empty">${icon('vial')}</span>`}
        <div class="row-main"><div class="row-title">${esc(s.title)}</div>
        <div class="row-meta">${esc(t('count.photos', { n }))}${!s.container ? ' · <span class="warn-text">' + esc(t('sample.noContainer')) + '</span>' : ''}</div></div>
        ${icon('chev', 'chev')}</a></li>`; }).join('')}</ul>`
      : `<p class="hint">${tt(L ? 'sample.emptyHintLaptop' : 'sample.emptyHint')}</p>`}
    ${L ? '' : `<div class="danger-zone"><button class="btn ghost danger-text" id="l-del">${icon('trash')}${tt('loc.delete')}</button></div>`}`;
  bindFields(l); wireMics(); hydratePhotos(main); renderGpsBox();

  $$('#lphotos [data-p]').forEach(b => b.addEventListener('click', () => viewPhoto(b.dataset.p, L ? {} : {
    onDelete: async () => { await removePhoto(b.dataset.p); l.photos = l.photos.filter(p => p !== b.dataset.p); await changedNow(l); route(); },
  })));
  if (L) return;
  const addPhotos = async camera => {
    const files = await pickPhotos({ camera, multiple: !camera });
    for (const f of files) l.photos.push(await storePhoto(f));
    if (files.length) { await changedNow(l); route(); }
  };
  $('#lp-cam').addEventListener('click', () => addPhotos(true));
  $('#lp-gal').addEventListener('click', () => addPhotos(false));
  $('#l-del').addEventListener('click', async () => {
    if (!await confirmDlg(t('loc.confirmDelete', { title: locTitle(l, idx), n: l.samples.length }), t('common.delete'))) return;
    await deleteLocationPhotos(l);
    e.locations = e.locations.filter(x => x !== l); await changedNow(); location.hash = `#/e/${e.id}`;
  });
}

async function addSample(e, l) {
  await autoTitleExcursion(e); autoTitleLocation(e, l);
  const s = { id: uid(), title: `${nextSampleNumber(e)}. `, notes: '', container: null, specimen: null, context: null, created: now(), updated: now() };
  l.samples.push(s); await changedNow(l, s);
  location.hash = `#/e/${e.id}/l/${l.id}/s/${s.id}`;
}

const SLOTS = [
  { key: 'container', label: 'sample.container', hint: 'sample.containerHint', optional: false },
  { key: 'specimen', label: 'sample.specimen', hint: 'sample.specimenHint', optional: true },
  { key: 'context', label: 'sample.context', hint: 'sample.contextHint', optional: true },
];
async function viewSample(eid, lid, sid) {
  const e = await loadExc(eid); if (!e) return notFound();
  const l = e.locations.find(x => x.id === lid); if (!l) return notFound();
  const si = l.samples.findIndex(x => x.id === sid); const s = l.samples[si]; if (!s) return notFound();
  const L = isLaptop();
  const prev = l.samples[si - 1], next = l.samples[si + 1];
  const main = shell({
    title: esc(s.title), back: `#/e/${e.id}/l/${l.id}`, crumb: `${esc(locTitle(l, e.locations.indexOf(l)))} · ${esc(e.title || t('exc.untitled'))}`,
    bottom: L ? [] : [
      { html: tt('common.done'), icon: 'check', onclick: () => { location.hash = `#/e/${e.id}/l/${l.id}`; } },
      { html: tt('sample.next'), icon: 'plus', primary: true, grow: true, onclick: () => addSample(e, l) },
    ],
  });
  main.innerHTML = `
    <section class="card">${field({ id: 'f-title', bind: 'title', label: tt('sample.title'), value: s.title, live: true })}</section>
    <div class="slots">${SLOTS.map(sl => `
      <div class="slot ${s[sl.key] ? 'filled' : ''}">
        <div class="slot-head"><span class="slot-name">${tt(sl.label)}</span>${sl.optional ? `<span class="opt">${tt('common.optional')}</span>` : ''}</div>
        ${L ? '' : `<p class="slot-hint">${tt(sl.hint)}</p>`}
        ${s[sl.key]
          ? `<button class="slot-photo" data-view="${sl.key}"><img data-photo="${esc(s[sl.key])}" alt=""></button>`
          : L ? `<div class="slot-none">${tt('photo.none')}</div>`
          : `<div class="slot-add"><button class="btn primary-soft grow" data-cam="${sl.key}">${icon('camera')}${tt('photo.take')}</button>
             <button class="btn ghost icon-only" data-gal="${sl.key}" aria-label="${esc(t('photo.gallery'))}">${icon('image')}</button></div>`}
      </div>`).join('')}</div>
    <section class="card">${field({ id: 'f-notes', bind: 'notes', label: tt('sample.notes'), value: s.notes, multiline: true, optional: true, placeholder: t('sample.notesPh') })}</section>
    ${L ? `<div class="pager">
        ${prev ? `<a class="btn ghost" href="#/e/${e.id}/l/${l.id}/s/${prev.id}">${icon('back')}${esc(prev.title)}</a>` : '<span></span>'}
        ${next ? `<a class="btn ghost" href="#/e/${e.id}/l/${l.id}/s/${next.id}">${esc(next.title)}${icon('chev')}</a>` : ''}</div>`
      : `<div class="danger-zone"><button class="btn ghost danger-text" id="s-del">${icon('trash')}${tt('sample.delete')}</button></div>`}`;
  bindFields(s, l); wireMics(); hydratePhotos(main);
  const setSlot = async (key, camera) => {
    const [f] = await pickPhotos({ camera }); if (!f) return;
    const old = s[key]; s[key] = await storePhoto(f); if (old) await removePhoto(old);
    await changedNow(s, l); route();
  };
  $$('[data-cam]', main).forEach(b => b.addEventListener('click', () => setSlot(b.dataset.cam, true)));
  $$('[data-gal]', main).forEach(b => b.addEventListener('click', () => setSlot(b.dataset.gal, false)));
  $$('[data-view]', main).forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.view;
    viewPhoto(s[key], L ? {} : {
      onReplace: () => setSlot(key, true),
      onDelete: async () => { await removePhoto(s[key]); s[key] = null; await changedNow(s, l); route(); },
    });
  }));
  const del = $('#s-del');
  if (del) del.addEventListener('click', async () => {
    if (!await confirmDlg(t('sample.confirmDelete', { title: s.title }), t('common.delete'))) return;
    for (const k of PHOTO_KEYS) await removePhoto(s[k]);
    l.samples = l.samples.filter(x => x !== s); await changedNow(l); location.hash = `#/e/${e.id}/l/${l.id}`;
  });
}

async function viewMap(eid, lid) {
  const e = await loadExc(eid); if (!e) return notFound();
  const focus = lid && e.locations.find(x => x.id === lid);
  const pts = e.locations.filter(x => x.gps);
  const main = shell({ title: esc(focus ? focus.title : e.title), back: focus ? `#/e/${e.id}/l/${focus.id}` : `#/e/${e.id}`, crumb: tt('map.title'), mainCls: 'map-main' });
  const gUrl = focus && focus.gps ? gmapsOne(focus.gps) : gmapsRoute(e.locations);
  main.innerHTML = `<div id="map" class="map"></div>
    <div class="map-bar">
      <span class="map-count">${esc(t('map.count', { n: pts.length, total: e.locations.length }))}</span>
      ${gUrl ? `<a class="btn small ghost" href="${gUrl}" target="_blank" rel="noopener">${icon('ext')}${tt(focus ? 'map.google' : 'exc.googleRoute')}</a>` : ''}
    </div>`;
  if (!window.L) { $('#map').innerHTML = `<p class="hint pad">${tt('map.unavailable')}</p>`; return; }
  if (!pts.length) { $('#map').innerHTML = `<p class="hint pad">${tt('map.noPoints')}</p>`; return; }
  const map = L.map('map', { zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const css = getComputedStyle(document.documentElement);
  const cBlue = css.getPropertyValue('--accent').trim() || '#2453b8', cPink = css.getPropertyValue('--eosin').trim() || '#c93a6e';
  pts.forEach(x => {
    const i = e.locations.indexOf(x) + 1, on = focus && x.id === focus.id;
    if (x.gps.acc) L.circle([x.gps.lat, x.gps.lon], { radius: x.gps.acc, color: on ? cPink : cBlue, weight: 1, fillOpacity: 0.08 }).addTo(map);
    L.marker([x.gps.lat, x.gps.lon], { icon: L.divIcon({ className: 'pin' + (on ? ' pin-on' : ''), html: `<span>${i}</span>`, iconSize: [32, 32], iconAnchor: [16, 16] }) })
      .addTo(map).bindPopup(`<b>${esc(x.title)}</b><br>${esc(t('count.samples', { n: x.samples.length }))}<br><a href="#/e/${e.id}/l/${x.id}">${esc(t('map.openLocation'))}</a>`);
  });
  map.fitBounds(L.latLngBounds(pts.map(x => [x.gps.lat, x.gps.lon])).pad(0.25), { maxZoom: 16 });
  if (focus && focus.gps) setTimeout(() => { if (state.map === map) map.flyTo([focus.gps.lat, focus.gps.lon], 18, { duration: 1.6 }); }, 900);
  state.map = map;
}

async function viewSettings() {
  state.exc = null;
  const main = shell({ title: tt('nav.settings'), back: '#/' });
  const L = isLaptop();
  let est = '', persisted = null;
  try { if (!L && navigator.storage && navigator.storage.estimate) { const s = await navigator.storage.estimate(); est = t('set.storageUsed', { used: (s.usage / 1048576).toFixed(1), quota: Math.round(s.quota / 1048576) }); } } catch (e) {}
  try { persisted = !L && navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) {}
  main.innerHTML = `
    <section class="card">
      <div class="field"><label for="s-lang">${tt('set.language')}</label>
        <select id="s-lang">${I18N.langs.map(l => `<option value="${l.code}" ${l.code === I18N.lang ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="s-mode">${tt('set.mode')}</label>
        <select id="s-mode"><option value="phone" ${!L ? 'selected' : ''}>${esc(t('set.modePhone'))}</option>
        <option value="laptop" ${L ? 'selected' : ''} ${HAS_FS ? '' : 'disabled'}>${esc(t('set.modeLaptop'))}</option></select>
        <p class="hint">${tt(HAS_FS ? 'set.modeHint' : 'set.modeHintNoFs')}</p></div>
      ${L ? '' : `<div class="field"><label for="s-photo">${tt('set.photoSize')}</label>
        <select id="s-photo">${[[1600, 'set.photo1600'], [2560, 'set.photo2560'], [0, 'set.photoOriginal']].map(([v, k]) => `<option value="${v}" ${+state.settings.photoMax === v ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select>
        <p class="hint">${tt('set.photoHint')}</p></div>`}
    </section>
    ${L ? `<h2 class="sec">${tt('lib.title')}</h2>
    <section class="card">
      <div class="meta-line">${icon('folder', 'tiny')} <span class="mono">${esc(Lib.root ? Lib.root.name : state.pendingHandle ? state.pendingHandle.name : t('lib.notSet'))}</span></div>
      <button class="btn ghost full" id="s-lib">${icon('folder')}${tt('lib.change')}</button>
      <p class="hint">${tt('lib.nasHint')}</p>
    </section>` : `<h2 class="sec">${tt('set.dataTitle')}</h2>
    <section class="card">
      <button class="btn ghost full" id="s-sendall">${icon('send')}${tt('sync.sendAll')}</button>
      <p class="hint">${tt('sync.sendAllHint')}</p>
      <button class="btn ghost full" id="s-import">${icon('upload')}${tt('set.importExc')}</button>
      <p class="hint">${tt('set.importHint')}</p>
      ${est ? `<div class="meta-line">${esc(est)}${persisted === true ? ' · ' + esc(t('set.persisted')) : ''}</div>` : ''}
      ${persisted === false ? `<button class="btn ghost full" id="s-persist">${tt('set.persist')}</button><p class="hint">${tt('set.persistHint')}</p>` : ''}
      ${Store.isMemory() ? `<p class="hint warn-text">${tt('set.memoryOnly')}</p>` : ''}
    </section>`}
    <h2 class="sec">${tt('set.textsTitle')}</h2>
    <section class="card">
      <label class="switch"><input type="checkbox" id="s-edit" ${I18N.edit ? 'checked' : ''}><span>${tt('set.editMode')}</span></label>
      <p class="hint">${tt('set.editModeHint')}</p>
      <a class="btn ghost full" href="#/texts">${icon('edit')}${tt('set.openTexts')}</a>
    </section>
    <h2 class="sec">${tt('set.installTitle')}</h2>
    <section class="card">
      ${isStandalone() ? `<p class="hint">${tt('set.installed')}</p>`
        : `${state.installEvt ? `<button class="btn primary full" id="s-install">${icon('download')}${tt('set.install')}</button>` : ''}
           <p class="hint">${tt(isLaptop() ? 'set.installHintLaptop' : 'set.installHintPhone')}</p>`}
    </section>
    <h2 class="sec">${tt('set.about')}</h2>
    <section class="card">${L ? '' : `<p class="hint">${tt('set.dictationHint')}</p>`}<div class="meta-line mono">v${APP_VERSION}</div></section>`;
  const saveSettings = () => Store.kvSet('settings', state.settings);
  $('#s-lang').addEventListener('change', async ev => { I18N.lang = ev.target.value; state.settings.lang = I18N.lang; document.documentElement.lang = I18N.lang; await saveSettings(); setEditPill(); route(); });
  $('#s-mode').addEventListener('change', async ev => { state.settings.mode = ev.target.value; await saveSettings(); applyMode(); route(); });
  const ph = $('#s-photo'); if (ph) ph.addEventListener('change', async ev => { state.settings.photoMax = +ev.target.value; await saveSettings(); toast(t('common.saved')); });
  $('#s-edit').addEventListener('change', ev => setEditMode(ev.target.checked));
  const lib = $('#s-lib'); if (lib) lib.addEventListener('click', chooseLibrary);
  const sa = $('#s-sendall'); if (sa) sa.addEventListener('click', async () => sendPackage((await Store.listExc()).map(e => e.id)));
  const im = $('#s-import'); if (im) im.addEventListener('click', importPackagePhone);
  const p = $('#s-persist'); if (p) p.addEventListener('click', async () => { const ok = await navigator.storage.persist(); toast(t(ok ? 'set.persisted' : 'set.persistRefused'), ok ? '' : 'warn'); route(); });
  const ins = $('#s-install'); if (ins) ins.addEventListener('click', async () => {
    const ev = state.installEvt; state.installEvt = null;   // the browser allows one prompt per event
    try { ev.prompt(); await ev.userChoice; } catch (e) {}
    route();
  });
}

async function viewTexts() {
  state.exc = null;
  const main = shell({ title: tt('texts.title'), back: '#/settings' });
  main.innerHTML = `
    <div class="tools">
      <button class="tool" id="x-exp">${icon('download')}${tt('texts.exportXlsx')}</button>
      <button class="tool" id="x-imp">${icon('upload')}${tt('texts.importXlsx')}</button>
      <button class="tool" id="x-json">${icon('download')}${tt('texts.exportJson')}</button>
    </div>
    <p class="hint">${tt('texts.hint')}</p>
    <input id="x-q" class="search" type="search" placeholder="${esc(t('texts.search'))}" autocomplete="off">
    <ul class="list texts" id="x-list"></ul>
    <div class="danger-zone"><button class="btn ghost danger-text" id="x-reset">${icon('trash')}${tt('texts.resetAll')}</button></div>`;
  const draw = () => {
    const q = $('#x-q').value.trim().toLowerCase();
    $('#x-list').innerHTML = allTextIds().filter(id => !q || id.toLowerCase().includes(q) || I18N.langs.some(l => textValue(id, l.code).toLowerCase().includes(q)))
      .map(id => `<li><button class="row text-row" data-id="${id}"><div class="row-main"><div class="mono tid">${id}${I18N.over[id] ? ' <span class="pill info">' + esc(t('texts.edited')) + '</span>' : ''}</div>
        <div class="row-title">${esc(t(id))}</div></div>${icon('edit', 'chev')}</button></li>`).join('');
  };
  draw();
  $('#x-q').addEventListener('input', draw);
  $('#x-list').addEventListener('click', ev => { const b = ev.target.closest('[data-id]'); if (b) editText(b.dataset.id, draw); });
  $('#x-exp').addEventListener('click', exportTextsXlsx);
  $('#x-imp').addEventListener('click', importTextsXlsx);
  $('#x-json').addEventListener('click', exportTextsJson);
  $('#x-reset').addEventListener('click', async () => {
    if (!await confirmDlg(t('texts.confirmReset'), t('texts.resetAll'))) return;
    I18N.over = {}; await saveTexts(); route();
  });
}

function notFound() {
  const main = shell({ title: tt('err.notFoundTitle'), back: '#/' });
  main.innerHTML = `<p class="hint pad">${tt('err.notFound')}</p>`;
}

/* ---------------- Text editing in place ---------------- */
function setEditPill() {
  $('#editpill').innerHTML = `<span>${icon('edit')}${esc(t('set.editModeOn'))}</span><button class="btn small" id="edit-off">${esc(t('common.done'))}</button>`;
  $('#edit-off').addEventListener('click', () => { setEditMode(false); route(); });
}
function setEditMode(on) { I18N.edit = on; document.body.classList.toggle('editing', on); $('#editpill').hidden = !on; }
// Machine translation for the text editor: Chrome's on-device translator when available, else MyMemory.
const translators = {};
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
async function translateText(text, from, to) {
  if (!text.trim() || from === to) return text;
  const keep = []; // protect {placeholders}
  const masked = text.replace(/\{\w+\}/g, m => { keep.push(m); return `{${keep.length - 1}}`; });
  let out = null;
  try {
    if ('Translator' in self) {
      const k = from + '>' + to;
      const av = await withTimeout(Translator.availability({ sourceLanguage: from, targetLanguage: to }), 2500);
      if (av === 'available') {
        translators[k] = translators[k] || Translator.create({ sourceLanguage: from, targetLanguage: to });
        out = await withTimeout((async () => (await translators[k]).translate(masked))(), 6000);
      } else if (av === 'downloadable' && !translators[k]) {
        translators[k] = Translator.create({ sourceLanguage: from, targetLanguage: to }); // download for next time
        translators[k].catch(() => { delete translators[k]; });
      }
    }
  } catch (e) { out = null; }
  if (!out) {
    const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(masked)}&langpair=${from}|${to}`);
    const j = await r.json();
    if (+j.responseStatus !== 200 || !j.responseData || !j.responseData.translatedText) throw new Error('translate failed');
    out = j.responseData.translatedText;
  }
  return out.replace(/\{\s*(\d+)\s*\}/g, (m, i) => keep[+i] ?? m);
}

function editText(id, after) {
  const def = TEXTS[id] || {};
  const m = modal(`<h3 class="mono tid">${esc(id)}</h3>
    <p class="hint">${tt('texts.autoHint')}</p>
    ${I18N.langs.map(l => `<div class="field"><label for="tx-${l.code}">${esc(l.name)}
      <span class="tx-state" id="txs-${l.code}">${I18N.over[id] && I18N.over[id][l.code] != null ? '<span class="pill info">' + esc(t('texts.edited')) + '</span>' : ''}</span></label>
      <textarea id="tx-${l.code}" data-lang="${l.code}" rows="2">${esc(textValue(id, l.code))}</textarea></div>`).join('')}
    ${/\{\w+\}/.test(def.en || '') ? `<p class="hint">${tt('texts.placeholderHint')}</p>` : ''}
    <div class="modal-actions">
      ${I18N.over[id] && TEXTS[id] ? `<button class="btn ghost" data-a="reset">${tt('texts.reset')}</button>` : ''}
      <button class="btn ghost" data-a="no">${tt('common.cancel')}</button>
      <button class="btn primary" data-a="ok">${tt('common.save')}</button></div>`, 'no-edit');
  const typed = new Set(); let timer = null, run = 0;
  const setState = (code, html) => { const el = $('#txs-' + code, m.el); if (el) el.innerHTML = html; };
  m.el.addEventListener('input', ev => {
    const ta = ev.target.closest('textarea[data-lang]'); if (!ta) return;
    const from = ta.dataset.lang; typed.add(from); setState(from, '');
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++run; const text = ta.value;
      const targets = I18N.langs.map(l => l.code).filter(c => !typed.has(c));
      targets.forEach(c => setState(c, `<span class="pill info">${esc(t('texts.translating'))}</span>`));
      let failed = false;
      await Promise.all(targets.map(async c => {
        try {
          const out = await translateText(text, from, c);
          if (mine !== run || typed.has(c)) return;
          $('#tx-' + c, m.el).value = out; setState(c, `<span class="pill warn">${esc(t('texts.autoTranslated'))}</span>`);
        } catch (e) { failed = true; if (mine === run) setState(c, ''); }
      }));
      if (failed && mine === run) toast(t('texts.translateFailed'), 'warn');
    }, 900);
  });
  m.el.addEventListener('click', async ev => {
    const a = ev.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'no') { clearTimeout(timer); return m.close(); }
    clearTimeout(timer); run++;
    if (a.dataset.a === 'reset') delete I18N.over[id];
    else I18N.langs.forEach(l => setText(id, l.code, $('#tx-' + l.code, m.el).value));
    await saveTexts(); m.close(); toast(t('common.saved'));
    if (after) after(); else { const y = window.scrollY; await route(); window.scrollTo(0, y); }
    setEditPill();
  });
}
document.addEventListener('click', ev => {
  if (!I18N.edit || ev.target.closest('.no-edit')) return;
  const el = ev.target.closest('[data-t]'); if (!el) return;
  ev.preventDefault(); ev.stopPropagation(); editText(el.dataset.t);
}, true);

/* ---------------- Saving files ---------------- */
let dlCap;
async function downloadsCap() {
  if (!IS_ARTIFACT) return null;
  if (dlCap === undefined) { try { dlCap = await window.claude.use('downloads'); } catch (e) { dlCap = null; } }
  return dlCap;
}
async function saveBlob(blob, filename) {
  const dl = await downloadsCap();
  if (dl) {
    try { await dl.save({ filename, data: blob }); return true; }
    catch (err) { if (!err || err.code !== 'declined') toast(t('err.download'), 'warn'); return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  return true;
}
function canShareFile(file) { try { return !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; } }

/* ---------------- Package: phone -> laptop ---------------- */
const extOf = b => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }[b && b.type] || 'jpg');
const mimeOf = p => ({ png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' }[String(p).split('.').pop().toLowerCase()] || 'image/jpeg');
function kml(e) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(e.title)}</name>
${e.locations.map((l, i) => l.gps ? `<Placemark><name>${i + 1}. ${esc(l.title)}</name><description>${esc([l.description, l.samples.map(s => s.title).join(', ')].filter(Boolean).join('\n'))}</description><Point><coordinates>${l.gps.lon},${l.gps.lat}${l.gps.alt != null ? ',' + l.gps.alt : ''}</coordinates></Point></Placemark>` : '').join('\n')}
</Document></kml>`;
}
async function sendPackage(ids) {
  if (!window.JSZip) return toast(t('err.libMissing'), 'warn');
  await flushSave();
  const excs = (await Promise.all(ids.map(id => Store.getExc(id)))).filter(Boolean);
  if (!excs.length) return toast(t('sync.nothing'));
  for (const e of excs) {
    const before = JSON.stringify([e.title, e.locations.map(l => l.title)]);
    await autoTitleExcursion(e); e.locations.forEach(l => autoTitleLocation(e, l));
    if (JSON.stringify([e.title, e.locations.map(l => l.title)]) !== before) await Store.putExc(e);
  }
  const busy = modal(`<p class="modal-msg">${tt('export.building')}</p><div class="bar"><span id="exp-bar"></span></div>`, 'no-edit');
  busy.el.dataset.locked = '1';
  try {
    const zip = new JSZip();
    const stamp = now().slice(0, 16).replace('T', '_').replace(':', '');
    const total = excs.reduce((n, e) => n + e.locations.reduce((m, l) => m + l.photos.length + l.samples.reduce((k, s) => k + PHOTO_KEYS.filter(p => s[p]).length, 0), 0), 0);
    let done = 0; const manifest = [];
    for (const e of excs) {
      const folder = folderName(e); const dir = zip.folder(folder); const pf = dir.folder('photos');
      const paths = new Map();
      for (const [li, l] of e.locations.entries()) {
        const jobs = [...l.photos.map((p, j) => [p, photoName(li, null, null, j)]), ...l.samples.flatMap((s, si) => PHOTO_KEYS.filter(k => s[k]).map(k => [s[k], photoName(li, si, k)]))];
        for (const [ref, name] of jobs) {
          const b = await Store.getPhoto(ref); if (!b) continue;
          const fn = `${name}.${extOf(b)}`; pf.file(fn, b, { compression: 'STORE' }); paths.set(ref, 'photos/' + fn);
          done++; const bar = $('#exp-bar'); if (bar) bar.style.width = (100 * done / Math.max(1, total)) + '%';
        }
      }
      dir.file('excursion.json', JSON.stringify(toJson(e, r => paths.get(r) || null), null, 2));
      dir.file('excursion.kml', kml(e));
      manifest.push({ id: e.id, title: e.title, folder, updated: e.updated });
    }
    zip.file('package.json', JSON.stringify({ format: FORMAT, kind: 'package', version: 1, app: APP_VERSION, created: now(), excursions: manifest }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const file = new File([blob], `msl-package_${stamp}.zip`, { type: 'application/zip' });
    busy.close();
    const share = canShareFile(file);
    const m = modal(`<h3>${tt('sync.ready')}</h3>
      <p class="meta-line">${esc(file.name)} · ${(blob.size / 1048576).toFixed(1)} MB · ${esc(t('count.excursions', { n: excs.length }))}</p>
      <p class="hint">${tt('sync.readyHint')}</p>
      <div class="modal-actions col">
        ${share ? `<button class="btn primary" data-a="share">${icon('share')}${tt('export.share')}</button>` : ''}
        <button class="btn ${share ? 'ghost' : 'primary'}" data-a="save">${icon('download')}${tt('export.save')}</button>
        <button class="btn ghost" data-a="no">${tt('common.close')}</button></div>`);
    m.el.addEventListener('click', async ev => {
      const a = ev.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 'no') return m.close();
      let ok = false;
      if (a.dataset.a === 'save') ok = await saveBlob(blob, file.name);
      if (a.dataset.a === 'share') { try { await navigator.share({ files: [file], title: file.name }); ok = true; } catch (err) { ok = false; } }
      if (!ok) return;
      // Clear the dirty flag only if nothing changed while the package was built.
      for (const x of excs) {
        const cur = await Store.getExc(x.id);
        if (cur && cur.updated === x.updated) { cur.dirty = false; cur.sentAt = now(); await Store.putExc(cur); }
      }
      m.close(); toast(t('sync.done')); route();
    });
  } catch (err) { busy.close(); console.error(err); toast(t('err.export'), 'warn'); }
}

// Read a package (or a single excursion export, or a zipped library folder) -> [{base, data}]
async function readPackage(file) {
  const zip = await JSZip.loadAsync(file);
  const items = [];
  for (const name of Object.keys(zip.files)) {
    if (!/(^|\/)excursion\.json$/.test(name)) continue;
    try {
      const data = JSON.parse(await zip.file(name).async('string'));
      if (data.format === FORMAT && data.excursion) items.push({ base: name.replace(/excursion\.json$/, ''), data });
    } catch (e) {}
  }
  return { zip, items };
}

async function importPackageLaptop() {
  if (!window.JSZip) return toast(t('err.libMissing'), 'warn');
  if (!Lib.root) return route();
  const file = await pickFile('.zip,application/zip'); if (!file) return;
  let pkg;
  try { pkg = await readPackage(file); } catch (e) { return toast(t('import.failed'), 'warn'); }
  if (!pkg.items.length) return toast(t('import.failed'), 'warn');
  await Lib.scan();
  const busy = modal(`<p class="modal-msg">${tt('import.working')}</p><div class="bar"><span id="imp-bar"></span></div>`, 'no-edit');
  busy.el.dataset.locked = '1';
  let added = 0, replaced = 0, skipped = 0, i = 0;
  try {
    for (const { base, data } of pkg.items) {
      const x = data.excursion; const old = Lib.cache.get(x.id);
      if (old) {
        const ed = old.exc.library && old.exc.library.laptopEdited, im = old.exc.library && old.exc.library.importedAt;
        if (ed && (!im || ed > im)) {
          busy.el.hidden = true;
          const go = await confirmDlg(t('import.overwriteCorrections', { title: x.title }), t('import.replace'), true, t('import.keepMine'));
          busy.el.hidden = false;
          if (!go) { skipped++; continue; }
        }
        await Lib.root.removeEntry(old.folder, { recursive: true });
      }
      const folder = old ? old.folder : folderName(x);
      const dir = await Lib.root.getDirectoryHandle(folder, { create: true });
      const pdir = await dir.getDirectoryHandle('photos', { create: true });
      for (const name of Object.keys(pkg.zip.files)) {
        if (!name.startsWith(base + 'photos/') || pkg.zip.files[name].dir) continue;
        await writeFile(pdir, name.slice((base + 'photos/').length), await pkg.zip.file(name).async('blob'));
      }
      const kmlFile = pkg.zip.file(base + 'excursion.kml');
      if (kmlFile) await writeFile(dir, 'excursion.kml', await kmlFile.async('blob'));
      data.library = { importedAt: now(), source: file.name };
      await writeFile(dir, 'excursion.json', JSON.stringify(data, null, 2));
      old ? replaced++ : added++;
      const bar = $('#imp-bar'); if (bar) bar.style.width = (100 * ++i / pkg.items.length) + '%';
    }
  } catch (err) { console.error(err); toast(t('import.failed'), 'warn'); }
  busy.close(); Lib.cache.clear(); state.urls.forEach(u => URL.revokeObjectURL(u)); state.urls.clear();
  toast(t('import.summary', { added, replaced, skipped }));
  route();
}

async function importPackagePhone() {
  if (!window.JSZip) return toast(t('err.libMissing'), 'warn');
  const file = await pickFile('.zip,application/zip'); if (!file) return;
  try {
    const { zip, items } = await readPackage(file);
    if (!items.length) throw new Error('empty');
    let n = 0;
    for (const { base, data } of items) {
      const x = data.excursion; let asCopy = false;
      const existing = await Store.getExc(x.id);
      if (existing) {
        const replace = await confirmDlg(t('import.exists', { title: x.title }), t('import.replace'), true, t('import.copy'));
        if (replace) for (const l of existing.locations) await deleteLocationPhotos(l); else asCopy = true;
      }
      const refs = new Map();
      for (const name of Object.keys(zip.files)) {
        if (!name.startsWith(base + 'photos/') || zip.files[name].dir) continue;
        const b = await zip.file(name).async('blob'); const id = uid();
        await Store.putPhoto(id, new Blob([b], { type: mimeOf(name) })); refs.set(name.slice(base.length), id);
      }
      const e = fromJson(x, p => (p ? refs.get(p) || null : null));
      if (asCopy) {
        e.id = uid(); e.title = `${x.title} (${t('import.copySuffix')})`;
        e.locations.forEach(l => { l.id = uid(); l.samples.forEach(s => { s.id = uid(); }); });
      }
      e.dirty = false; e.sentAt = now(); await Store.putExc(e); n++;
    }
    toast(t('import.summary', { added: n, replaced: 0, skipped: 0 })); route();
  } catch (err) { console.error(err); toast(t('import.failed'), 'warn'); }
}

/* ---------------- Texts spreadsheet ---------------- */
function exportTextsXlsx() {
  if (!window.XLSX) return toast(t('err.libMissing'), 'warn');
  const langs = I18N.langs.map(l => l.code);
  const rows = [['id', ...langs], ...allTextIds().map(id => [id, ...langs.map(l => textValue(id, l))])];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 30 }, ...langs.map(() => ({ wch: 45 }))];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'texts');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  saveBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `msl-texts_${now().slice(0, 10)}.xlsx`);
}
async function importTextsXlsx() {
  if (!window.XLSX) return toast(t('err.libMissing'), 'warn');
  const file = await pickFile('.xlsx,.xls,.ods,.csv'); if (!file) return;
  try {
    const wb = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const head = rows[0].map(h => String(h).trim().toLowerCase());
    const idCol = head.indexOf('id'); if (idCol < 0) throw new Error('no id column');
    const cols = head.map((h, i) => ({ h, i })).filter(c => c.i !== idCol && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(c.h));
    let added = 0, changedN = 0;
    for (const c of cols) if (!I18N.langs.some(l => l.code === c.h)) { I18N.langs.push({ code: c.h, name: c.h.toUpperCase(), speech: c.h }); added++; }
    for (const r of rows.slice(1)) {
      const id = String(r[idCol] || '').trim(); if (!id) continue;
      for (const c of cols) { const v = String(r[c.i] ?? ''); if (v !== textValue(id, c.h)) { setText(id, c.h, v); changedN++; } }
    }
    await saveTexts();
    toast(t('texts.imported', { n: changedN }) + (added ? ' · ' + t('texts.langsAdded', { n: added }) : ''));
    setEditPill(); route();
  } catch (err) { console.error(err); toast(t('texts.importFailed'), 'warn'); }
}
function exportTextsJson() {
  const out = {};
  allTextIds().forEach(id => { out[id] = {}; I18N.langs.forEach(l => { out[id][l.code] = textValue(id, l.code); }); });
  saveBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), 'texts.json');
}

/* ---------------- Router ---------------- */
async function route() {
  stopDictation();
  if (state.map) { state.map.remove(); state.map = null; }
  $$('.modal-wrap').forEach(m => m.remove());
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const p = path.split('/').filter(Boolean);
  const isNew = /(^|&)new=1/.test(query || '');
  if (isNew) history.replaceState(null, '', '#/' + path);
  document.title = t('app.name');
  if (p[0] === 'e' && !document.hidden) Warm.start(); else Warm.stop();
  try {
    if (p[0] === 'settings') return await viewSettings();
    if (p[0] === 'texts') return await viewTexts();
    if (p[0] === 'refresh') { Lib.cache.clear(); state.urls.clear(); history.replaceState(null, '', '#/'); return await viewHome(); }
    if (isLaptop() && !await ensureLibrary()) return viewLibrarySetup();
    if (!p.length) return await viewHome();
    if (p[0] === 'e' && p[1]) {
      if (p.length === 2) return await viewExcursion(p[1]);
      if (p[2] === 'map') return await viewMap(p[1]);
      if (p[2] === 'l' && p[3]) {
        if (p.length === 4) return await viewLocation(p[1], p[3]);
        if (p[4] === 'map') return await viewMap(p[1], p[3]);
        if (p[4] === 's' && p[5]) return await viewSample(p[1], p[3], p[5]);
      }
    }
    return notFound();
  } catch (err) { console.error(err); toast(t('err.generic'), 'warn'); }
}

/* ---------------- Updates ---------------- */
// A new version downloads in the background; then a bar offers to switch to it right away.
function setupUpdates() {
  if (!('serviceWorker' in navigator) || IS_ARTIFACT || !/^(https:|http:\/\/localhost)/.test(location.href)) return;
  let userAsked = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (userAsked) location.reload(); });
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = w => {
      if (!w || !navigator.serviceWorker.controller) return; // first install: nothing to replace
      const bar = $('#updatebar');
      bar.innerHTML = `<span>${esc(t('update.available'))}</span><button class="btn small" id="upd-go">${esc(t('update.now'))}</button>`;
      bar.hidden = false;
      $('#upd-go').addEventListener('click', async () => { userAsked = true; await flushSave(); w.postMessage({ type: 'SKIP_WAITING' }); });
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed') offer(nw); });
    });
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(() => {});
}

/* ---------------- Boot ---------------- */
function applyMode() {
  const auto = HAS_FS && !matchMedia('(pointer: coarse)').matches ? 'laptop' : 'phone';
  state.mode = state.settings.mode === 'laptop' && !HAS_FS ? 'phone' : (state.settings.mode || auto);
  document.body.dataset.mode = state.mode; state.exc = null;
}
async function boot() {
  try {
    const s = await Store.kvGet('settings'); if (s) Object.assign(state.settings, s);
    const o = await Store.kvGet('texts'); if (o) I18N.over = o;
    const x = await Store.kvGet('extraLangs'); if (x) I18N.langs.push(...x.filter(l => !I18N.langs.some(b => b.code === l.code)));
  } catch (e) {}
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  I18N.lang = state.settings.lang || (I18N.langs.some(l => l.code === nav) ? nav : 'en');
  document.documentElement.lang = I18N.lang;
  applyMode(); setEditPill();
  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { flushSave(); Warm.stop(); }
    else if (/^#\/e\//.test(location.hash)) Warm.start();
  });
  window.addEventListener('beforeinstallprompt', ev => { ev.preventDefault(); state.installEvt = ev; if (/^#\/settings/.test(location.hash)) route(); });
  window.addEventListener('appinstalled', () => { state.installEvt = null; toast(t('set.installDone')); if (/^#\/settings/.test(location.hash)) route(); });
  setupUpdates();
  route();
}
boot();
