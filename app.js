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
  // Director → Manager → caller: who passes programs / remarks to whom (same as CONFIG.FLOW in Code.gs)
  const FLOW = Object.assign({ TOP: 'Director', MID: 'Manager' }, CFG.FLOW || {});
  const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const isTop = u => sameName(u, FLOW.TOP), isMid = u => sameName(u, FLOW.MID);
  const isBoss = u => isTop(u) || isMid(u);

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
    progs: 'vpt_programs_local', cache: 'vpt_cache_v1', progCache: 'vpt_prog_cache_v1', outbox: 'vpt_outbox_v1', print: 'vpt_print', banner: 'vpt_banner_hidden',
    flow: 'vpt_flow', msgCache: 'vpt_msg_cache_v1', seen: 'vpt_seen_local', accounts: 'vpt_accounts_v1'
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
    clock: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    pin: '<svg class="ico pin" viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    road: '<svg class="ico" viewBox="0 0 24 24"><path d="M9 3 5 21M15 3l4 18M12 4v3M12 10.5v3M12 17v3"/></svg>',
    // side view of a lorry; body and cab take the status colour (--c)
    truck: '<svg class="truck" viewBox="0 0 34 20" aria-hidden="true"><rect class="t-box" x="1" y="2" width="20.5" height="11.5" rx="1.8"/>' +
      '<path class="t-rib" d="M6 3.2v9.2M11.2 3.2v9.2M16.4 3.2v9.2"/>' +
      '<rect class="t-shine" x="2.5" y="3.4" width="17.5" height="2.2" rx="1.1"/><path class="t-cab" d="M22.4 5.2h6.1l4.4 5V14h-10.5z"/>' +
      '<path class="t-win" d="M24 6.7h4l2.6 3.1H24z"/><circle class="t-light" cx="32.3" cy="12" r="1"/><rect class="t-base" x="1" y="12.8" width="31.9" height="2.1" rx="1"/>' +
      '<circle class="t-wheel" cx="7" cy="16" r="2.8"/><circle class="t-wheel" cx="26.6" cy="16" r="2.8"/></svg>',
    load: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 21V9l9-5 9 5v12M7 21v-7h10v7M7 17h10"/></svg>',  // warehouse
    flag: '<svg class="ico" viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>'
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
    pseg: 'noprog', pq: '', ploc: '', sel: new Set(),
    rq: '', rcat: '', // route view: search, one status only
    hmode: 'load', hub: '', hubAll: {}, // hub analyzer: loading / unloading point, which hub, sides showing every place
    rmode: store.get('vpt_rmode', 'road'), hview: store.get('vpt_hview', 'flow'), // route: road / map · hub: flow / map
    rpick: '', rplace: '', // on the map: the route chosen, or the loading / unloading point whose routes light up ('' = all)
    drafts: {}, editing: {},
    print: Object.assign({ rep: 'caller', caller: '', orient: 'auto', cols: 'auto' }, store.get(K.print, {})),
    detail: null, pending: false,
    changedAt: {}, gridSig: '', progSig: '', fromCache: false, fails: 0, sheetChangedAt: 0,
    saving: {}, lastSaveAt: 0, outbox: store.get(K.outbox, []), flushing: false, outboxError: '', retryTimer: null,
    repairInfo: {}, repairAt: 0, repairLoading: false,
    // Director → Manager → caller messages (Messages tab); flow is on once the deployed Code.gs has it
    flow: !LOCAL && !!store.get(K.flow, false), msgs: store.get(K.msgCache, []), msgSig: '', msgKnown: new Set(), msgSeeded: false,
    seenLocal: store.get(K.seen, {}), savedAt: {}, msgAddedAt: {}, inboxTab: 'in'
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
    S.apiAt = Date.now();
    let res;
    try { res = JSON.parse(text); } catch (e) { throw new Error('Invalid reply from Apps Script — check the deployment (Who has access: Anyone)'); }
    if (!res || !res.ok) { const er = new Error((res && res.error) || 'Something went wrong'); er.code = (res && res.code) || ''; throw er; }
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
    if (b.dnote != null) rec.dnote = String(b.dnote).trim();
    if (b.note != null) { const n = String(b.note).trim(); if (n !== (rec.note || '')) { rec.note = n; rec.noteBy = n ? user : ''; } }
    if (b.informed != null) {
      const v = (b.informed === true || b.informed === 'Yes') ? 'Yes' : 'No';
      if (v !== rec.informed) { rec.informed = v; rec.informedBy = v === 'Yes' ? user : ''; rec.informedAt = v === 'Yes' ? now : ''; }
    }
    rec.updatedBy = user; rec.updatedAt = now;
  }
  /** Same rules as route_ in Code.gs: sets the stage and returns who is told (shown at once, the server writes the real ones) */
  function routeMsgs(rec, before, b, now) {
    const user = String(b.user || ''), out = [];
    const progNew = !!rec.program && rec.program !== before.program;
    const msg = (to, kind, note, dnote) => out.push({ id: 'tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), date: todayKey(), at: now,
      vno: rec.vno, from: user, to: to, kind: kind, program: rec.program, broker: rec.broker, note: note || '', loc: rec.loc, cat: rec.cat,
      caller: rec.caller, seenBy: '', seenAt: '', dnote: dnote || '' });
    if (!rec.program) { rec.stage = ''; rec.dnoteSent = ''; }
    if (isTop(user) && b.send) { // "Direct": the Director sends straight to the caller
      rec.stage = ''; rec.dnoteSent = rec.dnote || '';
      if (rec.program) { rec.sentBy = user; rec.sentAt = now; if (rec.caller) msg(rec.caller, 'program', rec.note, rec.dnoteSent); }
      else if (rec.dnote && rec.caller) msg(rec.caller, 'remark', '', rec.dnote);
    } else if (isTop(user)) {
      if (progNew) { rec.stage = 'manager'; msg(FLOW.MID, 'program', rec.dnote); }
      else if (rec.dnote && rec.dnote !== before.dnote) msg(FLOW.MID, 'remark', rec.dnote);
    } else if (isMid(user)) {
      if (rec.program && (b.send || progNew)) {
        // the Director's remark goes on to the caller together with the program
        rec.stage = ''; rec.sentBy = user; rec.sentAt = now; rec.dnoteSent = rec.dnote || '';
        if (rec.caller) msg(rec.caller, 'program', rec.note, rec.dnoteSent);
      } else if (rec.note && rec.note !== before.note && rec.stage !== 'manager' && rec.caller) msg(rec.caller, 'remark', rec.note);
    } else if (progNew) rec.stage = '';
    return out;
  }

  /* -------- Programs + Messages: read straight from the sheet (≈1 s, public CSV); Code.gs only writes.
   *  If that fails (or the tabs are not there yet) the Apps Script is asked instead. -------- */
  const PROG_HEAD = {
    'id': 'id', 'date': 'date', 'vehicle no': 'vno', 'caller': 'caller', 'status': 'cat', 'location': 'loc', 'program next load': 'program',
    'broker party': 'broker', 'given by': 'givenBy', 'given at': 'givenAt', 'driver informed': 'informed', 'informed by': 'informedBy',
    'informed at': 'informedAt', 'going to': 'goingTo', 'note': 'note', 'updated by': 'updatedBy', 'updated at': 'updatedAt',
    'stage': 'stage', 'director remark': 'dnote', 'remark by': 'noteBy', 'sent by': 'sentBy', 'sent at': 'sentAt',
    'director remark sent': 'dnoteSent'
  };
  const MSG_HEAD = {
    'id': 'id', 'date': 'date', 'at': 'at', 'vehicle no': 'vno', 'from': 'from', 'to': 'to', 'kind': 'kind', 'program': 'program',
    'broker party': 'broker', 'remark': 'note', 'location': 'loc', 'status': 'cat', 'caller': 'caller', 'seen by': 'seenBy', 'seen at': 'seenAt',
    'director remark': 'dnote'
  };
  async function readTab(tab, head, must) {
    const from = addDays(todayKey(), -(PROGRAM_DAYS - 1));
    const url = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(CFG.SHEET_ID) + '/gviz/tq?tqx=out:csv&headers=1&sheet=' +
      encodeURIComponent(tab) + '&tq=' + encodeURIComponent("select * where B >= '" + from + "'");
    const r = await fetchWithTimeout(url, { cache: 'no-store' }, 15000);
    const text = await r.text();
    if (!r.ok || /^\s*</.test(text)) throw new Error('tab not readable');
    const grid = parseCsv(text);
    const keys = (grid[0] || []).map(h => head[normHead(h)] || '');
    // a missing tab gives the first sheet of the file instead — check the headings
    if (!must.every(k => keys.includes(k))) throw new Error('tab "' + tab + '" not found');
    return grid.slice(1).map(row => { const o = {}; keys.forEach((k, i) => { if (k) o[k] = String(row[i] == null ? '' : row[i]); }); return o; })
      .filter(o => o.id && o.vno);
  }
  /** → { programs, messages } (messages null while the flow is off).
   *  The sheet usually answers in under a second, but when nobody opened it for a while Google can take
   *  15 s to wake it — so if it is not back in 3 s the Apps Script is asked too, and the first answer wins. */
  function loadPrograms() {
    if (LOCAL) return Promise.resolve({ programs: Local.list(), messages: null });
    const viaScript = () => api('programs', { days: PROGRAM_DAYS })
      .then(res => ({ programs: res.programs || [], messages: S.flow ? res.messages || [] : null }));
    if (!CFG.SHEET_ID) return viaScript();
    const viaSheet = () => Promise.all([
      readTab(CFG.PROGRAM_TAB || 'Programs', PROG_HEAD, ['id', 'date', 'vno', 'program', 'updatedAt']),
      S.flow ? readTab(CFG.MESSAGE_TAB || 'Messages', MSG_HEAD, ['id', 'vno', 'from', 'to']) : Promise.resolve(null)
    ]).then(r => ({ programs: r[0], messages: r[1] }));
    return new Promise((resolve, reject) => {
      let done = false, asked = false, fails = 0, timer = null;
      const win = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const lose = e => { if (++fails === 2 && !done) { done = true; reject(e); } }; // both failed
      const askScript = () => { clearTimeout(timer); if (asked) return; asked = true; viaScript().then(win, lose); };
      viaSheet().then(win, e => { askScript(); lose(e); }); // not readable (e.g. Messages tab not made yet) → Apps Script
      timer = setTimeout(askScript, 3000);
    });
  }

  function computeActive() {
    const today = todayKey(), cut = addDays(today, -(PROGRAM_DAYS - 1));
    const latest = {};
    S.programs.forEach(p => {
      if (!p || !p.vno || (p.date || '') < cut) return;
      const c = latest[p.vno];
      if (!c || String(p.updatedAt || p.givenAt || '') >= String(c.updatedAt || c.givenAt || '')) latest[p.vno] = p;
    });
    const act = {}, hideFromMe = S.flow && !isBoss(S.user);
    Object.keys(latest).forEach(vno => {
      const p = latest[vno], v = S.byVno[vno];
      // a Director's program still with the Manager is not the caller's to act on yet
      if (hideFromMe && p.stage === 'manager') return;
      // today's programs always show; older ones only while the vehicle is still waiting for a program
      if (p.date === today || (v && NEEDS_PROGRAM[v.cat])) act[vno] = p;
    });
    S.active = act;
    S.ver = (S.ver || 0) + 1; // lists are redrawn only when this (or a filter) changes
  }

  function progState(v) {
    const p = S.active[v.vno];
    if (p && p.program && S.flow && p.stage === 'manager') return 'manager'; // with the Manager, not sent to the caller yet
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
    if (prog.status === 'fulfilled') {
      if (applyMessages(prog.value.messages)) changed = true;
      if (progFresh) {
        if (applyPrograms(prog.value.programs) || S.progError) changed = true;
        S.progError = '';
      }
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
    if (!S.auth.on && !S.user && S.callers.length && !S.askedWho) { S.askedWho = true; openWho(); }
  }

  /** Takes a programs list from the server. Programs given / told by another user are highlighted
   *  and announced, so everybody working at the same time sees them. Returns true if anything changed. */
  function applyPrograms(list) {
    list = keepMySaves(list);
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
        if (S.flow && p.program && p.program === o.program && p.stage !== 'manager' && o.stage === 'manager') news.push('📨 ' + vno + ': sent to the caller (' + (p.sentBy || p.updatedBy) + ')');
        else if (p.program && p.program !== o.program) news.push('📋 ' + vno + ': ' + p.program + ' (' + (p.givenBy || p.updatedBy) + ')');
        else if (p.program && p.informed === 'Yes' && o.informed !== 'Yes') news.push('✓ ' + vno + ': driver informed (' + (p.informedBy || p.updatedBy) + ')');
        else return;
        S.changedAt[vno] = now;
      });
      if (news.length) toast(news.length === 1 ? news[0] : news.length + ' programs updated by others');
    }
    S.progSeeded = true;
    return true;
  }
  /** The sheet can answer with what it had a few seconds before our save: a row this browser saved in the
   *  last 3 minutes is kept when the sheet's copy is older or not there yet. */
  function keepMySaves(list) {
    const mine = {}, now = Date.now();
    S.programs.forEach(p => { if (now - (S.savedAt[p.id] || 0) < 180000) mine[p.id] = p; });
    if (!Object.keys(mine).length) return list;
    const out = list.map(p => {
      const l = mine[p.id];
      if (!l) return p;
      delete mine[p.id];
      return String(l.updatedAt || '') > String(p.updatedAt || '') ? l : p;
    });
    return out.concat(Object.keys(mine).map(id => mine[id]));
  }
  /** programs (+ messages) only — checked more often than the sheet so other users' work shows up quickly.
   *  While the tab is hidden it still looks once a minute, so a new message can be announced. */
  async function refreshPrograms() {
    if (LOCAL || S.loading || S.progLoading || S.outbox.length || S.flushing) return;
    if (document.hidden && (!S.flow || Date.now() - (S.hiddenPollAt || 0) < 60000)) return;
    if (document.hidden) S.hiddenPollAt = Date.now();
    S.progLoading = true;
    const started = Date.now();
    try {
      const res = await loadPrograms();
      let changed = applyMessages(res.messages);
      if (started > S.lastSaveAt && !S.outbox.length && !S.flushing && applyPrograms(res.programs)) changed = true;
      if (changed) renderAll();
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
      const hay = v.search + (p ? ' ' + norm(p.program + ' ' + p.broker + ' ' + p.goingTo + ' ' + (p.note || '')) : '');
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
      (p && p.program ? '\n' + (v.cat === 'unloading' ? 'Next Loading' : 'Program') + ': *' + p.program + '*' : '') +
      (p && p.program && p.note ? '\nRemark: ' + p.note : '');
    return IS_PHONE
      ? 'https://wa.me/91' + v.phoneDigits + '?text=' + encodeURIComponent(text)
      : 'https://web.whatsapp.com/send?phone=91' + v.phoneDigits + '&text=' + encodeURIComponent(text);
  }
  function progPill(v) {
    const st = progState(v), p = S.active[v.vno];
    if (st === 'informed') return '<div class="vr-prog informed">✓ Program: <b>' + esc(p.program) + '</b>' + (p.broker ? ' (' + esc(p.broker) + ')' : '') + ' · driver informed' + (p.informedBy ? ' by ' + esc(p.informedBy) : '') + '</div>';
    if (st === 'given') return '<div class="vr-prog given">📋 Program: <b>' + esc(p.program) + '</b>' + (p.broker ? ' (' + esc(p.broker) + ')' : '') + ' · <b>driver not told yet</b></div>';
    if (st === 'manager') return '<div class="vr-prog at-mgr">📨 Program: <b>' + esc(p.program) + '</b> · with ' + esc(FLOW.MID) + ', not sent to the caller yet</div>';
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
    $('#callerChips3').innerHTML = chips;
    renderBadges();
    renderUser();
    renderInboxBtn();
    if (S.view === 'board') renderBoard();
    else if (S.view === 'programs') renderPrograms();
    else if (S.view === 'print') renderPrint();
    else if (S.view === 'route') renderRoutes();
    else if (S.view === 'hub') renderHub();
    else if (S.view === 'draw') renderDraw();
    if (S.detail) renderDetail();
  }

  function renderBadges() {
    const n = S.vehicles.filter(v => v.cat !== 'sold' && (!S.f.caller || v.callerName === S.f.caller))
      .filter(v => { const st = progState(v); return st === 'need' || st === 'given' || (st === 'manager' && isMid(S.user)); }).length;
    $$('[data-badge]').forEach(b => { b.textContent = n; b.hidden = !n; });
    // Route Finder: roads waiting for the Director
    const w = canCheck() ? S.drawn.filter(d => d.status === 'Waiting').length : 0;
    $$('[data-dbadge]').forEach(b => { b.textContent = w; b.hidden = !w; });
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
    { k: 'mgr', t: 'With ' + FLOW.MID, boss: true, hint: 'Programs the ' + FLOW.TOP + ' gave. The ' + FLOW.MID + ' checks each one and taps “Send to …” — only then the caller gets it.' },
    { k: 'call', t: 'Call driver', hint: 'Program given — caller: call the driver, tell the program, then tap “Yes, told”.' },
    { k: 'done', t: 'Driver informed', hint: 'The driver has been told the program.' },
    { k: 'all', t: 'All', hint: 'Every No Program / Unloading vehicle and every vehicle with a program.' }
  ];
  function progBuckets() {
    const vs = S.vehicles.filter(v => v.cat !== 'sold' && (!S.f.caller || v.callerName === S.f.caller) && (NEEDS_PROGRAM[v.cat] || S.active[v.vno]));
    const b = { noprog: [], unloading: [], mgr: [], call: [], done: [], all: vs };
    vs.forEach(v => {
      const st = progState(v);
      if (st === 'need') b[v.cat].push(v);
      else if (st === 'manager') b.mgr.push(v);
      else if (st === 'given') b.call.push(v);
      else if (st === 'informed') b.done.push(v);
    });
    const ord = v => (v.cat === 'noprog' ? 0 : v.cat === 'unloading' ? 1 : 2);
    Object.keys(b).forEach(k => b[k].sort((x, y) => ord(x) - ord(y) || placeSort(x, y)));
    return b;
  }
  /** where the program is for: unloading → where it is unloading; others → where it is now */
  const progPlace = v => (v.cat === 'unloading' ? (v.to || v.cur) : (v.cur || v.where)) || 'Location not written';

  function renderPrograms() {
    const key = [S.ver, S.pseg, S.pq, S.ploc, S.f.caller, JSON.stringify(S.editing), [...S.sel].join(), S.vehicles.length, S.user, S.flow, S.msgVer].join('|');
    if (key === S.progKey) { renderBulkBar(); return; }
    S.progKey = key;
    const b = progBuckets();
    const segs = PSEGS.filter(s => !s.boss || (S.flow && isBoss(S.user)));
    $('#progSeg').innerHTML = segs.map(s => '<button type="button" role="tab" data-pseg="' + s.k + '" class="' + (S.pseg === s.k ? 'on' : '') + (s.k === 'mgr' && b.mgr.length && isMid(S.user) ? ' hot' : '') + '">' +
      esc(s.t) + ' <span class="n">' + b[s.k].length + '</span></button>').join('');
    const seg = segs.find(s => s.k === S.pseg) || segs[0];
    const picking = seg.k === 'noprog' || seg.k === 'unloading';
    $('#progHint').textContent = seg.hint + (picking ? ' Tick several vehicles (or “Select all” of a location) to give them one program together.' : '');
    const list = $('#progList');
    if (!S.vehicles.length) { list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'; return; }
    let vs = b[seg.k];
    // location dropdown: locations of this tab, with how many vehicles each
    const locCount = {};
    vs.forEach(v => { const l = progPlace(v); locCount[l] = (locCount[l] || 0) + 1; });
    if (S.ploc && !locCount[S.ploc]) S.ploc = '';
    $('#ploc').innerHTML = '<option value="">All locations (' + vs.length + ')</option>' + Object.keys(locCount).sort()
      .map(l => '<option value="' + esc(l) + '"' + (l === S.ploc ? ' selected' : '') + '>' + esc(l) + ' (' + locCount[l] + ')</option>').join('');
    if (S.ploc) vs = vs.filter(v => progPlace(v) === S.ploc);
    if (S.pq) { const q = norm(S.pq); vs = vs.filter(v => (v.search + ' ' + norm((S.active[v.vno] || {}).program)).includes(q)); }
    // ticked vehicles that are no longer in this list are dropped
    if (!picking) S.sel.clear();
    else [...S.sel].forEach(vno => { if (!vs.some(v => v.vno === vno)) S.sel.delete(vno); });
    renderBulkBar();
    if (!vs.length) {
      const msg = { noprog: 'Every No Program vehicle has a program 👍', unloading: 'Every Unloading vehicle has a next load 👍', mgr: 'Nothing waiting for the ' + esc(FLOW.MID) + ' 👍', call: 'No driver is waiting to be called.', done: 'No driver informed yet.', all: 'No vehicle here.' }[seg.k];
      list.innerHTML = '<div class="empty"><b>' + msg + '</b>' + (S.f.caller ? 'Caller: ' + esc(S.f.caller) : 'All callers') + '</div>';
      return;
    }
    if (picking) { // grouped by location, each with "Select all"
      const by = {};
      vs.forEach(v => { (by[progPlace(v)] = by[progPlace(v)] || []).push(v); });
      list.innerHTML = Object.keys(by).sort((a, z) => by[z].length - by[a].length || a.localeCompare(z)).map(l => {
        const all = by[l].every(v => S.sel.has(v.vno));
        return '<h3 class="prog-sec" style="--c:' + CAT[seg.k].color + '"><span class="sw"></span>' + esc(l) + ' <span class="n">' + by[l].length + '</span>' +
          (by[l].length > 1 ? '<button type="button" class="btn link sm pick-all" data-pickall="' + esc(l) + '">' + (all ? 'Unselect all' : 'Select all ' + by[l].length) + '</button>' : '') + '</h3>' +
          by[l].map(v => pcardHtml(v, true)).join('');
      }).join('');
      return;
    }
    // mixed lists: No Program and Unloading shown in their own sections
    const groups = [['noprog', 'No Program'], ['unloading', 'Unloading'], ['', 'Other status']];
    S.mgrShown = seg.k === 'mgr' ? vs.map(v => v.vno) : [];
    const sendAll = seg.k === 'mgr' && isMid(S.user) && vs.length > 1
      ? '<div class="inbox-tools"><button type="button" class="btn primary" data-sendall="1">📨 Send all ' + vs.length + ' to the callers</button></div>' : '';
    list.innerHTML = sendAll + groups.map(g => {
      const part = vs.filter(v => (g[0] ? v.cat === g[0] : !NEEDS_PROGRAM[v.cat]));
      if (!part.length) return '';
      return '<h3 class="prog-sec" style="--c:' + (g[0] ? CAT[g[0]].color : 'var(--navy-3)') + '"><span class="sw"></span>' + g[1] + ' <span class="n">' + part.length + '</span></h3>' +
        part.map(pcardHtml).join('');
    }).join('');
  }
  function pcardHtml(v, pickable) {
    const c = CAT[v.cat], on = pickable && S.sel.has(v.vno);
    return '<article class="pcard' + flashCls(v) + (on ? ' picked' : '') + '" data-card="' + esc(v.vno) + '" style="--c:' + c.color + '">' +
      '<div class="pc-top">' +
      (pickable ? '<label class="pick" title="Select for one program together"><input type="checkbox" data-pick="' + esc(v.vno) + '"' + (on ? ' checked' : '') + '></label>' : '') +
      plate(v.vno) + catBadge(v) + flagBadges(v) + '<span class="tag-caller">' + esc(v.callerName) + '</span></div>' +
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
    const r = flowRole(v);
    let h = '<div class="pg' + (editing ? ' editing' : '') + (S.saving[v.vno] ? ' busy' : '') + '" data-v="' + esc(v.vno) + '">';
    if (!editing) {
      const ok = p.informed === 'Yes', atMgr = r.on && p.stage === 'manager';
      h += '<div class="pg-given' + (ok ? ' ok' : '') + (atMgr ? ' at-mgr' : '') + '">' +
        '<span class="pg-lbl">' + (v.cat === 'unloading' ? 'Next load program' : 'Program') + '</span>' +
        '<div class="pg-text">' + esc(p.program) + '</div>' +
        (p.broker ? '<div class="pg-meta">Broker / Party: <b>' + esc(p.broker) + '</b></div>' : '') +
        // Director's remark: the Director and Manager see the latest; the caller sees what the Manager sent on
        ((dn => (dn ? '<div class="pg-meta">' + esc(FLOW.TOP) + '’s remark: <b>' + esc(dn) + '</b></div>' : ''))(r.on ? (isBoss(S.user) ? p.dnote : p.dnoteSent) : '')) +
        (p.note ? '<div class="pg-meta">Remark' + (r.on && p.noteBy ? ' (' + esc(p.noteBy) + ')' : '') + ': <b>' + esc(p.note) + '</b></div>' : '') +
        '<div class="pg-meta">Given by <b>' + esc(p.givenBy || '—') + '</b>' + (p.givenAt ? ' · ' + esc(fmtStamp(p.givenAt)) : '') +
        ' <button type="button" class="btn link sm" data-act="edit">Change</button></div>' + deliveryHtml(v.vno) + '</div>';
      if (atMgr) {
        // the Director's program waits for the Manager's OK before the caller sees it
        h += isMid(S.user)
          ? '<button type="button" class="btn primary send-caller" data-act="send">📨 Send to ' + esc(r.caller) + '</button>'
          : '<div class="mgr-wait">📨 With ' + esc(FLOW.MID) + ' — not sent to the caller yet</div>' +
            (isTop(S.user) ? '<button type="button" class="btn send-caller direct-btn" data-act="send">➜ Send direct to ' + esc(r.caller) + '</button>' : '');
      } else {
        h += (v.phoneDigits ? '<a class="btn wa-send" href="' + esc(waLink(v)) + '" target="_blank" rel="noopener">' + ICO.wa + 'Send program on WhatsApp</a>' : '') +
          '<div class="inform"><div class="q">Driver ko bataya? <span class="muted">(Driver informed?)</span></div>' +
          '<div class="yn"><button type="button" class="yes' + (ok ? ' on' : '') + '" data-act="inform" data-val="Yes">' + ICO.check + 'Yes, told</button>' +
          '<button type="button" class="no' + (p.informed === 'No' ? ' on' : '') + '" data-act="inform" data-val="No">Not yet</button></div>' +
          (ok ? '<div class="pg-meta">Told by <b>' + esc(p.informedBy || '—') + '</b>' + (p.informedAt ? ' · ' + esc(fmtStamp(p.informedAt)) : '') + '</div>' : '') +
          '</div>';
      }
    } else {
      const progVal = d.program != null ? d.program : (p && p.program) || '';
      const brokerVal = d.broker != null ? d.broker : (p && p.broker) || '';
      const noteVal = d[r.nk] != null ? d[r.nk] : (p && p[r.nk]) || '';
      h += '<label class="field"><span class="pg-lbl">' + (v.cat === 'unloading' ? 'Next load program' : 'Program') + ' <span class="hi">— where to go / load from</span></span>' +
        '<input data-f="program" list="locList" value="' + esc(progVal) + '" autocomplete="off"></label>' +
        '<label class="field"><span class="pg-lbl">Broker / Party <span class="hi">(optional)</span></span>' +
        '<input data-f="broker" value="' + esc(brokerVal) + '" autocomplete="off"></label>' +
        '<label class="field" title="' + (r.on ? 'Only a remark? Leave Program empty and tap the button.' : '') + '"><span class="pg-lbl">' + esc(r.noteLbl) + ' <span class="hi">(optional)</span></span>' +
        '<input data-f="' + r.nk + '" value="' + esc(noteVal) + '" autocomplete="off"></label>' +
        '<div class="pg-actions"><button type="button" class="btn primary" data-act="give">' + ICO.check + esc(r.giveLbl) + '</button>' +
        (r.on && isTop(S.user) ? '<button type="button" class="btn direct-btn" data-act="give-direct" title="Skip the ' + esc(FLOW.MID) + ': straight to the caller">Direct → ' + esc(r.caller) + '</button>' : '') +
        (v.phoneDigits && !(r.on && isTop(S.user)) ? '<button type="button" class="btn wa-give" data-act="give-wa" title="Give the program and send it to the driver on WhatsApp">' + ICO.wa + '<span>Give + WhatsApp</span></button>' : '') +
        (has ? '<button type="button" class="btn" data-act="cancel">Cancel</button><button type="button" class="btn link sm" data-act="remove">Remove program</button>' : '') +
        '</div>' + deliveryHtml(v.vno);
    }
    return h + '</div>';
  }
  /** what this person's program box says and writes, in the Director → Manager → caller flow */
  function flowRole(v) {
    const on = S.flow && !!S.user, caller = (v && v.caller) || 'caller';
    if (on && isTop(S.user)) return { on: on, caller: caller, nk: 'dnote', to: FLOW.MID, noteLbl: 'Remark for ' + FLOW.MID, giveLbl: 'Give → ' + FLOW.MID };
    if (on && isMid(S.user)) return { on: on, caller: caller, nk: 'note', to: caller, noteLbl: 'Remark for ' + caller, giveLbl: 'Give → ' + caller };
    return { on: on, caller: caller, nk: 'note', to: '', noteLbl: 'Remark', giveLbl: 'Give program' };
  }

  function editingNow() {
    const a = document.activeElement;
    return !!(a && a.matches && a.matches('.pg [data-f]'));
  }

  /** Saves at once on screen (and in prints); the Google Sheet is written in the background
   *  (outbox kept in this browser, retried until it goes through). */
  async function saveProgram(vno, patch, okMsg) {
    if (!(await ensureUser())) return false;
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
      const before = { program: rec.program || '', note: rec.note || '', dnote: rec.dnote || '', stage: rec.stage || '' };
      const now = nowStr();
      applyPatch(rec, body, now);
      const tmpMsgs = S.flow ? routeMsgs(rec, before, body, now) : [];
      upsertProgram(rec);
      S.savedAt[rec.id] = Date.now();
      if (tmpMsgs.length) { S.msgs = S.msgs.concat(tmpMsgs); renderInboxBtn(); }
      S.outbox.push({ vno: vno, body: body, tmpMsgs: tmpMsgs.map(m => m.id) });
      store.set(K.outbox, S.outbox);
      flushOutbox();
    }
    computeActive();
    if (okMsg !== false) toast(okMsg || 'Saved'); // false = quiet (one note for many vehicles)
    return true;
  }
  /** bottom bar while vehicles are ticked in Programs */
  function renderBulkBar() {
    const n = S.sel.size, bar = $('#bulkBar');
    bar.hidden = !n || S.view !== 'programs';
    document.body.classList.toggle('has-bulk', !bar.hidden);
    if (bar.hidden) return;
    $('#bulkCount').textContent = n + ' vehicle' + (n > 1 ? 's' : '') + ' selected';
    const places = [...new Set([...S.sel].map(vno => (S.byVno[vno] ? progPlace(S.byVno[vno]) : '')))].filter(Boolean);
    $('#bulkWhere').textContent = places.length === 1 ? '· ' + places[0] : '· ' + places.length + ' locations';
    $('#bulkGive').textContent = 'Give to ' + n + (S.flow && isTop(S.user) ? ' → ' + FLOW.MID : '');
    $('#bulkDirect').hidden = !(S.flow && isTop(S.user));
    bar.classList.toggle('two-btn', !$('#bulkDirect').hidden);
    $('#bulkNote').closest('label').querySelector('.pg-lbl').textContent = S.flow && isTop(S.user) ? 'Remark for ' + FLOW.MID : 'Remark';
  }
  /** one program (and broker) for every ticked vehicle — saved at once, sent to the sheet in the background */
  async function bulkGive(direct) {
    direct = direct === true; // the Director's "Direct": straight to each vehicle's caller
    const program = $('#bulkProg').value.trim(), broker = $('#bulkBroker').value.trim(), note = $('#bulkNote').value.trim();
    if (!S.sel.size) return;
    if (!program) { toast('Write the program first (where to go / load from)', true); $('#bulkProg').focus(); return; }
    if (!(await ensureUser())) return;
    const vnos = [...S.sel], r = flowRole(null);
    for (const vno of vnos) {
      const body = { program: program, broker: broker, [r.nk]: note };
      if (r.on && (isMid(S.user) || direct)) body.send = true;
      await saveProgram(vno, body, false);
    }
    S.sel.clear();
    $('#bulkProg').value = ''; $('#bulkBroker').value = ''; $('#bulkNote').value = '';
    toast('Program given to ' + vnos.length + ' vehicle' + (vnos.length > 1 ? 's' : '') +
      (direct ? ' — sent straight to the callers ✓' : r.on && isTop(S.user) ? ' — sent to ' + FLOW.MID : r.on && isMid(S.user) ? ' — sent to the callers' : ' — now call the drivers'));
    renderAll();
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
        const a = S.programs.filter(p => p.vno === job.vno).sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)))[0];
        const id = a && !/^tmp-/.test(a.id) ? a.id : ''; // server also reuses today's row of the vehicle
        let srv, res;
        try {
          if (job.action === 'seen') res = await api('seen', { ids: job.ids, token: S.auth.token || '' });
          else { res = await api('saveProgram', Object.assign({}, job.body, { id: id, token: S.auth.token || '' })); srv = res.program; }
        } catch (e) {
          if (e.code === 'auth') { // login ended → ask for the PIN, then the waiting saves go on
            S.outboxError = 'Log in to save';
            setSaveState();
            logoutLocal();
            openLogin();
            return;
          }
          S.outboxError = e.message || 'Could not save';
          setSaveState();
          clearTimeout(S.retryTimer);
          S.retryTimer = setTimeout(flushOutbox, 8000);
          return;
        }
        S.outbox.shift();
        store.set(K.outbox, S.outbox);
        S.outboxError = '';
        if (job.action === 'seen') continue;
        S.savedAt[srv.id] = Date.now();
        // the server's messages replace the ones shown while saving
        const gone = new Set(job.tmpMsgs || []);
        if (gone.size || (res.messages || []).length) {
          S.msgs = S.msgs.filter(m => !gone.has(m.id)).concat(res.messages || []);
          (res.messages || []).forEach(m => { S.msgAddedAt[m.id] = Date.now(); S.msgKnown.add(m.id); });
          store.set(K.msgCache, S.msgs);
          renderInboxBtn();
        }
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
    const r = flowRole(S.byVno[vno]), p = S.active[vno];
    const clearDraft = () => { S.editing[vno] = false; delete d.program; delete d.broker; delete d.note; delete d.dnote; };
    if (act === 'cancel') clearDraft();
    else if (act === 'send') { await sendToCaller([vno]); return; }
    else if (act === 'give' || act === 'give-wa' || act === 'give-direct') {
      const program = String(d.program || '').trim(), broker = String(d.broker || '').trim(), note = String(d[r.nk] || '').trim();
      const direct = act === 'give-direct'; // the Director, straight to the caller
      if (!program && note && r.on && act !== 'give-wa') { // a remark on its own
        const body = { [r.nk]: note };
        if (direct) body.send = true;
        ok = await saveProgram(vno, body, direct ? 'Remark sent to ' + r.caller : r.to ? 'Remark sent to ' + r.to : 'Remark saved');
        if (ok) { delete d[r.nk]; if (!(p && p.program)) S.editing[vno] = false; }
      } else if (!program) { toast('Write the program first (where to go / load from)', true); const i = $('[data-f="program"]', box); if (i) i.focus(); return; }
      else {
        // WhatsApp has to open right inside the tap (before any waiting), or the browser blocks the new tab
        const sendNow = act === 'give-wa' && S.user && S.byVno[vno];
        if (sendNow) window.open(waLink(S.byVno[vno], { program: program, broker: broker, note: r.nk === 'note' ? note : '' }), '_blank', 'noopener');
        const body = { program: program, broker: broker, [r.nk]: note };
        if (r.on && (isMid(S.user) || direct)) body.send = true; // the Manager's (or a Direct) program goes straight to the caller
        ok = await saveProgram(vno, body,
          direct ? 'Program sent straight to ' + r.caller + ' ✓'
          : r.on && r.to ? 'Program sent to ' + r.to + (isTop(S.user) ? ' — the caller gets it once the ' + FLOW.MID + ' sends it' : '')
            : sendNow ? 'Program saved — WhatsApp opened, press Send there' : act === 'give-wa' ? 'Program saved — now tap “Send program on WhatsApp”' : 'Program saved — now call the driver');
        if (ok) clearDraft();
      }
    } else if (act === 'remove') {
      if (!confirm('Remove the program of ' + vno + '?')) return;
      ok = await saveProgram(vno, { program: '', broker: '', note: '', dnote: '' }, 'Program removed');
      if (ok) clearDraft();
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
      '<div class="card"><h4>Program</h4>' + progEditor(v) + '</div>' + detailMsgsHtml(v) +
      '<div class="card"><h4>Calling Sheet</h4><dl class="kv">' + kv.map(x => '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>').join('') + '</dl></div>' +
      (hist.length ? '<div class="card"><h4>Program history</h4><div class="hist">' + hist.map(x =>
        '<div class="hist-item">' + (x.program ? '<b>' + esc(x.program) + '</b>' : '<i>No program</i>') + (x.broker ? ' (' + esc(x.broker) + ')' : '') +
        (x.note ? ' · Remark: ' + esc(x.note) : '') +
        '<br>Given by ' + esc(x.givenBy || '—') + (x.givenAt ? ' · ' + esc(fmtStamp(x.givenAt)) : '') +
        (x.informed === 'Yes' ? ' · <b style="color:var(--green)">told by ' + esc(x.informedBy) + ' ' + esc(fmtStamp(x.informedAt)) + '</b>' : x.program ? ' · <b style="color:var(--amber)">driver not told</b>' : '') +
        '</div>').join('') + '</div></div>' : '') +
      '</div>';
  }

  /** who was told what about this vehicle (Director → Manager → caller), newest first */
  function detailMsgsHtml(v) {
    const vm = S.flow ? S.msgs.filter(m => m.vno === v.vno && (isBoss(S.user) || forMe(m) || fromMe(m))).sort(byNewest) : [];
    if (!vm.length) return '';
    return '<div class="card"><h4>Messages</h4><div class="hist">' + vm.map(m =>
      '<div class="hist-item"><b>' + esc(m.from) + ' → ' + esc(m.to) + '</b> · ' + esc(fmtStamp(m.at)) + '<br>' + esc(msgWhat(m)) +
      (m.kind === 'program' && m.dnote ? ' · 💬 ' + esc(FLOW.TOP) + ': ' + esc(m.dnote) : '') +
      (m.kind === 'program' && m.note ? ' · 💬 ' + (m.dnote ? esc(m.from) + ': ' : '') + esc(m.note) : '') + '<br>' +
      (isSeen(m) ? '<span class="m-ok">✓ Seen ' + esc(fmtStamp(seenAt(m))) + '</span>' : /^tmp-/.test(m.id) ? '<span class="m-wait">Sending…</span>' : '<span class="m-wait">Not seen yet</span>') +
      (forMe(m) && !isSeen(m) ? ' <button type="button" class="btn sm seen-btn" data-seen-id="' + esc(m.id) + '">' + ICO.check + 'Dekh liya</button>' : '') +
      '</div>').join('') + '</div></div>';
  }

  /* =====================================================================
   *  Who are you?
   * ===================================================================== */
  /* =====================================================================
   *  Pending calls — caller-wise, from the Dashboard tab of the Fleet sheet
   * ===================================================================== */
  const CALLS_MS = Math.max(20, Number(CFG.CALLS_REFRESH_SECONDS) || 60) * 1000;
  /** The big Fleet sheet is sometimes slow or briefly refuses: the last result is kept (shown at once on
   *  the next open) and a failed check is tried again after 5 s and 15 s instead of waiting a minute. */
  const K_CALLS = 'vpt_calls_cache_v1', K_CALLS_COLS = 'vpt_calls_cols_v1', K_CALLS_VIA = 'vpt_calls_via';
  function getCallsCsv(url, ms) {
    return fetchWithTimeout(url, { cache: 'no-store' }, ms)
      .then(r => r.text().then(text => ({ r: r, text: text })),
        e => { throw new Error(/too long/.test(e.message) ? 'too slow' : 'blocked'); })
      .then(({ r, text }) => {
        if (!r.ok) throw new Error('Google busy ' + r.status);
        if (/^\s*</.test(text)) throw new Error('not shared (Anyone with the link: Viewer)');
        return text;
      });
  }
  /** Three ways to read the Dashboard: the CSV export (exact column headings), gviz (the server the vehicles
   *  come from) and the Apps Script (Google reads it on its side). Some office networks / antivirus stop the
   *  browser from reading the Fleet sheet at all — then only the Apps Script gets through. The way that
   *  worked is tried first next time (the usual order is tried again an hour after a switch). */
  async function loadCalls(attempt) {
    if (!CFG.CALLS_SHEET_ID || S.callsLoading) return;
    S.callsLoading = true;
    if (!$('#callsOverlay').hidden) renderCalls();
    let failed = false;
    try {
      const base = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(CFG.CALLS_SHEET_ID), gid = encodeURIComponent(CFG.CALLS_GID);
      const ways = {
        export: () => getCallsCsv(base + '/export?format=csv&gid=' + gid, 10000).then(t => parseCalls(parseCsv(t))),
        gviz: () => getCallsCsv(base + '/gviz/tq?tqx=out:csv&headers=0&gid=' + gid, 12000).then(t => parseCalls(parseCsv(t), true)),
        script: () => api('dashboard').then(res => parseCalls(res.grid || []))
      };
      const label = { export: 'file', gviz: 'sheet', script: 'script' };
      const pref = store.get(K_CALLS_VIA, null);
      let order = ['export', 'gviz'].concat(LOCAL ? [] : ['script']);
      const fresh = !!pref && order.includes(pref.way) && Date.now() - (pref.at || 0) < 3600000;
      if (fresh) order = [pref.way].concat(order.filter(w => w !== pref.way));
      let calls = null;
      const tried = [];
      for (const w of order) {
        try {
          calls = await ways[w]();
          if (!fresh || pref.way !== w) store.set(K_CALLS_VIA, { way: w, at: Date.now() });
          break;
        } catch (e) { tried.push(label[w] + ' ' + (e.message || 'failed')); }
      }
      if (!calls) throw new Error('The Dashboard sheet did not answer — trying again (' + tried.join(' · ') + ')');
      S.calls = calls; S.callsAt = Date.now(); S.callsError = '';
      store.set(K_CALLS, { at: S.callsAt, calls: S.calls });
    } catch (e) {
      S.callsError = e.message || 'Could not load the Dashboard';
      failed = true;
    } finally {
      S.callsLoading = false;
      renderCallsBtn();
      if (!$('#callsOverlay').hidden) renderCalls();
    }
    const n = attempt || 0;
    if (failed && n < 2) setTimeout(() => loadCalls(n + 1), n ? 15000 : 5000);
  }
  /** Morning calls until 3 PM, evening calls from 3 PM (same split as the sheet's printf tab) */
  const callSession = () => (new Date().getHours() < 15 ? 'morning' : 'evening');
  const sessionLeft = c => Math.max(0, (c.total || 0) - (callSession() === 'morning' ? c.morning : c.evening));
  /** caller → done / pending (table "CALLER-WISE") + vehicles / morning / evening (table "CALLING SHEET REPORT SUMMARY").
   *  gviz leaves the heading text of number columns empty, so then each table is found by its title and read from
   *  the columns the export last showed (kept in localStorage; the Dashboard's present layout as default). */
  const CALLS_COLS = { a: { 'calls done': 1, 'calls pending': 2 }, b: { 'total vehicle': 1, 'morning calls': 2, 'evening calls': 3 } };
  function parseCalls(grid, gviz) {
    const byName = {}, order = [];
    const num = s => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
    const row = name => { if (!byName[name]) { byName[name] = { name: name, total: 0, done: 0, pending: 0, morning: 0, evening: 0 }; order.push(name); } return byName[name]; };
    const learnt = gviz ? store.get(K_CALLS_COLS, null) || CALLS_COLS : {};
    const table = (key, title, has) => {
      let h = grid.findIndex(r => normHead(r[0]) === 'caller' && has.every(x => r.map(normHead).includes(x))), col;
      if (h >= 0) {
        const head = grid[h].map(normHead);
        col = k => head.indexOf(k);
        learnt[key] = {}; has.concat(Object.keys(CALLS_COLS[key])).forEach(k => { learnt[key][k] = head.indexOf(k); });
      } else if (gviz) {
        const t = grid.findIndex((r, i) => normHead(r[0]) === title && grid[i + 1] && normHead(grid[i + 1][0]) === 'caller');
        if (t < 0) return null;
        h = t + 1;
        const at = learnt[key] || CALLS_COLS[key];
        col = k => (k in at ? at[k] : -1);
      } else return null;
      const rows = [];
      for (let i = h + 1; i < grid.length; i++) {
        const name = cleanCell(grid[i][0]);
        if (!name) break;
        rows.push(grid[i]);
        if (/^total$/i.test(name)) break;
      }
      return { col: col, rows: rows };
    };
    const a = table('a', 'caller wise', ['calls done', 'calls pending']);
    if (a) a.rows.forEach(r => { const c = row(cleanCell(r[0])); c.done = num(r[a.col('calls done')]); c.pending = num(r[a.col('calls pending')]); });
    const b = table('b', 'calling sheet report summary', ['morning calls', 'evening calls']);
    if (b) b.rows.forEach(r => { const c = row(cleanCell(r[0])); c.total = num(r[b.col('total vehicle')]); c.morning = num(r[b.col('morning calls')]); c.evening = num(r[b.col('evening calls')]); });
    if (!a && !b) throw new Error('Caller-wise calls not found in the Dashboard tab');
    if (!gviz && a && b) store.set(K_CALLS_COLS, learnt);
    const all = order.map(n => byName[n]);
    const total = all.find(c => /^total$/i.test(c.name)) || null;
    const callers = all.filter(c => !/^total$/i.test(c.name) && (c.total || c.done || c.pending || c.morning || c.evening)); // leave out inactive callers
    return { callers: callers, total: total };
  }
  /** calls still to make: the Dashboard's "Calls Pending", or this session's morning / evening calls not yet made */
  function pendingTotal() {
    if (!S.calls) return null;
    const dash = S.calls.total ? S.calls.total.pending : S.calls.callers.reduce((n, c) => n + c.pending, 0);
    const left = S.calls.callers.reduce((n, c) => n + sessionLeft(c), 0);
    return Math.max(dash, left);
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
    const body = $('#callsBody'), ses = callSession();
    $('#callsSub').textContent = (S.callsLoading ? 'Updating… · ' : '') +
      (S.callsAt ? 'From the Dashboard sheet · updated ' + clock(new Date(S.callsAt)) : 'Loading…') +
      ' · now: ' + (ses === 'morning' ? 'morning calls (till 3 PM)' : 'evening calls (from 3 PM)');
    if (!S.calls) { body.innerHTML = '<div class="empty">' + esc(S.callsError || 'Loading…') + '</div>'; return; }
    const cell = (v, cls) => '<td class="' + (cls || '') + '">' + v + '</td>';
    // this session's column: red + blinking while calls are left, e.g. "30 / 46"
    const sessCell = (c, which) => {
      const done = c[which], left = ses === which ? Math.max(0, (c.total || 0) - done) : 0;
      return cell(left ? '<span class="pend blink" title="' + left + ' call' + (left > 1 ? 's' : '') + ' pending">' + done + ' / ' + c.total + '</span>'
        : (ses === which && c.total ? '<span class="ok">' + done + ' ✓</span>' : String(done)));
    };
    const line = (c, isTotal) => {
      const pend = Math.max(c.pending, sessionLeft(c));
      return '<tr class="' + (isTotal ? 'tot' : '') + (c.name === S.user ? ' me' : '') + (pend ? ' has-pend' : '') + '">' +
        '<td class="nm">' + esc(c.name) + '</td>' + cell(c.total) + cell(c.done) +
        cell(c.pending ? '<span class="pend blink">' + c.pending + '</span>' : '<span class="ok">0 ✓</span>') +
        sessCell(c, 'morning') + sessCell(c, 'evening') + '</tr>';
    };
    body.innerHTML = '<div class="calls-wrap"><table class="calls-table"><thead><tr><th>Caller</th><th>Vehicles</th><th>Calls done</th><th>Pending</th>' +
      '<th class="' + (ses === 'morning' ? 'now' : '') + '">Morning</th><th class="' + (ses === 'evening' ? 'now' : '') + '">Evening</th></tr></thead><tbody>' +
      S.calls.callers.map(c => line(c)).join('') + '</tbody>' + (S.calls.total ? '<tfoot>' + line(S.calls.total, true) + '</tfoot>' : '') + '</table></div>' +
      (S.callsError ? '<p class="muted calls-err">' + esc(S.callsError) + (S.callsAt ? ' · showing the ' + clock(new Date(S.callsAt)) + ' figures' : '') + '</p>' : '');
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

  /* =====================================================================
   *  Inbox — Director → Manager → caller (rows of the Messages tab)
   * ===================================================================== */
  const BASE_TITLE = document.title;
  const forMe = m => !!S.user && sameName(m.to, S.user);
  const fromMe = m => !!S.user && sameName(m.from, S.user);
  const isSeen = m => !!(m.seenAt || S.seenLocal[m.id]);
  const seenAt = m => m.seenAt || (S.seenLocal[m.id] || {}).at || '';
  const byNewest = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));
  const msgWhat = m => (m.kind === 'program' ? (m.cat === 'Unloading' ? 'Next load: ' : 'Program: ') + m.program : 'Remark: ' + (m.note || m.dnote));
  const callerOf = vno => { const v = S.byVno[vno]; return (v && v.caller) || ((S.active[vno] || {}).caller) || 'caller'; };
  const unseenForMe = () => S.msgs.filter(m => forMe(m) && !isSeen(m));
  /** vehicles whose (Director's) program is waiting for the Manager */
  const mgrVnos = () => Object.keys(S.active).filter(vno => S.active[vno].program && S.active[vno].stage === 'manager' && S.byVno[vno]);

  /** Takes the messages from the sheet; keeps ours that the sheet does not show yet. Returns true if anything changed. */
  function applyMessages(list) {
    if (!list || !S.flow) return false;
    const byId = {}, now = Date.now();
    list.forEach(m => { byId[m.id] = m; });
    const keep = S.msgs.filter(m => !byId[m.id] && (/^tmp-/.test(m.id) || now - (S.msgAddedAt[m.id] || 0) < 180000));
    const merged = list.concat(keep);
    let gone = false; // "seen" marks the sheet has confirmed need not be kept here any more
    Object.keys(S.seenLocal).forEach(id => { if ((byId[id] && byId[id].seenAt) || now - S.seenLocal[id].t > 86400000) { delete S.seenLocal[id]; gone = true; } });
    if (gone) store.set(K.seen, S.seenLocal);
    const sig = JSON.stringify(merged);
    if (sig === S.msgSig) return false;
    S.msgSig = sig; S.msgs = merged; S.msgVer = (S.msgVer || 0) + 1;
    store.set(K.msgCache, merged);
    const fresh = merged.filter(m => forMe(m) && !isSeen(m) && !S.msgKnown.has(m.id));
    merged.forEach(m => S.msgKnown.add(m.id));
    if (S.msgSeeded && fresh.length) announce(fresh);
    S.msgSeeded = true;
    renderInboxBtn();
    if (!$('#inboxOverlay').hidden) renderInbox();
    return true;
  }
  /** a new message for me: note on screen, buzz the phone, and a system alert while the app is in the background */
  function announce(list) {
    const m = list.sort(byNewest)[0];
    toast(list.length === 1 ? '📩 ' + m.from + ' · ' + m.vno + ' · ' + msgWhat(m) : '📩 ' + list.length + ' new messages for you — open Inbox');
    try { if (navigator.vibrate) navigator.vibrate([160, 80, 160]); } catch (e) { /* not on this phone */ }
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    const title = list.length === 1 ? 'From ' + m.from + ' · ' + m.vno : list.length + ' new messages';
    const opts = { body: list.length === 1 ? msgWhat(m) : list.map(x => x.vno).join(', '), icon: 'icon-192.png', tag: 'vpt-inbox', renotify: true };
    const plain = () => { try { new Notification(title, opts); } catch (e) { /* phones need the service worker */ } };
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(r => (r ? r.showNotification(title, opts) : plain())).catch(plain);
    } else plain();
  }
  function renderInboxBtn() {
    const b = $('#inboxBtn');
    const on = S.flow && !!S.user;
    b.hidden = !on;
    const n = on ? unseenForMe().length : 0;
    document.title = (n ? '(' + n + ') ' : '') + BASE_TITLE;
    if (!on) return;
    $('#inboxCount').textContent = n;
    b.classList.toggle('blink', n > 0);
    b.classList.toggle('none', n === 0);
    b.title = n ? n + ' new — tap to see' : 'Inbox — nothing new';
  }
  /** "sent to X · ✓ seen 10:42" under a program, for the Director and the Manager */
  function deliveryHtml(vno) {
    if (!S.flow || !isBoss(S.user)) return '';
    const m = S.msgs.filter(x => x.vno === vno).sort(byNewest)[0];
    if (!m) return '';
    return '<div class="pg-meta dlv">' + (fromMe(m) ? 'Sent' : esc(m.from) + ' sent') + ' to <b>' + esc(m.to) + '</b> · ' + esc(fmtStamp(m.at)) + ' · ' +
      (isSeen(m) ? '<span class="m-ok">✓ Seen ' + esc(fmtStamp(seenAt(m))) + '</span>' : '<span class="m-wait">not seen yet</span>') + '</div>';
  }
  /** remarks in a message: the Director's (passed on by the Manager) and the sender's own */
  function msgNotes(m) {
    return (m.dnote ? '<div class="m-note">💬 <b>' + esc(FLOW.TOP) + ':</b> ' + esc(m.dnote) + '</div>' : '') +
      (m.note ? '<div class="m-note">💬 ' + (m.dnote ? '<b>' + esc(m.from) + ':</b> ' : '') + esc(m.note) + '</div>' : '');
  }
  function msgCard(m, out, sendHere) {
    const v = S.byVno[m.vno], seen = isSeen(m);
    const what = m.kind === 'program'
      ? '<div class="m-body">📋 ' + (m.cat === 'Unloading' ? 'Next load' : 'Program') + ': <b>' + esc(m.program) + '</b>' + (m.broker ? ' <span class="muted">(' + esc(m.broker) + ')</span>' : '') + '</div>' : '';
    const status = out
      ? (seen ? '<span class="m-ok">✓ Seen ' + esc(fmtStamp(seenAt(m))) + '</span>' : /^tmp-/.test(m.id) ? '<span class="m-wait">Sending…</span>' : '<span class="m-wait">Not seen yet</span>')
      : (seen ? '<span class="m-ok">✓ Seen</span>' : '');
    return '<article class="msg' + (!out && !seen ? ' unseen' : '') + '">' +
      '<div class="m-top">' + plate(m.vno) + '<span class="m-who">' + (out ? 'To <b>' + esc(m.to) + '</b>' : 'From <b>' + esc(m.from) + '</b>') + '</span>' +
      '<span class="m-time">' + esc(fmtStamp(m.at)) + '</span></div>' +
      '<div class="m-where">' + esc([m.cat, m.loc, m.caller ? 'Caller: ' + m.caller : ''].filter(Boolean).join(' · ')) + '</div>' +
      what + msgNotes(m) +
      '<div class="m-act">' + status +
      (sendHere ? '<button type="button" class="btn primary sm" data-msgact="send" data-vno="' + esc(m.vno) + '">📨 Send to ' + esc(callerOf(m.vno)) + '</button>' : '') +
      (v ? '<button type="button" class="btn sm" data-msgact="open" data-vno="' + esc(m.vno) + '">Open</button>' : '') +
      (!out && !seen ? '<button type="button" class="btn sm seen-btn" data-msgact="seen" data-id="' + esc(m.id) + '">' + ICO.check + 'Dekh liya</button>' : '') +
      '</div></article>';
  }
  function renderInbox() {
    const mine = S.msgs.filter(forMe).sort(byNewest), sent = S.msgs.filter(fromMe).sort(byNewest);
    const unseen = mine.filter(m => !isSeen(m)).length;
    $('#inboxSeg').innerHTML =
      '<button type="button" data-itab="in" class="' + (S.inboxTab === 'in' ? 'on' : '') + '">For me <span class="n' + (unseen ? ' hot' : '') + '">' + unseen + '</span></button>' +
      '<button type="button" data-itab="out" class="' + (S.inboxTab === 'out' ? 'on' : '') + '">Sent by me <span class="n">' + sent.length + '</span></button>';
    const waiting = isMid(S.user) ? mgrVnos() : [];
    let tools = '';
    if (S.inboxTab === 'in' && waiting.length > 1) tools += '<button type="button" class="btn primary sm" data-msgact="sendall">📨 Send all ' + waiting.length + ' to the callers</button>';
    if (S.inboxTab === 'in' && unseen > 1) tools += '<button type="button" class="btn sm seen-btn" data-msgact="allseen">' + ICO.check + 'Dekh liya — all ' + unseen + '</button>';
    if ('Notification' in window && Notification.permission === 'default') tools += '<button type="button" class="btn link sm" data-msgact="alerts">🔔 Turn on alerts</button>';
    const list = S.inboxTab === 'in' ? mine : sent;
    const sendShown = new Set();
    $('#inboxBody').innerHTML = (tools ? '<div class="inbox-tools">' + tools + '</div>' : '') + (list.length
      ? list.map(m => {
        const here = S.inboxTab === 'in' && waiting.includes(m.vno) && !sendShown.has(m.vno);
        if (here) sendShown.add(m.vno);
        return msgCard(m, S.inboxTab === 'out', here);
      }).join('')
      : '<div class="empty"><b>' + (S.inboxTab === 'in' ? 'Nothing for you yet' : 'You have not sent anything yet') + '</b>' +
        (S.inboxTab === 'in' ? (isMid(S.user) ? 'Programs and remarks from the ' + esc(FLOW.TOP) + ' come here.' : isTop(S.user) ? 'Replies come here.' : 'Programs and remarks from the ' + esc(FLOW.MID) + ' come here.') : '') + '</div>');
  }
  function openInbox() {
    S.inboxTab = unseenForMe().length || S.inboxTab !== 'out' ? 'in' : 'out';
    renderInbox();
    const ov = $('#inboxOverlay');
    ov.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
    setTimeout(() => ov.classList.add('show'), 60);
    refreshPrograms();
  }
  function closeInbox() {
    const ov = $('#inboxOverlay');
    ov.classList.remove('show');
    setTimeout(() => { ov.hidden = true; }, 180);
  }
  /** "Dekh liya ✓" — shown as seen at once, written to the sheet in the background */
  function markSeen(ids) {
    ids = ids.filter(id => id && !/^tmp-/.test(id) && !S.seenLocal[id]);
    if (!ids.length) return;
    const at = nowStr();
    ids.forEach(id => { S.seenLocal[id] = { at: at, t: Date.now() }; });
    store.set(K.seen, S.seenLocal);
    S.outbox.push({ action: 'seen', ids: ids });
    store.set(K.outbox, S.outbox);
    flushOutbox();
    S.msgVer = (S.msgVer || 0) + 1;
    renderInboxBtn();
    if (!$('#inboxOverlay').hidden) renderInbox();
  }
  /** the Manager sends the Director's program(s) on to the caller(s) */
  async function sendToCaller(vnos) {
    vnos = vnos.filter(vno => S.active[vno] && S.active[vno].stage === 'manager');
    if (!vnos.length || !(await ensureUser())) return;
    for (const vno of vnos) await saveProgram(vno, { send: true }, false);
    markSeen(S.msgs.filter(m => forMe(m) && vnos.includes(m.vno) && !isSeen(m)).map(m => m.id));
    toast(vnos.length === 1 ? 'Sent to ' + callerOf(vnos[0]) + ' ✓' : vnos.length + ' programs sent to the callers ✓');
    renderAll();
    if (!$('#inboxOverlay').hidden) renderInbox();
  }
  async function onInboxClick(e) {
    if (e.target.id === 'inboxOverlay' || e.target.closest('[data-close-inbox]')) { closeInbox(); return; }
    const t = e.target.closest('[data-itab]');
    if (t) { S.inboxTab = t.dataset.itab; renderInbox(); return; }
    const a = e.target.closest('[data-msgact]');
    if (!a) return;
    const act = a.dataset.msgact, vno = a.dataset.vno;
    if (act === 'seen') markSeen([a.dataset.id]);
    else if (act === 'allseen') markSeen(unseenForMe().map(m => m.id));
    else if (act === 'open') { closeInbox(); openDetail(vno); }
    else if (act === 'send') await sendToCaller([vno]);
    else if (act === 'sendall') await sendToCaller(mgrVnos());
    else if (act === 'alerts') { try { await Notification.requestPermission(); } catch (er) { /* ignore */ } renderInbox(); }
  }

  /* =====================================================================
   *  Login with a PIN (checked by Code.gs; switched on as soon as the
   *  deployed script supports it — until then "Who are you?" is used)
   * ===================================================================== */
  const K_AUTH = { on: 'vpt_auth_on', token: 'vpt_token', admin: 'vpt_admin' };
  S.auth = { on: !LOCAL && !!store.get(K_AUTH.on, false), token: store.get(K_AUTH.token, ''), admin: !!store.get(K_AUTH.admin, false), users: [] };

  /** true when somebody is known to save as (logged in, or picked in "Who are you?") */
  async function ensureUser() {
    if (S.auth.on) { if (S.auth.token) return true; openLogin(); return false; }
    if (S.user) return true;
    return !!(await askWho());
  }
  function logoutLocal() {
    S.auth.token = ''; S.auth.admin = false;
    store.set(K_AUTH.token, ''); store.set(K_AUTH.admin, false);
  }
  function setLoggedIn(res) {
    S.auth.token = res.token; S.auth.admin = !!res.admin;
    store.set(K_AUTH.token, res.token); store.set(K_AUTH.admin, !!res.admin);
    S.user = res.user; store.set(K.user, res.user);
    if (S.callers.includes(res.user)) { S.f.caller = res.user; store.set(K.caller, res.user); }
    else if (isBoss(res.user)) { S.f.caller = ''; store.set(K.caller, ''); } // Director / Manager start on all callers
  }
  /** at start: does the deployed script have login? is the saved login still valid? */
  async function checkAuth() {
    if (LOCAL) return;
    try {
      const ping = await api('ping');
      S.auth.on = !!ping.auth;
      store.set(K_AUTH.on, S.auth.on);
      if (!!ping.flow !== S.flow) { // Director → Manager → caller switched on (or off) by a new Code.gs
        S.flow = !!ping.flow; store.set(K.flow, S.flow);
        computeActive(); renderAll(); refreshPrograms();
      }
      if (!!ping.routes !== S.drawOk) { // Route Finder can save (Code.gs "routes-5")
        S.drawOk = !!ping.routes; store.set('vpt_draw_ok', S.drawOk);
        if (S.view === 'draw') renderDrawList();
      }
      loadDrawn(true);
    } catch (e) { return; } // offline: keep what we knew
    if (!S.auth.on) { closeAuth(); return; }
    if (!S.auth.token) { openLogin(); return; }
    try {
      const me = await api('me', { token: S.auth.token });
      S.user = me.user; S.auth.admin = !!me.admin; store.set(K.user, me.user); store.set(K_AUTH.admin, S.auth.admin);
      renderUser();
      flushOutbox();
    } catch (e) {
      if (e.code === 'auth') { logoutLocal(); openLogin(); }
    }
  }

  function showAuth(html, locked) {
    const ov = $('#authOverlay');
    $('#authBox').innerHTML = html;
    ov.dataset.locked = locked ? '1' : '';
    if (ov.hidden) {
      ov.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
      setTimeout(() => ov.classList.add('show'), 60);
    }
    setTimeout(() => { const i = $('#authBox input'); if (i) i.focus(); }, 120);
  }
  function closeAuth() {
    const ov = $('#authOverlay');
    if (ov.hidden) return;
    ov.classList.remove('show');
    setTimeout(() => { ov.hidden = true; }, 180);
  }
  const authHead = (title, sub) => '<img src="logo.webp" alt="" class="modal-logo"><h2>' + esc(title) + '</h2>' + (sub ? '<p class="muted">' + esc(sub) + '</p>' : '');
  const authErr = '<p class="auth-err" id="authErr" role="alert"></p>';
  function setAuthErr(msg) { const e = $('#authErr'); if (e) e.textContent = msg || ''; }
  function setAuthBusy(on) { $$('#authBox button, #authBox input').forEach(x => { x.disabled = on; }); }

  /* ---- quick login: a phone that logged in before keeps that login (and a salted hash of the PIN),
   *  so the next login with the same PIN opens at once — Google confirms it in the background ---- */
  const accKey = n => String(n || '').trim().toLowerCase();
  const accounts = () => store.get(K.accounts, {}) || {};
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  async function pinHash(salt, name, pin) {
    if (!window.crypto || !crypto.subtle || !window.TextEncoder) return '';
    return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + accKey(name) + '|' + pin)));
  }
  async function remember(name, pin, token, admin) {
    try {
      const salt = hex(crypto.getRandomValues(new Uint8Array(12)));
      const h = await pinHash(salt, name, pin);
      if (!h) return;
      const all = accounts();
      all[accKey(name)] = { name: name, token: token, admin: !!admin, salt: salt, h: h, len: pin.length, at: Date.now() };
      store.set(K.accounts, all);
    } catch (e) { /* this browser cannot remember — normal login every time */ }
  }
  function forget(name) { const all = accounts(); delete all[accKey(name)]; store.set(K.accounts, all); }
  /** Google's script sleeps when nobody used it for a while: wake it while the person picks a name */
  function warmApi() { if (!LOCAL && Date.now() - (S.apiAt || 0) > 60000) api('ping').catch(() => {}); }

  async function openLogin(msg) {
    if (!S.auth.on) return openWho();
    warmApi();
    const names = S.auth.users.length ? S.auth.users : (CFG.EXTRA_USERS || ['Director']).concat(S.callers);
    const acc = accounts();
    const quick = Object.keys(acc).map(k => acc[k]).sort((a, b) => b.at - a.at);
    const role = n => (S.callers.includes(n) ? 'Caller' : 'Management');
    showAuth(authHead('Login', quick.length ? 'Tap your name' : 'Choose your name') +
      (msg ? '<p class="auth-err">' + esc(msg) + '</p>' : '') +
      (quick.length ? '<div class="who-list fast">' + quick.map(a => '<button type="button" data-login="' + esc(a.name) + '">' + esc(a.name) +
        '<small>⚡ Quick login · ' + role(a.name) + '</small></button>').join('') + '</div><p class="muted or-line">Someone else</p>' : '') +
      '<div class="who-list">' + names.filter(n => !acc[accKey(n)]).map(n => '<button type="button" data-login="' + esc(n) + '">' + esc(n) +
        '<small>' + role(n) + '</small></button>').join('') + '</div>', true);
    if (!S.auth.users.length) {
      try { S.auth.users = (await api('users')).users || []; } catch (e) { /* keep the local list */ }
      if (S.auth.users.length && !$('#authOverlay').hidden && $('#authBox [data-login]')) openLogin(msg);
    }
  }
  /** PIN pad (no phone keyboard popping up); a quick-login name logs in by itself at the last digit */
  function openPin(name, msg) {
    const a = accounts()[accKey(name)];
    S.pin = { name: name, digits: '', len: (a && a.len) || 0, busy: false };
    showAuth(authHead(name, a ? 'Enter your PIN' : 'Enter your PIN and tap ➜') +
      '<div class="pin-dots" id="pinDots" aria-live="polite"></div>' + authErr + '<p class="auth-note" id="authNote"></p>' +
      '<div class="pin-pad" id="pinPad">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => '<button type="button" data-k="' + k + '">' + k + '</button>').join('') +
      '<button type="button" data-k="del" class="fn" aria-label="Delete">⌫</button><button type="button" data-k="0">0</button>' +
      '<button type="button" data-k="ok" class="go" aria-label="Login">➜</button></div>' +
      '<button type="button" class="btn link" data-auth="back">← Other name</button>', true);
    renderPinDots();
    if (msg) setAuthErr(msg);
  }
  function renderPinDots() {
    const box = $('#pinDots');
    if (!box || !S.pin) return;
    const n = Math.max(S.pin.len || 4, S.pin.digits.length);
    box.innerHTML = Array.from({ length: n }, (_, i) => '<i class="' + (i < S.pin.digits.length ? 'on' : '') + '"></i>').join('');
    box.classList.toggle('busy', S.pin.busy);
    $$('#pinPad button').forEach(b => { b.disabled = S.pin.busy; });
  }
  function pinKey(k) {
    if (!S.pin || S.pin.busy || !$('#pinPad')) return;
    if (k === 'ok') { if (S.pin.digits.length >= 4) doLogin(S.pin.name, S.pin.digits); else setAuthErr('The PIN has 4 or more digits'); return; }
    if (k === 'del') S.pin.digits = S.pin.digits.slice(0, -1);
    else if (/^\d$/.test(k) && S.pin.digits.length < 8) S.pin.digits += k;
    setAuthErr('');
    const box = $('#pinDots'); if (box) box.classList.remove('shake');
    renderPinDots();
    if (S.pin.len && S.pin.digits.length === S.pin.len) doLogin(S.pin.name, S.pin.digits);
  }
  function setAuthNote(t) { const e = $('#authNote'); if (e) e.textContent = t || ''; }
  async function doLogin(name, pin) {
    if (!pin) { setAuthErr('Enter your PIN'); return; }
    const a = accounts()[accKey(name)];
    if (a && a.token && (await pinHash(a.salt, name, pin)) === a.h) {
      finishLogin({ token: a.token, user: a.name, admin: a.admin }, false);
      a.at = Date.now(); const all = accounts(); all[accKey(name)] = a; store.set(K.accounts, all);
      api('me', { token: a.token })
        .then(me => { S.auth.admin = !!me.admin; store.set(K_AUTH.admin, S.auth.admin); })
        .catch(e => { if (e.code === 'auth') serverLogin(name, pin, true); }); // login ran out → renewed with the same PIN
      return;
    }
    await serverLogin(name, pin, false);
  }
  async function serverLogin(name, pin, quiet) {
    let slow = null;
    if (!quiet) {
      S.pin.busy = true; renderPinDots(); setAuthErr(''); setAuthNote('Checking PIN…');
      slow = setTimeout(() => setAuthNote('Checking PIN… Google is slow right now, please wait'), 4000);
    }
    try {
      const res = await api('login', { name: name, pin: pin });
      remember(res.user, pin, res.token, res.admin);
      if (quiet) setLoggedIn(res); else finishLogin(res, res.mustChange);
    } catch (e) {
      if (quiet) { // the PIN was changed on another phone → ask for the new one
        forget(name); logoutLocal(); S.user = ''; computeActive(); renderAll();
        openPin(name, 'Your PIN was changed — enter the new PIN');
        return;
      }
      S.pin.busy = false; S.pin.digits = ''; renderPinDots(); setAuthNote('');
      setAuthErr(e.message || 'Could not log in');
      const box = $('#pinDots'); if (box) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
    } finally { clearTimeout(slow); }
  }
  function finishLogin(res, mustChange) {
    setLoggedIn(res);
    if (mustChange) openSetPin(true);
    else { closeAuth(); toast('Welcome ' + res.user); }
    computeActive(); renderAll(); flushOutbox(); refreshPrograms();
  }
  function openSetPin(first) {
    showAuth(authHead(first ? 'Set your own PIN' : 'Change my PIN', first ? 'First login: choose a new PIN (4–8 digits) that only you know' : 'New PIN, 4–8 digits') +
      '<form class="pin-form" data-setpin="1">' +
      '<input type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" id="newPin1" aria-label="New PIN" placeholder="New PIN">' +
      '<input type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" id="newPin2" aria-label="New PIN again" placeholder="New PIN again">' +
      authErr + '<button type="submit" class="btn primary">Save PIN</button>' +
      (first ? '' : '<button type="button" class="btn link" data-auth="close">Cancel</button>') + '</form>', first);
  }
  async function doSetPin(name, p1, p2, after) {
    if (!/^\d{4,8}$/.test(p1)) { setAuthErr('PIN must be 4 to 8 digits'); return; }
    if (p2 != null && p1 !== p2) { setAuthErr('The two PINs are not the same'); return; }
    setAuthBusy(true); setAuthErr('');
    try {
      await api('setPin', Object.assign({ token: S.auth.token, pin: p1 }, name ? { name: name } : {}));
      if (!name || sameName(name, S.user)) remember(S.user, p1, S.auth.token, S.auth.admin); // quick login knows the new PIN
      else forget(name);
      toast(name ? 'PIN set for ' + name : 'Your new PIN is saved');
      if (after) after(); else closeAuth();
    } catch (e) {
      setAuthBusy(false);
      if (e.code === 'auth') { logoutLocal(); openLogin(); return; }
      setAuthErr(e.message || 'Could not save the PIN');
    }
  }
  function openUserMenu() {
    showAuth(authHead(S.user || 'Not logged in', S.auth.admin ? 'Director — can manage everybody\'s PIN' : 'Logged in on this phone') +
      '<div class="menu-list">' +
      '<button type="button" class="btn primary" data-auth="switch">Switch user <small>— next person logs in; you stay on quick login</small></button>' +
      '<button type="button" class="btn" data-auth="mypin">Change my PIN</button>' +
      (S.auth.admin ? '<button type="button" class="btn" data-auth="manage">Manage PINs</button>' : '') +
      '<button type="button" class="btn danger" data-auth="logout">Log out from this phone</button>' +
      '<button type="button" class="btn link" data-auth="close">Close</button></div>', false);
  }
  async function openManagePins() {
    showAuth(authHead('Manage PINs', 'Set a new PIN for anybody (4–8 digits)') + '<div class="pin-rows"><div class="skeleton"></div></div>' + authErr +
      '<button type="button" class="btn link" data-auth="close">Close</button>', false);
    let users = S.auth.users;
    try { users = S.auth.users = (await api('users')).users || users; } catch (e) { /* use what we have */ }
    const box = $('#authBox .pin-rows');
    if (!box) return;
    box.innerHTML = users.map(n => '<form class="pin-row" data-adminpin="' + esc(n) + '"><b>' + esc(n) + '</b>' +
      '<input type="password" inputmode="numeric" maxlength="8" aria-label="New PIN for ' + esc(n) + '" placeholder="New PIN">' +
      '<button type="submit" class="btn sm navy">Set</button></form>').join('');
  }
  function bindAuth() {
    const ov = $('#authOverlay');
    ov.addEventListener('click', e => {
      if (e.target === ov && !ov.dataset.locked) { closeAuth(); return; }
      const n = e.target.closest('[data-login]');
      if (n) { openPin(n.dataset.login); return; }
      const k = e.target.closest('[data-k]');
      if (k) { pinKey(k.dataset.k); return; }
      const a = e.target.closest('[data-auth]');
      if (!a) return;
      const act = a.dataset.auth;
      if (act === 'back') openLogin();
      else if (act === 'close') closeAuth();
      else if (act === 'mypin') openSetPin(false);
      else if (act === 'manage') openManagePins();
      else if (act === 'switch' || act === 'logout') {
        if (act === 'logout') { // forget this phone's login completely
          const t = S.auth.token;
          if (t) api('logout', { token: t }).catch(() => {});
          forget(S.user);
        }
        logoutLocal(); S.user = ''; store.set(K.user, '');
        computeActive(); renderAll(); openLogin();
      }
    });
    // PIN pad from a computer keyboard too
    document.addEventListener('keydown', e => {
      if ($('#authOverlay').hidden || !$('#pinPad')) return;
      if (/^\d$/.test(e.key)) pinKey(e.key);
      else if (e.key === 'Backspace') pinKey('del');
      else if (e.key === 'Enter') pinKey('ok');
      else return;
      e.preventDefault();
    });
    ov.addEventListener('submit', e => {
      e.preventDefault();
      const f = e.target;
      if (f.dataset.setpin) doSetPin('', $('#newPin1').value.trim(), $('#newPin2').value.trim());
      else if (f.dataset.adminpin) {
        const i = $('input', f);
        doSetPin(f.dataset.adminpin, i.value.trim(), null, () => { i.value = ''; setAuthBusy(false); setAuthErr(''); });
      }
    });
  }

  let whoResolve = null;
  function openWho() {
    const names = (CFG.EXTRA_USERS || ['Director']).concat(S.callers);
    $('#whoList').innerHTML = names.map(n => '<button type="button" data-who="' + esc(n) + '" class="' + (S.user === n ? 'on' : '') + '">' + esc(n) +
      '<small>' + (S.callers.includes(n) ? 'Caller' : 'Management') + '</small></button>').join('');
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
    if (p.program) {
      s += esc(p.program) +
        (/^director$/i.test(String(p.givenBy || '').trim()) ? ' <b class="by-d" title="Given by the Director">(D)</b>' : '') +
        (p.informed === 'Yes' ? ' <span class="ok">✓</span>' : '');
    }
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
    // "Remove programs": every program shown in this print (U&N / Caller wise)
    const withProg = printedPrograms();
    $('#clearProgBtn').hidden = !withProg.length;
    $('#clearProgBtn span').textContent = 'Remove programs (' + withProg.length + ')';
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

  /** vehicles whose program shows in the current print (only U&N and Caller wise have program columns) */
  function printedPrograms() {
    if (S.print.rep !== 'un' && S.print.rep !== 'caller') return [];
    return S.vehicles.filter(v => NEEDS_PROGRAM[v.cat] && (!S.print.caller || v.callerName === S.print.caller) &&
      S.active[v.vno] && (S.active[v.vno].program || S.active[v.vno].broker)).map(v => v.vno);
  }
  async function clearPrintedPrograms() {
    const vnos = printedPrograms();
    if (!vnos.length) return;
    const who = S.print.caller ? 'caller ' + S.print.caller : 'all callers';
    if (!confirm('Remove the program of ' + vnos.length + ' vehicle' + (vnos.length > 1 ? 's' : '') + ' (' + who + ')?\nThey go back to “Need program”.')) return;
    if (!(await ensureUser())) return;
    for (const vno of vnos) await saveProgram(vno, { program: '', broker: '', note: '' }, false);
    toast('Programs removed from ' + vnos.length + ' vehicle' + (vnos.length > 1 ? 's' : ''));
    renderAll();
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
    if (!['board', 'programs', 'print', 'route', 'hub', 'draw'].includes(view)) view = 'board';
    if (['route', 'hub', 'draw'].includes(view)) loadDrawn();   // the Director's drawn roads (again after 2 minutes)
    S.view = view;
    $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + view; });
    $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    if (!noHash && location.hash !== '#' + view) { try { history.replaceState(history.state, '', '#' + view); } catch (e) { location.hash = view; } }
    renderAll();
    renderBulkBar();
    window.scrollTo(0, 0);
  }

  /* =====================================================================
   *  Route — every From → To as a road, its vehicles as dots: at the loading point, on the way
   *  (grouped by where they are now) or at the unloading point. The sheet has no distances / GPS,
   *  so the place on the road comes from the status and the current location.
   * ===================================================================== */
  /** "CG08BA4211" → "BA42": series letters + first two digits (the fleet's numbers mostly end the same way) */
  function shortNo(vno) {
    const m = String(vno).match(/([A-Z]{1,3})(\d{2,4})$/);
    return m ? m[1] + m[2].slice(0, 2) : String(vno).slice(-4);
  }
  function routeZone(v) {
    const now = spellKey(v.cur);   // "KESKAL" / "Keskal " / "KESKAAL" are the same place
    if (now && now === spellKey(v.to)) return 'end';
    if (now && now === spellKey(v.from)) return 'start';
    if (v.cat === 'loading') return 'start';
    if (v.cat === 'unloading') return 'end';
    return 'way';
  }
  function routeGroups() {
    const by = {};
    let noRoute = 0;
    S.vehicles.forEach(v => {
      if (v.cat === 'sold' || (S.f.caller && v.callerName !== S.f.caller)) return;
      if (!v.from && !v.to) { noRoute++; return; }
      const key = v.from + '→' + v.to;
      (by[key] = by[key] || { from: v.from, to: v.to, vs: [] }).vs.push(v);
    });
    const q = norm(S.rq);
    let routes = Object.keys(by).map(k => by[k]);
    if (q) routes = routes.filter(r => norm(r.from + ' ' + r.to).includes(q) || r.vs.some(v => v.search.includes(q)));
    if (S.rcat) routes = routes.filter(r => r.vs.some(v => v.cat === S.rcat));
    routes.sort((a, b) => b.vs.length - a.vs.length || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    return { routes: routes, noRoute: noRoute };
  }
  /* ---- a route's ways: OSRM's road, its other ways, and the way through a town where trucks stand ---- */
  // colour, edge — pink, gold, sky, lime: none is a truck status colour (Loading blue, Unloading violet, Running green…)
  const LANES = [['#e8368f', '#9c1458'], ['#f0a30a', '#a86b00'], ['#29b6f6', '#0277bd'], ['#8bc34a', '#4b7a0a']];
  const ON_WAY = 25;   // km: a town this near a way is on it
  /** every way a lorry may take from A to B: OSRM's road and its other ways, plus the way through a town where trucks
   *  stand that is on none of them — when that is not much longer (Konsari → Vizianagaram: via Narayanpur, via Aheri ·
   *  Bijapur and, where the trucks are, via Kanker · Keshkal). stops: points, busiest first.
   *  side: stops just off a way (a short trip off the road and back) — no way of their own, not "galat" either */
  function routeWays(A, B, stops, sure, drawn) {   // sure: places the office said the lorries pass on this route (VPT_ROUTE_OK)
    const alts = roadAlts(A, B), main = roadKnown(A, B), side = new Set();   // drawn: the Director's roads from Route Finder
    if (!main && !(drawn && drawn.length)) return { ways: [], side: side };
    const ways = main ? [main] : [], ab = kmApart(A, B);
    const sample = pts => { const step = Math.max(1, Math.floor(pts.length / 40)); return pts.filter((q, i) => i % step === 0); };
    const offAll = pts => sample(pts).filter(q => !ways.some(x => alongLine(x.pts, q).off <= 5));   // the part on none of the ways
    // OSRM's other ways — not one that is nearly the same road
    if (main) alts.forEach(w => { if (ways.length < LANES.length && offAll(w.pts).length >= sample(w.pts).length * 0.15) ways.push(w); });
    // the Director's drawn roads: always a way (counts all its trucks, first on a tie); one that is nearly a way already takes its place
    (drawn || []).forEach(d => {
      const same = (x, y) => sample(x).filter(q => alongLine(y, q).off <= 5).length >= sample(x).length * 0.9;
      const i = ways.findIndex(w => same(d.pts, w.pts) && same(w.pts, d.pts)), way = Object.assign({}, d, { sure: true, via: i >= 0 ? ways[i].via : true });
      if (i >= 0) ways[i] = way;
      else { ways.splice(Math.min(ways.length, LANES.length - 1), 0, way); ways.length = Math.min(ways.length, LANES.length); }
    });
    const best = Math.min(...ways.map(w => w.km));
    // the office's way: one road through all its places in order (Somini → Kondagaon → Vizag → Anakapalli → Kakinada),
    // however long — or, when one of the ways already passes them all, that one
    const told = (sure || []).filter((p, i, l) => l.findIndex(q => q.join() === p.join()) === i && p.join() !== A.join() && p.join() !== B.join());
    if (told.length) {
      const own = ways.findIndex(w => told.every(p => alongLine(w.pts, p).off <= ON_WAY));
      if (own >= 0) ways[own] = Object.assign({}, ways[own], { sure: true });
      else {
        const at = p => kmApart(A, p) / (kmApart(A, p) + kmApart(p, B) || 1);
        const pts = [A].concat(told.sort((x, y) => at(x) - at(y)), [B]), legs = pts.slice(1).map((p, i) => road(pts[i], p));   // asked for once
        const km = legs.every(Boolean) ? legs.reduce((s, l) => s + l.km, 0) : Infinity;
        if (km <= best * 2.2 + 30) {
          ways.splice(Math.min(ways.length, LANES.length - 1), 0, { pts: legs.reduce((s, l, i) => s.concat(i ? l.pts.slice(1) : l.pts), []),
            km: km, min: legs.reduce((s, l) => s + l.min, 0), via: true, sure: true });
          ways.length = Math.min(ways.length, LANES.length);
        }
      }
    }
    stops.forEach(p => {
      if (ways.some(w => alongLine(w.pts, p).off <= ON_WAY) || kmApart(A, p) + kmApart(p, B) > ab * 1.6 + 40) return;   // on a way already / far off: nothing to ask
      const r1 = road(A, p), r2 = road(p, B);   // asked for once
      if (!r1 || !r2 || r1.km + r2.km > best * 1.35 + 30) return;   // a long way round: the current location is probably wrong
      // out to the town and back on the same road (a short trip off the way): no way of its own
      const o1 = offAll(r1.pts), o2 = offAll(r2.pts);
      const back = o1.length + o2.length < 4 || o2.filter(q => alongLine(r1.pts, q).off <= 3).length >= o2.length * 0.6;
      if (back || ways.length >= LANES.length) side.add(p.join());
      else ways.push({ pts: r1.pts.concat(r2.pts.slice(1)), km: r1.km + r2.km, min: r1.min + r2.min, via: true });
    });
    return { ways: ways, side: side };
  }
  // towns a way is called by: one name per point; no states, plants or offices
  let townList = null;
  function towns() {
    if (townList) return townList;
    const seen = {};
    townList = Object.keys(PLACES).filter(n => /^[A-Z]{4,}$/.test(n) && !NOT_PLACE.test(n) && !/^(NAME|PLACE|EMAMI|SOMINI|TELANGANA|KARNATAKA?|GUJA?RAT|GUJRAT)$/.test(n))
      .filter(n => !seen[PLACES[n].join()] && (seen[PLACES[n].join()] = 1)).map(n => ({ n: n.charAt(0) + n.slice(1).toLowerCase(), p: PLACES[n] }));
    return townList;
  }
  const nameMem = {};
  /** "Kanker · Keshkal": the towns on each way that the other ways do not pass (just one way: two towns along it) */
  function wayNames(ways, A, B) {
    const key = A.join() + '>' + B.join() + '|' + ways.map(w => w.km + ':' + w.pts.length).join(',');
    if (nameMem[key]) return nameMem[key];
    const T = towns().filter(t => kmApart(t.p, A) > 30 && kmApart(t.p, B) > 30);
    nameMem[key] = ways.map((w, i) => {
      const la = w.pts.map(q => q[0]), lo = w.pts.map(q => q[1]);
      const box = [Math.min(...la) - .1, Math.max(...la) + .1, Math.min(...lo) - .1, Math.max(...lo) + .1];   // a quick test first
      const near = T.filter(t => t.p[0] > box[0] && t.p[0] < box[1] && t.p[1] > box[2] && t.p[1] < box[3]).map(t => ({ n: t.n, p: t.p, o: alongLine(w.pts, t.p) }));
      const on6 = near.filter(t => t.o.off <= 6), on = on6.length ? on6 : near.filter(t => t.o.off <= 15);   // few known towns there: a bit wider
      let pick = ways.length < 2 ? [] : on.map(t => Object.assign(t, { far: Math.min(...ways.filter((x, j) => j !== i).map(x => alongLine(x.pts, t.p).off)) }))
        .filter(t => t.far > 15).sort((x, y) => y.far - x.far).slice(0, 2);
      if (!pick.length) pick = [0.35, 0.7].map(f => on.slice().sort((x, y) => Math.abs(x.o.along / x.o.total - f) - Math.abs(y.o.along / y.o.total - f))[0])
        .filter((t, k, l) => t && l.indexOf(t) === k);
      return pick.sort((x, y) => x.o.along - y.o.along).map(t => t.n).join(' · ');
    });
    return nameMem[key];
  }
  const truckMin = w => Math.max(w.min * 1.4, w.km * 60 / 45);   // as truckTime
  /** a route for the Road view / the map: its ways as lanes — the one with most trucks on it first, then the quickest —
   *  each with its name, km, truck time and colour; every stop on the way (trucks grouped by where they are now, one
   *  stop per point: GADHCHIROLI / GADCHIROLI are one) on its lane, ≈ km from A, or marked off route */
  function routeLanes(r) {
    const A = placeLL(r.from, true), B = placeLL(r.to, true), ok = !!(A && B && A.join() !== B.join()), byPlace = {};
    r.vs.filter(v => routeZone(v) === 'way').sort((a, b) => CAT[a.cat].i - CAT[b.cat].i).forEach(v => {
      const ll = v.cur && placeOn(v.cur, A, B, true), k = ll ? ll.join() : spellKey(v.cur) || '—';
      const c = byPlace[k] = byPlace[k] || { spell: {}, vs: [] };
      c.vs.push(v);
      if (v.cur) c.spell[v.cur] = (c.spell[v.cur] || 0) + 1;
    });
    const stops = Object.values(byPlace).map(c => {
      const place = Object.keys(c.spell).sort((x, y) => c.spell[y] - c.spell[x])[0] || '—';
      return { place: place, vs: c.vs, p: ok && place !== '—' ? placeOn(place, A, B, true) : null, at: -1, km: null, lane: 0 };
    });
    const told = (ROUTE_VIA[spellKey(r.from) + '>' + spellKey(r.to)] || []).map(n => ({ n: n, p: ok && placeOn(n, A, B, true) })).filter(x => x.p);
    const sure = told.map(x => x.p);
    const W = ok ? routeWays(A, B, stops.filter(c => c.p).sort((x, y) => y.vs.length - x.vs.length).map(c => c.p), sure, drawnFor(r.from, r.to)) : { ways: [], side: new Set() };
    const ways = W.ways, ab = ok ? kmApart(A, B) : 0;
    stops.forEach(c => { c.o = c.p ? ways.map(w => alongLine(w.pts, c.p)) : []; c.on = c.o.map(o => o.off <= ON_WAY); });
    // trucks on each way; a way through a town where trucks stand counts only the trucks on none of OSRM's ways —
    // a truck on the main road and on that way too stays on the main road. The way the office named (Kanker, Keshkal
    // on Konsari → Vizianagaram) counts all its trucks and comes first on a tie: that is the lorries' road
    const onOsrm = c => c.on.some((x, j) => x && !ways[j].via);
    const weight = ways.map((w, i) => stops.reduce((s, c) => s + (c.on[i] && !(w.via && !w.sure && onOsrm(c)) ? c.vs.length : 0), 0));
    const order = ways.map((w, i) => i).sort((x, y) => weight[y] - weight[x] || !!ways[y].sure - !!ways[x].sure || truckMin(ways[x]) - truckMin(ways[y]));
    const names = ways.length ? wayNames(ways, A, B).slice() : [];
    // the office's way is called by the places it named, in the order a lorry meets them ("via Kondagaon · Vishakhapatnam")
    const at = p => kmApart(A, p) / (kmApart(A, p) + kmApart(p, B) || 1);
    ways.forEach((w, i) => {
      if (w.code) { if (w.dname) names[i] = w.dname; }   // a drawn road: the towns it was saved with
      else if (w.sure && told.length) names[i] = told.slice().sort((x, y) => at(x.p) - at(y.p)).slice(0, 2).map(x => x.n.charAt(0) + x.n.slice(1).toLowerCase()).join(' · ');
    });
    const quick = ways.length > 1 ? ways.reduce((x, y) => (truckMin(y) < truckMin(x) ? y : x)) : null;
    const one = ways.length < 2;   // just one road: Google blue as before
    const lanes = order.map((i, li) => ({ w: ways[i], name: names[i], main: !i, code: ways[i].code || '', col: one ? '#1a73e8' : LANES[li][0], edge: one ? '#0b3d91' : LANES[li][1], quick: ways[i] === quick, n: 0 }));
    if (!lanes.length) lanes.push({ w: null, name: '', n: 0 });
    stops.forEach(c => {
      if (!c.p) return;
      const near = order.findIndex(i => c.on[i]);
      // on no way: beside the one it is nearest to, in the order of how far it is from A compared with B
      const li = near >= 0 ? near : ways.length ? order.indexOf(c.o.indexOf(c.o.reduce((x, y) => (y.off < x.off ? y : x)))) : 0;
      const w = lanes[li].w, o = ways.length ? c.o[order[li]] : null, dA = kmApart(A, c.p), dB = kmApart(c.p, B);
      c.lane = li;
      c.at = near >= 0 ? o.along / (o.total || 1) : dA / (dA + dB || 1);
      c.km = Math.round(c.at * (w ? w.km : ab * 1.25) / 5) * 5;   // grows with the order
      c.about = true;
      c.off = near < 0 && !W.side.has(c.p.join()) && alongLine([A, B], c.p).off > Math.max(60, ab * 0.25) && !routeOk(r.from, r.to, c.place);
    });
    stops.forEach(c => { if (c.p) lanes[c.lane].n += c.vs.length; });   // place not known: shown on the first lane, not counted on it
    lanes.forEach((l, i) => { l.stops = stops.filter(c => c.lane === i).sort((x, y) => x.at - y.at); });
    return { A: A, B: B, lanes: lanes };
  }
  function routeCard(r) {
    const zones = { start: [], way: [], end: [] }, counts = {};
    r.vs.forEach(v => { zones[routeZone(v)].push(v); counts[v.cat] = (counts[v.cat] || 0) + 1; });
    // vehicles at the same place stand together
    const clusters = z => zones[z].sort((a, b) => CAT[a.cat].i - CAT[b.cat].i);
    // the ways from A to B, one lane each; the trucks on the way on the lane of the way they are on
    const R = routeLanes(r), multi = R.lanes.length > 1, lit = multi ? (S.rlane || {})[r.from + '→' + r.to] : undefined;   // a way tapped to light it up
    let n = 0; // trucks pop in one after another
    const dot = v => '<button type="button" class="rdot rd-' + v.cat + (S.rcat && v.cat !== S.rcat ? ' dim' : '') + '" data-v="' + esc(v.vno) + '" style="--c:' + CAT[v.cat].color + ';--i:' + (n++) + '"' +
      ' aria-label="' + esc(v.vno + ', ' + CAT[v.cat].label + (v.cur ? ', now at ' + v.cur : '')) + '">' + ICO.truck + '<span>' + esc(shortNo(v.vno)) + '</span></button>';
    // a stop on the way is at least as wide as its place name, so the name stays on one line
    const tagW = c => Math.max(c.off ? 150 : 0, Math.min(170, 30 + c.place.length * 7 + (c.vs.length > 1 ? 18 : 0)));   // room for the warning too
    const zone = way => '<div class="rz rz-way">' + way.map(c =>
      '<div class="rc' + (c.off ? ' off' : '') + '" style="--tw:' + tagW(c) + 'px"><div class="rc-dots" style="--rows:' + Math.min(c.vs.length, 4) + '">' + c.vs.map(dot).join('') + '</div>' +
      '<div class="rc-place"><span>' + ICO.pin + esc(c.place) + (c.vs.length > 1 ? ' <b>×' + c.vs.length + '</b>' : '') +
        (c.off ? '<em class="off" title="This place is on none of the roads from A to B — check the current location in the Calling Sheet">⚠ Current location galat hai</em>' : c.km !== null ? '<em>' + (c.about ? '≈ ' : '') + c.km + ' km</em>' : '') + '</span></div></div>').join('') + '</div>';
    // trucks that have reached A / B stand right on that pin, not on a stop before it
    const at = z => {
      const vs = clusters(z);
      return vs.length ? '<div class="r-at"><div class="rc-dots" style="--rows:' + Math.min(vs.length, 4) + '">' + vs.map(dot).join('') + '</div></div>' : '';
    };
    const here = z => zones[z].length ? ' · ' + zones[z].length + ' here' : '';
    const items = [...new Set(r.vs.map(v => v.item).filter(Boolean))];
    return '<article class="route" style="--k:' + Math.min(r.k || 0, 12) + '">' +
      // the route name on a green highway signboard
      '<div class="r-head"><div class="r-title"><div class="r-sign"><span>' + esc(r.from || 'Start not set') + '</span>' +
      '<svg class="rs-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h15M13 6l6 6-6 6"/></svg><span>' + esc(r.to || 'Not set yet') + '</span></div>' +
      (items.length ? '<span class="r-items">' + esc(items.join(' · ')) + '</span>' : '') + '</div>' +
      '<span class="r-count" style="--c:var(--orange-d)">' + ICO.truck + '<b>' + r.vs.length + '</b> vehicle' + (r.vs.length > 1 ? 's' : '') + '</span>' +
      // how this route's trucks split by status, as one coloured bar
      '<div class="r-bar">' + CATS.filter(c => counts[c.key]).map(c => '<i style="--c:' + c.color + ';flex-grow:' + counts[c.key] + '" title="' +
        esc(c.label + ': ' + counts[c.key]) + '"></i>').join('') + '</div></div>' +
      '<div class="r-track-wrap"><div class="r-ways' + (multi ? ' multi' : '') + (R.lanes[lit] ? ' r-picked' : '') + '" data-route="' + esc(r.from + '→' + r.to) + '">' +
      (multi ? '<div class="r-ways-t">🛣️ <b>' + R.lanes.length + ' possible routes</b> from A to B (real roads, like Google Maps) · tap one to highlight it' +
        '<button type="button" class="link" data-rmap="' + esc(r.from + '→' + r.to) + '">See them on the map</button></div>' : '') +
      R.lanes.map((l, i) => '<div class="r-lane' + (l.stops.length ? '' : ' r-bare') + (multi && !l.stops.length ? ' r-none' : '') + (i === lit ? ' on' : '') + '" style="--lc:' + (l.col || '#c3c8dc') + '">' +
        // the way's name, km and truck time ("Fastest" on the quickest of several)
        (l.w ? '<' + (multi ? 'button type="button" data-lane="' + i + '"' : 'div') + ' class="r-lane-h">' + (multi ? '<i class="rw-no">' + (i + 1) + '</i>' : ICO.road) +
          (l.code ? '<span class="rw-code" title="Drawn in Route Finder, added by the Director">' + esc(l.code) + '</span>' : '') + '<b>' + (l.name ? 'via ' + esc(l.name) : multi ? (l.main ? 'Main road' : 'Other road') : 'Road') + '</b><span>' + l.w.km + ' km · ≈ ' + esc(truckTime(l.w.min, l.w.km)) + ' by truck</span>' +
          (multi ? '<span class="rw-n">' + (l.n ? l.n + ' truck' + (l.n > 1 ? 's' : '') + ' on it' : 'no truck on it now') + '</span>' : '') +
          (l.quick ? '<em>Fastest</em>' : '') + '</' + (multi ? 'button' : 'div') + '>' : '') +
        '<div class="r-track"><div class="r-road"></div>' +
        // A / B with their trucks on the first lane; the other lanes start and end at a small A / B
        (i ? '<div class="r-end r-from r-ghost"><span class="node"><i>A</i></span><b>' + esc(r.from) + '</b></div>'
          : '<div class="r-end r-from">' + at('start') + '<span class="node"><i>A</i></span><b>' + esc(r.from || '?') + '</b><small>' + ICO.load + 'Loading point' + here('start') + '</small></div>') +
        zone(l.stops) +
        (i ? '<div class="r-end r-to r-ghost"><span class="node"><i>B</i></span><b>' + esc(r.to) + '</b></div>'
          : '<div class="r-end r-to">' + at('end') + '<span class="node"><i>B</i></span><b>' + esc(r.to || '?') + '</b><small>' + ICO.flag + 'Unloading point' + here('end') + '</small></div>') +
        '</div></div>').join('') +
      '</div></div>' +
      // colour guide: every status, how many of this route's vehicles have it
      '<div class="r-legend"><span class="rl-t">Colour guide</span>' + CATS.map(c =>
        '<span class="rl' + (counts[c.key] ? '' : ' zero') + '" style="--c:' + c.color + '"><i></i>' + esc(c.label) + ' <b>' + (counts[c.key] || 0) + '</b></span>').join('') +
      '<button type="button" class="rl-all">All colours ▾</button>' +
      '<span class="rl-key"><span class="node-mini">A</span> loading point · <span class="node-mini b">B</span> unloading point · ' + ICO.pin + ' where it is now</span></div>' +
      '</article>';
  }

  /* ---- the small window over a vehicle dot (hover on a computer, tap on a phone) ---- */
  let popTimer = null;
  function routePopHtml(v) {
    const p = S.active[v.vno], c = CAT[v.cat];
    const row = (ico, html) => html ? '<div class="rp-row"><span class="rp-i">' + ico + '</span><div>' + html + '</div></div>' : '';
    return '<div class="rp-head" style="--c:' + c.color + '">' + plate(v.vno) + '<span class="badge" style="--c:' + c.color + '">' + esc(c.label) + '</span>' +
      (v.late ? '<span class="badge late">Late</span>' : '') + '</div>' +
      row('📍', 'Now at <b>' + esc(v.cur || '—') + '</b>') +
      row('🛣️', v.from || v.to ? esc(v.from || '?') + ' → ' + esc(v.to || 'not set') + (v.item ? ' · ' + esc(v.item) : '') : '') +
      row('👤', v.driver ? '<b>' + esc(v.driver) + '</b>' + (v.driverId ? ' <span class="muted">' + esc(v.driverId) + '</span>' : '') + (v.phoneDigits ? '<br>' + esc(v.phoneDigits) : '') : '<span class="muted">No driver details</span>') +
      row('☎️', 'Caller <b>' + esc(v.callerName) + '</b>' + (v.callTime ? ' · called ' + esc(v.callTime) : '')) +
      row('📋', p && p.program ? 'Program <b>' + esc(p.program) + '</b>' + (p.informed === 'Yes' ? ' · <span class="m-ok">driver told ✓</span>' : '') : '') +
      row('💬', v.remarks ? '<i>“' + esc(v.remarks) + '”</i>' : '') +
      '<div class="rp-act">' +
      (v.phoneDigits ? '<a class="btn sm call-btn" href="tel:+91' + v.phoneDigits + '">' + ICO.phone + 'Call</a>' +
        '<a class="btn sm wa-btn" href="' + esc(waLink(v)) + '" target="_blank" rel="noopener">' + ICO.wa + 'WhatsApp</a>' : '') +
      '<button type="button" class="btn sm navy" data-rp-open="' + esc(v.vno) + '">Full details</button></div>';
  }
  function showRoutePop(dot) {
    const v = S.byVno[dot.dataset.v];
    if (!v) return;
    clearTimeout(popTimer);
    const pop = $('#rpop');
    if (pop.dataset.v !== v.vno || pop.hidden) { pop.innerHTML = routePopHtml(v); pop.dataset.v = v.vno; }
    pop.hidden = false;
    $$('.rdot.on').forEach(d => d.classList.remove('on'));
    dot.classList.add('on');
    // above the dot when there is room, else below; always inside the screen
    const r = dot.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, m = 8;
    const left = Math.max(m, Math.min(window.innerWidth - w - m, r.left + r.width / 2 - w / 2));
    const above = r.top - h - 10 >= m;
    pop.style.left = left + 'px';
    pop.style.top = (above ? r.top - h - 10 : Math.min(window.innerHeight - h - m, r.bottom + 10)) + 'px';
    pop.style.setProperty('--ax', Math.max(14, Math.min(w - 14, r.left + r.width / 2 - left)) + 'px');
    pop.classList.toggle('below', !above);
  }
  function hideRoutePop(soon) {
    clearTimeout(popTimer);
    const go = () => { $('#rpop').hidden = true; $$('.rdot.on').forEach(d => d.classList.remove('on')); };
    if (soon) popTimer = setTimeout(go, 220); else go();
  }
  function renderRoutes() {
    const key = [S.ver, S.f.caller, S.rq, S.rcat, S.vehicles.length].join('|');
    if (key === S.routeKey) { if (S.rmode === 'map' && MAPS.routeMap) MAPS.routeMap.map.invalidateSize(); return; }
    S.routeKey = key;
    const list = $('#routeList');
    if (!S.vehicles.length) { list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'; return; }
    const g = routeGroups(), counts = {};
    g.routes.forEach(r => r.vs.forEach(v => { counts[v.cat] = (counts[v.cat] || 0) + 1; }));
    $('#routeLegend').innerHTML = CATS.filter(c => counts[c.key] || S.rcat === c.key).map(c =>
      '<button type="button" class="chip' + (S.rcat === c.key ? ' on' : '') + '" data-rcat="' + c.key + '" style="--c:' + c.color + '"><span class="sw"></span>' +
      esc(c.label) + ' <b>' + (counts[c.key] || 0) + '</b></button>').join('');
    // summary cards over the routes
    const onRoad = g.routes.reduce((s, r) => s + r.vs.length, 0);
    const kpi = (lbl, n, color, ico) => '<div class="rk" style="--c:' + color + '"><span class="rk-i">' + ico + '</span><b>' + n + '</b><small>' + esc(lbl) + '</small></div>';
    $('#routeSum').innerHTML = kpi('Routes', g.routes.length, 'var(--navy-3)', ICO.road) + kpi('Trucks on routes', onRoad, 'var(--orange)', ICO.truck) +
      ['running', 'loading', 'unloading', 'repair'].map(k => kpi(CAT[k].label, counts[k] || 0, CAT[k].color, ICO.truck)).join('');
    hideRoutePop();
    list.innerHTML = (g.routes.length ? g.routes.map((r, i) => { r.k = i; return routeCard(r); }).join('')
      : '<div class="empty"><b>No route found</b>' + (S.rq || S.rcat ? 'Clear the search / status to see all routes.' : '') + '</div>') +
      (g.noRoute ? '<p class="hint">' + g.noRoute + ' vehicle' + (g.noRoute > 1 ? 's have' : ' has') + ' no From / To in the Calling Sheet, so ' + (g.noRoute > 1 ? 'they are' : 'it is') + ' not on a route.</p>' : '');
    if (S.rmode === 'map') renderRouteMap();
  }

  /* =====================================================================
   *  Hub Analyzer — one place in the middle of a spider web, all its routes around it.
   *  Loading point X:  in  = empty trucks heading to X to load (their From is X), from where they are now,
   *                          + trucks whose program is X;  at = loading at X;  out = loaded from X, by To.
   *  Unloading point Y: in = loaded trucks on the way to Y, by From;  at = unloading at Y;
   *                     out = empty trucks leaving Y for their next loading point + next-load programs.
   * ===================================================================== */
  const HUB_COL = { load: { in: '#0e9fb8', out: '#16a34a' }, unload: { in: '#16a34a', out: '#0e9fb8' } };
  /** the sheet spells some places several ways (VIZIANAGRAM / VIZIANAGARAM / VIZIANGARAM):
   *  places whose letters differ only in vowels count as one, shown with the spelling used most */
  const spellKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[AEIOU]/g, '');
  function hubGroups(list, key) {
    const m = {}, spell = {};
    list.forEach(x => {
      const name = x[key] || '—', k = spellKey(name) || name;
      (m[k] = m[k] || []).push(x.v);
      (spell[k] = spell[k] || {})[name] = (spell[k][name] || 0) + 1;
    });
    const best = k => Object.keys(spell[k]).sort((a, b) => spell[k][b] - spell[k][a] || a.length - b.length)[0];
    return Object.keys(m).map(k => ({ place: best(k), vs: m[k] })).sort((a, b) => b.vs.length - a.vs.length || a.place.localeCompare(b.place));
  }
  function hubData(mode, hubName) {
    const at = [], inn = [], out = [], used = new Set(), hub = spellKey(hubName);
    const live = S.vehicles.filter(v => v.cat !== 'sold');
    const is = s => !!s && spellKey(s) === hub;
    if (mode === 'load') {
      live.forEach(v => {
        if (v.cat === 'loading' && (is(v.from) || (!v.from && is(v.cur)))) { at.push(v); used.add(v.vno); }
        else if (v.cat === 'empty' && is(v.from)) { inn.push({ v: v, at: v.cur || '—' }); used.add(v.vno); }
        else if (is(v.from) && ['running', 'unloading', 'loadnd'].includes(v.cat)) { out.push({ v: v, to: v.to || 'Not set' }); used.add(v.vno); }
      });
      // trucks given a program to this place are coming here too
      const h = norm(hubName);
      live.forEach(v => {
        const p = S.active[v.vno];
        if (used.has(v.vno) || !p || !p.program || !['unloading', 'noprog', 'empty'].includes(v.cat) || !norm(p.program).includes(h)) return;
        inn.push({ v: v, at: v.cur || v.to || '—', prog: true });
      });
    } else {
      live.forEach(v => {
        if (v.cat === 'unloading' && is(v.to)) {
          at.push(v);
          const p = S.active[v.vno];
          if (p && p.program) out.push({ v: v, to: up(p.program).slice(0, 24), prog: true });
        } else if (is(v.to) && ['running', 'loadnd'].includes(v.cat)) inn.push({ v: v, from: v.from || '—' });
        else if (v.cat === 'empty' && is(v.cur)) out.push({ v: v, to: v.from || 'Not set' });
      });
    }
    return { at: at, inn: hubGroups(inn, mode === 'load' ? 'at' : 'from'), out: hubGroups(out, 'to'),
      nIn: inn.length, nOut: out.length, progs: new Set(inn.concat(out).filter(x => x.prog).map(x => x.v.vno)) };
  }
  /** hubs to choose from, busiest first */
  function hubList(mode) {
    const spell = {}; // one entry per place, named with its most used spelling
    S.vehicles.forEach(v => {
      if (v.cat === 'sold') return;
      const name = mode === 'load' ? v.from : v.to;
      if (!name || !['loading', 'running', 'unloading', 'empty', 'loadnd'].includes(v.cat)) return;
      const k = spellKey(name);
      (spell[k] = spell[k] || {})[name] = (spell[k][name] || 0) + 1;
    });
    return Object.keys(spell).map(k => {
      const n = Object.keys(spell[k]).sort((a, b) => spell[k][b] - spell[k][a] || a.length - b.length)[0], d = hubData(mode, n);
      return { name: n, n: d.nIn + d.at.length + d.nOut };
    }).filter(h => h.n).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }
  /** where a truck is right now, said short: "at hub" / "reached" (already at the row's place) / its current location */
  function hubNow(v, place) {
    const k = spellKey(v.cur);
    if (!k) return '';
    return k === spellKey(S.hub) ? 'at hub' : place && k === spellKey(place) ? 'reached' : v.cur;
  }
  /** a row's trucks by where they are now: "KORAPUT ×3 · MANPUR · +2" */
  function hubNowLine(vs, place) {
    const gs = hubGroups(vs.map(v => ({ v: v, now: hubNow(v, place) })).filter(x => x.now), 'now');
    if (!gs.length) return '';
    const one = g => esc(g.place) + (g.vs.length > 1 ? ' ×' + g.vs.length : '');
    return gs.slice(0, 2).map(one).join(' · ') + (gs.length > 2 ? ' · +' + (gs.length - 2) : '');
  }
  /** truck pills: 🚚 BA42 (📋 = program given), and with a place given also where it is now */
  function hubTrucks(vs, progs, place) {
    return vs.map(v => {
      const now = place === undefined ? '' : hubNow(v, place);
      return '<button type="button" class="rdot rd-' + v.cat + '" data-v="' + esc(v.vno) + '" style="--c:' + CAT[v.cat].color + '" aria-label="' + esc(v.vno + ', ' + CAT[v.cat].label + (v.cur ? ', now at ' + v.cur : '')) + '">' +
        ICO.truck + '<span>' + esc(shortNo(v.vno)) + (progs.has(v.vno) ? ' 📋' : '') + '</span>' +
        (now ? '<small class="hf-at-now' + (now === 'reached' || now === 'at hub' ? ' ok' : '') + '">' + ICO.pin + esc(now) + '</small>' : '') + '</button>';
    }).join('');
  }
  /** one side of the flow: slim place rows (📍 name · status bar · count) that open to show their trucks;
   *  the busiest 7, then "+ N more" */
  function hubSide(side, d) {
    const gs = side === 'in' ? d.inn : d.out, max = 7, all = S.hubAll[side];
    const show = all || gs.length <= max ? gs : gs.slice(0, max - 1), more = gs.length - show.length;
    const bar = vs => {
      const c = {};
      vs.forEach(v => { c[v.cat] = (c[v.cat] || 0) + 1; });
      return '<span class="hf-bar">' + CATS.filter(k => c[k.key]).map(k => '<i style="--c:' + k.color + ';flex-grow:' + c[k.key] + '"></i>').join('') + '</span>';
    };
    const load = S.hmode === 'load';
    const empty = side === 'in' ? 'No truck is on the way here right now.' : load ? 'No loaded truck from here right now.' : 'No truck is leaving from here right now.';
    // coming to load: the place already is where the trucks are now; everywhere else say it under the name
    const sayNow = !(load && side === 'in');
    return (gs.length ? show.map((g, i) => {
      const now = sayNow ? hubNowLine(g.vs, g.place) : '';
      return '<div class="hf-item">' +
      '<button type="button" class="hf-row ' + (i % 2 ? 'pk' : 'yl') + '" data-hrow="' + side + '|' + esc(g.place) + '" data-n="' + g.vs.length + '" title="Tap to see the trucks">' +
      ICO.pin + '<span class="hf-nm"><b>' + esc(g.place) + '</b>' + (now ? '<small class="hf-now" title="Where these trucks are now"><i>now</i> ' + now + '</small>' : '') + '</span>' +
      bar(g.vs) + '<span class="hf-n">' + g.vs.length + '</span></button>' +
      '<div class="hf-trucks hr-trucks">' + hubTrucks(g.vs, d.progs, sayNow ? g.place : undefined) + '</div></div>';
    }).join('') +
      (more ? '<button type="button" class="hf-more" data-hmore="' + side + '">+ ' + more + ' more place' + (more > 1 ? 's' : '') + '</button>' : '')
      : '<p class="hf-none">' + empty + '</p>');
  }
  /** the whole picture in one piece: coming from → hub → going to (on a phone: top to bottom) */
  function hubFlow(d, mode) {
    const load = mode === 'load', col = HUB_COL[mode];
    const s = k => (k === 1 ? '' : 's');
    return '<section class="hflow2" style="--ci:' + col.in + ';--co:' + col.out + '">' +
      '<div class="hf-grid2">' +
        '<div class="hf-col in"><div class="hf-lh">⬇ ' + (load ? 'Coming to load · now at' : 'Coming to unload · from') + ' <span>' + d.nIn + ' truck' + s(d.nIn) + '</span></div>' + hubSide('in', d) + '</div>' +
        '<div class="hf-lane"></div>' +
        '<div class="hf-hubcol"><div class="hf-hub" role="button" tabindex="0" data-hubbox="1" title="Tap to see the trucks here">' +
          '<small>' + (load ? 'Loading point' : 'Unloading point') + '</small><b>' + esc(S.hub) + '</b>' +
          '<div class="hf-hc"><span class="ci">⬅ ' + d.nIn + '</span><span class="ca">' + d.at.length + ' ' + (load ? 'loading' : 'unloading') + '</span><span class="co">' + d.nOut + ' ➡</span></div>' +
          (d.at.length ? '<em>tap: trucks here</em>' : '') + '</div></div>' +
        '<div class="hf-lane"></div>' +
        '<div class="hf-col out"><div class="hf-lh">' + (load ? 'Loaded · going to' : 'After unloading · going to') + ' ⬆ <span>' + d.nOut + ' truck' + s(d.nOut) + '</span></div>' + hubSide('out', d) + '</div>' +
        '<svg class="hf-links" aria-hidden="true"></svg>' +
      '</div>' +
      '<div class="hf-at" hidden><div class="hf-lh">' + (load ? 'Loading at ' : 'Unloading at ') + esc(S.hub) + ' now <span>' + d.at.length + ' truck' + s(d.at.length) + '</span></div>' +
        '<div class="hr-trucks">' + hubTrucks(d.at, d.progs) + '</div></div>' +
      '</section>';
  }
  /** elbow lines with arrows: every "from" row → hub box, hub box → every "to" row;
   *  on a phone (top to bottom): both columns of places join into the hub, the hub forks out to both columns */
  function drawHubLinks() {
    const gr = $('#hubBody .hf-grid2');
    if (!gr) return;
    const svg = $('.hf-links', gr);
    if (getComputedStyle(svg).display === 'none') return;
    const R = gr.getBoundingClientRect(), H = $('.hf-hub', gr).getBoundingClientRect();
    svg.setAttribute('width', R.width); svg.setAttribute('height', R.height);
    svg.setAttribute('viewBox', '0 0 ' + R.width + ' ' + R.height);
    const mk = (id, side) => '<marker id="' + id + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path class="hf-ah ' + side + '" d="M0 0L10 5L0 10z"/></marker>';
    const defs = '<defs>' + mk('hfArrIn', 'in') + mk('hfArrOut', 'out') + '</defs>';
    const width = n => (1.6 + Math.min(4, Math.sqrt(n) * 1.05)).toFixed(1);
    if (getComputedStyle(gr).display !== 'grid') {
      // phone: down one column, round the corner, across to the middle, down into the hub (and the other way out)
      const down = (x1, y1, my, x2, y2) => {
        if (Math.abs(x2 - x1) < 1) return 'M' + x1 + ' ' + y1 + ' V' + y2;
        const r = Math.min(8, Math.abs(x2 - x1) / 2, my - y1, y2 - my), sx = x2 > x1 ? 1 : -1;
        return 'M' + x1 + ' ' + y1 + ' V' + (my - r) + ' Q' + x1 + ' ' + my + ' ' + (x1 + sx * r) + ' ' + my +
          ' H' + (x2 - sx * r) + ' Q' + x2 + ' ' + my + ' ' + x2 + ' ' + (my + r) + ' V' + y2;
      };
      const lanes = $$('.hf-lane', gr).map(l => l.getBoundingClientRect()), xc = H.left + H.width / 2 - R.left;
      const cols = into => {   // each column of places: its centre, how many trucks, where its last place ends
        const sel = into ? '.hf-col.in' : '.hf-col.out', c = {}, col = $(sel, gr).getBoundingClientRect();
        // an opened place and "+ more" span both columns: a line has to start below them
        const wide = Math.max(0, ...$$(sel + ' .hf-item.open, ' + sel + ' .hf-more', gr).map(e => e.getBoundingClientRect().bottom));
        $$(sel + ' .hf-row', gr).forEach(row => {
          const r = row.getBoundingClientRect();
          if (r.width > col.width * 0.7) return;
          const x = Math.round(r.left + r.width / 2 - R.left), k = c[x] = c[x] || { x: x, n: 0, end: 0 };
          k.n += +row.dataset.n || 0;
          k.end = Math.max(k.end, r.bottom, wide);
        });
        return Object.values(c);
      };
      const path = (p, side, n, k) => '<path class="hf-l ' + side + '" d="' + p + '" stroke-width="' + width(n) + '" marker-end="url(#' + (side === 'in' ? 'hfArrIn' : 'hfArrOut') + ')"/>' +
        '<path class="hf-dash" d="' + p + '"/>' +
        [0, 0.7].map(t => '<circle class="hf-mover ' + side + '" r="3.4"><animateMotion dur="1.4s" begin="-' + (t + k * 0.35).toFixed(2) + 's" repeatCount="indefinite" path="' + p + '"/></circle>').join('');
      let out = defs;
      if (lanes[0]) {
        const L = lanes[0], my = L.top + L.height / 2 - R.top, y2 = H.top - R.top - 2;
        out += cols(true).map((c, k) => path(down(c.x, c.end - R.top, my, xc, y2), 'in', c.n, k)).join('');
      }
      if (lanes[1]) {
        const L = lanes[1], y1 = H.bottom - R.top, my = L.top + L.height / 2 - R.top, y2 = L.bottom - R.top - 2;
        out += cols(false).map((c, k) => path(down(xc, y1, my, c.x, y2), 'out', c.n, k)).join('');
      }
      svg.innerHTML = out;
      return;
    }
    const elbow = (x1, y1, mx, x2, y2) => {
      if (Math.abs(y2 - y1) < 1) return 'M' + x1 + ' ' + y1 + ' H' + x2;
      const r = Math.min(9, Math.abs(y2 - y1) / 2, Math.abs(mx - x1), Math.abs(x2 - mx)), sy = y2 > y1 ? 1 : -1, sx = x2 > x1 ? 1 : -1;
      return 'M' + x1 + ' ' + y1 + ' H' + (mx - sx * r) + ' Q' + mx + ' ' + y1 + ' ' + mx + ' ' + (y1 + sy * r) +
        ' V' + (y2 - sy * r) + ' Q' + mx + ' ' + y2 + ' ' + (mx + sx * r) + ' ' + y2 + ' H' + x2;
    };
    const lines = (into) => {
      const rows = $$((into ? '.hf-col.in' : '.hf-col.out') + ' .hf-row', gr), n = rows.length;
      return rows.map((row, i) => {
        const r = row.getBoundingClientRect(), ry = r.top + r.height / 2 - R.top;
        const hy = H.top - R.top + H.height * (i + 1) / (n + 1);   // spread along the hub box side
        const w = width(+row.dataset.n);
        const x1 = into ? r.right - R.left : H.right - R.left, x2 = into ? H.left - R.left - 2 : r.left - R.left - 2;
        const mx = x1 + (x2 - x1) * (n > 1 ? 0.25 + 0.5 * (into ? i : n - 1 - i) / (n - 1) : 0.5);
        const p = elbow(x1, into ? ry : hy, mx, x2, into ? hy : ry);
        return '<path class="hf-l ' + (into ? 'in' : 'out') + '" d="' + p + '" stroke-width="' + w + '" marker-end="url(#' + (into ? 'hfArrIn' : 'hfArrOut') + ')"/><path class="hf-dash" d="' + p + '"/>';
      }).join('');
    };
    svg.innerHTML = defs + lines(true) + lines(false);
  }
  function renderHub() {
    const body = $('#hubBody'), narrow = body.clientWidth < 760;
    const key = [S.ver, S.hmode, S.hub, S.vehicles.length, narrow, JSON.stringify(S.hubAll)].join('|');
    if (key === S.hubKey) { drawHubLinks(); if (S.hview === 'map' && MAPS.hubMap) MAPS.hubMap.map.invalidateSize(); return; }
    S.hubKey = key;
    $$('#hubSeg [data-hmode]').forEach(b => b.classList.toggle('on', b.dataset.hmode === S.hmode));
    if (!S.vehicles.length) { body.innerHTML = '<div class="skeleton"></div>'; return; }
    const hubs = hubList(S.hmode);
    if (!hubs.length) { body.innerHTML = '<div class="empty"><b>No hub found</b>The Calling Sheet has no From / To yet.</div>'; return; }
    S.hub = (hubs.find(h => spellKey(h.name) === spellKey(S.hub)) || hubs[0]).name;
    $('#hubSel').innerHTML = hubs.map(h => '<option value="' + esc(h.name) + '"' + (h.name === S.hub ? ' selected' : '') + '>' + esc(h.name) + ' (' + h.n + ')</option>').join('');
    $('#hubChips').innerHTML = hubs.slice(0, narrow ? 6 : 10).map(h => '<button type="button" class="chip' + (h.name === S.hub ? ' on' : '') + '" data-hub="' + esc(h.name) + '">' + esc(h.name) + ' <b>' + h.n + '</b></button>').join('');
    const d = hubData(S.hmode, S.hub), col = HUB_COL[S.hmode], load = S.hmode === 'load';
    const stat = (lbl, n, sub, c) => '<div class="hst" style="--c:' + c + '"><b>' + n + '</b><span>' + esc(lbl) + '</span><small>' + esc(sub) + '</small></div>';
    body.innerHTML =
      '<div class="hub-stats">' +
        stat(load ? 'Coming to load' : 'Coming to unload', d.nIn, 'from ' + d.inn.length + ' place' + (d.inn.length === 1 ? '' : 's'), col.in) +
        stat(load ? 'Loading here now' : 'Unloading here now', d.at.length, S.hub, 'var(--navy-3)') +
        stat(load ? 'Loaded, going out' : 'Leaving after unloading', d.nOut, 'to ' + d.out.length + ' place' + (d.out.length === 1 ? '' : 's'), col.out) +
      '</div>' + hubFlow(d, S.hmode) +
      '<p class="hint hf-key">Tap a place to see its trucks · tap the hub for the trucks there · 📋 = program given · <b>now</b> = where the trucks are right now<span class="hk-lines"> · thicker line = more trucks</span></p>';
    requestAnimationFrame(drawHubLinks);
    setTimeout(drawHubLinks, 400); // again once the fonts have settled
    if (S.hview === 'map') renderHubMap(d);
  }

  /* =====================================================================
   *  Map — Route and Hub Analyzer on a real map (OpenStreetMap through Leaflet, loaded only when
   *  the map is opened). The Calling Sheet has place names, not GPS, so a vehicle stands at its
   *  current location's town. Where each place is comes from places.js; a name missing there is
   *  looked up once on OpenStreetMap (one name a second at most) and remembered in this browser.
   * ===================================================================== */
  const PLACES = window.VPT_PLACES || {};
  const placeIdx = {};   // spellKey → [lat, lng]: "KESKAL" / "KESKAAL" find the same point
  const placeAlts = {};  // spellKey → every different point under it: SELUR (Gadchiroli) and SALUR (Andhra) are both "SLR"
  Object.keys(PLACES).forEach(k => {
    const s = spellKey(k), p = PLACES[k], l = placeAlts[s] = placeAlts[s] || [];
    placeIdx[s] = p;
    if (!l.some(q => q.join() === p.join())) l.push(p);
  });
  const GEO_KEY = 'vpt_geo_v1';
  const geoMem = store.get(GEO_KEY, {});
  Object.keys(geoMem).forEach(n => { if (!geoMem[n].ll && Date.now() - geoMem[n].t > 14 * 864e5) delete geoMem[n]; }); // ask again after two weeks
  /** [lat, lng] of a place name, or null. loose: only look in what is known (for free text such as programs) */
  function placeLL(name, loose) {
    const n = up(name), k = spellKey(n);
    if (!k || n === '—') return null;
    if (PLACES[n]) return PLACES[n];
    if (placeIdx[k]) return placeIdx[k];
    if (geoMem[n]) return geoMem[n].ll;
    // a known place inside a longer name: "BHANDARA STM", "GADCHIROULI LAHERI M", "KONSARI LOADING"
    const w = n.split(/[^A-Z0-9]+/).filter(Boolean);
    for (let len = Math.min(3, w.length); len >= 1; len--) {
      for (let i = 0; i + len <= w.length; i++) {
        const sk = spellKey(w.slice(i, i + len).join(''));
        if (sk.length >= 3 && placeIdx[sk]) return placeIdx[sk];
      }
    }
    if (!loose) geoAsk(n);
    return null;
  }
  /** the office said this place is right on this route although it is far off the straight way (places.js VPT_ROUTE_OK) */
  const ROUTE_OK = {}, ROUTE_VIA = {};   // ROUTE_VIA: from>to → those places (each makes a way of the route)
  Object.keys(window.VPT_ROUTE_OK || {}).forEach(k => {
    const [f, t] = k.split('>').map(spellKey);
    window.VPT_ROUTE_OK[k].forEach(p => { ROUTE_OK[f + '>' + t + ':' + spellKey(p)] = true; });
    ROUTE_VIA[f + '>' + t] = window.VPT_ROUTE_OK[k];
  });
  const routeOk = (from, to, place) => !!ROUTE_OK[spellKey(from) + '>' + spellKey(to) + ':' + spellKey(place)];
  /** a place on the way from a to b: its own point, unless that is far off the way and another place of nearly the same
   *  name is on it — "SELUR" on Vizag → Shree Cement is Salur (Andhra), on Konsari → Raipur it is Selur (Gadchiroli) */
  function placeOn(name, a, b, loose) {
    const own = placeLL(name, loose), alts = placeAlts[spellKey(name)];
    if (!own || !alts || alts.length < 2 || !a || !b || a.join() === b.join()) return own;
    const way = Math.max(60, kmApart(a, b) * 0.25), off = p => alongLine([a, b], p).off;
    if (off(own) <= way) return own;
    const best = alts.reduce((x, p) => (off(p) < off(x) ? p : x), own);
    return off(best) <= way ? best : own;
  }
  const geoQ = [];
  let geoBusy = false, geoAsked = 0;
  // not places: never looked up (OpenStreetMap would find some office / garage somewhere)
  const NOT_PLACE = /\b(OFFICE|GARAGE|WORKSHOP|HOME|YARD|PARKING|DEPOT|PLANT|SITE|AGRO|ARGO|PUMP|SERVICE|STAND|HOTEL|DHABA|REPAIR)\b/;
  // what OpenStreetMap may answer with: a town / village / area, not a shop or a building
  const GEO_KINDS = ['city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood', 'municipality', 'city_district', 'county', 'district', 'state_district', 'locality', 'industrial'];
  function geoAsk(n) {
    if (geoQ.includes(n) || geoAsked >= 25 || !/[A-Z]{3}/.test(n) || NOT_PLACE.test(n)) return;
    geoQ.push(n);
    geoRun();
  }
  async function geoRun() {
    if (geoBusy) return;
    geoBusy = true;
    while (geoQ.length) {
      const n = geoQ.shift();
      geoAsked++;
      try {
        // only around where the fleet runs (Maharashtra → Jharkhand, Telangana / Andhra → Chhattisgarh)
        const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=in&viewbox=75.5,24,89,15.5&bounded=1&q=' + encodeURIComponent(n));
        const j = r.ok ? await r.json() : null;
        if (j) {
          // many villages share a name: take the one nearest the middle of the fleet's area (Raipur side)
          const far = x => Math.hypot(x.lat - 20.8, x.lon - 81);
          const hit = j.filter(x => GEO_KINDS.includes(x.addresstype)).sort((a, b) => far(a) - far(b))[0];
          geoMem[n] = { ll: hit ? [+(+hit.lat).toFixed(4), +(+hit.lon).toFixed(4)] : null, t: Date.now() };
          store.set(GEO_KEY, geoMem);
          if (hit) mapSoon();
        }
      } catch (e) { /* offline: asked again next time */ }
      await new Promise(res => setTimeout(res, 1200));
    }
    geoBusy = false;
  }
  /* ---- roads: the real road between two places, like Google Maps (OSRM — OpenStreetMap's free route finder).
   *  Today's routes come with the site (roads.js); a new pair is asked for once and kept in this browser. */
  const ROADS = window.VPT_ROADS || {};
  const ROAD_KEY = 'vpt_roads_v1';
  const roadMem = store.get(ROAD_KEY, {});
  Object.keys(roadMem).forEach(k => { if (!roadMem[k][0] && Date.now() - roadMem[k][1] > 7 * 864e5) delete roadMem[k]; });
  const roadPts = {};   // decoded once per pair
  /** Google's "encoded polyline" (5 decimals) ⇄ [[lat, lng], …] */
  function polyDecode(s) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < s.length) {
      for (let k = 0; k < 2; k++) {
        let r = 0, sh = 0, b;
        do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
        const d = r & 1 ? ~(r >> 1) : r >> 1;
        if (k) lng += d; else lat += d;
      }
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }
  function polyEncode(pts) {
    let o = '', pl = 0, pg = 0;
    const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 32) { s += String.fromCharCode((32 | (v & 31)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    pts.forEach(p => { const la = Math.round(p[0] * 1e5), lo = Math.round(p[1] * 1e5); o += e(la - pl) + e(lo - pg); pl = la; pg = lo; });
    return o;
  }
  /** fewer points, same shape (Douglas–Peucker, tol in degrees: 0.0012 ≈ 130 m) */
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length), st = [[0, pts.length - 1]];
    keep[0] = keep[pts.length - 1] = 1;
    while (st.length) {
      const [s, e] = st.pop(), y1 = pts[s][0], x1 = pts[s][1], dx = pts[e][1] - x1, dy = pts[e][0] - y1, L = dx * dx + dy * dy;
      let md = 0, mi = -1;
      for (let i = s + 1; i < e; i++) {
        const t = L ? Math.max(0, Math.min(1, ((pts[i][1] - x1) * dx + (pts[i][0] - y1) * dy) / L)) : 0;
        const d = Math.hypot(pts[i][1] - x1 - t * dx, pts[i][0] - y1 - t * dy);
        if (d > md) { md = d; mi = i; }
      }
      if (md > tol) { keep[mi] = 1; st.push([s, mi], [mi, e]); }
    }
    return pts.filter((p, i) => keep[i]);
  }
  const roadKey = (a, b) => a.join(',') + '>' + b.join(',');
  /** the road a → b as { pts, km, min } (min = car time from OSRM), or null — then asked for once, the map redraws when it comes */
  function road(a, b) {
    if (!a || !b || a.join() === b.join()) return null;
    const k = roadKey(a, b), r = ROADS[k] || roadMem[k];
    if (!r) { roadAsk(k, a, b); return null; }
    if (!r[0]) return null;   // no road found between them
    return roadPts[k] || (roadPts[k] = { pts: polyDecode(r[0]), km: r[1], min: r[2] });
  }
  /** the road a → b only when it is already known (roads.js / this browser): the road view never goes asking */
  function roadKnown(a, b) {
    if (!a || !b || a.join() === b.join()) return null;
    const k = roadKey(a, b), r = ROADS[k] || roadMem[k];
    if (!r || !r[0]) return null;
    return roadPts[k] || (roadPts[k] = { pts: polyDecode(r[0]), km: r[1], min: r[2] });
  }
  /* ---- the other ways from a to b, like Google Maps' route choices: OSRM's alternatives (roads.js VPT_ALTS, a new pair
   *  is asked for once and kept in this browser) — [[road, km, car minutes], …], [] when there is no other way */
  const ALTS = window.VPT_ALTS || {};
  const ALT_KEY = 'vpt_alts_v1';
  const altMem = store.get(ALT_KEY, {});
  Object.keys(altMem).forEach(k => { if (!Array.isArray(altMem[k]) && Date.now() - altMem[k] > 7 * 864e5) delete altMem[k]; });   // not found: ask again after a week
  function roadAlts(a, b) {
    if (!a || !b || a.join() === b.join()) return [];
    const k = roadKey(a, b), r = ALTS[k] || altMem[k];
    if (!r) { roadAsk(k, a, b, true); return []; }
    return Array.isArray(r) ? r.map((x, i) => roadPts[k + '#' + i] || (roadPts[k + '#' + i] = { pts: polyDecode(x[0]), km: x[1], min: x[2] })) : [];
  }
  /** the point of a line nearest to p: how far along the line it is (along / total, km) and how far p is from it (off, km) */
  function alongLine(pts, p) {
    const kx = Math.cos(p[0] * Math.PI / 180);
    let along = 0, off = Infinity, run = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ax = (a[1] - p[1]) * kx, ay = a[0] - p[0], dx = (b[1] - a[1]) * kx, dy = b[0] - a[0], L = dx * dx + dy * dy, seg = Math.sqrt(L) * 111;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0, x = ax + t * dx, y = ay + t * dy, d = Math.sqrt(x * x + y * y) * 111;
      if (d < off) { off = d; along = run + t * seg; }
      run += seg;
    }
    return { along: along, total: run, off: off };
  }
  const roadQ = [];
  let roadBusy = false, roadAsked = 0;
  function roadAsk(k, a, b, alts) {   // alts: OSRM's other ways too (the road comes with them)
    if (roadAsked >= 40 || roadQ.some(x => x[0] === k && x[3] === !!alts)) return;
    roadQ.push([k, a, b, !!alts]);
    roadRun();
  }
  async function roadRun() {
    if (roadBusy) return;
    roadBusy = true;
    while (roadQ.length) {
      const [k, a, b, alts] = roadQ.shift();
      if (alts ? ALTS[k] || altMem[k] : ROADS[k] || roadMem[k]) continue;   // came meanwhile with another answer
      roadAsked++;
      try {
        const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + a[1] + ',' + a[0] + ';' + b[1] + ',' + b[0] + '?overview=full&geometries=polyline' + (alts ? '&alternatives=3' : ''));
        const j = r.ok ? await r.json() : null;
        if (j) {
          const ok = j.code === 'Ok' && j.routes.length > 0;
          const pack = rt => [polyEncode(simplify(polyDecode(rt.geometry), 0.0012)), Math.round(rt.distance / 1000), Math.round(rt.duration / 60)];
          if (!ROADS[k]) roadMem[k] = ok ? pack(j.routes[0]) : [0, Date.now()];
          store.set(ROAD_KEY, roadMem);
          if (alts) { altMem[k] = ok ? j.routes.slice(1).map(pack) : Date.now(); store.set(ALT_KEY, altMem); }
          if (ok) mapSoon();
        }
      } catch (e) { /* offline / busy: asked again next time */ }
      await new Promise(res => setTimeout(res, 1100));
    }
    roadBusy = false;
  }
  /** a loaded lorry is much slower than OSRM's car: 1.4 × the car time, and never faster than 45 km/h on average */
  function truckTime(min, km) {
    const m = Math.round(Math.max(min * 1.4, (km || 0) * 60 / 45)), h = Math.floor(m / 60);
    return ((h ? h + ' hr ' : '') + (m % 60 || !h ? (m % 60) + ' min' : '')).trim();
  }
  /** the point on a road nearest to p, if it is within maxKm (a truck in a town on the road stands on the road) */
  function snapOn(pts, p, maxKm) {
    let best = null, bd = Infinity;
    const kx = Math.cos(p[0] * Math.PI / 180);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ax = (a[1] - p[1]) * kx, ay = a[0] - p[0], dx = (b[1] - a[1]) * kx, dy = b[0] - a[0], L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0, x = ax + t * dx, y = ay + t * dy, d = x * x + y * y;
      if (d < bd) { bd = d; best = [+(a[0] + t * (b[0] - a[0])).toFixed(4), +(a[1] + t * (b[1] - a[1])).toFixed(4)]; }
    }
    return best && Math.sqrt(bd) * 111 <= maxKm ? best : null;
  }
  /** where a truck stands on the map: its current town, moved onto its own route's road when the town is on it */
  function truckAt(v, m) {   // m: only onto a road that is on this map
    const ll = truckTown(v);
    if (!ll) return null;
    const a = placeLL(v.from, true), b = placeLL(v.to, true), rd = road(a, b);
    if (!rd || (m && !m.drawn.has(roadKey(a, b)))) return ll;
    // the chosen route shows all its ways: onto the nearest of them
    const on = ((m && m.ways[roadKey(a, b)]) || [rd.pts]).map(pts => snapOn(pts, ll, 30)).filter(Boolean);
    return on.sort((x, y) => kmApart(x, ll) - kmApart(y, ll))[0] || ll;
  }
  /** the town a truck is in now (loading / unloading ones with no current location: their From / To) */
  function truckTown(v) {
    const name = v.cur || (v.cat === 'loading' ? v.from : v.cat === 'unloading' ? v.to : '');
    if (!name) return null;
    placeLL(name);   // looks a new name up on OpenStreetMap
    return placeOn(name, placeLL(v.from, true), placeLL(v.to, true), true);
  }
  const kmApart = (a, b) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180)) * 111;
  /** where a truck is going next: a loaded one to its To, an empty one to its From (the loading point it heads to) */
  function truckNext(v) {
    if (['running', 'loadnd'].includes(v.cat)) return v.to;
    if (v.cat === 'empty') return v.from;
    return '';
  }
  /** trucks standing away from every road on the map get their own road: from where they are now to where they go
   *  (target(v) → [lat, lng]), a thinner line in the same colour, so no truck floats alone. Returns the legs drawn. */
  function legLines(m, vs, target, o) {
    const legs = {};
    vs.forEach(v => {
      const a = truckTown(v), b = target(v);
      if (!a || !b || kmApart(a, b) < 15) return;
      const f = placeLL(v.from, true), t = placeLL(v.to, true), own = road(f, t), ok = own && m.drawn.has(roadKey(f, t));
      if (ok && (m.ways[roadKey(f, t)] || [own.pts]).some(pts => snapOn(pts, a, 30))) return;   // already on a road shown
      const k = roadKey(a, b);
      if (m.drawn.has(k)) return;
      (legs[k] = legs[k] || { a: a, b: b, name: v.cur || '', vs: [] }).vs.push(v);
    });
    return Object.values(legs).map(l => {
      const n = l.vs.length;
      l.rd = flowLine(m, l.a, l.b, { color: o.color(l.vs[0]), edge: o.edge ? o.edge(l.vs[0]) : '#fff', n: n, look: 'leg',
        tip: esc((l.name || '?') + ' → ' + o.name(l.vs[0])) + ' · ' + n + ' truck' + (n > 1 ? 's' : '') + ' on the way (from where ' + (n > 1 ? 'they are' : 'it is') + ' now)' });
      return l;
    });
  }

  let mapT = null;
  function mapSoon() {
    clearTimeout(mapT);
    mapT = setTimeout(() => {
      if (S.view === 'route' && S.rmode === 'map') renderRouteMap();
      else if (S.view === 'route') { if (!roadQ.length) { S.routeKey = ''; renderRoutes(); } }   // the road view: once all asked-for ways / roads came (no jumping page)
      else if (S.view === 'draw') renderDraw();   // Route Finder: a From / To just found on OpenStreetMap
      else if (S.view === 'hub' && S.hview === 'map' && S.hub) renderHubMap(hubData(S.hmode, S.hub));
    }, 600);
  }

  const addCss = href => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); return l; };
  const addJs = src => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(s); s.onerror = () => { s.remove(); rej(new Error(src)); };
    document.head.appendChild(s);
  });
  let leaflet = null;
  /** Leaflet + its marker-cluster add-on (trucks in nearby towns merge into one count when zoomed out) */
  function loadLeaflet() {
    if (leaflet) return leaflet;
    const cdn = 'https://cdnjs.cloudflare.com/ajax/libs/', css = [addCss(cdn + 'leaflet/1.9.4/leaflet.min.css'), addCss(cdn + 'leaflet.markercluster/1.5.3/MarkerCluster.css')];
    leaflet = addJs(cdn + 'leaflet/1.9.4/leaflet.min.js').then(() => addJs(cdn + 'leaflet.markercluster/1.5.3/leaflet.markercluster.js')).then(() => window.L)
      .catch(() => { leaflet = null; css.forEach(x => x.remove()); throw new Error('map'); });
    return leaflet;
  }
  let glLib = null;
  /** MapLibre + its Leaflet bridge, which draw OpenFreeMap's map (free, no key, no limits, commercial use allowed);
   *  false when the phone has no WebGL or it does not load — then the map uses OpenStreetMap's own tiles */
  function loadGL() {
    if (glLib) return glLib;
    let webgl = false;
    try { const c = document.createElement('canvas'); webgl = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { /* no WebGL */ }
    if (!webgl) return (glLib = Promise.resolve(false));
    const npm = 'https://cdn.jsdelivr.net/npm/';
    addCss(npm + 'maplibre-gl@5.22.0/dist/maplibre-gl.css');
    glLib = addJs(npm + 'maplibre-gl@5.22.0/dist/maplibre-gl.js').then(() => addJs(npm + '@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js'))
      .then(() => !!window.L.maplibreGL).catch(() => false);
    return glLib;
  }
  /** the map underneath: OpenFreeMap's clean map (free, no key, no limits, commercial use allowed), drawn by MapLibre.
   *  On phones it draws at most 2× sharp (3× phones would do 2.25× the work for no visible gain).
   *  Only a phone without WebGL gets OpenStreetMap's plain tiles instead. */
  const OSM_DATA = 'Data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
  const cleanMap = L => L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/liberty', pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    padding: IS_PHONE ? 0.08 : 0.15, fadeDuration: IS_PHONE ? 0 : 300,
    attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' + OSM_DATA });
  const plainMap = L => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' });
  /** put the clean map under the map in #el; says "Loading the map…" until it has drawn (a few seconds the first time) */
  function addBaseMap(L, map) {
    const el = map.getContainer(), done = () => el.classList.remove('mp-busy');
    el.classList.add('mp-busy');
    loadGL().then(ok => {
      const base = (ok ? cleanMap(L) : plainMap(L)).addTo(map);
      const gm = ok && base.getMaplibreMap && base.getMaplibreMap();
      if (!gm) return done();
      gm.once('idle', done);
      setTimeout(done, 20000);
      // the bridge resizes its box when the map changes size (full screen, turning the phone) but not the drawing in it
      map.on('resize', () => setTimeout(() => {
        if (!map.hasLayer(base)) return;
        base._resizeContainer();
        gm.resize();
        base._update();
      }, 80));
    });
  }
  /** ⛶ the map over the whole screen (phones: the back button closes it again) */
  function mapFull(el, on) {
    if (el.classList.contains('mp-full') === on) return;
    el.classList.toggle('mp-full', on);
    document.body.classList.toggle('map-full', on);
    const b = el.querySelector('.mp-fs');
    if (b) { b.textContent = on ? '✕' : '⛶'; b.title = on ? 'Close full screen' : 'Full screen'; }
    if (on) try { history.pushState({ vpt: 'map' }, ''); } catch (e) { /* ignore */ }
    const m = Object.values(MAPS).find(x => x.map.getContainer() === el);
    if (m) setTimeout(() => m.map.invalidateSize(), 60);
  }
  /** a ring in the trucks' status colours with their count in the middle */
  function ringHtml(vs) {
    const c = {}, n = vs.length;
    vs.forEach(v => { c[v.cat] = (c[v.cat] || 0) + 1; });
    let deg = 0;
    const ring = CATS.filter(x => c[x.key]).map(x => { const a = deg; deg += c[x.key] / n * 360; return x.color + ' ' + a.toFixed(1) + 'deg ' + deg.toFixed(1) + 'deg'; }).join(',');
    return '<div class="mk-in mk-ring' + (n > 9 ? ' big' : '') + '" style="background:conic-gradient(' + ring + ')"><b>' + n + '</b></div>';
  }
  const MAPS = {};
  /** the map in #id (made once): the clean map underneath, layers for lines, places and trucks */
  async function mapFor(id, plain) {   // plain: no Trucks / Route lines switch (the Route Finder's drawing map)
    const L = await loadLeaflet();
    loadGL();   // start fetching the clean map's code at once
    let m = MAPS[id];
    if (!m) {
      const el = $('#' + id);
      el.innerHTML = '';
      // the mouse wheel zooms in / out around the cursor, half a level per notch
      const map = L.map(el, { scrollWheelZoom: true, wheelPxPerZoomLevel: 120, wheelDebounceTime: 30, zoomSnap: 0.5, minZoom: 4, maxZoom: 17, tapTolerance: 20 }).setView([21.5, 82], 6);
      map.attributionControl.setPrefix(false);
      addBaseMap(L, map);
      // ⛶ full screen, under the zoom buttons
      const Fs = L.Control.extend({ options: { position: 'topleft' }, onAdd: () => {
        const b = L.DomUtil.create('button', 'mp-fs');
        b.type = 'button'; b.textContent = '⛶'; b.title = 'Full screen';
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', () => { if (el.classList.contains('mp-full')) history.back(); else mapFull(el, true); });
        return b;
      } });
      new Fs().addTo(map);
      map.on('zoomend', () => el.classList.toggle('mp-near', map.getZoom() >= 7.5));
      map.on('zoomend moveend', () => MAPS[id] && declutterSoon(MAPS[id]));
      const trucks = L.markerClusterGroup({
        maxClusterRadius: 38, showCoverageOnHover: false, spiderfyOnMaxZoom: true, zoomToBoundsOnClick: true,
        iconCreateFunction: cl => L.divIcon({ className: 'mk', iconSize: null, html: ringHtml(cl.getAllChildMarkers().flatMap(x => x.options.vs || [])) })
      });
      m = MAPS[id] = { map: map, lines: L.layerGroup().addTo(map), marks: L.layerGroup().addTo(map), trucks: trucks.addTo(map), fit: '' };
      if (!plain) L.control.layers(null, { 'Trucks now': m.trucks, 'Route lines': m.lines }, { position: 'topright' }).addTo(map);
      el.addEventListener('click', e => {
        const v = e.target.closest('[data-v]'), p = e.target.closest('[data-rplace]');
        if (v) openDetail(v.dataset.v);
        if (p) { map.closePopup(); S.rpick = ''; S.rplace = p.dataset.rplace; renderRouteMap(); }   // light up every route to / from this point
      });
    }
    m.map.invalidateSize();
    m.lines.clearLayers(); m.marks.clearLayers(); m.trucks.clearLayers();
    m.drawn = new Set();   // roads on the map now (a → b), so a truck's own road is not drawn twice
    m.ways = {};           // a → b: every way of it drawn (the chosen route), [pts, …]
    return m;
  }
  /** a gentle curve from a to b, so A → B and B → A do not lie on top of each other */
  function arc(a, b, bend) {
    const dy = b[0] - a[0], dx = b[1] - a[1], c = [(a[0] + b[0]) / 2 + dx * bend, (a[1] + b[1]) / 2 - dy * bend], pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    }
    return pts;
  }
  /** a line with white dashes running along it (the way the trucks go) and an arrow two thirds of the way */
  /** a line a → b along the real road (a gentle curve until the road is known), Google style: coloured with an edge,
   *  white dashes running the way the trucks go, an arrow two thirds along. Returns the road ({ pts, km, min }) or null.
   *  o.look: 'all' (many routes at once), 'sel' (the chosen route, thick), 'dim' (the others while one is chosen), 'hub' */
  function flowLine(m, a, b, o) {   // o.rd: draw this way of a → b instead of its road
    const L = window.L, rd = o.rd || road(a, b), pts = rd ? rd.pts : arc(a, b, 0.14), n = o.n || 1, look = o.look || 'hub';
    m.drawn.add(roadKey(a, b));
    const w = o.w || (look === 'sel' ? 7 : look === 'leg' ? 4 : look === 'dim' || look === 'faint' ? 3 : look === 'all' ? 2.6 + Math.min(3, Math.sqrt(n) * 0.6) : 3 + Math.min(4, Math.sqrt(n) * 0.9));
    const tip = o.tip + (rd ? ' · ' + rd.km + ' km · ~' + truckTime(rd.min, rd.km) + ' by truck' : '');
    // 'faint': a way of the chosen route with no truck on it now — its colour, but thin, light and still
    const quiet = look === 'dim' || look === 'faint';
    m.lines.addLayer(L.polyline(pts, { color: o.edge || '#fff', weight: w + 3, opacity: look === 'faint' ? .3 : look === 'dim' ? .5 : .95, interactive: false, className: 'mp-edge' }));
    const line = L.polyline(pts, { color: look === 'dim' ? '#9aa0a6' : o.color, weight: w, opacity: look === 'faint' ? .55 : look === 'dim' ? .7 : 1, className: 'mp-line' }).bindTooltip(tip, { sticky: true });
    if (o.click) line.on('click', o.click);
    m.lines.addLayer(line);
    if (quiet) return rd;
    // running dashes: on a phone only on the chosen route / hub lines (dozens of moving lines make a phone stutter)
    if (!(IS_PHONE && look === 'all')) m.lines.addLayer(L.polyline(pts, { color: '#fff', weight: look === 'sel' ? 2.2 : 1.4, opacity: .85, dashArray: look === 'sel' ? '3 13' : '2 10', interactive: false, className: 'mp-flow' }));
    const i = Math.max(1, Math.round((pts.length - 1) * 0.62)), p = m.map.project(pts[i - 1], 8), q = m.map.project(pts[i], 8);
    const deg = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
    m.lines.addLayer(L.marker(pts[i], { interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'mk', iconSize: null, html: '<i class="mk-arrow" style="--c:' + (o.edge && look === 'sel' ? o.edge : o.color) + ';transform:translate(-50%,-50%) rotate(' + deg.toFixed(0) + 'deg)"></i>' }) }));
    return rd;
  }
  /** Google-style box on the road: 🚚 8 hr 28 min / 286 km */
  function etaBox(m, rd, from, i) {   // from: the place it starts at, i: which box — several boxes stand at different spots
    const L = window.L, at = [0.5, 0.3, 0.7, 0.18, 0.42, 0.6, 0.25, 0.8, 0.36, 0.52][(i || 0) % 10];
    const mid = rd.pts[Math.floor((rd.pts.length - 1) * (i === undefined ? 0.5 : at))];
    m.lines.addLayer(L.tooltip({ permanent: true, direction: i % 2 ? 'left' : 'right', offset: [i % 2 ? -10 : 10, 0], className: 'mp-eta-tip', interactive: false })
      .setLatLng(mid).setContent('<div class="mp-eta">' + ICO.truck + '<div><b>~' + esc(truckTime(rd.min, rd.km)) + '</b><small>' + (from ? esc(from) + ' · ' : '') + rd.km + ' km</small></div></div>'));
  }
  /** a box on one way of the chosen route — its number, truck time, name and km — where it runs apart from the others */
  function wayBox(m, l, i, ls) {
    const L = window.L, pts = l.w.pts, step = Math.max(1, Math.floor(pts.length / 60));
    let at = pts[Math.floor(pts.length / 2)], far = -1;
    if (ls.length > 1) {
      for (let k = Math.floor(pts.length * 0.15); k < pts.length * 0.85; k += step) {
        const d = Math.min(...ls.filter(x => x !== l).map(x => alongLine(x.w.pts, pts[k]).off));
        if (d > far) { far = d; at = pts[k]; }
      }
    }
    const faint = ls.length > 1 && !l.stops.length;   // no truck on this way now: a softer box, the first to give way
    m.lines.addLayer(L.tooltip({ permanent: true, direction: i % 2 ? 'left' : 'right', offset: [i % 2 ? -10 : 10, 0], className: 'mp-eta-tip' + (faint ? ' mp-faint' : ''), interactive: false, opacity: faint ? .6 : .9 })
      .setLatLng(at).setContent('<div class="mp-eta mp-way" style="--lc:' + l.col + '">' + (ls.length > 1 ? '<i class="rw-no">' + (i + 1) + '</i>' : ICO.truck) +
        '<div><b>~' + esc(truckTime(l.w.min, l.w.km)) + '</b><small>' + (l.code ? esc(l.code) + ' · ' : '') + (l.name ? 'via ' + esc(l.name) + ' · ' : '') + l.w.km + ' km</small></div></div>'));
  }
  /** trucks at their current location (loading / unloading ones at From / To when the location is empty):
   *  one truck = a small lorry with its number, more = a ring in their status colours with the count */
  function truckMarks(m, vs) {
    const L = window.L, at = {}, lost = {};
    vs.forEach(v => {
      const name = v.cur || (v.cat === 'loading' ? v.from : v.cat === 'unloading' ? v.to : '');
      const ll = truckAt(v, m);
      if (!ll) { (lost[name || 'No current location'] = lost[name || 'No current location'] || []).push(v); return; }
      const k = ll.join(',');
      (at[k] = at[k] || { ll: ll, name: name, vs: [] }).vs.push(v);
    });
    Object.keys(at).forEach(k => {
      const g = at[k], n = g.vs.length;
      const v = g.vs[0], html = n === 1 ? '<div class="mk-in mk-one" style="--c:' + CAT[v.cat].color + '">' + ICO.truck + '<span>' + esc(shortNo(v.vno)) + '</span></div>' : ringHtml(g.vs);
      const mk = L.marker(g.ll, { icon: L.divIcon({ className: 'mk', iconSize: null, html: html }), zIndexOffset: 1000 + n, riseOnHover: true, vs: g.vs });
      mk.bindTooltip(esc(g.name) + ' · ' + n + ' truck' + (n > 1 ? 's' : '') + ' now', { direction: 'top', offset: [0, -16] });
      mk.bindPopup(() => mapPopup(g.name, g.vs, 'Here now'), { maxWidth: 290, className: 'mp-pop' });
      m.trucks.addLayer(mk);
    });
    return lost;
  }
  function mapPopup(title, vs, sub) {
    return '<div class="mp-h">' + ICO.pin + '<b>' + esc(title) + '</b><span>' + vs.length + ' truck' + (vs.length > 1 ? 's' : '') + (sub ? ' · ' + esc(sub) : '') + '</span></div>' +
      '<div class="mp-list">' + vs.map(v => '<button type="button" class="mp-v" data-v="' + esc(v.vno) + '" style="--c:' + CAT[v.cat].color + '">' + ICO.truck +
        '<b>' + esc(shortNo(v.vno)) + '</b><span>' + esc(CAT[v.cat].label) + '</span><small>' + esc((v.from || '?') + ' → ' + (v.to || '?')) +
        (v.cur ? ' · now ' + esc(v.cur) : '') + '</small></button>').join('') + '</div><div class="mp-tip">Tap a truck for its details</div>';
  }
  /** what could not go on the map (so nobody wonders where a truck went) and what was placed by itself */
  function mapNote(el, lost, places, vs, key) {
    const nl = Object.keys(lost).map(k => esc(k) + ' (' + lost[k].length + ')');
    const ps = [...new Set(places)].filter(p => !lost[p]).map(esc);
    const auto = [...new Set(vs.flatMap(v => [v.cur, v.from, v.to]).map(up))]
      .filter(n => n && geoMem[n] && geoMem[n].ll && !PLACES[n] && !placeIdx[spellKey(n)]).map(esc);
    el.innerHTML = (key ? mapKey(key) : '') + '<b>Map:</b> trucks stand at their current location from the Calling Sheet (town, not GPS). ' +
      (nl.length ? '<br><b>Not on the map</b> — place not known: ' + nl.join(', ') + '.' : '') +
      (ps.length ? '<br><b>Route place not found:</b> ' + ps.join(', ') + '.' : '') +
      (auto.length ? '<br><b>Found by itself on OpenStreetMap</b> (check they are right): ' + auto.join(', ') + '.' : '') +
      (nl.length || ps.length || auto.length ? ' Tell us where these are and they will be fixed.' : '');
  }
  /** what the colours on the map mean, in one line under it: [[colour, words, 'line' | 'ring' | 'tip'], …] */
  function mapKey(items) {
    const ring = 'conic-gradient(#16a34a 0 50%, #7c3aed 0 75%, #dc2626 0)';
    return '<span class="mp-key">' + items.map(([c, t, kind]) =>
      '<span>' + (kind === 'ring' ? '<i class="ring" style="background:' + ring + '"></i>' : kind === 'tip' ? '👆' : '<i class="ln" style="--c:' + c + '"></i>') + esc(t) + '</span>').join('') + '</span>';
  }
  /** no label on top of another: the hub label first, then place tags (busiest first), time boxes, place names.
   *  A tag that would sit on one already shown shrinks to its count (the full tag shows on hover / tap or when
   *  zoomed in); a time box or name that would, hides. Runs again after every zoom / move. */
  function declutter(m) {
    const el = m.map.getContainer();
    const all = [...el.querySelectorAll('.mk-hub, .mk-tag, .mp-eta-tip, .mk-lbl')];
    all.forEach(e => { e.classList.remove('mk-small', 'mk-off', 'mk-flip'); e.style.marginLeft = e.style.marginTop = ''; });
    const rank = e => e.classList.contains('mk-hub') ? 1e6 : e.classList.contains('mk-tag') ? 1e4 + (+e.dataset.n || 0)
      : e.classList.contains('mp-eta-tip') ? (e.classList.contains('mp-faint') ? 4e3 : 5e3) : e.classList.contains('major') ? 2e3 : 1e3;
    const kept = [...el.querySelectorAll('.mk-pinw')].map(e => e.getBoundingClientRect()), pad = 2;   // the big A / B pins stay uncovered
    const hits = r => kept.some(k => r.left < k.right + pad && k.left < r.right + pad && r.top < k.bottom + pad && k.top < r.bottom + pad);
    all.filter(e => e.offsetParent !== null).sort((a, b) => rank(b) - rank(a)).forEach(e => {
      let r = e.getBoundingClientRect();
      if (!hits(r)) { kept.push(r); return; }
      if (e.classList.contains('mp-eta-tip')) {   // a time box: try the other side of its road, a bit above, a bit below
        const base = e.classList.contains('leaflet-tooltip-left') ? -6 : 6, flip = base < 0 ? r.width + 32 : -r.width - 32, h = r.height + 6;   // Leaflet's own margin ±6px
        const ok = [[flip, 0], [0, -h], [0, h], [flip, -h], [flip, h]].some(([dx, dy]) => {
          e.style.marginLeft = base + dx + 'px';
          e.style.marginTop = dy + 'px';
          r = e.getBoundingClientRect();
          return !hits(r);
        });
        if (ok) { e.classList.add('mk-flip'); kept.push(r); return; }
        e.style.marginLeft = e.style.marginTop = '';
      }
      if (e.classList.contains('mk-tag')) {   // try it as just its count; if even that is in the way, hide it until zoomed in
        e.classList.add('mk-small');
        r = e.getBoundingClientRect();
        if (!hits(r)) { kept.push(r); return; }
        e.classList.remove('mk-small');
      }
      e.classList.add('mk-off');
    });
  }
  function declutterSoon(m) {
    clearTimeout(m.dcT);
    m.dcT = setTimeout(() => declutter(m), 60);
  }
  /** zoom to where most of it is: a few far places (Bangalore, Gujarat) stay a zoom-out away */
  function mapFit(m, pts, key, trim) {
    key += '|' + (m.map.getContainer().clientWidth < 600);   // phone ⇄ computer size: fit again
    if (m.fit === key || !pts.length) return;
    m.fit = key;
    const cut = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.max(0, Math.round((xs.length - 1) * p)))];
    const lat = pts.map(p => p[0]), lng = pts.map(p => p[1]), edge = trim !== false && pts.length > 12 ? 0.06 : 0;
    m.map.fitBounds([[cut(lat, edge), cut(lng, edge)], [cut(lat, 1 - edge), cut(lng, 1 - edge)]], { paddingTopLeft: [30, 72], paddingBottomRight: [30, 30], maxZoom: 9 });   // room on top for the hub box / pins
  }

  /** Route tab on the map, like Google Maps: every route along its real road. Pick a route to see it alone with its
   *  time and km — or pick a loading / unloading point (or tap its pin) to light up every route coming to it (blue,
   *  with time and km) and going out from it (green). A / B pins, the trucks on the road where they are now. */
  async function renderRouteMap() {
    const note = $('#routeMapNote'), seq = S.rmapSeq = (S.rmapSeq || 0) + 1;
    let m;
    try { m = await mapFor('routeMap'); } catch (e) { note.innerHTML = '<b>The map could not load.</b> Check the internet and open Map again.'; return; }
    if (S.view !== 'route' || S.rmode !== 'map' || seq !== S.rmapSeq) return;   // a newer drawing of it is on its way
    const L = window.L, g = routeGroups(), ends = {}, pts = [], missing = [], narrow = m.map.getContainer().clientWidth < 600;
    const rkey = r => r.from + '→' + r.to;
    // every From / To once (spellings merged): how many vehicles come to it, how many leave from it
    const byPoint = {};
    g.routes.forEach(r => [[r.to, 'in'], [r.from, 'out']].forEach(([name, k]) => {
      if (!name) return;
      const p = byPoint[spellKey(name)] = byPoint[spellKey(name)] || { spell: {}, in: 0, out: 0 };
      p.spell[name] = (p.spell[name] || 0) + r.vs.length;
      p[k] += r.vs.length;
    }));
    const points = Object.values(byPoint).map(p => Object.assign(p, { name: Object.keys(p.spell).sort((a, b) => p.spell[b] - p.spell[a])[0] }))
      .sort((a, b) => b.in + b.out - a.in - a.out);
    const focus = S.rplace ? points.find(p => spellKey(p.name) === spellKey(S.rplace)) || null : null, fk = focus ? spellKey(focus.name) : '';
    const sel = focus ? null : g.routes.find(r => rkey(r) === S.rpick) || null;
    $('#routePick').innerHTML = '<option value="">All routes (' + g.routes.length + ')</option>' +
      g.routes.map(r => '<option value="' + esc(rkey(r)) + '"' + (sel === r ? ' selected' : '') + '>' + esc(r.from + ' → ' + r.to) + ' (' + r.vs.length + ')</option>').join('');
    $('#placePick').innerHTML = '<option value="">All loading / unloading points</option>' +
      points.map(p => '<option value="' + esc(p.name) + '"' + (focus === p ? ' selected' : '') + '>' + esc(p.name) + ' — ' + p.in + ' coming · ' + p.out + ' going</option>').join('');
    const role = r => !fk ? '' : spellKey(r.to) === fk ? 'in' : spellKey(r.from) === fk ? 'out' : '';
    const lit = r => r === sel || !!role(r), some = !!(sel || focus);
    const end = (name, ll, kind, n) => {
      const k = ll.join(','), e = ends[k] = ends[k] || { ll: ll, name: name, roles: {}, n: 0 };
      e.roles[kind] = 1; e.n += n;
    };
    let selRoad = null, boxes = 0;
    const sum = { in: [0, 0], out: [0, 0] };   // routes, vehicles
    // the dimmed ones first (under), then going out, then coming in / the chosen one (on top); busiest first
    const rank = r => (r === sel || role(r) === 'in' ? 3 : role(r) === 'out' ? 2 : 1);
    g.routes.slice().sort((x, y) => rank(x) - rank(y) || y.vs.length - x.vs.length).forEach(r => {
      const a = placeLL(r.from), b = placeLL(r.to), n = r.vs.length, on = lit(r), rl = role(r);
      if (r.from && !a) missing.push(r.from);
      if (r.to && !b) missing.push(r.to);
      if (rl) { sum[rl][0]++; sum[rl][1] += n; }
      if (!some || on) {
        if (a) { end(r.from, a, 'A', n); pts.push(a); }
        if (b) { end(r.to, b, 'B', n); pts.push(b); }
      }
      if (!a || !b || a.join() === b.join()) return;
      if (r === sel) {   // the chosen route: every way it can go, in the Road view's lane colours (route 1 on top)
        const ls = routeLanes(r).lanes.filter(l => l.w);
        if (ls.length) {
          m.ways[roadKey(a, b)] = ls.map(l => l.w.pts);
          ls.slice().reverse().sort((x, y) => !!x.stops.length - !!y.stops.length).forEach(l => {   // the ways with trucks on top
            const i = ls.indexOf(l);
            const busy = ls.length < 2 || l.stops.length > 0;   // a way with no truck on it now stays quiet
            flowLine(m, a, b, { rd: l.w, color: l.col, edge: l.edge, look: busy ? 'sel' : 'faint', w: busy ? (i ? 5 : 7) : 3.5, n: n,
              tip: (ls.length > 1 ? 'Route ' + (i + 1) + ' · ' : '') + (l.name ? 'via ' + esc(l.name) : esc(r.from + ' → ' + r.to)) + ' · ' + l.n + ' truck' + (l.n === 1 ? '' : 's') + ' on it' });
            l.w.pts.forEach(p => pts.push(p));
          });
          ls.forEach((l, i) => wayBox(m, l, i, ls));
          selRoad = ls;
          return;
        }
      }
      const dr = drawnFor(r.from, r.to)[0];   // the Director's drawn road, when there is one, is the route's line
      if (dr) m.ways[roadKey(a, b)] = [dr.pts];
      const rd = flowLine(m, a, b, { rd: dr, color: rl === 'out' ? '#188038' : on ? '#1a73e8' : '#4285f4', edge: rl === 'out' ? '#0b5d1e' : on ? '#0b3d91' : '#fff', n: n,
        look: some ? (on ? 'sel' : 'dim') : 'all', tip: esc(r.from + ' → ' + r.to) + ' · ' + n + ' vehicle' + (n > 1 ? 's' : ''),
        click: () => { S.rplace = ''; S.rpick = rkey(r); renderRouteMap(); } });
      if (!rd || !on) return;
      rd.pts.forEach(p => pts.push(p));
      if (rl === 'in' && boxes < (narrow ? 4 : 10)) etaBox(m, rd, r.from, boxes++);   // time and km on the busiest roads coming in
    });
    // a loading point also has empty trucks driving to it to load (their From is it): a road from where each group is now
    const coming = [];
    if (focus) {
      const to = placeLL(focus.name);
      if (to && !ends[to.join(',')]) { end(focus.name, to, 'B', 0); pts.push(to); }   // its pin, even when no route starts / ends here
      hubData('load', focus.name).inn.forEach(gp => {
        const a = placeLL(gp.place), n = gp.vs.length;
        if (!a || !to || a.join() === to.join()) return;
        coming.push(...gp.vs);
        sum.in[0]++; sum.in[1] += n;
        const rd = flowLine(m, a, to, { color: '#1a73e8', edge: '#0b3d91', n: n, look: 'sel',
          tip: esc(gp.place + ' → ' + focus.name) + ' · ' + n + ' empty truck' + (n > 1 ? 's' : '') + ' coming to load' });
        if (rd) { rd.pts.forEach(p => pts.push(p)); if (boxes < (narrow ? 4 : 10)) etaBox(m, rd, gp.place, boxes++); }
      });
      // those empty trucks are on routes starting here, but they are not going out
      sum.out[1] -= coming.filter(v => spellKey(v.from) === fk).length;
    }
    const s = k => (k === 1 ? '' : 's'), all = ' <button type="button" class="link" data-rpick="">Show all routes</button>';
    $('#routeEta').innerHTML = focus
      ? '<b>' + esc(focus.name) + '</b> · <span class="ms-in">● ' + sum.in[0] + ' route' + s(sum.in[0]) + ' coming in · ' + sum.in[1] + ' truck' + s(sum.in[1]) + '</span>' +
        ' · <span class="ms-out">● ' + sum.out[0] + ' going out · ' + sum.out[1] + ' truck' + s(sum.out[1]) + '</span>' + all
      : sel
        ? '<b>' + esc(sel.from + ' → ' + sel.to) + '</b>' + (!selRoad ? '' : selRoad.length > 1
          ? ' · <b>' + selRoad.length + ' possible routes</b> (' + selRoad.map((l, i) => '<span class="mp-wk" style="--lc:' + l.col + '">' + (i + 1) + '</span> ' + l.w.km + ' km').join(' · ') + ')'
          : ' · ' + selRoad[0].w.km + ' km · ~' + esc(truckTime(selRoad[0].w.min, selRoad[0].w.km)) + ' by truck') +
          ' · ' + sel.vs.length + ' truck' + s(sel.vs.length) + all
        : 'Pick a loading / unloading point (or tap its pin) to light up every route coming to it — or tap a route line to see it alone.';
    const major = new Set(Object.keys(ends).sort((x, y) => ends[y].n - ends[x].n).slice(0, narrow ? 6 : 12));
    Object.keys(ends).forEach(k => {
      const e = ends[k], kind = e.roles.A && e.roles.B ? 'ab' : e.roles.A ? 'a' : 'b', big = sel || (focus && spellKey(e.name) === fk);
      // the chosen route / point: Google-style pins (A orange, B red); otherwise small round A / B
      const html = big ? '<div class="mk-in mk-pinw' + (focus ? ' focus' : '') + '"><div class="mk-pin ' + kind + '"><i>' + (kind === 'b' ? 'B' : 'A') + '</i></div></div>'
        : '<div class="mk-in mk-end ' + kind + '"><i>' + (kind === 'b' ? 'B' : 'A') + '</i></div>';
      const mk = L.marker(e.ll, { icon: L.divIcon({ className: 'mk', iconSize: null, html: html }), zIndexOffset: 500 });   // under the trucks: a count at A / B stays readable
      mk.bindTooltip(esc(e.name), { permanent: true, direction: 'right', offset: big ? [14, -16] : [12, 0], className: 'mk-lbl' + (some || major.has(k) ? ' major' : '') });
      mk.bindPopup(() => {
        const vs = g.routes.filter(r => spellKey(r.from) === spellKey(e.name) || spellKey(r.to) === spellKey(e.name)).flatMap(r => r.vs)
          .filter(v => [v.cur, v.cat === 'loading' ? v.from : '', v.cat === 'unloading' ? v.to : ''].some(x => spellKey(x) === spellKey(e.name)));
        return mapPopup(e.name, vs, (kind === 'ab' ? 'Loading + unloading point' : kind === 'a' ? 'Loading point' : 'Unloading point')) +
          (focus && spellKey(e.name) === fk ? '' : '<button type="button" class="btn sm navy mp-lit" data-rplace="' + esc(e.name) + '">Show every route to / from here</button>');
      }, { maxWidth: 290, className: 'mp-pop' });
      m.marks.addLayer(mk);
    });
    const seen = new Set();
    const vs = (sel ? sel.vs : g.routes.filter(r => !focus || role(r)).flatMap(r => r.vs).concat(coming))
      .filter(v => (!S.rcat || v.cat === S.rcat) && !seen.has(v.vno) && seen.add(v.vno));
    // a truck away from every road shown: its own road from where it is now to where it goes next
    const focusLL = focus && placeLL(focus.name);
    legLines(m, vs, v => placeLL(truckNext(v), true), { color: () => '#5b8def', name: v => truckNext(v) }).forEach(l => {
      if (!l.rd) return;
      if (some) l.rd.pts.forEach(p => pts.push(p));   // all routes: the zoom keeps to where most of it is
      if (focusLL && l.b.join() === focusLL.join() && boxes < (narrow ? 4 : 10)) etaBox(m, l.rd, l.name || '?', boxes++);   // coming to the chosen point
    });
    const lost = truckMarks(m, vs);
    m.trucks.eachLayer(l => pts.push([l.getLatLng().lat, l.getLatLng().lng]));
    mapFit(m, pts, [S.f.caller, S.rq, S.rcat, sel ? rkey(sel) + (selRoad ? '+road' : '') : '', focus ? '@' + fk : ''].join('|'), !some);
    mapNote(note, lost, missing, vs, focus ? [['#1a73e8', 'coming in'], ['#188038', 'going out'], ['#9aa0a6', 'other routes'], ['', 'trucks (colour = status)', 'ring'], ['', 'tap a number for its trucks', 'tip']]
      : sel ? (selRoad && selRoad.length > 1 ? selRoad.map((l, i) => [l.col, 'route ' + (i + 1) + (l.name ? ' (via ' + l.name + ')' : '') + (l.stops.length ? '' : ' · no truck now')]) : [['#1a73e8', 'this route']]).concat([['#9aa0a6', 'other routes'], ['', 'trucks (colour = status)', 'ring'], ['', 'tap a truck for details', 'tip']])
      : [['#4285f4', 'route (from A to B)'], ['#5b8def', 'a truck’s own way'], ['', 'trucks (colour = status)', 'ring'], ['', 'tap a pin: every route there · tap a line: that route', 'tip']]);
    declutterSoon(m);
  }

  /** Hub Analyzer on the map: places trucks come from → hub → places they go to, and the trucks where they are now */
  async function renderHubMap(d) {
    const note = $('#hubMapNote'), seq = S.hmapSeq = (S.hmapSeq || 0) + 1;
    let m;
    try { m = await mapFor('hubMap'); } catch (e) { note.innerHTML = '<b>The map could not load.</b> Check the internet and open Map again.'; return; }
    if (S.view !== 'hub' || S.hview !== 'map' || seq !== S.hmapSeq) return;   // a newer drawing of it is on its way
    const L = window.L, col = HUB_COL[S.hmode], load = S.hmode === 'load', hub = placeLL(S.hub), pts = [], missing = [];
    if (!hub) missing.push(S.hub);
    else {
      pts.push(hub);
      // a slim one-line hub label (the counts are in the tiles above the map)
      const mk = L.marker(hub, { icon: L.divIcon({ className: 'mk', iconSize: null, html: '<div class="mk-in mk-hub" title="' + (load ? 'Loading point' : 'Unloading point') + '">' +
        '<i class="mk-hub-k">' + (load ? 'Loading' : 'Unloading') + '</i><b>' + esc(S.hub) + '</b><span>' + d.at.length + ' here</span></div>' }), zIndexOffset: 2000 });
      mk.bindPopup(() => mapPopup(S.hub, d.at, load ? 'Loading here now' : 'Unloading here now'), { maxWidth: 290, className: 'mp-pop' });
      m.marks.addLayer(mk);
    }
    // every road into the hub and out of it lit up (dark edge, running dashes; thicker = more trucks); each place's tag
    // says its km and truck time — no separate boxes on this map, they crowd it
    const EDGE = { '#0e9fb8': '#075e6e', '#16a34a': '#0b5d2a' };
    const side = (gs, into) => gs.forEach(gp => {
      const ll = placeLL(gp.place, !into && !load); // programs are free text: only places already known
      if (!ll) { missing.push(gp.place); return; }
      pts.push(ll);
      const c = into ? col.in : col.out, n = gp.vs.length;
      const dr = drawnFor(into ? gp.place : S.hub, into ? S.hub : gp.place)[0];   // the Director's drawn road for it, if any
      const rd = hub && ll.join() !== hub.join() ? flowLine(m, into ? ll : hub, into ? hub : ll, { rd: dr, color: c, edge: EDGE[c], n: n, look: 'sel', w: 3.5 + Math.min(3.5, Math.sqrt(n) * 0.9),
        tip: esc(into ? gp.place + ' → ' + S.hub : S.hub + ' → ' + gp.place) + ' · ' + n + ' truck' + (n > 1 ? 's' : '') }) : null;
      if (rd) rd.pts.forEach(p => pts.push(p));
      const mk = L.marker(ll, { icon: L.divIcon({ className: 'mk', iconSize: null, html: '<div class="mk-in mk-tag" data-n="' + n + '" style="--c:' + c + '">' +
        '<span class="t">' + esc(gp.place) + (rd ? '<small>' + rd.km + ' km · ~' + esc(truckTime(rd.min, rd.km).replace(' hr', 'h').replace(' min', 'm')) + '</small>' : '') + '</span><b>' + n + '</b></div>' }), zIndexOffset: 800 + n });
      mk.bindPopup(() => mapPopup(gp.place, gp.vs, (into ? (load ? 'Coming to load' : 'Coming to unload') : (load ? 'Loaded, going here' : 'Going here next')) +
        (rd ? ' · ' + rd.km + ' km · ~' + truckTime(rd.min, rd.km) : '')), { maxWidth: 290, className: 'mp-pop' });
      m.marks.addLayer(mk);
    });
    side(d.inn, true);
    side(d.out, false);
    const seen = new Set(), vs = d.at.concat(...d.inn.map(x => x.vs), ...d.out.map(x => x.vs)).filter(v => !seen.has(v.vno) && seen.add(v.vno));
    // a truck away from these roads: its own road from where it is now — to the hub (coming), or to where it goes (going)
    const goes = {};
    if (hub) d.inn.forEach(gp => gp.vs.forEach(v => { goes[v.vno] = { ll: hub, name: S.hub, into: true }; }));
    d.out.forEach(gp => { const ll = placeLL(gp.place, !load); if (ll) gp.vs.forEach(v => { goes[v.vno] = goes[v.vno] || { ll: ll, name: gp.place, into: false }; }); });
    legLines(m, vs.filter(v => goes[v.vno]), v => goes[v.vno].ll, { color: v => (goes[v.vno].into ? col.in : col.out), name: v => goes[v.vno].name })
      .forEach(l => { if (l.rd) l.rd.pts.forEach(p => pts.push(p)); });
    const lost = truckMarks(m, vs);
    m.trucks.eachLayer(l => pts.push([l.getLatLng().lat, l.getLatLng().lng]));
    mapFit(m, pts, S.hmode + '|' + S.hub, false);
    mapNote(note, lost, missing, vs, [[col.in, load ? 'empty trucks coming to load' : 'loaded trucks coming to unload'], [col.out, load ? 'loaded, going out' : 'leaving after unloading'],
      ['', 'trucks now (colour = status)', 'ring'], ['', 'thicker line = more trucks · tap a place for its trucks', 'tip']]);
    declutterSoon(m);
  }
  /** road ⇄ map on the Route tab (quiet: only set the buttons, the view draws itself when shown) */
  function setRouteMode(mode, quiet) {
    S.rmode = mode === 'map' ? 'map' : 'road';
    store.set('vpt_rmode', S.rmode);
    $$('#routeModeSeg [data-rmode]').forEach(b => b.classList.toggle('on', b.dataset.rmode === S.rmode));
    $('#view-route').classList.toggle('is-map', S.rmode === 'map');
    $('#routeMapWrap').hidden = S.rmode !== 'map';
    if (quiet) return;
    hideRoutePop();
    if (S.rmode === 'map') renderRouteMap();
  }
  /** flow ⇄ map on the Hub Analyzer */
  function setHubView(mode, quiet) {
    S.hview = mode === 'map' ? 'map' : 'flow';
    store.set('vpt_hview', S.hview);
    $$('#hubViewSeg [data-hview]').forEach(b => b.classList.toggle('on', b.dataset.hview === S.hview));
    $('#view-hub').classList.toggle('is-map', S.hview === 'map');
    $('#hubMapWrap').hidden = S.hview !== 'map';
    if (quiet) return;
    if (S.hview === 'map' && S.hub) renderHubMap(hubData(S.hmode, S.hub));
    else drawHubLinks();
  }

  /* =====================================================================
   *  Route Finder — draw a route's real road: A and B are pinned, every tap on the map adds a point from A towards B
   *  and the road follows the real roads through them (OSRM). Saved in the "Drawn Routes" tab (Code.gs) as "Waiting";
   *  the Director gives it a Route ID ("Approved") and from then on it is one of that route's ways in Route & Hub.
   * ===================================================================== */
  const DRAWN_KEY = 'vpt_drawn_v1';
  S.drawn = store.get(DRAWN_KEY, []);              // every drawn road: Waiting / Approved / Rejected
  S.drawOk = !!store.get('vpt_draw_ok', false);    // the deployed Apps Script can save them (Code.gs "routes-5")
  let drawnIdx = null;                             // the approved ones by From>To (spellings merged)
  /** the Director's drawn roads of a route, as ways { pts, km, min, code, dname } */
  function drawnFor(from, to) {
    if (!drawnIdx) {
      drawnIdx = {};
      S.drawn.filter(d => d.status === 'Approved' && d.road).forEach(d => {
        const k = spellKey(d.from) + '>' + spellKey(d.to);
        (drawnIdx[k] = drawnIdx[k] || []).push(d);
      });
    }
    return (drawnIdx[spellKey(from) + '>' + spellKey(to)] || [])
      .map(d => d.way || (d.way = { pts: polyDecode(d.road), km: +d.km || 0, min: +d.min || 0, code: d.code, dname: d.via }));
  }
  const DRAWN_HEAD = {
    'id': 'id', 'date': 'date', 'from': 'from', 'to': 'to', 'road': 'road', 'km': 'km', 'car minutes': 'min', 'via': 'via', 'points': 'points',
    'drawn by': 'by', 'drawn at': 'at', 'status': 'status', 'route id': 'code', 'checked by': 'okBy', 'checked at': 'okAt', 'note': 'note'
  };
  let drawnAt = 0, drawnBusy = null;
  /** the drawn roads: straight from the sheet (public CSV, ≈1 s), else from the Apps Script; again after 2 minutes */
  function loadDrawn(force) {
    if (LOCAL || drawnBusy || (!force && Date.now() - drawnAt < 120000)) return drawnBusy || Promise.resolve();
    drawnAt = Date.now();
    const viaSheet = async () => {
      const url = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(CFG.SHEET_ID) + '/gviz/tq?tqx=out:csv&headers=1&sheet=' +
        encodeURIComponent(CFG.ROUTE_TAB || 'Drawn Routes');
      const r = await fetchWithTimeout(url, { cache: 'no-store' }, 15000), text = await r.text();
      if (!r.ok || /^\s*</.test(text)) throw new Error('tab not readable');
      const grid = parseCsv(text), keys = (grid[0] || []).map(h => DRAWN_HEAD[normHead(h)] || '');
      if (!['id', 'road', 'status'].every(k => keys.includes(k))) throw new Error('no tab yet');   // a missing tab gives the first sheet
      return grid.slice(1).map(row => { const o = {}; keys.forEach((k, i) => { if (k) o[k] = String(row[i] == null ? '' : row[i]); }); return o; }).filter(o => o.id);
    };
    drawnBusy = viaSheet().catch(() => (S.drawOk ? api('routes').then(r => r.routes || []) : null))
      .then(list => { if (list) setDrawn(list); }).catch(() => { /* keep what we have */ })
      .then(() => { drawnBusy = null; });
    return drawnBusy;
  }
  function setDrawn(list) {
    const sig = l => JSON.stringify(l.map(d => [d.id, d.status, d.code]));
    const changed = sig(list) !== sig(S.drawn);
    S.drawn = list.map(d => { const o = Object.assign({}, d); delete o.way; return o; });   // its way is made again (with its new Route ID)
    drawnIdx = null;
    store.set(DRAWN_KEY, S.drawn);
    if (!changed) return;
    S.routeKey = '';
    renderBadges();
    if (['route', 'hub', 'draw'].includes(S.view)) renderAll();
  }
  const canCheck = () => isTop(S.user) || S.auth.admin;   // the Director: adds drawn roads to Route & Hub

  // the drawing: From / To (any place — the sheet's loading / unloading points first, any town, or a new name), the points
  // on the way (any order: each goes where it fits) — the road always runs A → points → B. Kept in this browser until saved.
  const D = { from: '', to: '', pts: [], hist: [], road: null, busy: false, seq: 0, msg: '', fitKey: '' };
  (draft => {
    if (draft.key && !draft.from) [draft.from, draft.to] = String(draft.key).split('→');   // a drawing kept by the first version
    D.from = draft.from || ''; D.to = draft.to || ''; D.pts = Array.isArray(draft.pts) ? draft.pts : []; D.hist = D.pts.slice();
  })(store.get('vpt_draw_draft', {}));
  D.follow = store.get('vpt_draw_follow', true);
  const keepDraft = () => store.set('vpt_draw_draft', { from: D.from, to: D.to, pts: D.pts });
  /** names for the From / To lists: the Calling Sheet's loading (or unloading) points, busiest first, then every known town */
  function drawPlaces(kind) {
    const n = {}, seen = new Set(), out = [];
    S.vehicles.forEach(v => { const p = v.cat !== 'sold' && (kind === 'from' ? v.from : v.to); if (p) n[p] = (n[p] || 0) + 1; });
    const add = p => { const k = spellKey(p); if (k && !seen.has(k)) { seen.add(k); out.push(p); } };
    Object.keys(n).sort((a, b) => n[b] - n[a]).forEach(add);
    Object.keys(PLACES).filter(p => /^[A-Z]/.test(p) && !NOT_PLACE.test(p)).sort().forEach(add);
    return out;
  }
  /** From / To on the map, or null (a name not known yet is looked up on OpenStreetMap — the map draws itself when found) */
  function drawSel() {
    if (!D.from || !D.to) return null;
    const A = placeLL(D.from), B = placeLL(D.to);
    return A && B && A.join() !== B.join() ? { from: D.from, to: D.to, A: A, B: B } : null;
  }
  async function renderDraw() {
    const sig = S.vehicles.length + '|' + Object.keys(PLACES).length;
    if (sig !== S.drawListSig) {   // the name lists, made again only when the sheet changed
      S.drawListSig = sig;
      const opts = l => l.map(p => '<option value="' + esc(p) + '">').join('');
      $('#drawFromList').innerHTML = opts(drawPlaces('from'));
      $('#drawToList').innerHTML = opts(drawPlaces('to'));
      $('#drawTownList').innerHTML = opts(towns().map(t => t.n));
    }
    if (document.activeElement !== $('#drawFrom')) $('#drawFrom').value = D.from;
    if (document.activeElement !== $('#drawTo')) $('#drawTo').value = D.to;
    renderDrawList();
    loadDrawn();
    let m = MAPS.drawMap;
    if (!m) {
      try { m = await mapFor('drawMap', true); } catch (e) { $('#drawNote').innerHTML = '<b>The map could not load.</b> Check the internet and open Route Finder again.'; return; }
      m.map.doubleClickZoom.disable();   // a double tap would be two points here
      m.map.on('click', e => drawAdd([+e.latlng.lat.toFixed(5), +e.latlng.lng.toFixed(5)]));
      drawTools(m);
      if (!drawSel()) m.map.setView([22.5, 80.5], 5);   // all India
    }
    if (S.view !== 'draw') return;
    m.map.invalidateSize();
    drawPaint();
    if (!D.road && !D.busy && D.pts.length) drawRoad();   // a drawing kept from before: its road again
  }
  /** the tools on the map itself (so they stay in full screen): what is drawn, on top; a cross in the middle —
   *  zoom in, move the map until the cross is on the place, "＋ Add point here" (exact on a phone); Undo, Clear, Save */
  function drawTools(m) {
    const L = window.L, ov = document.createElement('div');
    ov.className = 'dw-ov';
    ov.innerHTML = '<div class="dw-sum" id="drawSum"></div><div class="dw-cross" aria-hidden="true"></div>' +
      '<label class="dw-follow" title="On: the road follows the real roads between your points. Off: straight lines."><input type="checkbox" id="drawFollow"> Follow roads</label>' +
      '<div class="dw-bar">' +
        '<button type="button" class="dw-b" id="drawUndo" title="Take back the last point added">↶<span>Undo</span></button>' +
        '<button type="button" class="dw-b dw-here" id="drawHere" title="Add a point where the cross is">＋<span>Add point here</span></button>' +
        '<button type="button" class="dw-b" id="drawClear" title="Take out every point">✕<span>Clear</span></button>' +
        '<button type="button" class="dw-b dw-save" id="drawSave" title="Save this road for the Director">💾<span>Save</span></button>' +
      '</div>';
    m.map.getContainer().appendChild(ov);
    [...ov.children].forEach(c => { L.DomEvent.disableClickPropagation(c); L.DomEvent.disableScrollPropagation(c); });   // a tap on a tool is not a point
    $('#drawFollow').checked = D.follow;
    $('#drawFollow').addEventListener('change', e => { D.follow = e.target.checked; store.set('vpt_draw_follow', D.follow); drawRoad(); });
    $('#drawHere').addEventListener('click', () => { const c = m.map.getCenter(); D.tapAt = null; drawAdd([+c.lat.toFixed(5), +c.lng.toFixed(5)]); });
    $('#drawUndo').addEventListener('click', () => { const p = D.hist.pop(); drawTake(D.pts.includes(p) ? D.pts.indexOf(p) : D.pts.length - 1); });
    $('#drawClear').addEventListener('click', () => {
      if (D.pts.length > 2 && !confirm('Take out all ' + D.pts.length + ' points and start again?')) return;
      D.pts = []; D.hist = []; drawChanged();
    });
    $('#drawSave').addEventListener('click', drawSave);
  }
  function drawFit(g) {
    const m = MAPS.drawMap;
    D.fitKey = g.from + '→' + g.to;
    if (m) m.map.fitBounds([g.A, g.B].concat(D.pts), { paddingTopLeft: [40, 80], paddingBottomRight: [40, 100], maxZoom: 9 });
  }
  /** the map: A / B pins, the road (or a dotted A – B line before the first point), the points (drag to move, tap to
   *  take out), and this route's roads drawn before (faint: green = in Route & Hub, amber = waiting for the Director) */
  function drawPaint() {
    const m = MAPS.drawMap, g = drawSel(), L = window.L;
    drawSum(g);
    drawChips(g);
    if (!m || !L) return;
    m.lines.clearLayers(); m.marks.clearLayers(); m.drawn = new Set();
    if (!g) return;
    if (D.fitKey !== g.from + '→' + g.to) drawFit(g);   // a new From / To (or one just found): show both
    S.drawn.filter(d => d.road && d.status !== 'Rejected' && spellKey(d.from) === spellKey(g.from) && spellKey(d.to) === spellKey(g.to)).forEach(d => {
      const ok = d.status === 'Approved', w = d.way || (d.way = { pts: polyDecode(d.road), km: +d.km || 0, min: +d.min || 0, code: d.code, dname: d.via });
      flowLine(m, g.A, g.B, { rd: w, color: ok ? '#0f9d58' : '#f0a30a', edge: ok ? '#0b5d36' : '#a86b00', look: 'faint', w: 4,
        tip: (ok ? 'In Route & Hub as ' + esc(d.code) : 'Waiting for the Director') + ' · drawn by ' + esc(d.by) });
    });
    const pin = (ll, kind, name) => {
      const mk = L.marker(ll, { zIndexOffset: 500, icon: L.divIcon({ className: 'mk', iconSize: null, html: '<div class="mk-in mk-pinw"><div class="mk-pin ' + kind + '"><i>' + (kind === 'b' ? 'B' : 'A') + '</i></div></div>' }) });
      mk.bindTooltip(esc(name), { permanent: true, direction: 'right', offset: [14, -16], className: 'mk-lbl major' });
      m.marks.addLayer(mk);
    };
    pin(g.A, 'a', g.from);
    pin(g.B, 'b', g.to);
    if (D.road) flowLine(m, g.A, g.B, { rd: D.road, color: '#1a73e8', edge: '#0b3d91', look: 'sel', w: 6, tip: 'Your road' });
    else m.lines.addLayer(L.polyline([g.A, g.B], { color: '#5f6368', weight: 2.5, opacity: .75, dashArray: '2 9', interactive: false }));
    D.pts.forEach((p, i) => {
      const mk = L.marker(p, { draggable: true, keyboard: false, zIndexOffset: 900,
        icon: L.divIcon({ className: 'mk', iconSize: null, html: '<div class="mk-in dw-pt">' + (i + 1) + '</div>' }) });
      mk.bindTooltip(esc(nearTown(p)) + ' · drag to move · tap to take out', { direction: 'top', offset: [0, -14] });
      mk.on('dragend', e => {
        const ll = e.target.getLatLng(), nw = [+ll.lat.toFixed(5), +ll.lng.toFixed(5)], h = D.hist.indexOf(D.pts[i]);
        if (h >= 0) D.hist[h] = nw;
        D.pts[i] = nw;
        drawChanged();
      });
      mk.on('click', () => drawTake(i));
      m.marks.addLayer(mk);
    });
  }
  function drawSum(g) {
    const el = $('#drawSum'), w = D.road, n = D.pts.length;
    if (el) {
      el.innerHTML = !D.from || !D.to ? '<b>1.</b> Choose <b>From</b> and <b>To</b> above the map'
        : !g ? '<b>' + esc(D.from + ' → ' + D.to) + '</b> — finding this place on the map… (if it never shows, check the spelling)'
        : '<b>' + esc(g.from + ' → ' + g.to) + '</b>' + (w ? ' · <b>' + w.km + ' km</b> · ≈ ' + esc(truckTime(w.min, w.km)) : '') + ' · ' +
          (D.busy ? '<span class="dw-busy">Finding the road…</span>'
            : n ? '<span class="dw-ok">' + n + ' point' + (n > 1 ? 's' : '') + ' ✓</span> add more or 💾 Save'
            : '<span class="dw-next">Zoom in, put the ＋ on the road and “Add point here” — or tap the map</span>');
    }
    $('#drawNote').innerHTML = (D.msg ? '<b>' + esc(D.msg) + '</b><br>' : '') + 'Add the places the lorries pass in any order — each goes where it fits between A and B. ' +
      'Drag a point to move it, tap it to take it out. ' + (D.follow ? 'The road follows the real roads (OpenStreetMap).' : 'Straight lines between your points.');
    const off = (id, v) => { const b = $(id); if (b) b.disabled = v; };
    off('#drawUndo', !n); off('#drawClear', !n); off('#drawHere', !g);
    off('#drawSave', !(g && w && n && !D.busy));
  }
  /** the points as chips with the town they are at: tap one to zoom to it, ✕ to take it out */
  function drawChips(g) {
    $('#drawPts').innerHTML = !g ? '' : !D.pts.length ? '<span class="dw-pts-t">On the way: no place yet</span>'
      : '<span class="dw-pts-t">On the way:</span>' + D.pts.map((p, i) => '<span class="dw-chip"><button type="button" data-pgo="' + i + '"><i>' + (i + 1) + '</i>' +
        esc(nearTown(p)) + '</button><button type="button" class="x" data-pdel="' + i + '" aria-label="Take out point ' + (i + 1) + '">✕</button></span>').join('');
  }
  /** the town a point is at (or near), else its position */
  function nearTown(p) {
    let best = null, bd = 25;
    towns().forEach(t => { const d = kmApart(t.p, p); if (d < bd) { bd = d; best = t; } });
    return best ? (bd < 4 ? best.n : 'near ' + best.n) : p[0].toFixed(2) + ', ' + p[1].toFixed(2);
  }
  /** a point on the way: put where it makes the least detour between A, the points and B — so any order works */
  function drawAdd(ll) {
    const g = drawSel(), now = Date.now();
    if (D.tapAt && now - D.tapAt.t < 600 && kmApart(D.tapAt.ll, ll) < 1) return;   // one tap on a phone can come twice
    D.tapAt = { t: now, ll: ll };
    if (!g) { toast('Choose From and To first (above the map)'); return; }
    const chain = [g.A].concat(D.pts, [g.B]);
    let at = 0, cost = Infinity;
    for (let i = 0; i < chain.length - 1; i++) {
      const c = kmApart(chain[i], ll) + kmApart(ll, chain[i + 1]) - kmApart(chain[i], chain[i + 1]);
      if (c < cost) { cost = c; at = i; }
    }
    D.pts.splice(at, 0, ll);
    D.hist.push(ll);
    drawChanged();
  }
  function drawTake(i) {
    if (i < 0 || i >= D.pts.length) return;
    const p = D.pts.splice(i, 1)[0], h = D.hist.indexOf(p);
    if (h >= 0) D.hist.splice(h, 1);
    drawChanged();
  }
  function drawChanged() { keepDraft(); drawRoad(); }
  /** the road A → points → B along the real roads (one OSRM ask for the whole chain); straight lines when it cannot */
  async function drawRoad() {
    const g = drawSel(), seq = ++D.seq;
    D.msg = '';
    if (!g || !D.pts.length) { D.road = null; D.busy = false; drawPaint(); return; }
    const chain = [g.A].concat(D.pts, [g.B]);
    const straight = () => { let km = 0; for (let i = 1; i < chain.length; i++) km += kmApart(chain[i - 1], chain[i]); return { pts: chain.slice(), km: Math.round(km), min: Math.round(km) }; };
    if (!D.follow) { D.road = straight(); D.busy = false; drawPaint(); return; }
    D.busy = true;
    drawPaint();
    let road = null, msg = '';
    try {
      const r = await fetchWithTimeout('https://router.project-osrm.org/route/v1/driving/' + chain.map(p => p[1] + ',' + p[0]).join(';') + '?overview=full&geometries=polyline', {}, 20000);
      const j = r.ok ? await r.json() : null, rt = j && j.code === 'Ok' && j.routes[0];
      if (rt) road = { pts: simplify(polyDecode(rt.geometry), 0.0012), km: Math.round(rt.distance / 1000), min: Math.round(rt.duration / 60) };
      else msg = 'No road found through these points — joined with straight lines';
    } catch (e) { msg = 'The road finder did not answer — joined with straight lines (move a point to try again)'; }
    if (seq !== D.seq) return;   // changed again meanwhile: that answer counts
    D.road = road || straight(); D.msg = msg; D.busy = false;
    drawPaint();
  }
  async function drawSave() {
    const g = drawSel();
    if (!g || !D.road || !D.pts.length || D.busy) return;
    if (!S.drawOk) { toast('Saving needs the new Apps Script (Code.gs) — see the note under the map', true); renderDrawList(); return; }
    if (!(await ensureUser())) return;
    if (!S.auth.token) { toast('Log in first to save a road', true); return; }
    const b = $('#drawSave');
    b.disabled = true;
    try {
      const res = await api('saveRoute', { token: S.auth.token, from: g.from, to: g.to, road: polyEncode(simplify(D.road.pts, 0.0015)),
        km: D.road.km, min: D.road.min, via: wayNames([D.road], g.A, g.B)[0] || '', points: polyEncode(D.pts) });
      setDrawn(S.drawn.concat([res.route]));
      D.pts = []; D.hist = []; D.road = null; keepDraft();
      toast('Saved ✓ — waiting for the Director to add it to Route & Hub');
      renderDraw();
      $('#drawList').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) {
      if (e.code === 'auth') { logoutLocal(); openLogin(); }
      toast(e.message, true);
    } finally { drawSum(drawSel()); }
  }
  /** the Director: Approved (with a Route ID) / Rejected; whoever drew a waiting road (or the Director) may delete it */
  async function drawSet(id, status, code) {
    if (!S.drawOk) { toast('This needs the new Apps Script (Code.gs) — see the note under the map', true); return; }
    if (!(await ensureUser()) || !S.auth.token) return;
    try {
      const res = await api('setRoute', { token: S.auth.token, id: id, status: status, code: code || '' });
      setDrawn(status === 'Deleted' ? S.drawn.filter(d => d.id !== id) : S.drawn.map(d => (d.id === id ? Object.assign({}, d, res.route) : d)));
      toast(status === 'Approved' ? 'Added to Route & Hub as ' + code + ' ✓' : status === 'Deleted' ? 'Deleted' : status === 'Rejected' ? 'Taken out — not used in Route & Hub' : 'Done');
      renderDraw();
    } catch (e) {
      if (e.code === 'auth') { logoutLocal(); openLogin(); }
      toast(e.message, true);
    }
  }
  /** a saved road on the map again (to check it, or to change it and save it as a new one) */
  function drawShow(id) {
    const d = S.drawn.find(x => x.id === id);
    if (!d) return;
    D.from = d.from; D.to = d.to; D.pts = d.points ? polyDecode(d.points) : []; D.hist = D.pts.slice(); D.busy = false; D.msg = ''; D.seq++;
    D.road = { pts: polyDecode(d.road), km: +d.km || 0, min: +d.min || 0 };
    keepDraft();
    $('#drawFrom').value = D.from; $('#drawTo').value = D.to;
    D.fitKey = D.from + '→' + D.to;   // fit to the road itself, below
    renderDraw().then(() => { const m = MAPS.drawMap; if (m) m.map.fitBounds(window.L.latLngBounds(D.road.pts), { paddingTopLeft: [40, 80], paddingBottomRight: [40, 100] }); });
    $('#drawMap').scrollIntoView({ block: 'center' });
  }
  function renderDrawList() {
    const boss = canCheck(), me = String(S.user || '').toLowerCase();
    const rank = { Waiting: 0, Approved: 1, Rejected: 2 };
    const list = S.drawn.slice().sort((a, b) => (rank[a.status] == null ? 3 : rank[a.status]) - (rank[b.status] == null ? 3 : rank[b.status]) || String(b.at).localeCompare(String(a.at)));
    const n = st => S.drawn.filter(d => d.status === st).length;
    const next = 'R-' + (101 + n('Approved'));
    const card = d => {
      const st = d.status === 'Approved' ? 'ok' : d.status === 'Rejected' ? 'no' : 'wait', own = String(d.by).toLowerCase() === me && st === 'wait';
      return '<div class="dl-card dl-' + st + '"><div class="dl-top"><b>' + esc(d.from + ' → ' + d.to) + '</b><span class="dl-st">' +
        (st === 'ok' ? '✓ In Route &amp; Hub · ' + esc(d.code) : st === 'no' ? '✕ Not used' : '⏳ Waiting for the Director') + '</span></div>' +
        '<div class="dl-meta">' + esc(d.km) + ' km · ≈ ' + esc(truckTime(+d.min || 0, +d.km || 0)) + ' by truck' + (d.via ? ' · via ' + esc(d.via) : '') +
        ' · drawn by <b>' + esc(d.by) + '</b> ' + esc(d.at) + (d.okBy && st !== 'wait' ? ' · ' + (st === 'ok' ? 'added' : 'checked') + ' by ' + esc(d.okBy) : '') + '</div>' +
        '<div class="dl-act"><button type="button" class="btn sm" data-dshow="' + esc(d.id) + '">🗺️ Show</button>' +
        (boss && st !== 'ok' ? '<input class="dl-code" data-dcode="' + esc(d.id) + '" value="' + esc(d.code || next) + '" maxlength="30" aria-label="Route ID">' +
          '<button type="button" class="btn sm primary" data-dok="' + esc(d.id) + '">✓ Add to Route &amp; Hub</button>' : '') +
        (boss && st === 'wait' ? '<button type="button" class="btn sm" data-dno="' + esc(d.id) + '">✕ Don’t use</button>' : '') +
        (boss && st === 'ok' ? '<button type="button" class="btn sm" data-dno="' + esc(d.id) + '">Take out of Route &amp; Hub</button>' : '') +
        (boss || own ? '<button type="button" class="btn sm dl-del" data-ddel="' + esc(d.id) + '">🗑 Delete</button>' : '') + '</div></div>';
    };
    $('#drawList').innerHTML = '<div class="dl-head"><h3>Drawn roads</h3><span>' + n('Waiting') + ' waiting · ' + n('Approved') + ' in Route &amp; Hub</span>' +
      (boss ? '<em>Director: check a road (🗺️ Show), give it a Route ID and “Add to Route &amp; Hub”.</em>' : '<em>The Director checks each saved road and adds it to Route &amp; Hub.</em>') + '</div>' +
      (S.drawOk ? '' : '<p class="dl-warn">⚠ Saving needs the new Apps Script once: Apps Script → paste the new Code.gs → Save → Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy. Until then you can draw, but not save.</p>') +
      (list.length ? list.map(card).join('') : '<p class="dl-empty">No road drawn yet. Pick a route above and draw its road from A to B.</p>');
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
    $('#userBtn').addEventListener('click', () => { if (S.auth.on) openUserMenu(); else openWho(); });
    $('#callsBtn').addEventListener('click', openCalls);
    $('#callsOverlay').addEventListener('click', e => { if (e.target.id === 'callsOverlay' || e.target.closest('[data-close-calls]')) closeCalls(); });
    $('#inboxBtn').addEventListener('click', openInbox);
    $('#inboxOverlay').addEventListener('click', onInboxClick);

    // caller chips (board + programs)
    ['#callerChips', '#callerChips2', '#callerChips3'].forEach(sel => $(sel).addEventListener('click', e => {
      const b = e.target.closest('[data-caller]'); if (b) setCaller(b.dataset.caller);
    }));
    // route view: search, status filter, tap a vehicle
    let rqt = null;
    $('#rq').addEventListener('input', e => { clearTimeout(rqt); rqt = setTimeout(() => { S.rq = e.target.value.trim(); renderRoutes(); }, IS_PHONE ? 220 : 120); });
    $('#routeLegend').addEventListener('click', e => { const b = e.target.closest('[data-rcat]'); if (b) { S.rcat = S.rcat === b.dataset.rcat ? '' : b.dataset.rcat; renderRoutes(); } });
    // the Route banner: three trucks in the company colours driving across
    ['#rhLane1', '#rhLane2', '#rhLane3'].forEach((s, i) => { $(s).innerHTML = '<span class="rh-truck" style="--c:' + ['#f28a1c', '#ffffff', '#7c83d6'][i] + '">' + ICO.truck + '</span>'; });
    // a vehicle dot: hover (computer) or tap (phone) opens a small window about it; "Full details" opens everything
    const hoverable = !!(window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches);
    const pop = $('#rpop');
    [$('#routeList'), $('#hubBody')].forEach(rl => { // Route and Hub Analyzer trucks behave the same
      rl.addEventListener('mouseover', e => { const d = hoverable && e.target.closest('.rdot'); if (d) showRoutePop(d); });
      rl.addEventListener('mouseout', e => {
        if (!hoverable || !e.target.closest('.rdot')) return;
        const to = e.relatedTarget;
        if (!(to && to.closest && (to.closest('#rpop') || to.closest('.rdot')))) hideRoutePop(true);
      });
      rl.addEventListener('focusin', e => { const d = e.target.closest('.rdot'); if (d) showRoutePop(d); });
      rl.addEventListener('click', e => {
        const all = e.target.closest('.rl-all');
        if (all) { const lg = all.closest('.r-legend'); lg.classList.toggle('open'); all.textContent = lg.classList.contains('open') ? 'Fewer colours ▴' : 'All colours ▾'; return; }
        // a route's ways: tap one to light it up (the others fade), again to see all; or see them on the map
        const lh = e.target.closest('.r-lane-h[data-lane]');
        if (lh) {
          const ws = lh.closest('.r-ways'), lane = lh.closest('.r-lane'), on = !lane.classList.contains('on');
          ws.querySelectorAll('.r-lane').forEach(l => l.classList.toggle('on', on && l === lane));
          ws.classList.toggle('r-picked', on);
          S.rlane = S.rlane || {};
          S.rlane[ws.dataset.route] = on ? +lh.dataset.lane : undefined;   // kept when the list is drawn again
          return;
        }
        const rm = e.target.closest('[data-rmap]');
        if (rm) { S.rpick = rm.dataset.rmap; S.rplace = ''; setRouteMode('map'); $('#routeMapWrap').scrollIntoView({ block: 'start' }); return; }
        // hub analyzer: a place row opens / closes its trucks (one at a time), "+ N more", the hub box shows its trucks
        const hrow = e.target.closest('.hf-row');
        if (hrow) {
          const it = hrow.closest('.hf-item'), was = it.classList.contains('open');
          $$('#hubBody .hf-item.open').forEach(x => x.classList.remove('open'));
          if (!was) it.classList.add('open');
          drawHubLinks();
          return;
        }
        const more = e.target.closest('[data-hmore]');
        if (more) { S.hubAll[more.dataset.hmore] = true; renderHub(); return; }
        if (e.target.closest('[data-hubbox]')) { const p = $('#hubBody .hf-at'); if (p) { p.hidden = !p.hidden; drawHubLinks(); } return; }
        const d = e.target.closest('.rdot');
        if (!d) return;
        if (hoverable) { hideRoutePop(); openDetail(d.dataset.v); } else showRoutePop(d);
      });
    });
    // hub analyzer controls
    $('#hubSeg').addEventListener('click', e => { const b = e.target.closest('[data-hmode]'); if (b && b.dataset.hmode !== S.hmode) { S.hmode = b.dataset.hmode; S.hub = ''; S.hubAll = {}; renderHub(); } });
    $('#hubSel').addEventListener('change', e => { S.hub = e.target.value; S.hubAll = {}; renderHub(); });
    // road / flow ⇄ map
    $('#routeModeSeg').addEventListener('click', e => { const b = e.target.closest('[data-rmode]'); if (b) setRouteMode(b.dataset.rmode); });
    $('#hubViewSeg').addEventListener('click', e => { const b = e.target.closest('[data-hview]'); if (b) setHubView(b.dataset.hview); });
    $('#routePick').addEventListener('change', e => { S.rpick = e.target.value; S.rplace = ''; renderRouteMap(); });
    $('#placePick').addEventListener('change', e => { S.rplace = e.target.value; S.rpick = ''; renderRouteMap(); });
    // Route Finder: From / To (any place), ⇅ swap, a place on the way by name, the point chips (tap: zoom to it, ✕: take
    // it out); the tools on the map are bound when the map is made. The list: show a saved road, the Director adds it
    // to Route & Hub (Route ID) / does not use it / deletes it
    const setEnd = (k, v) => {
      v = up(String(v || '').trim());
      if (v === D[k]) return;
      D[k] = v; D.road = null; D.msg = ''; D.seq++;
      keepDraft();
      if (v) placeLL(v);   // a name not known yet: looked up on OpenStreetMap
      drawRoad();
    };
    $('#drawFrom').addEventListener('change', e => setEnd('from', e.target.value));
    $('#drawTo').addEventListener('change', e => setEnd('to', e.target.value));
    $('#drawSwap').addEventListener('click', () => {
      [D.from, D.to] = [D.to, D.from]; D.pts.reverse(); D.road = null; D.seq++;
      $('#drawFrom').value = D.from; $('#drawTo').value = D.to;
      keepDraft(); drawRoad();
    });
    const addPlace = () => {
      const v = $('#drawPlace').value.trim();
      if (!v) return;
      const p = placeLL(v);
      if (!p) { toast('“' + v + '” is not on the map yet — check the spelling, or zoom in and add it with ＋', true); return; }
      $('#drawPlace').value = '';
      D.tapAt = null;
      drawAdd(p.slice());
    };
    $('#drawPlaceAdd').addEventListener('click', addPlace);
    $('#drawPlace').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addPlace(); } });
    $('#drawPts').addEventListener('click', e => {
      const go = e.target.closest('[data-pgo]'), del = e.target.closest('[data-pdel]');
      if (del) drawTake(+del.dataset.pdel);
      else if (go && MAPS.drawMap) { MAPS.drawMap.map.setView(D.pts[+go.dataset.pgo], 11); $('#drawMap').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    });
    $('#drawList').addEventListener('click', e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.dshow) drawShow(t.dataset.dshow);
      else if (t.dataset.dok) {
        const inp = $$('#drawList [data-dcode]').find(x => x.dataset.dcode === t.dataset.dok), code = inp ? inp.value.trim() : '';
        if (!code) { toast('Give the road a Route ID first', true); return; }
        drawSet(t.dataset.dok, 'Approved', code);
      } else if (t.dataset.dno) drawSet(t.dataset.dno, 'Rejected');
      else if (t.dataset.ddel && confirm('Delete this drawn road?')) drawSet(t.dataset.ddel, 'Deleted');
    });
    // full-screen map: the back button / Esc close it (but a detail sheet over it closes first)
    window.addEventListener('popstate', () => { const f = $('.mp-map.mp-full'); if (f && !(history.state && history.state.vpt === 'map')) mapFull(f, false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !S.detail && $('.mp-map.mp-full')) history.back(); });
    $('#routeEta').addEventListener('click', e => { if (e.target.closest('[data-rpick]')) { S.rpick = ''; S.rplace = ''; renderRouteMap(); } });
    setRouteMode(S.rmode, true);
    setHubView(S.hview, true);
    $('#hubChips').addEventListener('click', e => { const b = e.target.closest('[data-hub]'); if (b) { S.hub = b.dataset.hub; S.hubAll = {}; renderHub(); } });
    $('#hubBody').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-hubbox]')) { e.preventDefault(); e.target.click(); } });
    let hubRt = null;
    window.addEventListener('resize', () => { clearTimeout(hubRt); hubRt = setTimeout(() => { if (S.view === 'hub') renderHub(); }, 200); });
    pop.addEventListener('mouseenter', () => clearTimeout(popTimer));
    pop.addEventListener('mouseleave', () => hideRoutePop(true));
    pop.addEventListener('click', e => { const o = e.target.closest('[data-rp-open]'); if (o) { hideRoutePop(); openDetail(o.dataset.rpOpen); } });
    document.addEventListener('click', e => { if (!pop.hidden && !e.target.closest('#rpop, .rdot')) hideRoutePop(); });
    document.addEventListener('scroll', () => { if (!pop.hidden) hideRoutePop(); }, { passive: true, capture: true });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) hideRoutePop(); });

    // search
    let qt = null;
    $('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { S.f.q = e.target.value.trim(); renderBoard(); }, IS_PHONE ? 220 : 120); });
    let pqt = null;
    $('#pq').addEventListener('input', e => { clearTimeout(pqt); pqt = setTimeout(() => { S.pq = e.target.value.trim(); renderPrograms(); }, IS_PHONE ? 220 : 120); });
    document.addEventListener('keydown', e => {
      if (e.key === '/' && S.view === 'board' && !/input|select|textarea/i.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); $('#q').focus(); }
      if (e.key === 'Escape') { if (!$('#whoOverlay').hidden) closeWho(); else if (!$('#callsOverlay').hidden) closeCalls(); else if (!$('#inboxOverlay').hidden) closeInbox(); else if (S.detail) closeDetail(); }
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
    $('#progSeg').addEventListener('click', e => { const b = e.target.closest('[data-pseg]'); if (b) { S.pseg = b.dataset.pseg; S.sel.clear(); renderPrograms(); } });
    // pick several vehicles → one program for all of them
    $('#ploc').addEventListener('change', e => { S.ploc = e.target.value; renderPrograms(); });
    $('#progList').addEventListener('change', e => {
      const c = e.target.closest('[data-pick]');
      if (!c) return;
      if (c.checked) S.sel.add(c.dataset.pick); else S.sel.delete(c.dataset.pick);
      renderPrograms();
    });
    $('#progList').addEventListener('click', e => {
      const b = e.target.closest('[data-pickall]');
      if (!b) return;
      const vnos = $$('#progList .pcard').map(c => c.dataset.card).filter(vno => S.byVno[vno] && progPlace(S.byVno[vno]) === b.dataset.pickall);
      const all = vnos.every(x => S.sel.has(x));
      vnos.forEach(x => { if (all) S.sel.delete(x); else S.sel.add(x); });
      renderPrograms();
    });
    $('#bulkClear').addEventListener('click', () => { S.sel.clear(); renderPrograms(); });
    $('#bulkGive').addEventListener('click', () => bulkGive(false));
    $('#bulkDirect').addEventListener('click', () => bulkGive(true));
    $('#bulkProg').addEventListener('keydown', e => { if (e.key === 'Enter') bulkGive(); });
    $('#progList').addEventListener('click', e => {
      if (e.target.closest('[data-sendall]')) { sendToCaller(S.mgrShown || []); return; }
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
    $('#sheetOverlay').addEventListener('click', e => {
      if (e.target.id === 'sheetOverlay' || e.target.closest('[data-close]')) { closeDetail(); return; }
      const s = e.target.closest('[data-seen-id]');
      if (s) { markSeen([s.dataset.seenId]); renderDetail(); }
    });

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
    $('#clearProgBtn').addEventListener('click', clearPrintedPrograms);
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
    S.msgs.forEach(m => S.msgKnown.add(m.id)); // already-known messages are not announced again
    computeActive();
    setView(location.hash.slice(1) || 'board', true);
    showBanner();
    setSaveState();
    flushOutbox(); // saves left over from last time
    bindInstall();
    bindAuth();
    if (S.auth.on && !S.auth.token) openLogin(); // login known to be on and nobody logged in on this phone
    checkAuth();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      // a new version of the site took over (on a slow phone the saved old copy may have opened first):
      // reload once so the new one shows — unless somebody is typing, then just say so
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        if (editingNow()) { toast('A new version of the website is ready — refresh the page'); return; }
        reloading = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').catch(() => {}); // offline copy: opens at once on slow networks
    }
    const cc = store.get(K_CALLS, null); // last calls figures: shown at once, refreshed right after
    if (cc && cc.calls) { S.calls = cc.calls; S.callsAt = cc.at; }
    renderCallsBtn();
    renderInboxBtn();
    loadCalls();
    setStickyTop();
    refresh().then(schedulePoll);
  }
  start();
})();
