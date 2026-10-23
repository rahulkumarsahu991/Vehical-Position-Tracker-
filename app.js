/* =====================================================================
 * Daman Group — Vehicle Position Tracker
 *
 *  • Reads the "Calling Sheet" tab of the Google Sheet (CSV export): where
 *    every vehicle is and what it is doing, caller wise.
 *  • Programs (next load) given by the Director and "driver informed" ticks are
 *    saved through Code.gs (Apps Script) in a "Programs" tab — or only in this
 *    browser while APPS_SCRIPT_URL is empty.
 *  • Prints: Caller wise (one page per caller), U&N, L&R, R&H — one page each.
 * ===================================================================== */
(function () {
  'use strict';

  const CFG = window.VPT_CONFIG || {};
  const API_URL = String(CFG.APPS_SCRIPT_URL || '').trim();
  const LOCAL = !API_URL;
  const PROGRAM_DAYS = Math.max(1, Number(CFG.PROGRAM_DAYS) || 3);
  const REFRESH_MS = Math.max(10, Number(CFG.REFRESH_SECONDS) || (Number(CFG.REFRESH_MINUTES) || 0) * 60 || 20) * 1000;
  const CHANGE_MARK_MS = 3 * 60000; // "Updated" tag stays this long on a vehicle that changed in the sheet
  const COMPANY = CFG.COMPANY || 'Daman Group';

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  const up = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase();
  const pad = n => String(n).padStart(2, '0');

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full / blocked */ } }
  };
  const K = {
    user: 'vpt_user', caller: 'vpt_caller', group: 'vpt_group', closed: 'vpt_closed',
    progs: 'vpt_programs_local', cache: 'vpt_cache_v1', progCache: 'vpt_prog_cache_v1', outbox: 'vpt_outbox_v1', print: 'vpt_print', banner: 'vpt_banner_hidden'
  };

  /* ---------------- status categories (same groups as the sheet's prints) ---------------- */
  const CATS = [
    { key: 'loading', label: 'Loading', color: '#2563eb' },
    { key: 'unloading', label: 'Unloading', color: '#7c3aed' },
    { key: 'running', label: 'Running', color: '#16a34a' },
    { key: 'empty', label: 'Empty Running', color: '#0e9fb8' },
    { key: 'noprog', label: 'No Program', color: '#ea580c' },
    { key: 'repair', label: 'Repair', color: '#dc2626' },
    { key: 'halted', label: 'Halted / No Driver', color: '#64748b' },
    { key: 'loadnd', label: 'Load / No Driver', color: '#a16207' },
    { key: 'emergency', label: 'Emergency', color: '#9f1239' },
    { key: 'other', label: 'Others', color: '#78716c' }
  ];
  const CAT = { sold: { key: 'sold', label: 'Sold', color: '#a8a29e', i: 99 } };
  CATS.forEach((c, i) => { c.i = i; CAT[c.key] = c; });
  const NEEDS_PROGRAM = { noprog: 1, unloading: 1 };

  const ICO = {
    phone: '<svg class="ico" viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
    wa: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 21l1.6-4.6A8.5 8.5 0 1 1 8 19.6z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .8a4 4 0 0 1-2.1-2.1l.8-1-1-2z"/></svg>',
    x: '<svg class="ico" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    chev: '<svg class="ico chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
    check: '<svg class="ico" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
    clock: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  };

  /* ---------------- state ---------------- */
  const S = {
    vehicles: [], byVno: {}, callers: [], places: [], items: [],
    programs: [], active: {},
    loadedAt: 0, dataDate: '', loading: false, sheetError: '', progError: '',
    user: store.get(K.user, ''),
    view: 'board',
    f: { caller: store.get(K.caller, ''), q: '', cats: new Set(), loc: '', item: '', prog: '', flags: new Set() },
    group: store.get(K.group, 'status'),
    closed: new Set(store.get(K.closed, [])),
    sort: { key: 'cat', dir: 1 },
    pseg: 'noprog', pq: '',
    drafts: {}, editing: {},
    print: Object.assign({ rep: 'caller', caller: '', orient: 'auto', cols: 'auto' }, store.get(K.print, {})),
    detail: null, pending: false,
    changedAt: {}, gridSig: '', progSig: '', fromCache: false, fails: 0, sheetChangedAt: 0,
    saving: {}, lastSaveAt: 0, outbox: store.get(K.outbox, []), flushing: false, outboxError: '', retryTimer: null,
    repairInfo: {}, repairAt: 0, repairLoading: false
  };

  /* =====================================================================
   *  Dates & times
   * ===================================================================== */
  function todayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function nowStr() { const d = new Date(); return todayKey(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function addDays(key, n) { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return todayKey(d); }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function prettyDate(key) { const m = String(key).match(/^(\d{4})-(\d\d)-(\d\d)/); return m ? (+m[3]) + ' ' + MON[+m[2] - 1] : key; }
  function clock(d) { let h = d.getHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; return h + ':' + pad(d.getMinutes()) + ' ' + ap; }
  /** "2026-10-22 15:10:04" → "3:10 PM" (today) or "21 Oct, 3:10 PM" */
  function fmtStamp(s) {
    const m = String(s || '').match(/^(\d{4}-\d\d-\d\d)[ T](\d\d):(\d\d)/);
    if (!m) return s || '';
    const d = new Date(m[1] + 'T' + m[2] + ':' + m[3] + ':00');
    return (m[1] === todayKey() ? '' : prettyDate(m[1]) + ', ') + clock(d);
  }
  /** Sheet dates: "10/22/2026" (M/D/Y), "22/10/2026" (D/M/Y) or "2026-10-22" → "2026-10-22" */
  function sheetDateKey(s, dmy) {
    const m = String(s || '').match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (!m) return '';
    if (m[1].length === 4) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    const a = +m[1], b = +m[2];
    return dmy ? y + '-' + pad(b) + '-' + pad(a) : y + '-' + pad(a) + '-' + pad(b);
  }
  /** "4:27:49 PM" → minutes after midnight */
  function timeMin(s) {
    const m = String(s || '').match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
    if (!m) return null;
    let h = +m[1];
    if (m[3]) { const pm = m[3].toUpperCase() === 'PM'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    return h * 60 + +m[2];
  }
  /** "16:19:51" or "4:19:51 PM" → "4:19 PM" */
  function shortTime(s) {
    const m = timeMin(s);
    if (m == null) return s;
    const h = Math.floor(m / 60) % 24;
    return (h % 12 || 12) + ':' + pad(m % 60) + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function partOfDay(d) { const h = d.getHours(); return h < 12 ? 'MORNING' : h < 17 ? 'AFTERNOON' : h < 21 ? 'EVENING' : 'NIGHT'; }

  /* =====================================================================
   *  Google Sheet → vehicles
   * ===================================================================== */
  function parseCsv(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  const normHead = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const FIELD_BY_HEAD = {
    'sr no': 'sr', 'date': 'date', 'vehicle number': 'vno', 'vehicle no': 'vno', 'caller assigned': 'caller', 'caller': 'caller',
    'call time': 'callTime', 'driver name': 'driver', 'driver id': 'driverId', 'driver phone': 'phone', 'status': 'status',
    'on time late': 'onTime', 'from location': 'from', 'to location': 'to', 'current location': 'cur', 'item': 'item',
    'follow up time': 'followUp', 'route check': 'routeCheck', 'diesel': 'diesel', 'remarks': 'remarks',
    'next program': 'nextProgram', 'trip mgmt informed': 'tripInformed'
  };
  function cleanCell(s) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return /^#(REF|N\/A|VALUE|ERROR|NAME\?|DIV\/0)!?/i.test(s) ? '' : s;
  }

  function categorize(status, onTime) {
    const s = norm(status), o = norm(onTime);
    if (s === 'sold') return 'sold';
    if (o.includes('emergency') || s.includes('emergency')) return 'emergency';
    if (o.includes('repair') || s.includes('repair')) return 'repair';
    if (o.includes('no program') || s.includes('no program')) return 'noprog';
    if (o.includes('no driver')) return (s === 'load' || s === 'loaded') ? 'loadnd' : 'halted';
    if (s.startsWith('unload')) return 'unloading';
    if (s.startsWith('loading')) return 'loading';
    if (s.startsWith('running')) return 'running';
    if (s.startsWith('empty')) return 'empty';
    return 'other';
  }

  /** dateOrder: 'DMY' / 'MDY' when the sheet's date style is known; otherwise guessed from the dates */
  function parseCalling(grid, dateOrder) {
    let h = -1;
    for (let i = 0; i < Math.min(grid.length, 15); i++) {
      if ((grid[i] || []).some(c => normHead(c) === 'vehicle number' || normHead(c) === 'vehicle no')) { h = i; break; }
    }
    if (h < 0) throw new Error('"Vehicle Number" heading not found in the Calling Sheet');
    const map = {};
    grid[h].forEach((c, i) => { const k = FIELD_BY_HEAD[normHead(c)]; if (k && map[k] == null) map[k] = i; });

    const rows = [];
    for (let r = h + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const get = k => (map[k] == null ? '' : cleanCell(row[map[k]]));
      const vno = get('vno').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!vno) continue;
      const v = { vno };
      Object.keys(map).forEach(k => { if (k !== 'vno') v[k] = get(k); });
      rows.push(v);
    }
    // date order: any first part > 12 means D/M/Y
    const dmy = dateOrder ? dateOrder === 'DMY'
      : rows.some(v => { const m = String(v.date || '').match(/^(\d{1,2})[\/\-.]/); return m && +m[1] > 12; });
    const seen = {}, out = [], dateCount = {};
    rows.forEach(v => {
      enrich(v, dmy);
      if (v.dateKey) dateCount[v.dateKey] = (dateCount[v.dateKey] || 0) + 1;
      if (seen[v.vno] != null) out[seen[v.vno]] = v; else { seen[v.vno] = out.length; out.push(v); }
    });
    let dataDate = '', best = 0;
    Object.keys(dateCount).forEach(k => { if (dateCount[k] > best || (dateCount[k] === best && k > dataDate)) { best = dateCount[k]; dataDate = k; } });
    return { vehicles: out, dataDate: dataDate };
  }

  function enrich(v, dmy) {
    ['caller', 'driver', 'status', 'onTime', 'from', 'to', 'cur', 'item', 'remarks', 'nextProgram', 'phone', 'driverId', 'callTime', 'followUp', 'date', 'diesel', 'routeCheck']
      .forEach(k => { if (v[k] == null) v[k] = ''; });
    v.cat = categorize(v.status, v.onTime);
    v.late = /late/i.test(v.onTime);
    v.callerName = v.caller || 'Unassigned';
    v.from = up(v.from); v.to = up(v.to); v.cur = up(v.cur); v.item = up(v.item);
    v.where = v.cur || (v.cat === 'loading' ? v.from : v.cat === 'unloading' ? v.to : '') || '';
    v.dateKey = sheetDateKey(v.date, dmy);
    v.phoneDigits = String(v.phone).replace(/\D/g, '').slice(-10);
    v.callTime = shortTime(v.callTime); v.followUp = shortTime(v.followUp); // one time style, whichever sheet it came from
    v.followMin = timeMin(v.followUp);
    v.search = norm([v.vno, v.vno.slice(-4), v.driver, v.driverId, v.phone, v.from, v.to, v.cur, v.item, v.remarks,
      v.callerName, v.status, v.onTime, v.nextProgram, CAT[v.cat].label].join(' '));
  }

  /** what the vehicle is doing, for one line of text */
  function doing(v) {
    const it = v.item ? ' · ' + v.item : '';
    switch (v.cat) {
      case 'loading': return { pre: 'Loading at', loc: v.from || v.cur, post: (v.to ? ' · for ' + v.to : '') + it + (v.cur && v.from && v.cur !== v.from ? ' · now at ' + v.cur : '') };
      case 'unloading': return { pre: 'Unloading at', loc: v.to || v.cur, post: it + (v.cur && v.to && v.cur !== v.to ? ' · now at ' + v.cur : '') };
      case 'running': return { pre: 'Running · now at', loc: v.cur || '—', post: (v.from && v.to ? ' · ' + v.from + ' → ' + v.to : v.from ? ' · from ' + v.from : v.to ? ' · to ' + v.to : '') + it };
      case 'empty': return { pre: 'Empty · now at', loc: v.cur || '—', post: v.from ? ' · from ' + v.from : '' };
      case 'noprog': return { pre: 'No program · at', loc: v.cur || '—', post: '' };
      case 'repair': return { pre: 'Repair at', loc: v.cur || '—', post: '' };
      case 'halted': return { pre: 'No driver · at', loc: v.cur || '—', post: '' };
      case 'loadnd': return { pre: 'Loaded, no driver · at', loc: v.cur || '—', post: it };
      case 'emergency': return { pre: 'Emergency at', loc: v.cur || '—', post: '' };
      case 'sold': return { pre: 'Sold', loc: '', post: '' };
      default: return { pre: (v.status || 'Status unknown') + ' · at', loc: v.cur || '—', post: '' };
    }
  }
  function doingHtml(v) {
    const d = doing(v);
    return '<span class="sm">' + esc(d.pre) + '</span> <span class="loc">' + esc(d.loc) + '</span>' + (d.post ? '<span class="sm">' + esc(d.post) + '</span>' : '');
  }

  function flagsOf(v) {
    const t = todayKey(), nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    return {
      late: v.late,
      stale: !!(S.dataDate && v.dateKey && v.dateKey < S.dataDate),
      due: v.dateKey === t && v.followMin != null && v.followMin <= nowMin && !/sold/i.test(v.status),
      nodrv: !v.driver && !v.phoneDigits,
      upd: recentlyChanged(v)
    };
  }

  /* =====================================================================
   *  Loading data
   * ===================================================================== */
  async function fetchWithTimeout(url, opts, ms) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    try { return await fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {})); }
    catch (e) { throw new Error(e && e.name === 'AbortError' ? 'Google Sheet is taking too long' : 'No internet connection'); }
    finally { if (t) clearTimeout(t); }
  }

  /** → { sig, grid() } — the CSV is parsed only when it differs from last time (saves work on slow phones) */
  async function loadCallingGrid() {
    const getCsv = async (url, ms) => {
      const r = await fetchWithTimeout(url, { cache: 'no-store' }, ms);
      if (!r.ok) throw new Error('Google Sheet replied ' + r.status);
      const text = await r.text();
      if (/^\s*</.test(text)) throw new Error('Google Sheet is not shared — set "Anyone with the link: Viewer"');
      return text;
    };
    // 1) the Fleet sheet itself — one quick request (gviz), freshest data
    const src = CFG.CALLING_SOURCE;
    if (src && src.SHEET_ID) {
      try {
        const text = await getCsv('https://docs.google.com/spreadsheets/d/' + encodeURIComponent(src.SHEET_ID) +
          '/gviz/tq?tqx=out:csv&gid=' + encodeURIComponent(src.GID), 15000);
        if (/vehicle/i.test(text.slice(0, 600))) return { sig: text, grid: () => parseCsv(text), order: src.DATE_ORDER || '' };
      } catch (e) { /* fall back to the copy */ }
    }
    // 2) the copy in the vehicle position sheet
    const url = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(CFG.SHEET_ID) +
      '/export?format=csv&gid=' + encodeURIComponent(CFG.CALLING_GID);
    try {
      const text = await getCsv(url, 30000);
      return { sig: text, grid: () => parseCsv(text), order: '' };
    } catch (e) {
      if (!LOCAL) { // fall back to the Apps Script (works even if the sheet is private)
        const res = await api('calling');
        return { sig: JSON.stringify(res.grid), grid: () => res.grid, order: '' };
      }
      throw e;
    }
  }

  async function api(action, payload) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), 40000) : null;
    let text;
    try {
      const r = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request → no CORS preflight
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
        signal: ctrl ? ctrl.signal : undefined
      });
      text = await r.text();
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? 'Server is taking too long — try again' : 'No internet connection — try again');
    } finally { if (t) clearTimeout(t); }
    let res;
    try { res = JSON.parse(text); } catch (e) { throw new Error('Invalid reply from Apps Script — check the deployment (Who has access: Anyone)'); }
    if (!res || !res.ok) throw new Error((res && res.error) || 'Something went wrong');
    return res;
  }

  /* -------- programs kept in this browser (until Code.gs is connected) -------- */
  const Local = {
    all() { return store.get(K.progs, []); },
    list() { const cut = addDays(todayKey(), -(PROGRAM_DAYS - 1)); return this.all().filter(p => (p.date || '') >= cut); },
    save(b) {
      const all = this.all();
      let rec = b.id ? all.find(p => p.id === b.id) : null;
      if (!rec) {
        rec = { id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), date: todayKey(), vno: b.vno,
          caller: '', cat: '', loc: '', program: '', broker: '', givenBy: '', givenAt: '', informed: '', informedBy: '',
          informedAt: '', goingTo: '', note: '', updatedBy: '', updatedAt: '' };
        all.push(rec);
      }
      applyPatch(rec, b, nowStr());
      store.set(K.progs, all.slice(-800));
      return Object.assign({}, rec);
    }
  };
  /** Same rules as saveProgram_ in Code.gs */
  function applyPatch(rec, b, now) {
    const user = String(b.user || '').trim() || 'Unknown';
    ['caller', 'cat', 'loc'].forEach(k => { if (b[k] != null && b[k] !== '') rec[k] = String(b[k]).trim(); });
    if (b.program != null) {
      const p = String(b.program).trim();
      if (p !== rec.program) {
        rec.program = p; rec.givenBy = p ? user : ''; rec.givenAt = p ? now : '';
        if (b.informed == null) { rec.informed = p ? 'No' : ''; rec.informedBy = ''; rec.informedAt = ''; }
      }
    }
    if (b.broker != null) rec.broker = String(b.broker).trim();
    if (b.goingTo != null) rec.goingTo = String(b.goingTo).trim();
    if (b.note != null) rec.note = String(b.note).trim();
    if (b.informed != null) {
      const v = (b.informed === true || b.informed === 'Yes') ? 'Yes' : 'No';
      if (v !== rec.informed) { rec.informed = v; rec.informedBy = v === 'Yes' ? user : ''; rec.informedAt = v === 'Yes' ? now : ''; }
    }
    rec.updatedBy = user; rec.updatedAt = now;
  }

  async function loadPrograms() {
    if (LOCAL) return Local.list();
    const res = await api('programs', { days: PROGRAM_DAYS });
    return res.programs || [];
  }

  function computeActive() {
    const today = todayKey(), cut = addDays(today, -(PROGRAM_DAYS - 1));
    const latest = {};
    S.programs.forEach(p => {
      if (!p || !p.vno || (p.date || '') < cut) return;
      const c = latest[p.vno];
      if (!c || String(p.updatedAt || p.givenAt || '') >= String(c.updatedAt || c.givenAt || '')) latest[p.vno] = p;
    });
    const act = {};
    Object.keys(latest).forEach(vno => {
      const p = latest[vno], v = S.byVno[vno];
      // today's programs always show; older ones only while the vehicle is still waiting for a program
      if (p.date === today || (v && NEEDS_PROGRAM[v.cat])) act[vno] = p;
    });
    S.active = act;
    S.ver = (S.ver || 0) + 1; // lists are redrawn only when this (or a filter) changes
  }

  function progState(v) {
    const p = S.active[v.vno];
    if (p && p.program) return p.informed === 'Yes' ? 'informed' : 'given';
    return NEEDS_PROGRAM[v.cat] ? 'need' : '';
  }

  function setData(parsed) {
    S.ver = (S.ver || 0) + 1;
    S.vehicles = parsed.vehicles;
    S.dataDate = parsed.dataDate;
    S.byVno = {};
    S.vehicles.forEach(v => { S.byVno[v.vno] = v; });
    const callers = [], seenC = {};
    S.vehicles.forEach(v => { if (v.caller && !seenC[v.caller]) { seenC[v.caller] = 1; callers.push(v.caller); } });
    S.callers = callers;
    const places = {}, items = {};
    S.vehicles.forEach(v => { [v.from, v.to, v.cur].forEach(p => { if (p) places[p] = 1; }); if (v.item) items[v.item] = 1; });
    S.places = Object.keys(places).sort();
    S.items = Object.keys(items).sort();
    $('#locList').innerHTML = S.places.map(p => '<option value="' + esc(p) + '">').join('');
  }

  /** Checks the Google Sheet (and the programs). Redraws only when something really changed,
   *  and marks the vehicles whose row changed in the sheet. */
  async function refresh(manual) {
    if (S.loading) return;
    S.loading = true; S.manual = !!manual; setSync();
    const started = Date.now();
    const [cal, prog] = await Promise.allSettled([loadCallingGrid(), loadPrograms()]);
    let changed = !S.vehicles.length;
    if (cal.status === 'fulfilled') {
      const sig = cal.value.sig;
      if (sig !== S.gridSig) {
        try {
          const old = S.byVno, compare = !!S.gridSig && !S.fromCache;
          const grid = cal.value.grid();
          setData(parseCalling(grid, cal.value.order));
          S.gridSig = sig; S.fromCache = false; S.sheetError = ''; S.sheetChangedAt = Date.now(); changed = true;
          if (compare) markChanged(old);
          store.set(K.cache, { at: Date.now(), grid: grid, order: cal.value.order });
        } catch (e) { S.sheetError = e.message || String(e); changed = true; }
      }
      if (S.sheetError && sig === S.gridSig) { S.sheetError = ''; changed = true; }
      S.fromCache = false;
      S.loadedAt = Date.now();
    } else {
      const err = (cal.reason && cal.reason.message) || 'Could not load the Google Sheet';
      if (err !== S.sheetError) changed = true;
      S.sheetError = err;
    }
    // a programs list asked for before the last save (or during one) is out of date — keep ours
    const progFresh = started > S.lastSaveAt && !S.outbox.length && !S.flushing;
    if (prog.status === 'fulfilled' && progFresh) {
      if (applyPrograms(prog.value) || S.progError) changed = true;
      S.progError = '';
    } else if (prog.status === 'rejected') {
      const err = (prog.reason && prog.reason.message) || 'Could not load programs';
      if (err !== S.progError) changed = true;
      S.progError = err;
    }
    S.fails = S.sheetError ? (S.fails || 0) + 1 : 0;
    S.loading = false; S.manual = false;
    setSync();
    if (manual && !S.sheetError && !S.progError) toast(changed ? 'Updated from Google Sheet' : 'Already up to date');
    else if (manual) toast(S.sheetError || S.progError, true);
    if (changed) { computeActive(); showBanner(); renderAll(); }
    if (!S.user && S.callers.length && !S.askedWho) { S.askedWho = true; openWho(); }
  }

  /** Takes a programs list from the server. Programs given / told by another user are highlighted
   *  and announced, so everybody working at the same time sees them. Returns true if anything changed. */
  function applyPrograms(list) {
    const sig = JSON.stringify(list);
    if (sig === S.progSig) return false;
    const before = S.active;
    S.programs = list; S.progSig = sig;
    if (!LOCAL) store.set(K.progCache, list);
    computeActive();
    if (S.progSeeded) {
      const now = Date.now(), news = [];
      Object.keys(S.active).forEach(vno => {
        const p = S.active[vno], o = before[vno] || {};
        if (p.updatedBy === S.user) return;
        if (p.program && p.program !== o.program) news.push('📋 ' + vno + ': ' + p.program + ' (' + (p.givenBy || p.updatedBy) + ')');
        else if (p.program && p.informed === 'Yes' && o.informed !== 'Yes') news.push('✓ ' + vno + ': driver informed (' + (p.informedBy || p.updatedBy) + ')');
        else return;
        S.changedAt[vno] = now;
      });
      if (news.length) toast(news.length === 1 ? news[0] : news.length + ' programs updated by others');
    }
    S.progSeeded = true;
    return true;
  }
  /** programs only — checked more often than the sheet so other users' programs show up quickly */
  async function refreshPrograms() {
    if (LOCAL || S.loading || S.progLoading || document.hidden || S.outbox.length || S.flushing) return;
    S.progLoading = true;
    const started = Date.now();
    try {
      const list = await loadPrograms();
      if (started > S.lastSaveAt && !S.outbox.length && !S.flushing && applyPrograms(list)) renderAll();
    } catch (e) { /* the full refresh shows errors */ }
    finally { S.progLoading = false; }
  }

  const ROW_SIG = ['cat', 'status', 'onTime', 'from', 'to', 'cur', 'item', 'remarks', 'driver', 'phone', 'caller', 'callTime', 'nextProgram'];
  function markChanged(old) {
    const now = Date.now();
    let n = 0;
    S.vehicles.forEach(v => {
      const o = old[v.vno];
      if (!o || ROW_SIG.some(k => o[k] !== v[k])) { S.changedAt[v.vno] = now; n++; }
    });
    S.lastChangeCount = n;
  }
  function recentlyChanged(v) { return Date.now() - (S.changedAt[v.vno] || 0) < CHANGE_MARK_MS; }
  function flashCls(v) { return Date.now() - (S.changedAt[v.vno] || 0) < 8000 ? ' flash' : ''; }

  function setSync() {
    const b = $('#syncBtn'), t = $('#syncText');
    b.classList.remove('ok', 'err', 'loading');
    if (S.loading) {
      b.classList.add(S.vehicles.length && !S.sheetError ? 'ok' : 'loading', 'checking');
      if (S.manual || !S.vehicles.length || S.fromCache) { b.classList.add('loading'); t.textContent = 'Updating…'; }
      return;
    }
    b.classList.remove('checking');
    if (S.sheetError) { b.classList.add('err'); t.textContent = S.loadedAt ? 'Offline · ' + clock(new Date(S.loadedAt)) : 'Not loaded'; return; }
    b.classList.add('ok');
    t.innerHTML = '<span class="lv">Live · </span>' + clock(new Date(S.loadedAt));
    b.title = 'Connected to the Google Sheet — checked every ' + Math.round(REFRESH_MS / 1000) + ' seconds.\n' +
      'Calling Sheet ' + (S.dataDate ? prettyDate(S.dataDate) : '') +
      (S.sheetChangedAt ? ' · last change seen ' + clock(new Date(S.sheetChangedAt)) : '') + '\nClick to check now.';
  }

  /* keep checking the sheet; slow down while it keeps failing, pause while the tab is hidden */
  let pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    const wait = Math.min(300000, REFRESH_MS * Math.pow(2, Math.min(S.fails || 0, 4)));
    pollTimer = setTimeout(async () => {
      if (!document.hidden && navigator.onLine !== false) await refresh();
      schedulePoll();
    }, wait);
  }
  function refreshIfStale() {
    if (!document.hidden && Date.now() - S.loadedAt > 10000) refresh().then(schedulePoll);
  }

  function showBanner() {
    const el = $('#banner');
    let html = '', cls = '';
    if (S.sheetError) {
      cls = 'err';
      html = '<span><b>Could not load the Google Sheet:</b> ' + esc(S.sheetError) +
        (S.vehicles.length ? '. Showing the last loaded data' + (S.loadedAt ? ' (' + fmtStamp(todayKey(new Date(S.loadedAt)) + ' ' + pad(new Date(S.loadedAt).getHours()) + ':' + pad(new Date(S.loadedAt).getMinutes())) + ')' : '') + '.' : '.') + '</span>';
    } else if (S.progError) {
      cls = 'err';
      html = '<span><b>Programs could not be loaded:</b> ' + esc(S.progError) + '</span>';
    } else if (LOCAL && !sessionStorage.getItem(K.banner)) {
      html = '<span><b>Setup pending:</b> programs are saved only in this browser. Deploy <b>Code.gs</b> (see README) and paste its URL in <b>config.js</b> so the Director and all callers see the same programs.</span><button class="x" data-hide-banner aria-label="Hide">×</button>';
    }
    el.className = 'banner ' + cls;
    el.innerHTML = html;
    el.hidden = !html;
  }

  /* =====================================================================
   *  Filters
   * ===================================================================== */
  function matches(v, skipCats) {
    const f = S.f;
    if (v.cat === 'sold') return false;
    if (f.caller && v.callerName !== f.caller) return false;
    if (!skipCats && f.cats.size && !f.cats.has(v.cat)) return false;
    if (f.loc && v.where !== f.loc) return false;
    if (f.item && v.item !== f.item) return false;
    if (f.prog) {
      if (progState(v) !== f.prog) return false;
    }
    if (f.flags.size) {
      const fl = flagsOf(v);
      for (const k of f.flags) if (!fl[k]) return false;
    }
    if (f.q) {
      const p = S.active[v.vno];
      const hay = v.search + (p ? ' ' + norm(p.program + ' ' + p.broker + ' ' + p.goingTo) : '');
      const words = norm(f.q).split(' ');
      for (const w of words) if (w && !hay.includes(w.replace(/\s/g, ''))) return false;
    }
    return true;
  }
  const placeSort = (a, b) => (a.where || '~').localeCompare(b.where || '~') || a.vno.localeCompare(b.vno);

  function filterCount() {
    const f = S.f;
    return f.cats.size + (f.loc ? 1 : 0) + (f.item ? 1 : 0) + (f.prog ? 1 : 0) + f.flags.size;
  }

  /* =====================================================================
   *  Render — shared
   * ===================================================================== */
  function plate(vno, big) { return '<span class="plate' + (big ? ' big' : '') + '"><i></i><span>' + esc(vno) + '</span></span>'; }
  function catBadge(v) { const c = CAT[v.cat]; return '<span class="badge" style="--c:' + c.color + '">' + esc(c.label) + '</span>'; }
  function flagBadges(v) {
    const fl = flagsOf(v); let h = '';
    if (fl.upd) h += '<span class="badge upd" title="Changed in the Google Sheet">Updated ' + esc(clock(new Date(S.changedAt[v.vno]))) + '</span>';
    if (fl.late) h += '<span class="badge late">Late</span>';
    if (fl.stale) h += '<span class="badge stale">Last call ' + esc(prettyDate(v.dateKey)) + '</span>';
    return h;
  }
  function driverHtml(v) {
    if (!v.driver && !v.phoneDigits) return '<span class="nodrv">No driver details</span>';
    return '<span class="drv"><b>' + esc(v.driver || 'Driver') + '</b>' + (v.driverId ? '<span class="muted">' + esc(v.driverId) + '</span>' : '') + '</span>' +
      (v.phoneDigits ? '<a class="call" href="tel:+91' + v.phoneDigits + '" title="Call ' + esc(v.driver) + '">' + esc(v.phoneDigits) + '</a>' +
        '<a class="wa" href="' + esc(waLink(v)) + '" target="_blank" rel="noopener" title="WhatsApp ' + esc(v.driver || 'driver') + '" aria-label="WhatsApp"></a>' : '');
  }
  /** WhatsApp chat with the driver, message already typed (program included when there is one).
   *  Phones open the WhatsApp app; computers open WhatsApp Web straight in that chat. */
  const IS_PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  function waLink(v, prog) {
    const p = prog || S.active[v.vno];
    const text = '*' + COMPANY.toUpperCase() + '*' + (v.driver ? '\nDriver: ' + v.driver : '') + '\nVehicle: *' + v.vno + '*' +
      (p && p.program ? '\n' + (v.cat === 'unloading' ? 'Next Loading' : 'Program') + ': *' + p.program + '*' : '');
    return IS_PHONE
      ? 'https://wa.me/91' + v.phoneDigits + '?text=' + encodeURIComponent(text)
      : 'https://web.whatsapp.com/send?phone=91' + v.phoneDigits + '&text=' + encodeURIComponent(text);
  }
  function progPill(v) {
    const st = progState(v), p = S.active[v.vno];
    if (st === 'informed') return '<div class="vr-prog informed">✓ Program: <b>' + esc(p.program) + '</b>' + (p.broker ? ' (' + esc(p.broker) + ')' : '') + ' · driver informed' + (p.informedBy ? ' by ' + esc(p.informedBy) : '') + '</div>';
    if (st === 'given') return '<div class="vr-prog given">📋 Program: <b>' + esc(p.program) + '</b>' + (p.broker ? ' (' + esc(p.broker) + ')' : '') + ' · <b>driver not told yet</b></div>';
    if (st === 'need') return '<div class="vr-prog need">' + (v.cat === 'unloading' ? 'Next load not given yet' : 'No program yet — waiting for Director') + '</div>';
    return '';
  }
  function vrowHtml(v, showCat) {
    const c = CAT[v.cat];
    const fl = flagsOf(v);
    const meta = '<span class="tag-caller">' + esc(v.callerName) + '</span>' +
      (v.callTime ? '<span title="Call time">' + esc(shortTime(v.callTime)) + '</span>' : '') +
      (fl.due ? '<span class="badge due" title="Follow-up time passed">Follow-up ' + esc(shortTime(v.followUp)) + '</span>' : '');
    return '<article class="vrow' + flashCls(v) + '" tabindex="0" data-v="' + esc(v.vno) + '" style="--c:' + c.color + '">' +
      '<div class="vr-a vr-plate">' + plate(v.vno) + (showCat ? catBadge(v) : '') + flagBadges(v) + '</div>' +
      '<div class="vr-what vr-what-wrap">' + doingHtml(v) + '</div>' +
      '<div class="vr-b">' + driverHtml(v) + '</div>' +
      '<div class="vr-remark">' + esc(v.remarks) + '</div>' +
      '<div class="vr-c">' + meta + '</div>' +
      progPill(v) +
      '</article>';
  }

  function callerChipsHtml() {
    const all = S.vehicles.filter(v => v.cat !== 'sold');
    const count = {};
    all.forEach(v => { count[v.callerName] = (count[v.callerName] || 0) + 1; });
    const names = S.callers.slice();
    if (count.Unassigned) names.push('Unassigned');
    let h = '<button type="button" class="caller-chip' + (!S.f.caller ? ' on' : '') + '" data-caller="">All callers <span class="n">' + all.length + '</span></button>';
    names.forEach(n => {
      h += '<button type="button" class="caller-chip' + (S.f.caller === n ? ' on' : '') + (S.user === n ? ' me' : '') + '" data-caller="' + esc(n) + '">' +
        esc(n) + ' <span class="n">' + (count[n] || 0) + '</span></button>';
    });
    return h;
  }

  function renderAll() {
    if (editingNow()) { S.pending = true; return; }
    S.pending = false;
    const chips = callerChipsHtml();
    $('#callerChips').innerHTML = chips;
    $('#callerChips2').innerHTML = chips;
    renderBadges();
    renderUser();
    if (S.view === 'board') renderBoard();
    else if (S.view === 'programs') renderPrograms();
    else if (S.view === 'print') renderPrint();
    if (S.detail) renderDetail();
  }

  function renderBadges() {
    const n = S.vehicles.filter(v => v.cat !== 'sold' && (!S.f.caller || v.callerName === S.f.caller))
      .filter(v => { const st = progState(v); return st === 'need' || st === 'given'; }).length;
    $$('[data-badge]').forEach(b => { b.textContent = n; b.hidden = !n; });
  }
  function renderUser() {
    $('#userName').textContent = S.user || 'Who?';
    $('#userInitial').textContent = (S.user || '?').trim().charAt(0).toUpperCase();
    $('#userBtn').title = (S.user ? S.user + ' — ' : '') + 'change user';
  }

  /* =====================================================================
   *  Board
   * ===================================================================== */
  function renderFilters() {
    const f = S.f;
    $('#catChips').innerHTML = CATS.map(c => '<button type="button" class="chip' + (f.cats.has(c.key) ? ' on' : '') + '" data-cat="' + c.key + '" style="--c:' + c.color + '"><span class="sw"></span>' + esc(c.label) + '</button>').join('');
    const scope = S.vehicles.filter(v => v.cat !== 'sold' && (!f.caller || v.callerName === f.caller));
    const locCount = {}, itemCount = {};
    scope.forEach(v => { if (v.where) locCount[v.where] = (locCount[v.where] || 0) + 1; if (v.item) itemCount[v.item] = (itemCount[v.item] || 0) + 1; });
    const opt = (obj, sel, all) => '<option value="">' + all + '</option>' + Object.keys(obj).sort().map(k => '<option value="' + esc(k) + '"' + (k === sel ? ' selected' : '') + '>' + esc(k) + ' (' + obj[k] + ')</option>').join('') +
      (sel && !obj[sel] ? '<option value="' + esc(sel) + '" selected>' + esc(sel) + ' (0)</option>' : '');
    $('#fLoc').innerHTML = opt(locCount, f.loc, 'All locations');
    $('#fItem').innerHTML = opt(itemCount, f.item, 'All items');
    $('#fProg').value = f.prog;
    $$('[data-flag]').forEach(b => b.classList.toggle('on', f.flags.has(b.dataset.flag)));
    const n = filterCount();
    $('#filterCount').textContent = n; $('#filterCount').hidden = !n;
  }

  function renderBoard() {
    // nothing changed since the last drawing → keep it (switching tabs stays instant on slow phones)
    const f = S.f;
    const key = [S.ver, f.caller, f.q, [...f.cats].join(), f.loc, f.item, f.prog, [...f.flags].join(), S.group,
      S.sort.key, S.sort.dir, S.vehicles.length || S.loading, S.sheetError, S.user].join('|');
    if (key === S.boardKey) return;
    S.boardKey = key;
    renderFilters();
    $('#groupBy').value = S.group;
    const list = $('#boardList');
    if (!S.vehicles.length) {
      $('#kpis').innerHTML = '';
      $('#resultLine').innerHTML = '';
      list.innerHTML = S.loading || !S.loadedAt && !S.sheetError
        ? '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'
        : '<div class="empty"><b>No vehicles loaded</b>' + esc(S.sheetError || 'The Calling Sheet is empty.') + '</div>';
      return;
    }
    const base = S.vehicles.filter(v => matches(v, true));
    const counts = {};
    base.forEach(v => { counts[v.cat] = (counts[v.cat] || 0) + 1; });
    $('#kpis').innerHTML = '<button type="button" class="kpi total' + (!S.f.cats.size ? ' on' : '') + '" data-kpi="" style="--c:var(--orange)"><span class="k-lbl">Total vehicles</span><span class="k-n">' + base.length + '</span></button>' +
      CATS.map(c => '<button type="button" class="kpi' + (S.f.cats.has(c.key) ? ' on' : '') + (counts[c.key] ? '' : ' zero') + '" data-kpi="' + c.key + '" style="--c:' + c.color + '"><span class="k-lbl">' + esc(c.label) + '</span><span class="k-n">' + (counts[c.key] || 0) + '</span></button>').join('');

    const vs = base.filter(v => !S.f.cats.size || S.f.cats.has(v.cat));
    const bits = [];
    if (S.f.caller) bits.push('caller <b>' + esc(S.f.caller) + '</b>');
    if (S.f.cats.size) bits.push([...S.f.cats].map(k => CAT[k].label).join(', '));
    if (S.f.loc) bits.push('at ' + esc(S.f.loc));
    if (S.f.item) bits.push(esc(S.f.item));
    if (S.f.q) bits.push('“' + esc(S.f.q) + '”');
    const anyFilter = S.f.caller || filterCount() || S.f.q;
    $('#resultLine').innerHTML = 'Showing <b>' + vs.length + '</b> vehicle' + (vs.length === 1 ? '' : 's') + (bits.length ? ' · ' + bits.join(' · ') : '') +
      (S.dataDate ? ' · Calling Sheet <b>' + prettyDate(S.dataDate) + '</b>' : '') +
      (anyFilter ? ' <button type="button" class="btn link sm" data-clear-all>Clear filters</button>' : '');

    if (!vs.length) { list.innerHTML = '<div class="empty"><b>No vehicle matches</b>Change the caller, search or filters.</div>'; return; }

    if (S.group === 'table') { list.innerHTML = tableHtml(vs); return; }

    let groups = [];
    if (S.group === 'status') {
      CATS.forEach(c => { const g = vs.filter(v => v.cat === c.key).sort(placeSort); if (g.length) groups.push({ key: c.key, title: c.label, color: c.color, items: g, showCat: false }); });
    } else if (S.group === 'location') {
      const by = {};
      vs.forEach(v => { const k = v.where || 'Location not written'; (by[k] = by[k] || []).push(v); });
      groups = Object.keys(by).sort((a, b) => by[b].length - by[a].length || a.localeCompare(b))
        .map(k => ({ key: k, title: k, color: 'var(--navy-3)', items: by[k].sort((a, b) => CAT[a.cat].i - CAT[b.cat].i || a.vno.localeCompare(b.vno)), showCat: true,
          sub: summaryLine(by[k]) }));
    } else {
      const order = S.callers.concat(['Unassigned']);
      order.forEach(n => { const g = vs.filter(v => v.callerName === n).sort((a, b) => CAT[a.cat].i - CAT[b.cat].i || placeSort(a, b)); if (g.length) groups.push({ key: n, title: n, color: 'var(--orange)', items: g, showCat: true, sub: summaryLine(g) }); });
    }
    list.innerHTML = groups.map(g => {
      const id = S.group + ':' + g.key;
      return '<section class="group' + (S.closed.has(id) ? ' closed' : '') + '">' +
        '<button type="button" class="g-head" data-group="' + esc(id) + '" style="--c:' + g.color + '"><span class="sw"></span><h3>' + esc(g.title) + '</h3><span class="n">' + g.items.length + '</span>' +
        (g.sub ? '<span class="g-sub">' + g.sub + '</span>' : '') + ICO.chev + '</button>' +
        '<div class="g-body">' + g.items.map(v => vrowHtml(v, g.showCat)).join('') + '</div></section>';
    }).join('');
  }

  function summaryLine(vs) {
    const c = {};
    vs.forEach(v => { c[v.cat] = (c[v.cat] || 0) + 1; });
    return CATS.filter(x => c[x.key]).map(x => esc(x.label) + ' ' + c[x.key]).join(' · ');
  }

  const TCOLS = [
    { k: 'vno', t: 'Vehicle', v: v => v.vno, h: v => '<b>' + esc(v.vno) + '</b>', cls: 'nowrap' },
    { k: 'cat', t: 'Status', v: v => CAT[v.cat].i, h: v => catBadge(v) + (v.late ? ' <span class="badge late">Late</span>' : ''), cls: 'nowrap' },
    { k: 'where', t: 'Now at', v: v => v.where, h: v => '<b>' + esc(v.where) + '</b>' },
    { k: 'from', t: 'From', v: v => v.from },
    { k: 'to', t: 'To', v: v => v.to },
    { k: 'item', t: 'Item', v: v => v.item },
    { k: 'driver', t: 'Driver', v: v => v.driver },
    { k: 'phone', t: 'Phone', v: v => v.phoneDigits, h: v => v.phoneDigits ? '<a class="call" href="tel:+91' + v.phoneDigits + '">' + v.phoneDigits + '</a> <a class="wa" href="' + esc(waLink(v)) + '" target="_blank" rel="noopener" aria-label="WhatsApp"></a>' : '', cls: 'nowrap' },
    { k: 'callerName', t: 'Caller', v: v => v.callerName },
    { k: 'callTime', t: 'Call', v: v => timeMin(v.callTime) || 0, h: v => esc(shortTime(v.callTime)), cls: 'nowrap' },
    { k: 'remarks', t: 'Remarks', v: v => v.remarks, cls: 'rem' },
    { k: 'prog', t: 'Program', v: v => { const p = S.active[v.vno]; return p ? p.program : ''; },
      h: v => { const p = S.active[v.vno]; if (!p || !p.program) return NEEDS_PROGRAM[v.cat] ? '<span class="badge warn">Needed</span>' : ''; return esc(p.program) + (p.informed === 'Yes' ? ' <span class="badge" style="--c:#15803d">Told</span>' : ' <span class="badge warn">Not told</span>'); } }
  ];
  function tableHtml(vs) {
    const col = TCOLS.find(c => c.k === S.sort.key) || TCOLS[1];
    const dir = S.sort.dir;
    const sorted = vs.slice().sort((a, b) => {
      const x = col.v(a), y = col.v(b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x || '~').localeCompare(String(y || '~'));
      return r * dir || placeSort(a, b);
    });
    return '<div class="table-wrap"><table class="vt"><thead><tr>' +
      TCOLS.map(c => '<th data-sort="' + c.k + '" class="' + (c.k === col.k ? 'sorted' : '') + '">' + c.t + '<span class="ar">' + (c.k === col.k ? (dir > 0 ? '▲' : '▼') : '↕') + '</span></th>').join('') +
      '</tr></thead><tbody>' +
      sorted.map(v => '<tr class="' + flashCls(v) + '" data-v="' + esc(v.vno) + '">' + TCOLS.map(c => '<td class="' + (c.cls || '') + '">' + (c.h ? c.h(v) : esc(c.v(v))) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  /* =====================================================================
   *  Programs view
   * ===================================================================== */
  const PSEGS = [
    { k: 'noprog', t: 'No Program', hint: 'No Program vehicles without a program. Director: write where the vehicle should go / load from and tap “Give program”.' },
    { k: 'unloading', t: 'Unloading', hint: 'Unloading vehicles without a next load. Director: write the next load and tap “Give program”.' },
    { k: 'call', t: 'Call driver', hint: 'Program given — caller: call the driver, tell the program, then tap “Yes, told”.' },
    { k: 'done', t: 'Driver informed', hint: 'The driver has been told the program.' },
    { k: 'all', t: 'All', hint: 'Every No Program / Unloading vehicle and every vehicle with a program.' }
  ];
  function progBuckets() {
    const vs = S.vehicles.filter(v => v.cat !== 'sold' && (!S.f.caller || v.callerName === S.f.caller) && (NEEDS_PROGRAM[v.cat] || S.active[v.vno]));
    const b = { noprog: [], unloading: [], call: [], done: [], all: vs };
    vs.forEach(v => {
      const st = progState(v);
      if (st === 'need') b[v.cat].push(v);
      else if (st === 'given') b.call.push(v);
      else if (st === 'informed') b.done.push(v);
    });
    const ord = v => (v.cat === 'noprog' ? 0 : v.cat === 'unloading' ? 1 : 2);
    Object.keys(b).forEach(k => b[k].sort((x, y) => ord(x) - ord(y) || placeSort(x, y)));
    return b;
  }
  function renderPrograms() {
    const key = [S.ver, S.pseg, S.pq, S.f.caller, JSON.stringify(S.editing), S.vehicles.length, S.user].join('|');
    if (key === S.progKey) return;
    S.progKey = key;
    const b = progBuckets();
    $('#progSeg').innerHTML = PSEGS.map(s => '<button type="button" role="tab" data-pseg="' + s.k + '" class="' + (S.pseg === s.k ? 'on' : '') + '">' + s.t + ' <span class="n">' + b[s.k].length + '</span></button>').join('');
    const seg = PSEGS.find(s => s.k === S.pseg) || PSEGS[0];
    $('#progHint').textContent = seg.hint;
    const list = $('#progList');
    if (!S.vehicles.length) { list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'; return; }
    let vs = b[seg.k];
    if (S.pq) { const q = norm(S.pq); vs = vs.filter(v => (v.search + ' ' + norm((S.active[v.vno] || {}).program)).includes(q)); }
    if (!vs.length) {
      const msg = { noprog: 'Every No Program vehicle has a program 👍', unloading: 'Every Unloading vehicle has a next load 👍', call: 'No driver is waiting to be called.', done: 'No driver informed yet.', all: 'No vehicle here.' }[seg.k];
      list.innerHTML = '<div class="empty"><b>' + msg + '</b>' + (S.f.caller ? 'Caller: ' + esc(S.f.caller) : 'All callers') + '</div>';
      return;
    }
    if (seg.k === 'noprog' || seg.k === 'unloading') { list.innerHTML = vs.map(pcardHtml).join(''); return; }
    // mixed lists: No Program and Unloading shown in their own sections
    const groups = [['noprog', 'No Program'], ['unloading', 'Unloading'], ['', 'Other status']];
    list.innerHTML = groups.map(g => {
      const part = vs.filter(v => (g[0] ? v.cat === g[0] : !NEEDS_PROGRAM[v.cat]));
      if (!part.length) return '';
      return '<h3 class="prog-sec" style="--c:' + (g[0] ? CAT[g[0]].color : 'var(--navy-3)') + '"><span class="sw"></span>' + g[1] + ' <span class="n">' + part.length + '</span></h3>' +
        part.map(pcardHtml).join('');
    }).join('');
  }
  function pcardHtml(v) {
    const c = CAT[v.cat];
    return '<article class="pcard' + flashCls(v) + '" data-card="' + esc(v.vno) + '" style="--c:' + c.color + '">' +
      '<div class="pc-top">' + plate(v.vno) + catBadge(v) + flagBadges(v) + '<span class="tag-caller">' + esc(v.callerName) + '</span></div>' +
      '<div class="pc-where">' + doingHtml(v) + '</div>' +
      '<div class="pc-line">' + driverHtml(v) + '</div>' +
      (v.remarks ? '<div class="pc-remark">“' + esc(v.remarks) + '”</div>' : '') +
      progEditor(v) +
      '</article>';
  }

  /** Program box — used on program cards and in the vehicle detail */
  function progEditor(v) {
    const p = S.active[v.vno];
    const d = S.drafts[v.vno] || {};
    const has = !!(p && p.program);
    const editing = !has || S.editing[v.vno];
    let h = '<div class="pg' + (editing ? ' editing' : '') + (S.saving[v.vno] ? ' busy' : '') + '" data-v="' + esc(v.vno) + '">';
    if (!editing) {
      const ok = p.informed === 'Yes';
      h += '<div class="pg-given' + (ok ? ' ok' : '') + '">' +
        '<span class="pg-lbl">' + (v.cat === 'unloading' ? 'Next load program' : 'Program') + '</span>' +
        '<div class="pg-text">' + esc(p.program) + '</div>' +
        (p.broker ? '<div class="pg-meta">Broker / Party: <b>' + esc(p.broker) + '</b></div>' : '') +
        '<div class="pg-meta">Given by <b>' + esc(p.givenBy || '—') + '</b>' + (p.givenAt ? ' · ' + esc(fmtStamp(p.givenAt)) : '') +
        ' <button type="button" class="btn link sm" data-act="edit">Change</button></div></div>' +
        (v.phoneDigits ? '<a class="btn wa-send" href="' + esc(waLink(v)) + '" target="_blank" rel="noopener">' + ICO.wa + 'Send program on WhatsApp</a>' : '') +
        '<div class="inform"><div class="q">Driver ko bataya? <span class="muted">(Driver informed?)</span></div>' +
        '<div class="yn"><button type="button" class="yes' + (ok ? ' on' : '') + '" data-act="inform" data-val="Yes">' + ICO.check + 'Yes, told</button>' +
        '<button type="button" class="no' + (p.informed === 'No' ? ' on' : '') + '" data-act="inform" data-val="No">Not yet</button></div>' +
        (ok ? '<div class="pg-meta">Told by <b>' + esc(p.informedBy || '—') + '</b>' + (p.informedAt ? ' · ' + esc(fmtStamp(p.informedAt)) : '') + '</div>' : '') +
        '</div>';
    } else {
      const progVal = d.program != null ? d.program : (p && p.program) || '';
      const brokerVal = d.broker != null ? d.broker : (p && p.broker) || '';
      h += '<label class="field"><span class="pg-lbl">' + (v.cat === 'unloading' ? 'Next load program' : 'Program') + ' <span class="hi">— where to go / load from</span></span>' +
        '<input data-f="program" list="locList" value="' + esc(progVal) + '" autocomplete="off"></label>' +
        '<label class="field"><span class="pg-lbl">Broker / Party <span class="hi">(optional)</span></span>' +
        '<input data-f="broker" value="' + esc(brokerVal) + '" autocomplete="off"></label>' +
        '<div class="pg-actions"><button type="button" class="btn primary" data-act="give">' + ICO.check + 'Give program</button>' +
        (v.phoneDigits ? '<button type="button" class="btn wa-give" data-act="give-wa" title="Give the program and send it to the driver on WhatsApp">' + ICO.wa + '<span>Give + WhatsApp</span></button>' : '') +
        (has ? '<button type="button" class="btn" data-act="cancel">Cancel</button><button type="button" class="btn link sm" data-act="remove">Remove program</button>' : '') +
        '</div>';
    }
    return h + '</div>';
  }

  function editingNow() {
    const a = document.activeElement;
    return !!(a && a.matches && a.matches('.pg [data-f]'));
  }

  /** Saves at once on screen (and in prints); the Google Sheet is written in the background
   *  (outbox kept in this browser, retried until it goes through). */
  async function saveProgram(vno, patch, okMsg) {
    if (!S.user) { const u = await askWho(); if (!u) return false; }
    const v = S.byVno[vno];
    const body = Object.assign({
      vno: vno, caller: v ? v.caller : '', cat: v ? CAT[v.cat].label : '', loc: v ? v.where : '', user: S.user
    }, patch);
    if (LOCAL) {
      const rec = Local.save(Object.assign({ id: S.active[vno] ? S.active[vno].id : '' }, body));
      upsertProgram(rec);
    } else {
      const cur = S.active[vno];
      const rec = cur ? Object.assign({}, cur) : {
        id: 'tmp-' + Date.now().toString(36), date: todayKey(), vno: vno, caller: '', cat: '', loc: '', program: '', broker: '',
        givenBy: '', givenAt: '', informed: '', informedBy: '', informedAt: '', goingTo: '', note: '', updatedBy: '', updatedAt: ''
      };
      applyPatch(rec, body, nowStr());
      upsertProgram(rec);
      S.outbox.push({ vno: vno, body: body });
      store.set(K.outbox, S.outbox);
      flushOutbox();
    }
    computeActive();
    toast(okMsg || 'Saved');
    return true;
  }
  function upsertProgram(rec) {
    const i = S.programs.findIndex(p => p.id === rec.id);
    if (i >= 0) S.programs[i] = rec; else S.programs.push(rec);
  }

  /** Sends waiting saves one by one, in order. */
  async function flushOutbox() {
    if (S.flushing || !S.outbox.length) return;
    S.flushing = true; setSaveState();
    try {
      while (S.outbox.length) {
        const job = S.outbox[0];
        const a = S.active[job.vno];
        const id = a && !/^tmp-/.test(a.id) ? a.id : ''; // server also reuses today's row of the vehicle
        let srv;
        try {
          srv = (await api('saveProgram', Object.assign({}, job.body, { id: id }))).program;
        } catch (e) {
          S.outboxError = e.message || 'Could not save';
          setSaveState();
          clearTimeout(S.retryTimer);
          S.retryTimer = setTimeout(flushOutbox, 8000);
          return;
        }
        S.outbox.shift();
        store.set(K.outbox, S.outbox);
        S.outboxError = '';
        const local = S.programs.find(p => p.vno === job.vno && (p.id === srv.id || /^tmp-/.test(p.id)));
        if (S.outbox.some(j => j.vno === job.vno)) { if (local) local.id = srv.id; } // newer local change still to send
        else {
          S.programs = S.programs.filter(p => !(p.vno === job.vno && (p.id === srv.id || /^tmp-/.test(p.id))));
          S.programs.push(srv);
          computeActive();
        }
      }
    } finally {
      S.flushing = false;
      S.lastSaveAt = Date.now();
      setSaveState();
    }
  }
  /** "Saving…" / "Not saved yet" note in the header while the outbox is not empty */
  function setSaveState() {
    const n = S.outbox.length;
    const el = $('#saveState');
    el.hidden = !n;
    el.className = 'save-state' + (S.outboxError ? ' err' : '');
    el.textContent = !n ? '' : S.outboxError ? n + ' not saved yet — retrying…' : 'Saving to sheet…';
    el.title = S.outboxError || 'Programs are being written to the Google Sheet';
  }

  async function onProgAction(btn) {
    const box = btn.closest('.pg'); const vno = box.dataset.v;
    const act = btn.dataset.act;
    const d = S.drafts[vno] = S.drafts[vno] || {};
    $$('[data-f]', box).forEach(i => { d[i.dataset.f] = i.value; });
    let ok = true;
    if (act === 'edit') { S.editing[vno] = true; }
    else if (act === 'cancel') { S.editing[vno] = false; delete d.program; delete d.broker; }
    else if (act === 'give' || act === 'give-wa') {
      const program = String(d.program || '').trim(), broker = String(d.broker || '').trim();
      if (!program) { toast('Write the program first (where to go / load from)', true); const i = $('[data-f="program"]', box); if (i) i.focus(); return; }
      // WhatsApp has to open right inside the tap (before any waiting), or the browser blocks the new tab
      const sendNow = act === 'give-wa' && S.user && S.byVno[vno];
      if (sendNow) window.open(waLink(S.byVno[vno], { program: program, broker: broker }), '_blank', 'noopener');
      ok = await saveProgram(vno, { program: program, broker: broker },
        sendNow ? 'Program saved — WhatsApp opened, press Send there' : act === 'give-wa' ? 'Program saved — now tap “Send program on WhatsApp”' : 'Program saved — now call the driver');
      if (ok) { S.editing[vno] = false; delete d.program; delete d.broker; }
    } else if (act === 'remove') {
      if (!confirm('Remove the program of ' + vno + '?')) return;
      ok = await saveProgram(vno, { program: '', broker: '' }, 'Program removed');
      if (ok) { S.editing[vno] = false; delete d.program; delete d.broker; }
    } else if (act === 'inform') {
      ok = await saveProgram(vno, { informed: btn.dataset.val }, btn.dataset.val === 'Yes' ? 'Marked: driver informed ✓' : 'Marked: driver not told yet');
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    renderAll();
  }

  /* =====================================================================
   *  Vehicle detail
   * ===================================================================== */
  function openDetail(vno) {
    if (!S.byVno[vno]) return;
    const wasOpen = !!S.detail;
    S.detail = vno;
    renderDetail();
    const ov = $('#sheetOverlay');
    ov.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
    setTimeout(() => ov.classList.add('show'), 60);
    if (!wasOpen) try { history.pushState({ vpt: 'sheet' }, ''); } catch (e) { /* ignore */ }
  }
  function closeDetail(fromPop) {
    if (!S.detail) return;
    if (S.editing[S.detail]) { delete S.editing[S.detail]; delete S.drafts[S.detail]; } // closed without saving
    S.detail = null;
    const ov = $('#sheetOverlay');
    ov.classList.remove('show');
    setTimeout(() => { if (!S.detail) ov.hidden = true; }, 200);
    if (!fromPop && history.state && history.state.vpt === 'sheet') history.back();
  }
  function renderDetail() {
    const v = S.byVno[S.detail];
    if (!v) { closeDetail(); return; }
    const c = CAT[v.cat], p = S.active[v.vno], d = doing(v);
    const kv = [
      ['Caller', v.callerName], ['Call time', shortTime(v.callTime)], ['Follow-up', shortTime(v.followUp)],
      ['Status', v.status + (v.onTime ? ' · ' + v.onTime : '')], ['From', v.from], ['To', v.to],
      ['Current location', v.cur], ['Item', v.item], ['Driver', v.driver], ['Driver ID', v.driverId], ['Phone', v.phone],
      ['Diesel', v.diesel], ['Route check', v.routeCheck], ['Remarks', v.remarks], ['Next program (sheet)', v.nextProgram],
      ['Sheet date', v.dateKey ? prettyDate(v.dateKey) : v.date]
    ].filter(x => String(x[1] || '').trim());
    const hist = S.programs.filter(x => x.vno === v.vno).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    $('#sheet').innerHTML =
      '<div class="sh-head">' + plate(v.vno, true) + '<span class="badge" style="--c:' + c.color + ';background:#fff">' + esc(c.label) + '</span>' + flagBadges(v) +
      '<button type="button" class="x" data-close aria-label="Close">' + ICO.x + '</button></div>' +
      '<div class="sh-body">' +
      '<div class="where-big" style="border-left:5px solid ' + c.color + '"><div class="lbl">Vehicle kaha hai · where is it now</div><div class="loc">' + esc(v.where || d.loc || '—') + '</div><div class="doing">' +
        esc(c.label + (v.from && v.to ? ' · ' + v.from + ' → ' + v.to : v.from ? ' · from ' + v.from : v.to ? ' · to ' + v.to : '') + (v.item ? ' · ' + v.item : '')) + '</div></div>' +
      (v.phoneDigits ? '<div class="quick"><a href="tel:+91' + v.phoneDigits + '" class="btn call-btn">' + ICO.phone + 'Call ' + esc((v.driver || 'driver').split(' ')[0]) + '</a>' +
        '<a href="' + esc(waLink(v)) + '" target="_blank" rel="noopener" class="btn wa-btn">' + ICO.wa + 'WhatsApp' + (p && p.program ? ' program' : '') + '</a></div>' : '') +
      '<div class="card"><h4>Program</h4>' + progEditor(v) + '</div>' +
      '<div class="card"><h4>Calling Sheet</h4><dl class="kv">' + kv.map(x => '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>').join('') + '</dl></div>' +
      (hist.length ? '<div class="card"><h4>Program history</h4><div class="hist">' + hist.map(x =>
        '<div class="hist-item">' + (x.program ? '<b>' + esc(x.program) + '</b>' : '<i>No program</i>') + (x.broker ? ' (' + esc(x.broker) + ')' : '') +
        '<br>Given by ' + esc(x.givenBy || '—') + (x.givenAt ? ' · ' + esc(fmtStamp(x.givenAt)) : '') +
        (x.informed === 'Yes' ? ' · <b style="color:var(--green)">told by ' + esc(x.informedBy) + ' ' + esc(fmtStamp(x.informedAt)) + '</b>' : x.program ? ' · <b style="color:var(--amber)">driver not told</b>' : '') +
        '</div>').join('') + '</div></div>' : '') +
      '</div>';
  }

  /* =====================================================================
   *  Who are you?
   * ===================================================================== */
  /* =====================================================================
   *  Pending calls — caller-wise, from the Dashboard tab of the Fleet sheet
   * ===================================================================== */
  const CALLS_MS = Math.max(20, Number(CFG.CALLS_REFRESH_SECONDS) || 60) * 1000;
  async function loadCalls() {
    if (!CFG.CALLS_SHEET_ID || S.callsLoading) return;
    S.callsLoading = true;
    try {
      const url = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(CFG.CALLS_SHEET_ID) + '/export?format=csv&gid=' + encodeURIComponent(CFG.CALLS_GID);
      const r = await fetchWithTimeout(url, { cache: 'no-store' }, 30000);
      const text = await r.text();
      if (!r.ok || /^\s*</.test(text)) throw new Error('Dashboard sheet is not shared (Anyone with the link: Viewer)');
      S.calls = parseCalls(parseCsv(text)); S.callsAt = Date.now(); S.callsError = '';
    } catch (e) {
      S.callsError = e.message || 'Could not load the Dashboard';
    } finally {
      S.callsLoading = false;
      renderCallsBtn();
      if (!$('#callsOverlay').hidden) renderCalls();
    }
  }
  /** caller → done / pending (table "CALLER-WISE") + vehicles / morning / evening (table "CALLING SHEET REPORT SUMMARY") */
  function parseCalls(grid) {
    const byName = {}, order = [];
    const num = s => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
    const row = name => { if (!byName[name]) { byName[name] = { name: name, total: 0, done: 0, pending: 0, morning: 0, evening: 0 }; order.push(name); } return byName[name]; };
    const table = has => {
      const h = grid.findIndex(r => normHead(r[0]) === 'caller' && has.every(x => r.map(normHead).includes(x)));
      if (h < 0) return null;
      const head = grid[h].map(normHead), rows = [];
      for (let i = h + 1; i < grid.length; i++) {
        const name = cleanCell(grid[i][0]);
        if (!name) break;
        rows.push(grid[i]);
        if (/^total$/i.test(name)) break;
      }
      return { col: k => head.indexOf(k), rows: rows };
    };
    const a = table(['calls done', 'calls pending']);
    if (a) a.rows.forEach(r => { const c = row(cleanCell(r[0])); c.done = num(r[a.col('calls done')]); c.pending = num(r[a.col('calls pending')]); });
    const b = table(['morning calls', 'evening calls']);
    if (b) b.rows.forEach(r => { const c = row(cleanCell(r[0])); c.total = num(r[b.col('total vehicle')]); c.morning = num(r[b.col('morning calls')]); c.evening = num(r[b.col('evening calls')]); });
    if (!a && !b) throw new Error('Caller-wise calls not found in the Dashboard tab');
    const all = order.map(n => byName[n]);
    const total = all.find(c => /^total$/i.test(c.name)) || null;
    const callers = all.filter(c => !/^total$/i.test(c.name) && (c.total || c.done || c.pending || c.morning || c.evening)); // leave out inactive callers
    return { callers: callers, total: total };
  }
  function pendingTotal() {
    if (!S.calls) return null;
    return S.calls.total ? S.calls.total.pending : S.calls.callers.reduce((n, c) => n + c.pending, 0);
  }
  function renderCallsBtn() {
    const b = $('#callsBtn');
    b.hidden = !CFG.CALLS_SHEET_ID;
    const n = pendingTotal();
    $('#callsCount').textContent = n == null ? '–' : n;
    b.classList.toggle('blink', !!n);   // blinks only while some call is pending
    b.classList.toggle('zero', n === 0);
    b.classList.toggle('nodata', n == null);
    b.title = n == null ? (S.callsError || 'Loading calls…') : n + ' call' + (n === 1 ? '' : 's') + ' pending — tap for caller-wise';
  }
  function renderCalls() {
    const body = $('#callsBody');
    $('#callsSub').textContent = S.callsAt ? 'From the Dashboard sheet · updated ' + clock(new Date(S.callsAt)) + ' · checks every ' + Math.round(CALLS_MS / 1000) + ' s' : 'Loading…';
    if (!S.calls) { body.innerHTML = '<div class="empty">' + esc(S.callsError || 'Loading…') + '</div>'; return; }
    const cell = (v, cls) => '<td class="' + (cls || '') + '">' + v + '</td>';
    const line = (c, isTotal) => '<tr class="' + (isTotal ? 'tot' : '') + (c.name === S.user ? ' me' : '') + (c.pending ? ' has-pend' : '') + '">' +
      '<td class="nm">' + esc(c.name) + '</td>' + cell(c.total) + cell(c.done) +
      cell(c.pending ? '<span class="pend blink">' + c.pending + '</span>' : '<span class="ok">0 ✓</span>') +
      cell(c.morning) + cell(c.evening) + '</tr>';
    body.innerHTML = '<div class="calls-wrap"><table class="calls-table"><thead><tr><th>Caller</th><th>Vehicles</th><th>Calls done</th><th>Pending</th><th>Morning</th><th>Evening</th></tr></thead><tbody>' +
      S.calls.callers.map(c => line(c)).join('') + '</tbody>' + (S.calls.total ? '<tfoot>' + line(S.calls.total, true) + '</tfoot>' : '') + '</table></div>' +
      (S.callsError ? '<p class="muted">Last update failed: ' + esc(S.callsError) + '</p>' : '');
  }
  function openCalls() {
    renderCalls();
    const ov = $('#callsOverlay');
    ov.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
    setTimeout(() => ov.classList.add('show'), 60);
    if (Date.now() - (S.callsAt || 0) > 20000) loadCalls();
  }
  function closeCalls() {
    const ov = $('#callsOverlay');
    ov.classList.remove('show');
    setTimeout(() => { ov.hidden = true; }, 180);
  }

  let whoResolve = null;
  function openWho() {
    const names = (CFG.EXTRA_USERS || ['Director']).concat(S.callers);
    $('#whoList').innerHTML = names.map(n => '<button type="button" data-who="' + esc(n) + '" class="' + (S.user === n ? 'on' : '') + '">' + esc(n) +
      '<small>' + (S.callers.includes(n) ? 'Caller' : 'Office') + '</small></button>').join('');
    $('#whoInput').value = names.includes(S.user) ? '' : S.user;
    const ov = $('#whoOverlay');
    ov.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
    setTimeout(() => ov.classList.add('show'), 60);
  }
  function closeWho(name) {
    const ov = $('#whoOverlay');
    ov.classList.remove('show');
    setTimeout(() => { ov.hidden = true; }, 180);
    if (name) {
      const first = !S.user;
      S.user = name; store.set(K.user, name);
      if (S.callers.includes(name) && (first || !S.f.caller)) { S.f.caller = name; store.set(K.caller, name); }
      toast('Hello ' + name);
      renderAll();
    }
    if (whoResolve) { const r = whoResolve; whoResolve = null; r(name || ''); }
  }
  function askWho() { return new Promise(res => { whoResolve = res; openWho(); }); }

  /* =====================================================================
   *  Print
   * ===================================================================== */
  const REPORTS = {
    caller: { name: 'Caller wise', cats: CATS.map(c => c.key), orient: 'landscape', cols: 1, perCaller: true, printf: true,
      hint: 'Same layout as the sheet’s “printf” tab — one page per caller (“All callers” = every caller on its own page). Programs given on this website fill “Next Load” / “Program” (✓ = driver informed).' },
    un: { name: 'U&N — Unloading & No Program', cats: ['unloading', 'noprog'], orient: 'portrait', cols: 1, withCaller: true,
      hint: 'For the Director: all callers together on one page. “Next Load” shows the programs given on this website (✓ = driver informed); blank rows are for writing.' },
    lr: { name: 'L&R — Loading & Running', cats: ['loading', 'running', 'empty'], orient: 'portrait', cols: 2,
      pages: [{ cats: ['loading'], title: 'L&R — Loading' }, { cats: ['running', 'empty'], title: 'L&R — Running & Empty Running' }],
      hint: 'Page 1: Loading · Page 2: Running + Empty Running — all callers (or the caller you choose), each on one page.' },
    rh: { name: 'R&H — Repair & Halted', cats: ['repair', 'halted', 'loadnd', 'emergency', 'other'], orient: 'portrait', cols: 2,
      hint: 'Repair, Halted / No Driver, Load / No Driver, Emergency and Others on one page.' }
  };

  function placeKey(v) {
    switch (v.cat) {
      case 'loading': return v.from || v.cur;
      case 'unloading': return v.to || v.cur;
      case 'running': return (v.from || '?') + ' - ' + (v.to || '?');
      case 'empty': return v.cur || v.from;
      default: return v.cur;
    }
  }
  function progCell(v) {
    const p = S.active[v.vno];
    if (!p) return '';
    let s = '';
    if (p.program) s += esc(p.program) + (p.informed === 'Yes' ? ' <span class="ok">✓</span>' : '');
    return s;
  }
  function blockHtml(cat, list, rep, caller) {
    const c = CAT[cat];
    const withCaller = rep.withCaller && !caller;
    const rows = list.slice().sort((a, b) => (placeKey(a) || '~').localeCompare(placeKey(b) || '~') || a.vno.localeCompare(b.vno));
    const counter = {};
    const placeN = v => { const k = placeKey(v) || ''; if (!k) return ''; counter[k] = (counter[k] || 0) + 1; return esc(k) + ' (' + counter[k] + ')'; };
    let head, cells;
    switch (cat) {
      case 'loading': head = ['From Location', 'To / Item']; cells = v => [placeN(v), esc(v.to) + (v.item ? (v.to ? ' · ' : '') + esc(v.item) : '')]; break;
      case 'unloading': head = ['To Location', 'Item', 'Next Load']; cells = v => [placeN(v), esc(v.item), progCell(v)]; break;
      case 'running': head = ['Route', 'Current Location']; cells = v => [placeN(v), esc(v.cur)]; break;
      case 'empty': head = ['Current Location', 'From Location']; cells = v => [placeN(v), esc(v.from)]; break;
      case 'noprog': head = ['Current Location', 'Next Load', 'Broker']; cells = v => { const p = S.active[v.vno]; return [placeN(v), progCell(v), esc(p ? p.broker : '')]; }; break;
      case 'repair': head = ['Location', 'Reason']; cells = v => [esc(v.cur), esc(v.remarks)]; break;
      case 'halted': head = ['Location']; cells = v => [placeN(v)]; break;
      case 'emergency': head = ['Location', 'Reason']; cells = v => [esc(v.cur), esc(v.remarks)]; break;
      case 'other': head = ['Location', 'Status']; cells = v => [esc(v.cur), esc(v.status)]; break;
      default: head = ['Location']; cells = v => [esc(v.cur)];
    }
    if (withCaller) head = head.concat(['Caller']);
    const data = rows.map(v => { const cs = cells(v); return withCaller ? cs.concat([esc(v.callerName)]) : cs; });
    // drop columns that are empty for every vehicle — except Next Load / Broker, kept blank for writing by hand
    const keep = head.map((t, j) => t === 'Next Load' || t === 'Broker' || data.some(cs => String(cs[j]).trim()));
    const body = rows.map((v, i) => '<tr><td class="sr">' + (i + 1) + '.</td><td class="vn">' + esc(v.vno) + '</td>' +
      data[i].map((x, j) => keep[j] ? '<td' + (head[j] === 'Next Load' ? ' class="prog" data-edit="' + esc(v.vno) + '"' : head[j] === 'Broker' ? ' data-edit="' + esc(v.vno) + '"' : '') + '>' + x + '</td>' : '').join('') + '</tr>').join('');
    return '<div class="pblock" style="--c:' + c.color + '"><div class="pb-title"><span>' + esc(c.label) + '</span><span class="n">' + rows.length + '</span></div><table>' +
      '<thead><tr><th>#</th><th>Vehicle</th>' + head.map((x, j) => keep[j] ? '<th>' + x + '</th>' : '').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  /** part (optional): { cats, title } — one page of a report that is split over several pages */
  function pageHtml(rep, vs, caller, orient, cols, pageNo, pages, part) {
    const now = new Date();
    const cats = part ? part.cats : rep.cats;
    const by = {};
    vs.forEach(v => { (by[v.cat] = by[v.cat] || []).push(v); });
    const blocks = cats.filter(k => (by[k] || []).length).map(k => blockHtml(k, by[k], rep, caller)).join('');
    const total = cats.reduce((n, k) => n + (by[k] || []).length, 0);
    const sum = cats.map(k => '<span class="' + ((by[k] || []).length ? '' : 'z') + '">' + esc(CAT[k].label) + ' <b>' + (by[k] || []).length + '</b></span>').join('');
    const title = rep.perCaller ? 'Caller: ' + (caller || 'All') : (part ? part.title : rep.name) + (caller ? ' · Caller: ' + caller : '');
    return '<div class="page ' + orient + '" data-maxfs="16" data-name="' + esc(part ? part.title : rep.name) + (caller ? ' ' + esc(caller) : '') + '"><div class="page-inner">' +
      '<div class="ph"><img src="logo.webp" alt=""><div class="t"><b>DAMAN GROUP</b><span>' + esc(title) + '</span></div>' +
      '<div class="r">DATE: ' + pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear() + ' | TIME: ' + clock(now) + ' | ' + partOfDay(now) +
      '<br><span class="tot">TOTAL ' + total + '</span>' + (rep.perCaller ? '' : ' &nbsp;' + esc(rep.name.split(' — ')[0])) + '</div></div>' +
      '<div class="psum">' + sum + '</div>' +
      '<div class="pbody" style="column-count:' + cols + '">' + (blocks || '<p>No vehicles.</p>') + '</div>' +
      '<div class="pfoot"><span>' + esc(COMPANY) + ' · Vehicle Position Tracker · Calling Sheet ' + esc(S.dataDate ? prettyDate(S.dataDate) : '') +
      (S.loadedAt ? ', loaded ' + clock(new Date(S.loadedAt)) : '') + '</span><span>' + (pages > 1 ? 'Page ' + pageNo + ' / ' + pages : '') + '</span></div>' +
      '</div></div>';
  }

  /** Roboto is needed only for the printf-style print — loaded the first time Print is opened */
  function loadPrintFont() {
    if (S.printFont) return;
    S.printFont = true;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.crossOrigin = 'anonymous'; // lets JPG / PDF downloads copy the font
    l.href = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap';
    document.head.appendChild(l);
  }

  function renderPrint() {
    loadPrintFont();
    const P = S.print;
    const rep = REPORTS[P.rep] || REPORTS.caller;
    $$('#repSeg button').forEach(b => b.classList.toggle('on', b.dataset.rep === P.rep));
    const names = S.callers.concat(S.vehicles.some(v => !v.caller && v.cat !== 'sold') ? ['Unassigned'] : []);
    if (P.caller && !names.includes(P.caller)) P.caller = '';
    $('#repCaller').innerHTML = '<option value="">' + (rep.perCaller ? 'All callers (one page each)' : 'All callers') + '</option>' +
      names.map(n => '<option value="' + esc(n) + '"' + (P.caller === n ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    $('#repOrient').value = P.orient; $('#repCols').value = P.cols;
    $('#repHint').textContent = rep.hint;
    const area = $('#printArea');
    if (!S.vehicles.length) { area.innerHTML = '<div class="empty"><b>No data yet</b>Waiting for the Calling Sheet…</div>'; return; }

    const all = S.vehicles.filter(v => v.cat !== 'sold');
    let sets;
    if (rep.perCaller) sets = (P.caller ? [P.caller] : names).map(n => ({ caller: n, vs: all.filter(v => v.callerName === n) })).filter(s => s.vs.length);
    else sets = [{ caller: P.caller, vs: P.caller ? all.filter(v => v.callerName === P.caller) : all }];
    if (!sets.length) { area.innerHTML = '<div class="empty"><b>No vehicles</b>Nothing to print for this caller.</div>'; return; }
    $('#repCols').disabled = !!rep.printf;
    if (rep.printf) {
      loadRepairInfo();
      const o = P.orient === 'auto' ? rep.orient : P.orient;
      area.innerHTML = '<div class="pages">' + sets.map(s => printfPageHtml(s.vs, s.caller, o)).join('') + '</div>';
      setPageSize(o);
      fitPages();
      return;
    }
    if (rep.pages) { // e.g. L&R: page 1 Loading, page 2 Running + Empty Running
      const o = P.orient === 'auto' ? rep.orient : P.orient; // one paper orientation for the whole print
      const parts = rep.pages.map(pg => Object.assign({}, sets[0], { part: pg }));
      const lays = parts.map(s => chooseLayout(rep, [s], o));
      area.innerHTML = '<div class="pages">' + parts.map((s, i) => pageHtml(rep, s.vs, s.caller, o, lays[i].c, i + 1, parts.length, s.part)).join('') + '</div>';
      setPageSize(o);
      fitPages();
      return;
    }
    const lay = chooseLayout(rep, sets);
    area.innerHTML = '<div class="pages">' + sets.map((s, i) => pageHtml(rep, s.vs, s.caller, lay.o, lay.c, i + 1, sets.length)).join('') + '</div>';
    setPageSize(lay.o);
    fitPages();
    if (P.orient === 'auto' || P.cols === 'auto') {
      $('#repHint').textContent = rep.hint + ' Auto layout: ' + lay.o + ', ' + lay.c + ' column' + (lay.c > 1 ? 's' : '') + '.';
    }
  }

  /* ---------------- Caller wise = the sheet's "printf" tab ----------------
   * Left: LOADING, UNLOADING, REPAIR, EMERGENCY, OTHERS · Right: RUNNING (+WT.), EMPTY RUNNING,
   * NO DRIVER (load + halted), NO PROGRAM — one empty row between blocks, empty blocks left out. */
  const PF_FILL = { orange: '#f39c12', yellow: '#fcc202', navy: '#1f395f' };
  function printfBlocks(vs) {
    const by = {};
    vs.forEach(v => { (by[v.cat] = by[v.cat] || []).push(v); });
    const list = k => (by[k] || []).slice().sort((a, b) => (placeKey(a) || '~').localeCompare(placeKey(b) || '~') || a.vno.localeCompare(b.vno));
    const L = [], R = [];
    const add = (side, label, fill, heads, rows, edit) => { if (rows.length) side.push({ label: label, fill: fill, heads: heads, rows: rows, edit: !!edit }); };
    add(L, 'LOADING', 'orange', ['FROM LOCATION', ''], list('loading').map(v => [v.vno, esc(v.from), ''])); // 3rd column left blank (user asked)
    add(L, 'UNLOADING', 'orange', ['TO LOCATION (ITEM)', 'NEXT LOAD'], list('unloading').map(v => [v.vno, esc(v.to + (v.item ? ' (' + v.item + ')' : '')), progCell(v)]), true);
    add(L, 'REPAIR', 'yellow', ['LOCATION', 'REASON'], list('repair').map(v => {
      const r = S.repairInfo[v.vno] || {};
      const d = String(r.date || '').match(/^(\d{4})-(\d\d)-(\d\d)/);
      return [v.vno, esc(r.loc || v.cur), esc((r.reason || v.remarks) + (d ? ' [' + d[3] + '-' + MON[+d[2] - 1] + ']' : r.date ? ' [' + r.date + ']' : ''))];
    }));
    add(L, 'EMERGENCY', 'navy', ['LOCATION', ''], list('emergency').map(v => [v.vno, esc(v.cur), '']));
    add(L, 'OTHERS', 'orange', ['LOCATION', 'REMARKS / STATUS'], list('other').map(v => [v.vno, esc(v.cur), esc(v.status)]));
    add(R, 'RUNNING', 'yellow', ['ROUTE', 'CURRENT LOCATION'], list('running').map(v => [v.vno, esc((v.from || '') + ' - ' + (v.to || '')), esc(v.cur)]));
    add(R, 'EMPTY RUNNING', 'yellow', ['CURRENT LOCATION', 'FROM LOCATION'], list('empty').map(v => [v.vno, esc(v.cur), esc(v.from)]));
    add(R, 'NO DRIVER', 'orange', ['LOCATION', ''], list('loadnd').concat(list('halted')).map(v => [v.vno, esc(v.cur), '']));
    add(R, 'NO PROGRAM', 'yellow', ['CURRENT LOCATION', 'PROGRAM'], list('noprog').map(v => [v.vno, esc(v.cur), progCell(v)]), true);
    return { L: L, R: R };
  }
  /** one side of the sheet as rows of 3 cells */
  function printfSide(blocks, none) {
    if (!blocks.length) return [{ cells: [esc(none), '', ''], none: true }];
    const rows = [];
    blocks.forEach((b, i) => {
      if (i) rows.push({ cells: ['', '', ''] });
      rows.push({ head: b.fill, cells: [esc(b.label) + '<br>' + b.rows.length, esc(b.heads[0]), esc(b.heads[1])] });
      b.rows.forEach(r => rows.push({ cells: [esc(r[0]), r[1], r[2]], edit: b.edit ? r[0] : '' }));
    });
    return rows;
  }
  function printfPageHtml(vs, caller, orient) {
    const now = new Date(), h = now.getHours();
    const dk = S.dataDate || todayKey();
    const time = pad(h % 12 || 12) + ':' + pad(now.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
    const b = printfBlocks(vs);
    const left = printfSide(b.L, '-- No Active Loading/Unloading/Alerts --');
    const right = printfSide(b.R, '-- No Active Running / Transit --');
    const cell = (r, j) => {
      if (!r) return '<td></td>';
      if (r.edit && j === 2) return '<td class="pf-prog" data-edit="' + esc(r.edit) + '">' + r.cells[2] + '</td>';
      if (r.head) return j === 0 ? '<td class="pf-cat" style="background:' + PF_FILL[r.head] + (r.head === 'navy' ? ';color:#fff' : '') + '">' + r.cells[0] + '</td>' : '<td class="pf-hd">' + r.cells[j] + '</td>';
      return '<td' + (r.none && j === 0 ? ' class="pf-none"' : '') + '>' + r.cells[j] + '</td>';
    };
    let body = '';
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const l = left[i], r = right[i];
      body += '<tr>' + [0, 1, 2].map(j => cell(l, j)).join('') + [0, 1, 2].map(j => cell(r, j)).join('') +
        (i === 0 ? '<td class="pf-hd">WT.</td>' : '<td></td>') + '</tr>';
    }
    return '<div class="page ' + orient + '" data-maxfs="18" data-name="' + esc(caller || 'All') + '"><div class="page-inner"><table class="pf">' +
      '<colgroup><col style="width:10.5%"><col style="width:17.9%"><col style="width:19.2%"><col style="width:10.9%"><col style="width:20.9%"><col style="width:13.9%"><col style="width:6.7%"></colgroup>' +
      '<tr class="pf-top"><td colspan="3">CALLER: ' + esc(String(caller || 'ALL').toUpperCase()) + '</td>' +
      '<td colspan="4">DATE: ' + dk.slice(8, 10) + '/' + dk.slice(5, 7) + '/' + dk.slice(0, 4) + ' | TIME: ' + time + (h < 13 ? ' | MORNING' : h >= 15 ? ' | EVENING' : '') + '</td></tr>' +
      body + '</table></div></div>';
  }

  /** Repair date + reason come from the sheet's R&H tab (the Calling Sheet has no repair date). */
  async function loadRepairInfo() {
    if (S.repairLoading || Date.now() - S.repairAt < 180000 || !CFG.RH_GID) return;
    S.repairLoading = true;
    try {
      const url = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(CFG.SHEET_ID) + '/export?format=csv&gid=' + encodeURIComponent(CFG.RH_GID);
      const r = await fetchWithTimeout(url, { cache: 'no-store' }, 30000);
      const text = await r.text();
      if (!r.ok || /^\s*</.test(text)) throw new Error('R&H not readable');
      const grid = parseCsv(text), info = {};
      const start = grid.findIndex(row => /^repair\s*\(/i.test(String(row[0] || '').trim()));
      for (let i = start + 1; start >= 0 && i < grid.length; i++) {
        const m = String(grid[i][0] || '').match(/^\d+\.\s*([A-Z0-9]+)/i);
        if (!m) break;
        info[m[1].toUpperCase()] = { date: cleanCell(grid[i][1]), loc: up(grid[i][2]), reason: cleanCell(grid[i][3]) };
      }
      const changed = JSON.stringify(info) !== JSON.stringify(S.repairInfo);
      S.repairInfo = info; S.repairAt = Date.now();
      if (changed && S.view === 'print' && REPORTS[S.print.rep] && REPORTS[S.print.rep].printf) renderPrint();
    } catch (e) {
      S.repairAt = Date.now() - 120000; // try again in a minute; meanwhile Calling Sheet remarks are used
    } finally {
      S.repairLoading = false;
    }
  }

  /* ---------------- PDF / JPG downloads (the tools load only the first time they are used) ---------------- */
  const LIBS = {
    img: 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js',
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
  };
  const libLoads = {};
  function loadLib(url) {
    return libLoads[url] || (libLoads[url] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = url; s.async = true; s.onload = res;
      s.onerror = () => { delete libLoads[url]; rej(new Error('No internet — could not load the download tool')); };
      document.head.appendChild(s);
    }));
  }
  /** The page's fonts, fetched by the site itself and put inside the picture (Latin letters only).
   *  Without them the picture falls back to a wider font and the text runs into each other. */
  const FONT_CSS_URLS = [
    'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600;700&display=swap',
    'https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap'
  ];
  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function fontCss() {
    if (S.fontCss) return S.fontCss;
    const sheets = await Promise.all(FONT_CSS_URLS.map(u => fetch(u).then(r => { if (!r.ok) throw new Error('font'); return r.text(); })));
    const blocks = [];
    sheets.forEach(css => css.split(/(?=@font-face)/).forEach(b => {
      if (b.includes('@font-face') && (!/unicode-range/i.test(b) || /U\+0000-00FF/i.test(b))) blocks.push(b.replace(/\/\*[^*]*\*\//g, ''));
    }));
    const done = await Promise.all(blocks.map(async b => {
      const m = b.match(/url\((['"]?)(https:[^)'"]+)\1\)/);
      if (!m) return b;
      const buf = await (await fetch(m[2])).arrayBuffer();
      return b.replace(m[0], 'url(data:font/woff2;base64,' + toBase64(buf) + ')');
    }));
    S.fontCss = done.join('\n');
    return S.fontCss;
  }
  /** every print page as a JPEG, one after another (keeps memory low on phones) */
  async function pageImages(onEach) {
    const [, fonts] = await Promise.all([loadLib(LIBS.img), fontCss()]);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    renderPrint(); // lay the pages out again now that every font has loaded
    const pagesEl = $('#printArea .pages');
    const pages = pagesEl ? $$('.page', pagesEl) : [];
    if (!pages.length) throw new Error('Nothing to download');
    const zoom = pagesEl.style.zoom;
    pagesEl.style.zoom = '';
    try {
      const out = [];
      for (let i = 0; i < pages.length; i++) {
        if (onEach) onEach(i + 1, pages.length);
        const pg = pages[i];
        const url = await window.htmlToImage.toJpeg(pg, { quality: 0.92, pixelRatio: 2, backgroundColor: '#ffffff', fontEmbedCSS: fonts, style: { margin: '0', boxShadow: 'none' } });
        out.push({ url: url, name: String(pg.dataset.name || 'Page ' + (i + 1)).split(' — ').pop(), landscape: pg.classList.contains('landscape'), w: pg.offsetWidth, h: pg.offsetHeight });
      }
      return out;
    } finally { pagesEl.style.zoom = zoom; }
  }
  const safeName = s => String(s).replace(/[^\w\- ]+/g, ' ').trim().replace(/\s+/g, '-');
  function saveFile(href, name) { const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  async function downloadOut(kind) {
    if (S.exporting) return;
    S.exporting = true;
    const btn = $(kind === 'pdf' ? '#pdfBtn' : '#jpgBtn'), label = $('span', btn), was = label.textContent;
    $$('.out-btns .btn').forEach(b => { b.disabled = true; });
    try {
      loadPrintFont();
      const rep = { caller: 'Caller-wise', un: 'U-N', lr: 'L-R', rh: 'R-H' }[S.print.rep] || 'Print';
      const d = S.dataDate || todayKey(), date = d.slice(8, 10) + '-' + d.slice(5, 7) + '-' + d.slice(0, 4);
      const imgs = await pageImages((i, n) => { label.textContent = n > 1 ? i + '/' + n : '…'; });
      if (kind === 'jpg') {
        for (let i = 0; i < imgs.length; i++) {
          saveFile(imgs[i].url, 'Daman_' + rep + '_' + safeName(imgs[i].name) + '_' + date + '.jpg');
          if (i < imgs.length - 1) await new Promise(r => setTimeout(r, 450));
        }
        toast(imgs.length === 1 ? 'JPG downloaded' : imgs.length + ' JPG files downloaded');
      } else {
        label.textContent = 'PDF…';
        await loadLib(LIBS.pdf);
        let pdf = null;
        imgs.forEach(im => {
          const o = im.landscape ? 'landscape' : 'portrait', pw = im.landscape ? 297 : 210, ph = im.landscape ? 210 : 297;
          if (!pdf) pdf = new window.jspdf.jsPDF({ orientation: o, unit: 'mm', format: 'a4' }); else pdf.addPage('a4', o);
          let w = pw, h = im.h * pw / im.w;
          if (h > ph) { w = w * ph / h; h = ph; }
          pdf.addImage(im.url, 'JPEG', (pw - w) / 2, 0, w, h);
        });
        pdf.save('Daman_' + rep + (S.print.caller ? '_' + safeName(S.print.caller) : '') + '_' + date + '.pdf');
        toast('PDF downloaded');
      }
    } catch (e) {
      toast((e && e.message) || 'Could not make the file', true);
    } finally {
      label.textContent = was;
      $$('.out-btns .btn').forEach(b => { b.disabled = false; });
      S.exporting = false;
    }
  }

  /** "Auto" page / columns: try each layout on the fullest page and keep the one with the biggest text
   *  (the report's usual layout wins unless another is clearly more readable). */
  const layoutCache = {};
  function chooseLayout(rep, sets, fixedOrient) {
    const P = S.print;
    const orients = fixedOrient ? [fixedOrient] : P.orient === 'auto' ? ['portrait', 'landscape'] : [P.orient];
    const colsList = P.cols === 'auto' ? [1, 2, 3] : [+P.cols];
    if (orients.length * colsList.length === 1) return { o: orients[0], c: colsList[0] };
    const big = sets.reduce((a, s) => (s.vs.length > a.vs.length ? s : a), sets[0]);
    const key = [P.rep, P.orient, P.cols, fixedOrient, big.part ? big.part.cats.join() : '', big.caller,
      big.vs.length, big.vs.map(v => v.cat + v.vno).join('').length].join('|');
    if (layoutCache[key]) return layoutCache[key];
    const area = $('#printArea');
    const isUsual = (o, c) => (P.orient === 'auto' ? o === rep.orient : true) && (P.cols === 'auto' ? c === rep.cols : true);
    const combos = [];
    orients.forEach(o => colsList.forEach(c => combos.push({ o: o, c: c })));
    combos.sort((a, b) => isUsual(b.o, b.c) - isUsual(a.o, a.c)); // the usual layout first
    let best = null;
    for (const k of combos) {
      area.innerHTML = '<div class="pages">' + pageHtml(rep, big.vs, big.caller, k.o, k.c, 1, 1, big.part) + '</div>';
      const fs = fitOne($('#printArea .page'));
      const score = fs + (isUsual(k.o, k.c) ? 1.6 : 0) - k.c * 0.01;
      if (!best || score > best.score) best = { o: k.o, c: k.c, score: score };
      if (best.score >= 13) break; // nothing else can beat it
    }
    return (layoutCache[key] = { o: best.o, c: best.c });
  }

  function setPageSize(orient) {
    let st = $('#pageSize');
    if (!st) { st = document.createElement('style'); st.id = 'pageSize'; document.head.appendChild(st); }
    st.textContent = '@page { size: A4 ' + orient + '; margin: 0; }';
  }

  /** shrink the text of every page until it fits on one sheet of paper */
  function fitPages() {
    const pagesEl = $('#printArea .pages');
    if (!pagesEl) return;
    pagesEl.style.zoom = '';
    $$('.page', pagesEl).forEach(fitOne);
    scalePreview();
  }
  /** returns the font size used, or 0 when even the smallest text does not fit (page then runs onto a 2nd sheet) */
  function fitOne(pg) {
    pg.classList.remove('flow');
    const inner = $('.page-inner', pg);
    const blocks = $$('.pblock', pg);
    const fits = fs => {
      pg.style.setProperty('--fs', fs + 'px');
      if (inner.scrollHeight > inner.clientHeight + 1) return false;
      // a table wider than its column would spill over the next column
      // (a table split over two columns has one client rect per column)
      return blocks.every(b => {
        const t = b.firstElementChild, colW = b.getClientRects()[0];
        return !t || !colW || Array.from(t.getClientRects()).every(r => r.width <= colW.width + 1.5);
      });
    };
    let lo = 6.5, hi = Number(pg.dataset.maxfs) || 13;
    if (fits(hi)) return hi;
    if (!fits(lo)) { pg.classList.add('flow'); return 0; }
    for (let i = 0; i < 7; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    const fs = Math.floor(lo * 4) / 4;
    fits(fs);
    return fs;
  }
  function scalePreview() {
    const pagesEl = $('#printArea .pages');
    if (!pagesEl || !pagesEl.firstElementChild) return;
    pagesEl.style.zoom = '';
    const avail = $('#printArea').clientWidth - 4;
    const pw = pagesEl.firstElementChild.offsetWidth;
    if (pw > avail && avail > 0) pagesEl.style.zoom = String(Math.max(0.3, avail / pw));
  }

  /* =====================================================================
   *  Views, toast, events
   * ===================================================================== */
  function setView(view, noHash) {
    if (!['board', 'programs', 'print'].includes(view)) view = 'board';
    S.view = view;
    $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + view; });
    $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    if (!noHash && location.hash !== '#' + view) { try { history.replaceState(history.state, '', '#' + view); } catch (e) { location.hash = view; } }
    renderAll();
    window.scrollTo(0, 0);
  }

  /** sticky group headings sit right under the header (two rows high on phones) */
  function setStickyTop() { document.documentElement.style.setProperty('--sticky-top', $('.top').offsetHeight + 'px'); }

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 5000 : 2600);
  }

  function setCaller(name) {
    S.f.caller = name;
    store.set(K.caller, name);
    if (S.view === 'print') S.print.caller = name;
    renderAll();
  }

  function bind() {
    // navigation
    $$('[data-view]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); setView(b.dataset.view); }));
    window.addEventListener('hashchange', () => setView(location.hash.slice(1), true));
    window.addEventListener('popstate', () => { if (S.detail) closeDetail(true); });

    $('#syncBtn').addEventListener('click', () => refresh(true));
    $('#userBtn').addEventListener('click', openWho);
    $('#callsBtn').addEventListener('click', openCalls);
    $('#callsOverlay').addEventListener('click', e => { if (e.target.id === 'callsOverlay' || e.target.closest('[data-close-calls]')) closeCalls(); });

    // caller chips (board + programs)
    ['#callerChips', '#callerChips2'].forEach(sel => $(sel).addEventListener('click', e => {
      const b = e.target.closest('[data-caller]'); if (b) setCaller(b.dataset.caller);
    }));

    // search
    let qt = null;
    $('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { S.f.q = e.target.value.trim(); renderBoard(); }, IS_PHONE ? 220 : 120); });
    let pqt = null;
    $('#pq').addEventListener('input', e => { clearTimeout(pqt); pqt = setTimeout(() => { S.pq = e.target.value.trim(); renderPrograms(); }, IS_PHONE ? 220 : 120); });
    document.addEventListener('keydown', e => {
      if (e.key === '/' && S.view === 'board' && !/input|select|textarea/i.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); $('#q').focus(); }
      if (e.key === 'Escape') { if (!$('#whoOverlay').hidden) closeWho(); else if (!$('#callsOverlay').hidden) closeCalls(); else if (S.detail) closeDetail(); }
    });

    // group + filters
    $('#groupBy').addEventListener('change', e => { S.group = e.target.value; store.set(K.group, S.group); renderBoard(); });
    $('#filterBtn').addEventListener('click', () => {
      const f = $('#filters'); f.hidden = !f.hidden; $('#filterBtn').setAttribute('aria-expanded', String(!f.hidden));
    });
    $('#catChips').addEventListener('click', e => {
      const b = e.target.closest('[data-cat]'); if (!b) return;
      const k = b.dataset.cat; if (S.f.cats.has(k)) S.f.cats.delete(k); else S.f.cats.add(k);
      renderBoard();
    });
    $('#fLoc').addEventListener('change', e => { S.f.loc = e.target.value; renderBoard(); });
    $('#fItem').addEventListener('change', e => { S.f.item = e.target.value; renderBoard(); });
    $('#fProg').addEventListener('change', e => { S.f.prog = e.target.value; renderBoard(); });
    $$('[data-flag]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.flag; if (S.f.flags.has(k)) S.f.flags.delete(k); else S.f.flags.add(k); renderBoard();
    }));
    const resetAll = () => { S.f.cats.clear(); S.f.loc = ''; S.f.item = ''; S.f.prog = ''; S.f.flags.clear(); };
    $('#resetFilters').addEventListener('click', () => { resetAll(); renderBoard(); });

    $('#kpis').addEventListener('click', e => {
      const b = e.target.closest('[data-kpi]'); if (!b) return;
      const k = b.dataset.kpi;
      if (!k) S.f.cats.clear(); else if (S.f.cats.has(k)) S.f.cats.delete(k); else S.f.cats.add(k);
      renderBoard();
    });
    $('#resultLine').addEventListener('click', e => {
      if (!e.target.closest('[data-clear-all]')) return;
      resetAll(); S.f.q = ''; $('#q').value = ''; setCaller('');
    });

    // board list: open a vehicle, collapse groups, sort table
    $('#boardList').addEventListener('click', e => {
      if (e.target.closest('a')) return;
      const g = e.target.closest('[data-group]');
      if (g) {
        const id = g.dataset.group;
        if (S.closed.has(id)) S.closed.delete(id); else S.closed.add(id);
        store.set(K.closed, [...S.closed]);
        g.parentElement.classList.toggle('closed');
        return;
      }
      const th = e.target.closest('[data-sort]');
      if (th) { const k = th.dataset.sort; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : 1 }; renderBoard(); return; }
      const r = e.target.closest('[data-v]'); if (r) openDetail(r.dataset.v);
    });
    $('#boardList').addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('.vrow')) openDetail(e.target.dataset.v);
    });

    // programs view
    $('#progSeg').addEventListener('click', e => { const b = e.target.closest('[data-pseg]'); if (b) { S.pseg = b.dataset.pseg; renderPrograms(); } });
    $('#progList').addEventListener('click', e => {
      if (e.target.closest('a, button, input, label')) return;
      const card = e.target.closest('[data-card]'); if (card) openDetail(card.dataset.card);
    });

    // program editor (cards + detail)
    document.addEventListener('click', e => {
      const b = e.target.closest('.pg [data-act]');
      if (b) { e.preventDefault(); onProgAction(b); }
    });
    document.addEventListener('input', e => {
      const i = e.target.closest('.pg [data-f]'); if (!i) return;
      const vno = i.closest('.pg').dataset.v;
      (S.drafts[vno] = S.drafts[vno] || {})[i.dataset.f] = i.value;
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const i = e.target.closest && e.target.closest('.pg [data-f]'); if (!i) return;
      e.preventDefault();
      const btn = $('[data-act="give"]', i.closest('.pg'));
      if (btn) btn.click();
    });
    document.addEventListener('focusout', () => setTimeout(() => { if (S.pending && !editingNow()) renderAll(); }, 250));

    // detail sheet
    $('#sheetOverlay').addEventListener('click', e => { if (e.target.id === 'sheetOverlay' || e.target.closest('[data-close]')) closeDetail(); });

    // who
    $('#whoList').addEventListener('click', e => { const b = e.target.closest('[data-who]'); if (b) closeWho(b.dataset.who); });
    $('#whoForm').addEventListener('submit', e => { e.preventDefault(); const n = $('#whoInput').value.trim(); if (n) closeWho(n); });
    $('#whoOverlay').addEventListener('click', e => { if (e.target.id === 'whoOverlay') closeWho(); });

    // banner
    $('#banner').addEventListener('click', e => {
      if (e.target.closest('[data-hide-banner]')) { try { sessionStorage.setItem(K.banner, '1'); } catch (er) { /* ignore */ } showBanner(); }
    });

    // print
    const savePrint = () => store.set(K.print, S.print);
    // a font that arrives late changes text widths → fit the print pages again
    if (document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener('loadingdone', () => { if (S.view === 'print') fitPages(); });
    }
    // tap a Next Load / Program / Broker cell in the print preview → change that vehicle's program
    $('#printArea').addEventListener('click', e => {
      const c = e.target.closest('[data-edit]');
      if (!c) return;
      const vno = c.dataset.edit;
      if (S.active[vno] && S.active[vno].program) S.editing[vno] = true;
      openDetail(vno);
      setTimeout(() => { const i = $('#sheet .pg [data-f="program"]'); if (i) i.focus(); }, 250);
    });
    $('#repSeg').addEventListener('click', e => { const b = e.target.closest('[data-rep]'); if (b) { S.print.rep = b.dataset.rep; savePrint(); renderPrint(); } });
    $('#repCaller').addEventListener('change', e => { S.print.caller = e.target.value; savePrint(); renderPrint(); });
    $('#repOrient').addEventListener('change', e => { S.print.orient = e.target.value; savePrint(); renderPrint(); });
    $('#repCols').addEventListener('change', e => { S.print.cols = e.target.value; savePrint(); renderPrint(); });
    $('#printBtn').addEventListener('click', () => { renderPrint(); setTimeout(() => window.print(), 60); });
    $('#pdfBtn').addEventListener('click', () => downloadOut('pdf'));
    $('#jpgBtn').addEventListener('click', () => downloadOut('jpg'));
    window.addEventListener('beforeprint', () => { if (S.view !== 'print') setView('print'); });
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.view === 'print') scalePreview(); }, 150); });

    // live sync with the Google Sheet
    document.addEventListener('visibilitychange', refreshIfStale);
    window.addEventListener('focus', refreshIfStale);
    window.addEventListener('online', refreshIfStale);
    window.addEventListener('online', flushOutbox);
    setInterval(refreshPrograms, 10000);
    setInterval(() => { if (!document.hidden) loadCalls(); }, CALLS_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (S.callsAt || 0) > CALLS_MS) loadCalls(); });
    window.addEventListener('resize', setStickyTop);
    if (window.ResizeObserver) new ResizeObserver(setStickyTop).observe($('.top'));
    window.addEventListener('beforeunload', e => { if (S.outbox.length) { e.preventDefault(); e.returnValue = ''; } });
  }

  /* ---------------- install as an app ----------------
   * Chrome / Edge / Android hand over an install prompt → our Install button shows it.
   * iPhone Safari has no prompt → the strip says how: Share → Add to Home Screen. */
  let installEvt = null;
  const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const K_INSTALL = 'vpt_install_hidden_until';
  const isInstalled = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  function showInstallBar(how) {
    if (isInstalled() || Date.now() < (store.get(K_INSTALL, 0) || 0)) return;
    if (how) $('#installHow').textContent = how;
    $('#installBar').hidden = false;
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installEvt = e;
    $('#installBtn').hidden = false;
    showInstallBar();
  });
  window.addEventListener('appinstalled', () => {
    installEvt = null;
    $('#installBar').hidden = true;
    toast('App installed ✓ — open it from your home screen');
  });
  function bindInstall() {
    $('#installBtn').addEventListener('click', async () => {
      if (!installEvt) return;
      installEvt.prompt();
      const choice = await installEvt.userChoice.catch(() => null);
      installEvt = null;
      if (choice && choice.outcome === 'accepted') $('#installBar').hidden = true;
    });
    $('#installClose').addEventListener('click', () => {
      $('#installBar').hidden = true;
      store.set(K_INSTALL, Date.now() + 3 * 86400000); // ask again after 3 days
    });
    if (IS_IOS && !isInstalled()) {
      $('#installBtn').hidden = true;
      showInstallBar('iPhone: tap Share ⬆ then “Add to Home Screen”');
    }
  }

  /* ---------------- start ---------------- */
  function start() {
    bind();
    if (S.print.caller === undefined) S.print.caller = '';
    // instant first paint from the last loaded sheet
    const cache = store.get(K.cache, null);
    if (cache && cache.grid) {
      try {
        setData(parseCalling(cache.grid, cache.order));
        S.loadedAt = cache.at || 0; S.gridSig = JSON.stringify(cache.grid); S.fromCache = true;
      } catch (e) { /* ignore a bad cache */ }
    }
    S.programs = LOCAL ? Local.list() : store.get(K.progCache, []); // last known programs until the server answers
    computeActive();
    setView(location.hash.slice(1) || 'board', true);
    showBanner();
    setSaveState();
    flushOutbox(); // saves left over from last time
    bindInstall();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {}); // offline copy: opens at once on slow networks
    }
    renderCallsBtn();
    loadCalls();
    setStickyTop();
    refresh().then(schedulePoll);
  }
  start();
})();
