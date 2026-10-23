/**
 * =====================================================================
 *  DAMAN GROUP — VEHICLE POSITION TRACKER
 *  Google Apps Script backend for the website.
 *
 *  The website reads the vehicles from the "Calling Sheet" tab and NEVER
 *  changes that tab. This script only saves what is done on the website:
 *    • the program (next load) the Director gives a vehicle
 *    • "Driver ko bataya?" — driver informed Yes / No (by the caller)
 *    • "Kaha ja rahi hai?" — where a No Program vehicle is going
 *  into a separate tab "Programs" (created automatically), one row per program.
 *
 *  ONE-TIME SETUP
 *   1. Open the vehicle position Google Sheet (the one with "Calling Sheet").
 *   2. Extensions → Apps Script.
 *        • Only "function myFunction() { }" there → delete it, paste this whole file.
 *        • Other code already there → do NOT delete it. Click ＋ (next to Files)
 *          → Script → name it "VehicleTracker" → paste this whole file there.
 *          (If Save then shows "already been declared", make this a separate
 *          project instead: script.google.com → New project → paste → Save.
 *          SHEET_ID below already points to the sheet, so it works the same.)
 *      Click Save.
 *   3. Choose the function "setup" in the toolbar and click ▶ Run.
 *      Allow the permissions Google asks for.
 *   4. Deploy → New deployment → ⚙ Select type: Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      → Deploy → copy the Web app URL (ends with /exec).
 *   5. Paste that URL into config.js → APPS_SCRIPT_URL.
 *   6. Programs in the sheet's own U&N print: choose the function
 *      "linkPrintSheets" → ▶ Run (once). The "Next Load" and "Broker" columns
 *      of U&N then fill in by themselves. (Undo: run "unlinkPrintSheets".)
 *
 *   7. Login: everybody first logs in with PIN 1234 and must then choose their own PIN.
 *      The Director can set / reset anybody's PIN on the website (tap your name → Manage PINs).
 *
 *  AFTER EDITING THIS FILE LATER
 *   Deploy → Manage deployments → ✏ Edit → Version: "New version" → Deploy.
 *   (The /exec URL stays the same, so config.js does not change.)
 * =====================================================================
 */

const CONFIG = {
  // The vehicle position Google Sheet ('' = the spreadsheet this script is attached to).
  SHEET_ID: '1YpK_o9T-3SF_j8Z4hpMsukJDF5IFnDvfDZKPMLMZRLc',
  CALLING_TAB: 'Calling Sheet',
  PROGRAM_TAB: 'Programs',
  DAYS: 3,              // programs sent to the website (today + earlier days)
  TZ: 'Asia/Kolkata',

  // ---- login (PINs are kept in this script's properties — not in the sheet, not in the website) ----
  DEFAULT_PIN: '1234',                  // first PIN for everybody; each person must set their own at first login
  ADMINS: ['Director'],                 // can set / reset anybody's PIN from the website
  EXTRA_USERS: ['Director', 'Office'],  // who can log in besides the callers named in the Calling Sheet
  TOKEN_DAYS: 60                        // a phone stays logged in this long
};

const FIELDS = [
  ['id', 'ID'], ['date', 'Date'], ['vno', 'Vehicle No'], ['caller', 'Caller'], ['cat', 'Status'], ['loc', 'Location'],
  ['program', 'Program (Next Load)'], ['broker', 'Broker / Party'], ['givenBy', 'Given By'], ['givenAt', 'Given At'],
  ['informed', 'Driver Informed'], ['informedBy', 'Informed By'], ['informedAt', 'Informed At'],
  ['goingTo', 'Going To'], ['note', 'Note'], ['updatedBy', 'Updated By'], ['updatedAt', 'Updated At']
];

const ACTIONS = {
  ping: () => ({ app: 'Daman Vehicle Position Tracker', time: now_(), auth: true }),
  calling: () => ({ grid: callingGrid_() }),
  programs: b => ({ programs: listPrograms_(b.days), today: today_() }),
  saveProgram: saveProgram_,
  users: () => ({ users: knownUsers_() }),
  login: login_,
  me: b => { const u = who_(b.token); return { user: u, admin: isAdmin_(u) }; },
  setPin: setPin_,
  logout: b => { if (b.token) PropertiesService.getScriptProperties().deleteProperty('tok_' + b.token); return {}; }
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = p.action || 'ping';
  if (action !== 'ping' && action !== 'programs') return json_({ ok: false, error: 'Please use the website.' });
  return run_(action, p);
}

function doPost(e) {
  let b;
  try {
    b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }
  return run_(b.action, b);
}

function run_(action, b) {
  try {
    const fn = ACTIONS[action];
    if (!fn) throw new Error('Unknown action: ' + action);
    return json_(Object.assign({ ok: true }, fn(b || {})));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err), code: (err && err.code) || '' });
  }
}

function err_(msg, code) { const e = new Error(msg); e.code = code || ''; return e; }

/* ------------------------------------------------------------------ */
/*  Login with a PIN                                                   */
/* ------------------------------------------------------------------ */

/** Director / Office + every caller named in the Calling Sheet ("Caller Assigned") */
function knownUsers_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('users');
  if (hit) return JSON.parse(hit);
  const out = [], seen = {};
  const add = n => { n = String(n || '').trim(); if (n && !seen[n.toLowerCase()]) { seen[n.toLowerCase()] = 1; out.push(n); } };
  CONFIG.EXTRA_USERS.forEach(add);
  try {
    const grid = callingGrid_();
    const h = grid.findIndex(r => r.some(c => /caller\s*assigned/i.test(c)));
    const col = h >= 0 ? grid[h].findIndex(c => /caller\s*assigned/i.test(c)) : -1;
    if (col >= 0) for (let i = h + 1; i < grid.length; i++) add(grid[i][col]);
  } catch (e) { /* the extra users can still log in */ }
  cache.put('users', JSON.stringify(out), 600);
  return out;
}
function canon_(name) {
  const n = String(name || '').trim().toLowerCase();
  return knownUsers_().find(u => u.toLowerCase() === n) || '';
}
function isAdmin_(name) { return CONFIG.ADMINS.some(a => a.toLowerCase() === String(name || '').toLowerCase()); }
function hash_(name, pin) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'vpt|' + name.toLowerCase() + '|' + pin, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(raw);
}

function login_(b) {
  const name = canon_(b.name);
  if (!name) throw err_('This name cannot log in');
  const cache = CacheService.getScriptCache(), failKey = 'fail_' + name.toLowerCase();
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw err_('Too many wrong PINs — try again after 5 minutes');
  const pin = String(b.pin || '').trim();
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('pin_' + name.toLowerCase());
  const ok = stored ? stored === hash_(name, pin) : pin === CONFIG.DEFAULT_PIN;
  if (!ok) { cache.put(failKey, String(fails + 1), 300); throw err_('Wrong PIN'); }
  cache.remove(failKey);
  pruneTokens_(props);
  const token = Utilities.getUuid().replace(/-/g, '');
  props.setProperty('tok_' + token, JSON.stringify({ n: name, e: Date.now() + CONFIG.TOKEN_DAYS * 86400000 }));
  return { token: token, user: name, admin: isAdmin_(name), mustChange: !stored };
}

/** the logged-in name for a token, or an 'auth' error (the website then shows the login again) */
function who_(token) {
  const raw = token ? PropertiesService.getScriptProperties().getProperty('tok_' + token) : null;
  const t = raw ? JSON.parse(raw) : null;
  if (!t || t.e < Date.now()) throw err_('Please log in again', 'auth');
  return t.n;
}

function setPin_(b) {
  const me = who_(b.token);
  const target = b.name ? canon_(b.name) : me;
  if (!target) throw err_('Unknown name');
  if (target !== me && !isAdmin_(me)) throw err_('Only the Director can change somebody else\'s PIN');
  const pin = String(b.pin || '').trim();
  if (!/^\d{4,8}$/.test(pin)) throw err_('PIN must be 4 to 8 digits');
  if (pin === CONFIG.DEFAULT_PIN) throw err_('Choose a PIN other than ' + CONFIG.DEFAULT_PIN);
  PropertiesService.getScriptProperties().setProperty('pin_' + target.toLowerCase(), hash_(target, pin));
  return { user: target };
}

function pruneTokens_(props) {
  const all = props.getProperties(), now = Date.now();
  Object.keys(all).forEach(k => {
    if (k.indexOf('tok_') !== 0) return;
    try { if (JSON.parse(all[k]).e < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

/** Run once from the editor: creates the "Programs" tab and asks for permissions. */
function setup() {
  const ss = ss_();
  programSheet_();
  if (!ss.getSheetByName(CONFIG.CALLING_TAB)) Logger.log('⚠ Tab "' + CONFIG.CALLING_TAB + '" not found — check CONFIG.CALLING_TAB.');
  Logger.log('✅ Ready: ' + ss.getUrl());
  Logger.log('Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).');
}

/* ------------------------------------------------------------------ */

function ss_() {
  if (!CONFIG.SHEET_ID) return SpreadsheetApp.getActiveSpreadsheet();
  const m = String(CONFIG.SHEET_ID).match(/[-\w]{25,}/);
  return SpreadsheetApp.openById(m ? m[0] : CONFIG.SHEET_ID);
}

function programSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(CONFIG.PROGRAM_TAB);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.PROGRAM_TAB);
    sh.getRange(1, 1, 1, FIELDS.length).setValues([FIELDS.map(f => f[1])])
      .setFontWeight('bold').setBackground('#1b1e4f').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    // plain text, so dates / times / numbers are kept exactly as written
    sh.getRange(1, 1, sh.getMaxRows(), FIELDS.length).setNumberFormat('@');
    sh.setColumnWidth(7, 280);
  }
  return sh;
}

function callingGrid_() {
  const sh = ss_().getSheetByName(CONFIG.CALLING_TAB);
  if (!sh) throw new Error('Tab "' + CONFIG.CALLING_TAB + '" not found');
  const grid = sh.getDataRange().getDisplayValues();
  while (grid.length && grid[grid.length - 1].every(c => c === '')) grid.pop();
  return grid;
}

function rowToObj_(row) {
  const o = {};
  FIELDS.forEach((f, i) => { o[f[0]] = String(row[i] == null ? '' : row[i]); });
  return o;
}

function listPrograms_(days) {
  const sh = programSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const n = Math.max(1, Math.min(Number(days) || CONFIG.DAYS, 60));
  const cut = Utilities.formatDate(new Date(Date.now() - (n - 1) * 86400000), CONFIG.TZ, 'yyyy-MM-dd');
  return sh.getRange(2, 1, last - 1, FIELDS.length).getDisplayValues()
    .map(rowToObj_)
    .filter(p => p.id && p.date >= cut);
}

function saveProgram_(b) {
  b.user = who_(b.token); // the logged-in name is what goes into "Given By" / "Informed By"
  const vno = String(b.vno || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!vno) throw new Error('Vehicle number missing');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = programSheet_();
    const last = sh.getLastRow();
    let rowNo = -1, rec = null;
    if (b.id && last >= 2) {
      const ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
      for (let i = ids.length - 1; i >= 0; i--) {
        if (ids[i][0] === String(b.id)) { rowNo = i + 2; break; }
      }
    }
    // no id (or not found): reuse today's row of this vehicle — one row per vehicle per day,
    // so a double click or two phones saving at once never make a second row
    if (rowNo < 0 && last >= 2) {
      const today = today_();
      const keys = sh.getRange(2, 2, last - 1, 2).getDisplayValues(); // Date, Vehicle No
      for (let i = keys.length - 1; i >= 0; i--) {
        if (keys[i][1] === vno && keys[i][0] === today) { rowNo = i + 2; break; }
      }
    }
    if (rowNo > 0) rec = rowToObj_(sh.getRange(rowNo, 1, 1, FIELDS.length).getDisplayValues()[0]);
    if (!rec) {
      rec = {};
      FIELDS.forEach(f => { rec[f[0]] = ''; });
      rec.id = 'P' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 900 + 100);
      rec.date = today_();
      rec.vno = vno;
    }
    applyPatch_(rec, b, now_());
    const values = [FIELDS.map(f => rec[f[0]])];
    if (rowNo > 0) {
      sh.getRange(rowNo, 1, 1, FIELDS.length).setValues(values);
    } else {
      rowNo = sh.getLastRow() + 1;
      if (rowNo > sh.getMaxRows()) {
        sh.insertRowsAfter(sh.getMaxRows(), 500);
        sh.getRange(rowNo, 1, 500, FIELDS.length).setNumberFormat('@');
      }
      sh.getRange(rowNo, 1, 1, FIELDS.length).setNumberFormat('@').setValues(values);
    }
    return { program: rec };
  } finally {
    lock.releaseLock();
  }
}

/** Same rules as applyPatch in app.js */
function applyPatch_(rec, b, now) {
  const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 300);
  const user = clean(b.user) || 'Unknown';
  ['caller', 'cat', 'loc'].forEach(k => { if (b[k] != null && b[k] !== '') rec[k] = clean(b[k]); });
  if (b.program != null) {
    const p = clean(b.program);
    if (p !== rec.program) {
      rec.program = p;
      rec.givenBy = p ? user : '';
      rec.givenAt = p ? now : '';
      if (b.informed == null) { rec.informed = p ? 'No' : ''; rec.informedBy = ''; rec.informedAt = ''; }
    }
  }
  if (b.broker != null) rec.broker = clean(b.broker);
  if (b.goingTo != null) rec.goingTo = clean(b.goingTo);
  if (b.note != null) rec.note = clean(b.note);
  if (b.informed != null) {
    const v = (b.informed === true || b.informed === 'Yes') ? 'Yes' : 'No';
    if (v !== rec.informed) {
      rec.informed = v;
      rec.informedBy = v === 'Yes' ? user : '';
      rec.informedAt = v === 'Yes' ? now : '';
    }
  }
  rec.updatedBy = user;
  rec.updatedAt = now;
}

/* ------------------------------------------------------------------ */
/*  Programs in the sheet's own print tabs (U&N)                       */
/* ------------------------------------------------------------------ */
// In the tab "Unloading & No Program" (it feeds U&N) the columns "Next Load" and "Broker"
// are empty placeholders:  IFERROR('Calling Sheet'!C4:C987/0, "")
// linkPrintSheets() makes a small tab "Next Load" (latest program of every vehicle, from the
// "Programs" tab) and swaps those placeholders for a lookup into it. Run it once from the editor.
const PRINT_LINK = {
  TAB: 'Unloading & No Program',
  NEXT_TAB: 'Next Load',
  CELLS: { A7: ['next'], F7: ['next'], K7: ['next', 'broker'] }, // placeholders, left to right
  BLANK: /IFERROR\(\s*('Calling Sheet'!C\d+:C\d+)\s*\/\s*0\s*,\s*""\s*\)/
};

function linkPrintSheets() {
  const ss = ss_();
  programSheet_();
  let nt = ss.getSheetByName(PRINT_LINK.NEXT_TAB);
  if (!nt) nt = ss.insertSheet(PRINT_LINK.NEXT_TAB, ss.getSheets().length);
  nt.getRange('A1').setFormula(nextLoadFormula_());
  SpreadsheetApp.flush();
  const top = nt.getRange('A1').getDisplayValue();
  if (/^#/.test(top)) throw new Error('"' + PRINT_LINK.NEXT_TAB + '" tab shows ' + top + ' — nothing else was changed.');

  const sh = ss.getSheetByName(PRINT_LINK.TAB);
  if (!sh) throw new Error('Tab "' + PRINT_LINK.TAB + '" not found');
  const props = PropertiesService.getScriptProperties();
  Object.keys(PRINT_LINK.CELLS).forEach(a1 => {
    const cell = sh.getRange(a1);
    const old = cell.getFormula();
    if (!old) { Logger.log('⚠ ' + a1 + ': no formula — skipped'); return; }
    if (old.indexOf(PRINT_LINK.NEXT_TAB) >= 0) { Logger.log('✅ ' + a1 + ': already linked'); return; }
    let f = old, n = 0;
    PRINT_LINK.CELLS[a1].forEach(what => {
      const m = f.match(PRINT_LINK.BLANK);
      if (!m) return;
      f = f.slice(0, m.index) + lookup_(m[1], what === 'next' ? 2 : 3) + f.slice(m.index + m[0].length);
      n++;
    });
    if (!n) { Logger.log('⚠ ' + a1 + ': empty "Next Load" column not found — skipped'); return; }
    const before = cell.getDisplayValue();
    props.setProperty('backup_' + a1, old);
    cell.setFormula(f);
    SpreadsheetApp.flush();
    const shown = cell.getDisplayValue();
    // safety: an error, or a list that went blank, puts the old formula back
    if (/^#(ERROR|N\/A|VALUE|REF|NAME|DIV)/i.test(shown) || (before && !shown)) {
      cell.setFormula(old);
      Logger.log('❌ ' + a1 + ': new formula showed ' + shown + ' — old formula restored');
      return;
    }
    Logger.log('✅ ' + a1 + ': linked (' + n + ' column' + (n > 1 ? 's' : '') + ')');
  });
  Logger.log('Done. Open the U&N tab — "Next Load" / "Broker" now show the programs given on the website.');
}

/** Puts the original U&N formulas back. */
function unlinkPrintSheets() {
  const sh = ss_().getSheetByName(PRINT_LINK.TAB);
  const props = PropertiesService.getScriptProperties();
  Object.keys(PRINT_LINK.CELLS).forEach(a1 => {
    const old = props.getProperty('backup_' + a1);
    if (old && sh) { sh.getRange(a1).setFormula(old); Logger.log('↩ ' + a1 + ' restored'); }
  });
}

function lookup_(vehicleRange, col) {
  return 'ARRAYFORMULA(IFERROR(VLOOKUP(' + vehicleRange + ", '" + PRINT_LINK.NEXT_TAB + "'!A:C, " + col + ', FALSE), ""))';
}

/** "Next Load" tab: newest program of each vehicle from the last CONFIG.DAYS days; ✓ = driver informed. */
function nextLoadFormula_() {
  const col = k => {
    let n = FIELDS.findIndex(f => f[0] === k) + 1, s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return "'" + CONFIG.PROGRAM_TAB + "'!" + s + '2:' + s;
  };
  return '={"Vehicle No", "Next Load", "Broker", "Updated At"; IFERROR(SORT(FILTER({' +
    col('vno') + ', ' + col('program') + ' & IF(' + col('informed') + ' = "Yes", " ✓", ""), ' + col('broker') + ', ' + col('updatedAt') + '}, ' +
    col('vno') + ' <> "", ' + col('date') + ' >= TEXT(TODAY() - ' + (CONFIG.DAYS - 1) + ', "yyyy-mm-dd")), 4, FALSE), {"", "", "", ""})}';
}

function today_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'); }
function now_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss'); }

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
