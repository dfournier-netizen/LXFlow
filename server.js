#!/usr/bin/env node
/* ============================================================================
 * LXFlow — locally-hosted real-time cue tracking server
 * Single-process: HTTP (static + uploads) + WebSocket (realtime) + JSON store.
 * Pure JS (no native modules) so it bundles into a standalone executable.
 * State auto-persists to a JSON file on every mutation; no manual load/save.
 * ========================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import mammoth from 'mammoth';
import XLSX from 'xlsx';
import formidable from 'formidable';
import { getDocumentProxy } from 'unpdf';
import { OPS } from 'unpdf/pdfjs';
import { PNG } from 'pngjs';
import { DOMParser } from '@xmldom/xmldom';

// Resolve our own directory in both ESM (dev) and CJS bundle (packaged) form.
let APP_DIR;
try { APP_DIR = path.dirname(fileURLToPath(import.meta.url)); }
catch { APP_DIR = __dirname; }   // CJS bundle / pkg snapshot
// When packaged with pkg, the app lives in a read-only snapshot; the real,
// writable location is next to the executable.
const PACKAGED = !!process.pkg;
const BASE_DIR = PACKAGED ? path.dirname(process.execPath) : APP_DIR;

/* ---- config ------------------------------------------------------------- */
const DEFAULT_PORT = 7390;                       // not :8000 / :8443
function resolvePort() {
  const fromFlag = process.argv.find(a => a.startsWith('--port='));
  if (fromFlag) return parseInt(fromFlag.split('=')[1], 10);
  if (process.argv[2] && /^\d+$/.test(process.argv[2])) return parseInt(process.argv[2], 10);
  if (process.env.ROS_PORT) return parseInt(process.env.ROS_PORT, 10);
  return DEFAULT_PORT;
}
const PORT = resolvePort();
const DATA_PATH = process.env.ROS_DATA || process.env.ROS_DB
  || path.join(BASE_DIR, 'runofshow-data.json');
const AUTO_OPEN = !process.argv.includes('--no-open') && process.env.ROS_NO_OPEN !== '1';

// Optional shared room code. Empty string = open (no gate).
function resolveCode() {
  const flag = process.argv.find(a => a.startsWith('--code='));
  if (flag) return flag.split('=').slice(1).join('=');
  if (process.env.ROS_CODE) return process.env.ROS_CODE;
  return '';
}
const ROOM_CODE = resolveCode();

// Image store (served over HTTP, NOT embedded in realtime sync) + small config file.
const IMG_DIR = process.env.ROS_IMAGES || path.join(BASE_DIR, 'runofshow-images');
const CONFIG_PATH = path.join(BASE_DIR, 'runofshow-config.json');
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { return {}; } }
function saveConfig(c) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c)); } catch (e) { console.error('  ! config save failed:', e.message); } }
let CONFIG = loadConfig();
// Which network adapter/IP to bind to. '' or undefined => all interfaces.
function resolveHost() {
  const flag = process.argv.find(a => a.startsWith('--host='));
  if (flag) return flag.split('=')[1];
  if (process.env.ROS_HOST) return process.env.ROS_HOST;
  if (CONFIG.bindHost) return CONFIG.bindHost;
  return undefined;
}
let BIND_HOST = resolveHost();

/* ---- persistence (atomic JSON file) ------------------------------------- */
/* DATA.events: [ { ev, updated } ].  ev never carries the 'updated' field.  */
const HISTORY_LIMIT = 50;
const HISTORY_BYTES = 16 * 1024 * 1024;
let DATA = { events: [], history: { undo: [], redo: [] } };
function validData(raw) {
  const validId = value => typeof value === 'string' && value.length > 0;
  const unique = rows => rows.every(row => row && validId(row.id)) && new Set(rows.map(row => row.id)).size === rows.length;
  return raw && Array.isArray(raw.events) && unique(raw.events.map(x => x?.ev)) && raw.events.every(({ev}) =>
    Array.isArray(ev.columns) && ev.columns.every(col => col && typeof col.key === 'string') &&
    Array.isArray(ev.days) && unique(ev.days) && ev.days.every(day =>
      Array.isArray(day.shows) && unique(day.shows) && day.shows.every(show => Array.isArray(show.cues) && unique(show.cues))));
}
function trimHistory() {
  for (const key of ['undo', 'redo']) DATA.history[key] = DATA.history[key].slice(-HISTORY_LIMIT);
  while (Buffer.byteLength(JSON.stringify(DATA.history)) > HISTORY_BYTES && (DATA.history.undo.length || DATA.history.redo.length)) {
    const key = DATA.history.undo.length >= DATA.history.redo.length ? 'undo' : 'redo';
    DATA.history[key].shift();
  }
}
function loadData() {
  if (!fs.existsSync(DATA_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!validData(raw)) throw new Error('Invalid show data');
    DATA = raw;
  } catch (error) {
    // Never silently replace unreadable show data with a blank event.
    const recovery = DATA_PATH + '.bak';
    let raw;
    try { raw = JSON.parse(fs.readFileSync(recovery, 'utf8')); if (!validData(raw)) throw new Error('Invalid backup'); }
    catch { throw new Error(`Cannot read ${DATA_PATH}; original preserved. Restore a valid backup before restarting. ${error.message}`); }
    fs.copyFileSync(DATA_PATH, DATA_PATH + '.corrupt-' + Date.now());
    DATA = raw;
    console.error('  ! Recovered show data from backup:', recovery);
  }
  const history = DATA.history || {};
  DATA.history = Object.fromEntries(['undo', 'redo'].map(key => [key, Array.isArray(history[key]) ? history[key].filter(x => validData({events:x.events})) : []]));
  trimHistory();
}
let saveTimer = null;
function flushData() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    const tmp = DATA_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DATA));
    // Back up only a valid previous version; keep recovery evidence intact.
    if (fs.existsSync(DATA_PATH)) {
      try { if (validData(JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')))) fs.copyFileSync(DATA_PATH, DATA_PATH + '.bak'); } catch {}
    }
    fs.renameSync(tmp, DATA_PATH);
  } catch (e) { console.error('  ! save failed:', e.message); }
}
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(flushData, 40); }
process.on('exit', () => { if (saveTimer) flushData(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { flushData(); process.exit(0); });

/* ---- domain model -------------------------------------------------------
 * Event → Days → Shows → Cues.  A cue row is column-flexible: { id, ...cols }.
 * ------------------------------------------------------------------------ */
const uid = (p = '') => p + crypto.randomBytes(6).toString('hex');

function blankEvent(name = 'New Event') {
  return {
    id: uid('evt_'),
    name,
    columns: [
      { key: 'cue',     label: 'Cue #',   width: 80  },
      { key: 'time',    label: 'Time',    width: 90  },
      { key: 'who',     label: 'Who',     width: 90  },
      { key: 'action',  label: 'Action',  width: 320 },
      { key: 'dept',    label: 'Dept',    width: 120 },
      { key: 'notes',   label: 'Notes',   width: 260 },
    ],
    notes: [],
    days: [{
      id: uid('day_'), label: 'Day 1', date: '',
      shows: [{ id: uid('show_'), label: 'Show 1', cues: [] }],
    }],
  };
}

function loadEvents() {
  return [...DATA.events].sort((a, b) => (b.updated || 0) - (a.updated || 0)).map(x => x.ev);
}
function saveEvent(ev) {
  if (!validData({events:[{ev}]})) throw new Error('Invalid event');
  const w = DATA.events.find(x => x.ev.id === ev.id);
  if (w) { w.ev = ev; w.updated = Date.now(); }
  else DATA.events.push({ ev, updated: Date.now() });
  persist();
}
function deleteEvent(id) {
  DATA.events = DATA.events.filter(x => x.ev.id !== id);
  persist();
}

loadData();
if (loadEvents().length === 0) saveEvent(blankEvent('Untitled Event'));

/* ---- live (non-persistent) presence + locks ----------------------------- */
const clients = new Map();
const locks = new Map();

function presenceList() {
  return [...clients.values()].map(c => ({
    id: c.id, name: c.name, position: c.position, color: c.color,
    pointer: c.pointer, follow: c.follow,
  }));
}
const lockKey = l => `${l.showId}|${l.cueId}|${l.colKey}`;
function lockList() { return [...locks.values()].map(({ ws, ...r }) => r); }

/* ---- broadcast helpers -------------------------------------------------- */
function broadcast(obj, exceptWs = null) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws !== exceptWs) ws.send(msg);
  }
}
function sendState(ws) {
  ws.send(JSON.stringify(stateMessage()));
  ws.send(JSON.stringify({ t: 'presence', users: presenceList() }));
  ws.send(JSON.stringify({ t: 'locks', locks: lockList() }));
}

/* ---- image store -------------------------------------------------------- */
function ensureImgDir() { try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch {} }
function saveImageBuf(buf, ext) {
  ensureImgDir();
  ext = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const id = uid('img_') + '.' + ext;
  fs.writeFileSync(path.join(IMG_DIR, id), buf);
  return id;
}
function imageFile(id) { if (!/^[A-Za-z0-9_.\-]+$/.test(id)) return null; const p = path.join(IMG_DIR, id); return p.startsWith(IMG_DIR) ? p : null; }
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
// Images are retained across deletes/wipes so undo and backups can restore them.
function adapterList() {
  const ifs = os.networkInterfaces(); const out = [];
  for (const name in ifs) for (const a of ifs[name]) if (a.family === 'IPv4') out.push({ name, address: a.address, netmask: a.netmask, internal: !!a.internal, cidr: a.cidr || '' });
  return out;
}
// "Host" = a request from the machine running the server (loopback). Network
// adapter controls are restricted to the host so coworkers can't change which
// interface YOUR computer is exposed on.
function isLoopbackAddr(a) { a = String(a || ''); return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.'); }

/* ---- PDF helpers: filename stripping + image decode --------------------- */
const _FILE_EXT = '(?:jpe?g|png|gif|bmp|tiff?|webp|heic|svg|mp4|mov|m4v|avi|wmv|mpe?g|mkv|webm|pptx?|keynote|key|pdf|docx?|xlsx?|csv|wav|mp3|aiff?)';
const _FILE_TOKEN = new RegExp('\\S+\\.' + _FILE_EXT + '\\b', 'gi');
function stripFileNames(str) {
  return String(str).replace(_FILE_TOKEN, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}
const _SCREEN_LABEL = /^(left|right|center|centre|main|side|house|lower\s*third|down\s*stage|stage)\s+screen$/i;
const _TIME_ANCHOR = /^((?:\d{1,2}(?::[0-5]\d){0,2}\s*(?:a\.?m\.?|p\.?m\.?))|(?:(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?))(?=\s|[-\u2013\u2014:]|$)\s*[-\u2013\u2014:]?\s*(.*)$/i;
function imgToRGBA(img) {
  if (!img || !img.data) return null;
  const { width, height, kind, data } = img;
  if (!width || !height) return null;
  const out = Buffer.alloc(width * height * 4);
  if (kind === 3) { for (let i = 0; i < width * height * 4; i++) out[i] = data[i]; return { width, height, rgba: out }; }
  if (kind === 2) { for (let i = 0, j = 0; i < width * height; i++) { out[j++] = data[i*3]; out[j++] = data[i*3+1]; out[j++] = data[i*3+2]; out[j++] = 255; } return { width, height, rgba: out }; }
  if (kind === 1) { const rb = (width + 7) >> 3; for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const b = data[y*rb+(x>>3)] || 0; const v = ((b >> (7-(x&7))) & 1) ? 255 : 0; const o = (y*width+x)*4; out[o]=out[o+1]=out[o+2]=v; out[o+3]=255; } return { width, height, rgba: out }; }
  return null;
}
// Resolve a pdfjs image object, waiting for async decode (needed in the bundled build).
function getPdfObj(page, name) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 4000);
    try { page.objs.get(name, v => { clearTimeout(t); resolve(v); }); }
    catch { clearTimeout(t); resolve(null); }
  });
}
function rgbaToPngBuf(width, height, rgba) { const png = new PNG({ width, height }); for (let i = 0; i < rgba.length; i++) png.data[i] = rgba[i]; return PNG.sync.write(png); }

/* ---- document parsing --------------------------------------------------- */
async function parseUpload(filepath, filename, options = {}) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.docx') return { tables: await parseDocx(filepath) };
  if (ext === '.pdf') return { tables: await parsePdf(filepath) };
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv' || ext === '.tsv')
    return { tables: parseSheet(filepath, options) };
  if (!['.txt', '.text', '.md'].includes(ext)) throw new Error('Unsupported file type. Choose DOCX, PDF, XLSX, XLS, CSV, TSV, TXT, or MD.');
  const text = fs.readFileSync(filepath, 'utf8').replace(/^\uFEFF/, '');
  if (text.includes('\0')) throw new Error('This file is not a supported text document.');
  return { tables: textToTables(text) };
}
async function parseDocx(fp) {
  const { value: html, messages } = await mammoth.convertToHtml({ path: fp });
  const tables = extractHtmlDocument(html);
  if (tables.length) {
    const warnings = messages.map(m => m.message);
    return tables.map(t => ({...t, warnings: [...(t.warnings || []), ...warnings]}));
  }
  const { value: text } = await mammoth.extractRawText({ path: fp });
  return textToTables(text);
}
// Parse a PDF. If it contains images (a storyboard), build cue rows and attach
// each embedded screen image to the nearest cue by page position; otherwise run
// the extracted text through the same memo/line parser as Word/plain text.
// Filenames captions and bare LEFT/CENTER/RIGHT SCREEN labels are stripped.
async function parsePdf(fp) {
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(fp)));
  try {
  const pages = []; let totalImages = 0;
  const warnings = ['PDF reading order and image-to-cue matches are approximate. Review the preview against the source; filenames and screen labels are preserved.'];
  let failedImages = 0;
  const mul = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    const raw = []; let curY = null, line = '';
    const flush = () => { const t = line.replace(/\s+/g, ' ').trim(); if (t) raw.push({ y: curY, text: t }); line = ''; };
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const y = Math.round(it.transform[5]);
      if (curY !== null && Math.abs(y - curY) > 3) flush();
      curY = y;
      line += (line && !line.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
      if (it.hasEOL) { flush(); curY = null; }
    }
    flush();
    const lines = [];
    for (const L of raw) if (L.text.trim()) lines.push({ y: L.y, text: L.text });
    // image placements via operator list + CTM tracking
    const ol = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = []; const placements = [];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], a = ol.argsArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, a);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) placements.push({ name: a && a[0], yTop: ctm[5] + ctm[3] });
    }
    const nameToId = {};
    for (const pl of placements) {
      if (!pl.name || (pl.name in nameToId)) continue;
      let id = null;
      try { const img = await getPdfObj(page, pl.name); const r = imgToRGBA(img); if (r && r.width >= 8 && r.height >= 8) id = saveImageBuf(rgbaToPngBuf(r.width, r.height, r.rgba), 'png'); } catch {}
      nameToId[pl.name] = id; if (id) totalImages++; else failedImages++;
    }
    pages.push({ p, lines, placements, nameToId });
  }
  if (totalImages === 0) {
    const all = pages.map(pg => pg.lines.map(l => l.text).join('\n')).join('\n');
    if (!all.trim()) throw new Error('This PDF has no extractable text or supported images. It may require OCR; export a text-based PDF or spreadsheet.');
    return textToTables(all).map(t => ({...t, warnings: [...warnings, ...(failedImages ? ['Some PDF images could not be decoded.'] : [])]}));
  }
  // storyboard: rows from cue lines, images attached to the nearest cue above
  const rows = [];
  for (const pg of pages) {
    let cur = null;
    for (const L of pg.lines) {
      const am = L.text.match(_TIME_ANCHOR);
      if (am) { cur = { page: pg.p, y: L.y, time: am[1].replace(/\s+/g, ' ').trim(), action: (am[2] || '').trim(), notes: [], imgIds: new Set() }; rows.push(cur); }
      else if (cur) cur.notes.push(L.text);
      else { cur = { page: pg.p, y: L.y, time: '', action: L.text, notes: [], imgIds: new Set() }; rows.push(cur); }
    }
    const pageRows = rows.filter(r => r.page === pg.p);
    if (!pageRows.length && pg.placements.some(pl => pg.nameToId[pl.name])) {
      const row = {page:pg.p, y:Infinity, time:'', action:`Page ${pg.p} image (no extractable text)`, notes:[], imgIds:new Set()};
      rows.push(row); pageRows.push(row);
      warnings.push(`Page ${pg.p} has images but no extractable text; no OCR was performed.`);
    }
    for (const pl of pg.placements) {
      const id = pg.nameToId[pl.name]; if (!id) continue;
      let best = null;
      for (const r of pageRows) if (r.y >= pl.yTop - 1) { if (!best || r.y < best.y) best = r; }
      if (!best) {
        best = {page:pg.p, y:pl.yTop, time:'', action:`Unassigned image on page ${pg.p}`, notes:[], imgIds:new Set()};
        rows.push(best); warnings.push(`An image on page ${pg.p} had no preceding cue; it was kept in an unassigned image row.`);
      }
      best.imgIds.add(id);
    }
  }
  const outRows = rows.map(r => { const o = { id: uid('cue_'), time: r.time, action: r.action, notes: r.notes.join('\n') }; if (r.imgIds.size) o._images = [...r.imgIds]; return o; });
  return [{ name: 'Storyboard', columns: [{ key: 'time', label: 'Time' }, { key: 'action', label: 'Action' }, { key: 'notes', label: 'Notes' }], rows: outRows, warnings: [...warnings, ...(failedImages ? ['Some PDF images could not be decoded.'] : [])] }];
  } finally { await pdf.destroy(); }
}

function htmlDocument(html) {
  return new DOMParser({errorHandler: {warning() {}, error() {}, fatalError(message) { throw new Error(message); }}}).parseFromString('<html><body>' + html + '</body></html>', 'text/html');
}
function nodeText(node) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1) return '';
  const tag = node.nodeName.toLowerCase();
  if (tag === 'br') return '\n';
  return Array.from(node.childNodes).map(nodeText).join('') + (['p','div','li'].includes(tag) ? '\n' : '');
}
function tableFromNode(table) {
  const grid = []; let merged = false;
  const trs = Array.from(table.getElementsByTagName('tr')).filter(tr => {
    let parent = tr.parentNode; while (parent && parent !== table) { if (parent.nodeName.toLowerCase() === 'table') return false; parent = parent.parentNode; } return true;
  });
  trs.forEach((tr, r) => {
    grid[r] ||= []; let c = 0;
    for (const cell of Array.from(tr.childNodes).filter(n => /^(td|th)$/i.test(n.nodeName))) {
      while (grid[r][c] !== undefined) c++;
      const span = attr => Math.max(1, Math.min(1000, parseInt(cell.getAttribute(attr), 10) || 1));
      const colspan = span('colspan'), rowspan = Math.min(span('rowspan'), trs.length-r);
      merged ||= colspan > 1 || rowspan > 1;
      for (let rr = r; rr < r + rowspan; rr++) {
        grid[rr] ||= [];
        for (let cc = c; cc < c + colspan; cc++) grid[rr][cc] = rr === r && cc === c ? nodeText(cell).trim() : '';
      }
      c += colspan;
      if (c > 10000 || grid.length * c > 1000000) throw new Error('Document table is too large. Split it into smaller cue tables.');
    }
  });
  const result = gridToTable(grid, true);
  if (merged) result.warnings.push('Merged table cells were expanded to a grid; content appears once in the top-left cell. Review alignment.');
  return result;
}
function extractHtmlTables(html) {
  return Array.from(htmlDocument(html).getElementsByTagName('table')).filter(table => {
    let parent = table.parentNode; while (parent) { if (parent.nodeName.toLowerCase() === 'table') return false; parent = parent.parentNode; } return true;
  }).map(tableFromNode);
}
function extractHtmlDocument(html) {
  const body = htmlDocument(html).getElementsByTagName('body')[0];
  const tables = []; let text = '', tableNumber = 0;
  const flush = () => { if (text.trim()) tables.push(...textToTables(text).map(t => ({...t, name: 'Document text ' + (tables.length + 1)}))); text = ''; };
  function visit(node) {
    if (node.nodeName.toLowerCase() === 'table') { flush(); tables.push({name: 'Table ' + (++tableNumber), ...tableFromNode(node)}); }
    else if (node.nodeType === 1 && node.getElementsByTagName('table').length) Array.from(node.childNodes).forEach(visit);
    else text += nodeText(node);
  }
  Array.from(body.childNodes).forEach(visit); flush(); return tables;
}
function uniqueColumnKey(label, index, used) {
  const base = slug(label) || 'col' + index;
  let key = base, n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  used.add(key); return key;
}
function gridToTable(grid, hasHeader) {
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const header = Array.from({length: width}, (_, i) => hasHeader ? String(grid[0]?.[i] ?? '') : 'Column ' + (i + 1));
  const used = new Set(['id', '_images', '_notify', '__proto__', 'constructor', 'prototype']);
  const columns = header.map((h, i) => ({key: uniqueColumnKey(h, i, used), label: h || 'Column ' + (i + 1)}));
  const rows = grid.slice(hasHeader ? 1 : 0).filter(r => r.some(value => String(value ?? '').trim() !== '')).map(r => {
    const row = {id: uid('cue_')}; columns.forEach((col, i) => row[col.key] = String(r[i] ?? '')); return row;
  });
  return {columns, rows, warnings: []};
}
function parseSheet(fp, options = {}) {
  const startRow = Number(options.startRow ?? 1);
  if (!Number.isSafeInteger(startRow) || startRow < 1) throw new Error('Starting row must be a positive whole number.');
  const hasHeader = options.hasHeader !== false;
  // raw:true at read time is critical for CSV/TSV: otherwise SheetJS converts
  // literal clock strings and leading-zero cue numbers before raw:false can help.
  const wb = XLSX.readFile(fp, {raw: true, cellNF: true, cellText: true});
  const tables = wb.SheetNames.map(sn => {
    const ws = wb.Sheets[sn];
    if (!ws['!ref'] || startRow > XLSX.utils.decode_range(ws['!ref']).e.r + 1) return {name: sn, columns: [], rows: [], warnings: []};
    const range = XLSX.utils.decode_range(ws['!ref']); range.s.r = startRow - 1; range.s.c = 0;
    if ((range.e.r - range.s.r + 1) * (range.e.c + 1) > 1000000) throw new Error(`Sheet "${sn}" exceeds one million cells. Export only the cue table or remove unused formatted rows and columns.`);
    const aoa = XLSX.utils.sheet_to_json(ws, {header: 1, blankrows: true, defval: '', raw: false, range});
    // sheet_to_json suppresses error cells: preserve their visible Excel error.
    for (let r = range.s.r; r <= range.e.r; r++) for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({r,c})];
      if (cell?.t === 'e') { aoa[r-range.s.r] ||= []; aoa[r-range.s.r][c] = cell.w || XLSX.utils.format_cell(cell); }
    }
    const result = gridToTable(aoa, hasHeader);
    result.sourceRows = aoa.map((row, i) => ({row, source: startRow + i})).slice(hasHeader ? 1 : 0).filter(({row}) => row.some(value => String(value ?? '').trim() !== '')).map(({source}) => source);
    result.columns.forEach((col, c) => {
      if (!/(^|[ _-])(time|start|end|trt|duration)($|[ _-])/i.test(col.label)) return;
      if (result.rows.some(row => /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(row[col.key].trim()))) result.warnings.push(`"${col.label}" contains numeric values. If these are Excel day fractions, explicitly choose time of day or duration; they were preserved to avoid guessing units.`);
    });
    if (aoa.some(row => row.some(value => /^#(?:DIV\/0!|N\/A|VALUE!|REF!|NAME\?|NUM!|NULL!)/.test(String(value))))) result.warnings.push('Spreadsheet error values were preserved. Resolve them in the source or review these cells before import.');
    return {name: sn, ...result};
  }).filter(t => t.columns.length);
  return tables.length ? tables : [{name: 'Sheet1', columns: [], rows: [], warnings: []}];
}
// Structured "memo" run-of-show parser.  Handles documents laid out as:
//     Tuesday, June 23
//     <segment title = the action>
//     Who:  <names>
//     Report Time: / Time:  <time>
//     Where: <location>
//     <free-text description / Sequence: lines>
// Produces one table PER DAY (named by the day header) so each day can be
// merged into its own show.  Returns null if the document isn't this format.
const _DAY_RE = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const _FIELD_RE = /^(who|report time|time|where|what to do)\s*[:.]\s*(.*)$/i;
const _ANCHOR_RE = /^(who|time|report time)\s*[:.]/i;
function parseMemoRunOfShow(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  let i = lines.findIndex(l => _DAY_RE.test(l));
  if (i < 0 || !lines.slice(i + 1).some(l => _ANCHOR_RE.test(l))) return null;                         // no day headers -> not this format
  const cols = [
    { key: 'time',   label: 'Time'   },
    { key: 'who',    label: 'Who'    },
    { key: 'action', label: 'Action' },
    { key: 'where',  label: 'Where'  },
    { key: 'notes',  label: 'Notes'  },
  ];
  const days = [];
  if (i > 0) days.push({...linesToRows(lines.slice(0, i).join('\n')), name: 'Document introduction'});
  let cur = null;
  while (i < lines.length) {
    const line = lines[i];
    if (_DAY_RE.test(line)) { cur = { name: line, columns: cols.map(c => ({ ...c })), rows: [] }; days.push(cur); i++; continue; }
    if (!cur) { i++; continue; }
    const seg = { id: uid('cue_'), who: '', time: '', action: line, where: '', notes: [] };
    i++;
    while (i < lines.length && !_DAY_RE.test(lines[i])) {
      const l = lines[i];
      const fm = l.match(_FIELD_RE);
      if (!fm) {
        if (_ANCHOR_RE.test(lines[i + 1] || '')) break;   // next line begins a new segment
        seg.notes.push(l); i++; continue;
      }
      const label = fm[1].toLowerCase(), val = fm[2].trim();
      if (label === 'who') seg.who = val;
      else if (label === 'time' || label === 'report time') seg.time = val;
      else if (label === 'where') seg.where = val;
      else if (label === 'what to do') seg.notes.push(val);
      i++;
    }
    cur.rows.push({ id: seg.id, time: seg.time, who: seg.who, action: seg.action, where: seg.where, notes: seg.notes.join('\n') });
  }
  const tables = days.filter(d => d.rows.length);
  return tables.length ? tables : null;
}
// Turn arbitrary text into tables: structured memo first, else line-by-line.
function textToTables(text) {
  const memo = parseMemoRunOfShow(text);
  return memo || [linesToRows(text)];
}
// Split a plain run-of-show line into { who, action }.
// Handles "WHO - WHAT" / "WHO: WHAT" / "WHO | WHAT" and trailing "WHAT (WHO)".
function splitWhoWhat(line) {
  let m = line.match(/^\s*(.{1,20}?)\s*[-\u2013\u2014:|\t]\s+(.+)$/);
  if (m) {
    const who = m[1].trim(), what = m[2].trim();
    if (who && who.split(/\s+/).length <= 4 && who.length <= 20) return { who, action: what };
  }
  const p = line.match(/^(.*?)[\(\[]\s*([^)\]]{1,20})\s*[\)\]]\s*$/);
  if (p && p[2].trim() && p[2].trim().split(/\s+/).length <= 4) return { who: p[2].trim(), action: p[1].trim() };
  return { who: '', action: line };
}
function linesToRows(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = lines.map(l => { const { who, action } = splitWhoWhat(l); return { id: uid('cue_'), who, action }; });
  const anyWho = rows.some(r => r.who);
  if (!anyWho) { rows.forEach(r => delete r.who); return { name: 'Text', columns: [{ key: 'action', label: 'Action' }], rows }; }
  return { name: 'Text', columns: [{ key: 'who', label: 'Who' }, { key: 'action', label: 'Action' }], rows };
}
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/* ---- client HTML --------------------------------------------------------
 * In a packaged build the HTML is embedded via globalThis.__INDEX_HTML__
 * (injected at bundle time).  In dev we read it from disk.
 * ------------------------------------------------------------------------ */
let _html = null;
function indexHtml() {
  if (_html != null) return _html;
  if (typeof globalThis.__INDEX_HTML__ === 'string') return (_html = globalThis.__INDEX_HTML__);
  try { _html = fs.readFileSync(path.join(APP_DIR, 'public', 'index.html'), 'utf8'); }
  catch { _html = '<h1>index.html not found</h1>'; }
  return _html;
}

/* ---- HTTP server -------------------------------------------------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const httpHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/upload') {
    const temporaryFiles = new Set();
    try {
      const form = formidable({ maxFileSize: 50 * 1024 * 1024, maxFiles: 1 });
      form.on('fileBegin', (_name, file) => temporaryFiles.add(file.filepath));
      const [fields, files] = await form.parse(req);
      const f = files.file?.[0];
      if (!f) { res.writeHead(400); return res.end('no file'); }
      const requestedStartRow = Array.isArray(fields.startRow) ? fields.startRow[0] : fields.startRow;
      const requestedHasHeader = Array.isArray(fields.hasHeader) ? fields.hasHeader[0] : fields.hasHeader;
      const parsed = await parseUpload(f.filepath, f.originalFilename || 'upload', { startRow: requestedStartRow, hasHeader: requestedHasHeader !== 'false' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, filename: f.originalFilename, ...parsed }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    } finally {
      for (const file of temporaryFiles) { try { fs.unlinkSync(file); } catch {} }
    }
  }

  // serve a stored image (full resolution, cached)
  if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
    const id = decodeURIComponent(url.pathname.slice(5));
    const fp = imageFile(id);
    if (!fp || !fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': IMG_MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(fs.readFileSync(fp));
  }

  // manually attach an image to a cue: stores the original bytes unmodified, returns its id
  if (req.method === 'POST' && url.pathname === '/attach') {
    try {
      const form = formidable({ maxFileSize: 50 * 1024 * 1024 });
      const [, files] = await form.parse(req);
      const f = files.file?.[0];
      if (!f) { res.writeHead(400); return res.end('no file'); }
      const ext = path.extname(f.originalFilename || '').replace('.', '').toLowerCase() || 'png';
      const buf = fs.readFileSync(f.filepath); fs.unlink(f.filepath, () => {});
      const id = saveImageBuf(buf, ext);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  // list network adapters (HOST ONLY -- loopback requests from the host machine)
  if (req.method === 'GET' && url.pathname === '/adapters') {
    if (!isLoopbackAddr(req.socket.remoteAddress)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'host only' })); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, current: BIND_HOST || '', adapters: adapterList() }));
  }

  // the client is the only static asset, served from memory
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(indexHtml());
  }

  // dev convenience: serve other files from ./public if present
  const file = path.join(APP_DIR, 'public', path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(APP_DIR, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
};
const server = http.createServer(httpHandler);

/* ---- WebSocket server --------------------------------------------------- */
const wss = new WebSocketServer({ noServer: true });
function attachUpgrade(srv) {
  srv.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => { ws._local = isLoopbackAddr(req.socket.remoteAddress); wss.emit('connection', ws, req); });
  });
}
attachUpgrade(server);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'hello', requireCode: !!ROOM_CODE }));
  ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } handle(ws, m); });
  ws.on('close', () => {
    clients.delete(ws);
    let changed = false;
    for (const [k, l] of locks) if (l.ws === ws) { locks.delete(k); changed = true; }
    broadcast({ t: 'presence', users: presenceList() });
    if (changed) broadcast({ t: 'locks', locks: lockList() });
  });
  if (!ROOM_CODE) sendState(ws);
});

function historyStatus() {
  const {undo, redo} = DATA.history;
  return {canUndo: !!undo.length, canRedo: !!redo.length, undoLabel: undo.at(-1)?.label || '', redoLabel: redo.at(-1)?.label || ''};
}
function stateMessage() { return {t: 'state', events: loadEvents(), history: historyStatus()}; }
function normalizePointer(pointer) {
  if (!pointer) return null;
  const event = DATA.events.find(x => x.ev.id === pointer.eventId)?.ev;
  const show = event?.days.find(d => d.id === pointer.dayId)?.shows.find(s => s.id === pointer.showId);
  const cues = show?.cues || [];
  const index = Object.hasOwn(pointer, 'cueId') ? cues.findIndex(c => c.id === pointer.cueId) : (Number.isInteger(pointer.cueIdx) && pointer.cueIdx >= 0 && pointer.cueIdx < cues.length ? pointer.cueIdx : -1);
  return {...pointer, cueId: index >= 0 ? cues[index].id : null, cueIdx: index};
}
function reconcilePresence() {
  for (const client of clients.values()) client.pointer = normalizePointer(client.pointer);
  for (const [key, lock] of locks) {
    const exists = DATA.events.some(({ev}) => ev.days.some(day => day.shows.some(show => show.id === lock.showId && show.cues.some(cue => cue.id === lock.cueId) && ev.columns.some(col => col.key === lock.colKey))));
    if (!exists) locks.delete(key);
  }
  broadcast({t: 'presence', users: presenceList()});
  broadcast({t: 'locks', locks: lockList()});
}
const mutationLabels = {'event:update':'Edit event', 'event:create':'Create event', 'event:delete':'Delete event', 'data:wipe':'Wipe show data', 'note:add':'Add note', 'note:delete':'Delete note', merge:'Import cues'};
function handle(ws, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t !== 'join' && !clients.has(ws)) return;
  if (m.t === 'history:undo' || m.t === 'history:redo') {
    if (locks.size) { ws.send(JSON.stringify({t:'error', message:'Finish active cell edits before undo or redo.'})); return; }
    const undo = m.t === 'history:undo';
    const source = DATA.history[undo ? 'undo' : 'redo'];
    const destination = DATA.history[undo ? 'redo' : 'undo'];
    const step = source.pop();
    if (!step) return;
    destination.push({events: structuredClone(DATA.events), label: step.label});
    DATA.events = step.events;
    trimHistory(); persist(); reconcilePresence(); broadcast(stateMessage());
    return;
  }
  const label = mutationLabels[m.t];
  const before = label ? structuredClone(DATA.events) : null;
  try { handleMessage(ws, m); }
  catch (error) { if (before) DATA.events = before; ws.send(JSON.stringify({t:'error', message: error.message, requestId: m.requestId})); ws.send(JSON.stringify(stateMessage())); return; }
  if (before && JSON.stringify(before) !== JSON.stringify(DATA.events)) {
    DATA.history.undo.push({events: before, label}); DATA.history.redo = [];
    trimHistory(); persist(); reconcilePresence(); broadcast(stateMessage());
  }
  if(m.t==='merge' && m.requestId) ws.send(JSON.stringify({t:'merge:result',requestId:m.requestId,ok:true}));
}
function handleMessage(ws, m) {
  switch (m.t) {
    case 'join': {
      if (ROOM_CODE && (m.code || '') !== ROOM_CODE) {
        ws.send(JSON.stringify({ t: 'denied', reason: 'Invalid room code' }));
        return;
      }
      clients.set(ws, {
        id: m.id || uid('usr_'), name: m.name || 'Anon', position: m.position || '',
        color: m.color || '#4f8cff', pointer: normalizePointer(m.pointer), follow: null,
      });
      ws.send(JSON.stringify({ t: 'joined', you: clients.get(ws) }));
      if (ROOM_CODE) sendState(ws);
      broadcast({ t: 'presence', users: presenceList() });
      break;
    }
    case 'pointer': {
      const c = clients.get(ws); if (!c) break;
      c.pointer = normalizePointer(m.pointer);
      broadcast({ t: 'presence', users: presenceList() });
      break;
    }
    case 'follow': {
      const c = clients.get(ws); if (!c) break;
      c.follow = m.targetId || null;
      ws.send(JSON.stringify({ t: 'followAck', targetId: c.follow }));
      break;
    }
    case 'lock': {
      const c = clients.get(ws); if (!c) break;
      const l = { showId: m.showId, cueId: m.cueId, colKey: m.colKey, userId: c.id, name: c.name, color: c.color, ws };
      const k = lockKey(l);
      const cur = locks.get(k);
      if (cur && cur.userId !== c.id) { ws.send(JSON.stringify({ t: 'lockDenied', cueId: m.cueId, colKey: m.colKey, by: cur.name })); break; }
      locks.set(k, l);
      broadcast({ t: 'locks', locks: lockList() });
      break;
    }
    case 'unlock': {
      const c = clients.get(ws); if (!c) break;
      const k = lockKey({ showId: m.showId, cueId: m.cueId, colKey: m.colKey });
      const cur = locks.get(k);
      if (cur && cur.userId === c.id) { locks.delete(k); broadcast({ t: 'locks', locks: lockList() }); }
      break;
    }
    case 'note:add': {
      const c = clients.get(ws);
      const w = DATA.events.find(x => x.ev.id === m.eventId);
      if (!w) break;
      if (!Array.isArray(w.ev.notes)) w.ev.notes = [];
      const text = String(m.text || '').slice(0, 4000).trim();
      if (!text) break;
      w.ev.notes.push({ id: uid('note_'), author: (c && c.name) || m.author || 'Anon', color: (c && c.color) || m.color || '#8b97a7', text, ts: Date.now() });
      saveEvent(w.ev);
      
      break;
    }
    case 'note:delete': {
      const w = DATA.events.find(x => x.ev.id === m.eventId);
      if (!w || !Array.isArray(w.ev.notes)) break;
      w.ev.notes = w.ev.notes.filter(n => n.id !== m.noteId);
      saveEvent(w.ev);
      
      break;
    }
    case 'event:update': { saveEvent(m.event);  break; }
    case 'event:create': { saveEvent(blankEvent(m.name || 'New Event'));  break; }
    case 'event:delete': { deleteEvent(m.id);  break; }
    case 'data:wipe': {
      DATA.events = [];
      saveEvent(blankEvent('Untitled Event'));
      
      break;
    }
    case 'net:setAdapter': {
      if (!ws._local) { ws.send(JSON.stringify({ t: 'net:set', ok: false, error: 'Network settings can only be changed on the host computer.' })); break; }
      CONFIG.bindHost = m.address || '';     // '' => all interfaces
      saveConfig(CONFIG);
      ws.send(JSON.stringify({ t: 'net:set', ok: true, current: CONFIG.bindHost, adapters: adapterList(), boundNow: BIND_HOST || '' }));
      break;
    }
    case 'merge': {
      const existing = loadEvents().find(e => e.id === m.eventId);
      if (!existing) throw new Error('Import destination event no longer exists. Reopen the import dialog.');
      const ev = structuredClone(existing);
      const day = ev.days.find(d => d.id === m.dayId);
      const show = day?.shows.find(s => s.id === m.showId);
      if (!show) throw new Error('Import destination show no longer exists. Reopen the import dialog.');
      const batches=m.batches??[{columns:m.columns,rows:m.rows}];
      if(!Array.isArray(batches)||!batches.length)throw new Error('No tables to import.');
      const reserved=new Set(['id','_images','_notify','__proto__','constructor','prototype']);
      const have = new Set(ev.columns.map(c => c.key));
      const ids = new Set(show.cues.map(cue => cue.id));
      for(const batch of batches){
        if(!batch||!Array.isArray(batch.rows)||!Array.isArray(batch.columns))throw new Error('Invalid import table.');
        for(const col of batch.columns){
          if(!col||typeof col.key!=='string'||!col.key||reserved.has(col.key))throw new Error('Invalid import column.');
          if(have.has(col.key))throw new Error('An import column already exists. Reopen the import dialog to refresh mapping.');
          ev.columns.push({key:col.key,label:String(col.label??col.key),width:160}); have.add(col.key);
        }
        for(const row of batch.rows){
          if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Invalid import row.');
          const cue={id:typeof row.id==='string'&&row.id&&!ids.has(row.id)?row.id:uid('cue_')};
          for(const [key,value] of Object.entries(row)){
            if(key==='id')continue;
            if(key==='_images'){if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!imageFile(id)||!fs.existsSync(imageFile(id))))throw new Error('Import image unavailable. Re-upload the document.'); cue._images=value.slice();continue;}
            if(key==='_notify'){if(value&&typeof value==='object')cue._notify=value;continue;}
            if(reserved.has(key)||!have.has(key))throw new Error('Import row contains an unknown column.');
            if(value!==null&&typeof value==='object')throw new Error('Import cells must contain text or scalar values.');
            cue[key]=String(value??'');
          }
          ids.add(cue.id); show.cues.push(cue);
        }
      }
      saveEvent(ev);
      
      break;
    }
  }
}

/* ---- startup ------------------------------------------------------------ */
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k in ifs) for (const a of ifs[k]) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}
function openBrowser(url) {
  const p = process.platform;
  const cmd = p === 'win32' ? `start "" "${url}"` : p === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ! Port ${PORT} is already in use. Start with a different port:`);
    console.error(`    set a port and relaunch, e.g.  --port=7391\n`);
    process.exit(1);
  }
  throw e;
});

const BOUND_TO_IP = BIND_HOST && BIND_HOST !== '0.0.0.0' && BIND_HOST !== '::' && !isLoopbackAddr(BIND_HOST);
// The host always reaches the app (and host-only controls) via localhost.
const OPEN_URL = `http://localhost:${PORT}`;
server.listen(PORT, BIND_HOST || undefined, () => {
  const line = '  ' + '─'.repeat(52);
  console.log(`\n  LXFlow  —  cue tracking server`);
  console.log(line);
  if (BOUND_TO_IP) {
    const a = adapterList().find(x => x.address === BIND_HOST);
    console.log(`  On THIS computer:   http://localhost:${PORT}   (host controls)`);
    console.log(`  Coworkers (${a ? a.name : 'adapter'}):  http://${BIND_HOST}:${PORT}`);
    console.log(`  (not reachable on any other network, e.g. a show/Ethernet net)`);
  } else {
    console.log(`  On THIS computer:   http://localhost:${PORT}`);
    for (const a of adapterList().filter(x => !x.internal)) console.log(`  ${a.name}:  http://${a.address}:${PORT}`);
    console.log(line);
    console.log(`  Tip: in Settings → Network you can lock the app to ONE adapter (e.g. Wi-Fi).`);
  }
  console.log(line);
  if (ROOM_CODE) console.log(`  Room code required to join: ${ROOM_CODE}`);
  console.log(`  Data: ${DATA_PATH}`);
  console.log(`  Keep this window open while the show runs. Close it to stop.\n`);
  if (AUTO_OPEN) openBrowser(OPEN_URL);
});

// When bound to a single adapter, keep a loopback listener so the host can
// always reach the app (and host-only network controls) at localhost.
if (BOUND_TO_IP) {
  const lb = http.createServer(httpHandler);
  attachUpgrade(lb);
  lb.on('error', (e) => console.error('  ! loopback listener:', e.message));
  lb.listen(PORT, '127.0.0.1');
}
