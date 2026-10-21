/**
 * FuelDesk — diesel buy advisor for Steve's Sanitation
 * Cloudflare Worker (ES module, zero dependencies)
 *
 * What it does on every cron tick (and on POST /api/run):
 *   1. Pull the bulk tank + 28 days of pump transactions from FuelCloud
 *   2. Pull NY Harbor ULSD futures (HO) front + next month from Yahoo Finance
 *   3. Build a burn-rate model, project the tank, work out the last day to order
 *   4. Score the price (percentile, trend, curve, supplier quote + learned basis)
 *   5. Decide: ORDER_NOW / BUY_AHEAD / FILL_UP / HOLD
 *   6. Save everything to Firebase RTDB (REST) and send Web Push alerts
 *
 * Secrets / vars (Worker → Settings → Variables):
 *   APP_KEY                   shared key the PWA and Apps Script send as X-App-Key
 *   FIREBASE_URL              https://<project>-default-rtdb.firebaseio.com
 *   FIREBASE_SECRET           RTDB database secret (Project settings → Service accounts → Database secrets)
 *   DB_ROOT                   (optional) root node, default "fueldesk"
 *   FUELCLOUD_ACCESS_TOKEN    bootstrap pair from FuelCloud portal → Settings → API
 *   FUELCLOUD_REFRESH_TOKEN   (only used until the Worker has stored its own rotated pair)
 *   FUELCLOUD_BASE            (optional) default https://api.fuelcloud.com
 *   FUELCLOUD_API_PREFIX      (optional) default /rest/v1.0
 *   FUELCLOUD_FILL_PATH       (optional) override for the fill endpoint; default /rest/v1.0/transaction (FuelCloud "Create FILL Transactions")
 *   FUELCLOUD_FILLS           (optional) set to "off" to hide the "also record in FuelCloud" option
 *   VAPID_PUBLIC_KEY          base64url, 65-byte uncompressed P-256 point (POST /api/admin/vapid generates a pair)
 *   VAPID_PRIVATE_KEY         base64url, 32-byte scalar
 *   VAPID_SUBJECT             mailto:kelly@stevessanitation.com
 *   ALLOWED_ORIGIN            https://melgard05.github.io  (CORS; comma-separate several)
 *   PRICE_BASE                (optional) default https://query1.finance.yahoo.com
 *   PRICE_SYMBOL              (optional) default HO=F
 *
 * Cron triggers (Worker → Settings → Triggers), in UTC:
 *   "0 12-23 * * MON-FRI"  hourly, roughly 7am–6pm Central, weekdays  (use "0,30 12-23 * * MON-FRI" for every 30 min)
 *   "0 14 * * SAT,SUN"     one check on Saturday/Sunday morning
 *   (Cloudflare's day-of-week field is 1–7 with 1 = Sunday, so stick to the names)
 */

// ───────────────────────────────────────────────────────────────────────────────
// Defaults (overridable from the dashboard → saved at /config)
// ───────────────────────────────────────────────────────────────────────────────
export const VERSION = '2026-10-19b';
export const DEFAULT_CONFIG = {
  tz: 'America/Chicago',
  tankId: null,                 // FuelCloud tank id; null = first diesel tank
  floorPct: 15,                 // planning floor, % of capacity (FuelCloud's "critical low" is 15%)
  maxFillPct: 90,               // ullage — deliveries fill to this %
  leadBusinessDays: 1,          // supplier lead time in business days ("at least a day")
  safetyDays: 1,                // delivery must arrive this many days before the floor
  orderCutoffHour: 10,          // orders placed before this local hour count as today
  minDropGal: 3500,             // smallest load worth taking (a short load)
  loadGal: 7500,                // a normal full transport load — the opportunistic signals wait until one fits
  usageLookbackDays: 28,
  usageSafetyPct: 10,           // planning burn = observed × (1 + this %)
  priceWindowDays: 60,          // calendar days for percentile / median
  cheapPct: 0.33,               // ≤ this percentile = cheap
  richPct: 0.67,                // ≥ this percentile = expensive
  risingFastPct: 0.04,          // 5-trading-day change
  fallingFastPct: -0.04,
  intradayJumpPct: 0.025,       // live vs previous settle
  contangoStrongPct: 0.015,     // next-month premium that argues for buying now
  buyAheadWindowDays: 7,        // calendar days to order-by within which a rising market → buy ahead
  watchWindowDays: 7,
  bridgeDays: 10,               // partial load size (days of burn) when forced to buy into a falling, expensive market
  digestEnabled: true,
  digestHour: 7,
  digestWeekdaysOnly: true,
  quietStart: 21,               // no non-critical pushes between quietStart and quietEnd (local hours)
  quietEnd: 6,
  useDefaultHolidays: true,     // New Year's, Memorial, July 4, Labor, Thanksgiving, Christmas (observed)
  holidays: [],                 // extra YYYY-MM-DD the supplier is closed
  postDeliveriesToFuelCloud: false,
  supplierName: 'Lakes Community Coop',
  productMode: 'schedule',             // 'schedule' = follow productSchedule by date; 'manual' = use quoteProductPattern
  productSchedule: [                   // what you buy, by start date (MM-DD); repeats every year
    { from: '03-15', product: 'b5rm' },
    { from: '04-15', product: 'b20rm' },        // MN B20 requirement Apr 15 – Sep 30
    { from: '10-01', product: 'b5rm' },
    { from: '11-01', product: 'seasonal' },
    { from: '11-25', product: 'wintermaster' },
  ],
  quoteProductPattern: '\\bRM\\b',       // manual mode only: regex matched against the sheet's product labels
  quoteBlend: 'auto',                  // manual mode only: 'auto' = follow the sheet's B5/B20 flag, or 'B5' / 'B20'
  contractRowPattern: 'auto',          // strip row to use as the supplier curve: 'auto' (RM for clear, FM for dyed), or a regex
  contractAlertPct: 0.05,              // flag when the next-3-month contract average is this far below today's spot
};

const ACTION_STATES = new Set(['ORDER_NOW', 'BUY_AHEAD', 'FILL_UP']);
export const STATE_LABEL = {
  ORDER_NOW: 'Order now',
  BUY_AHEAD: 'Buy ahead',
  FILL_UP: 'Good day to order',
  HOLD: 'Hold',
};

// ───────────────────────────────────────────────────────────────────────────────
// Date helpers (all "ymd" values are local-calendar strings YYYY-MM-DD)
// ───────────────────────────────────────────────────────────────────────────────
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    dow: DOW.indexOf(p.weekday),
  };
}
/** local wall time (ymd + "HH:MM" in tz) → UTC epoch ms */
export function localToUtcMs(ymd, hhmm, tz) {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), h, m);
  // offset of tz at that instant, applied twice to settle across DST edges
  const off = (ms) => { const p = localParts(new Date(ms), tz); return Date.UTC(+p.ymd.slice(0, 4), +p.ymd.slice(5, 7) - 1, +p.ymd.slice(8, 10), p.hour, p.minute) - ms; };
  let t = guess - off(guess); t = guess - off(t);
  return t;
}
export function ymdAddDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dowOf(ymd) { return new Date(`${ymd}T12:00:00Z`).getUTCDay(); }
export function daysBetween(a, b) { return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000); }
export function fmtDate(ymd, withDow = true) {
  if (!ymd) return '—';
  const d = new Date(`${ymd}T12:00:00Z`);
  const s = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return withDow ? `${DOW[d.getUTCDay()]} ${s}` : s;
}

function nthWeekday(year, month, dow, n) {
  // month 1-12; n ≥ 1 → nth occurrence; n = -1 → last
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1, 12));
    const offset = (dow - first.getUTCDay() + 7) % 7;
    return new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7, 12)).toISOString().slice(0, 10);
  }
  const last = new Date(Date.UTC(year, month, 0, 12));
  const back = (last.getUTCDay() - dow + 7) % 7;
  return new Date(Date.UTC(year, month, 0 - back, 12)).toISOString().slice(0, 10);
}
function observed(ymd) {
  const d = dowOf(ymd);
  if (d === 6) return ymdAddDays(ymd, -1);
  if (d === 0) return ymdAddDays(ymd, 1);
  return ymd;
}
export function usHolidays(year) {
  return [
    observed(`${year}-01-01`),
    nthWeekday(year, 5, 1, -1),          // Memorial Day
    observed(`${year}-07-04`),
    nthWeekday(year, 9, 1, 1),           // Labor Day
    nthWeekday(year, 11, 4, 4),          // Thanksgiving
    observed(`${year}-12-25`),
  ];
}
export function holidaySet(config, aroundYmd) {
  const y = Number(aroundYmd.slice(0, 4));
  const set = new Set(config.holidays || []);
  if (config.useDefaultHolidays !== false) {
    for (const yy of [y - 1, y, y + 1]) usHolidays(yy).forEach(h => set.add(h));
  }
  return set;
}
export function isBusinessDay(ymd, hol) {
  const d = dowOf(ymd);
  return d >= 1 && d <= 5 && !hol.has(ymd);
}
export function nextBusinessDayOnOrAfter(ymd, hol) {
  let d = ymd, guard = 0;
  while (!isBusinessDay(d, hol) && guard++ < 14) d = ymdAddDays(d, 1);
  return d;
}
export function addBusinessDays(ymd, n, hol) {
  let d = ymd, left = n, guard = 0;
  while (left > 0 && guard++ < 60) {
    d = ymdAddDays(d, 1);
    if (isBusinessDay(d, hol)) left--;
  }
  return d;
}

// ───────────────────────────────────────────────────────────────────────────────
// Usage model — gallons dispensed per local day → planning burn by day of week
// ───────────────────────────────────────────────────────────────────────────────
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(n, p = 0) { const f = 10 ** p; return Math.round(n * f) / f; }

/**
 * @param dailyGallons {[ymd]: gallons} — complete days only (exclude today)
 * @returns profile or null when there is no data at all
 */
export function buildUsageProfile(dailyGallons, todayYmd, config, hourly) {
  const look = config.usageLookbackDays || 28;
  const byDow = Array.from({ length: 7 }, () => []);
  let total = 0, days = 0, last7 = 0, anyData = false;
  for (let i = look; i >= 1; i--) {
    const d = ymdAddDays(todayYmd, -i);
    const g = Number(dailyGallons[d] || 0);
    if (dailyGallons[d] !== undefined) anyData = true;
    byDow[dowOf(d)].push(g);
    total += g; days++;
    if (i <= 7) last7 += g;
  }
  if (!anyData) return null;
  const dowAvg = byDow.map((arr, dow) => {
    if (!arr.length) return 0;
    if (dow >= 1 && dow <= 5) {
      // weekday zeros are almost always holidays / missing data, not real usage
      const nz = arr.filter(v => v > 0);
      return nz.length ? mean(nz) : 0;
    }
    return mean(arr);
  });
  const safety = 1 + (config.usageSafetyPct || 0) / 100;
  const weekdayAvg = mean(dowAvg.slice(1, 6));
  const weekendAvg = mean([dowAvg[0], dowAvg[6]]);
  return {
    byDow: dowAvg.map(v => round(v, 1)),
    planningByDow: dowAvg.map(v => round(v * safety, 1)),
    weekdayAvg: round(weekdayAvg, 1),
    weekendAvg: round(weekendAvg, 1),
    avg7: round(last7 / 7, 1),
    avgLookback: round(total / Math.max(days, 1), 1),
    planningWeekly: round(dowAvg.reduce((s, v) => s + v, 0) * safety, 0),
    sampleDays: days,
    totalGal: round(total, 0),
    lookbackDays: look,
    hourlyCum: hourlyCumFromTotals(hourly) || null,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Projection + order timing
// ───────────────────────────────────────────────────────────────────────────────
export function remainingFractionOfDay(hour, minute = 0, hourlyCum = null) {
  // share of today's usage still ahead, from the fueling-time profile (learned, else the observed default)
  const cum = hourlyCum && hourlyCum.length === 24 ? hourlyCum : DEFAULT_HOURLY_CUM;
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  const before = h === 0 ? 0 : cum[h - 1];
  const during = cum[h] - before;
  return Math.max(0, Math.min(1, 1 - (before + during * (minute / 60))));
}

export function projectInventory({ inventoryGal, todayYmd, hour, minute, planningByDow, floorGal, horizonDays = 60, hourlyCum = null }) {
  const days = [];
  let level = inventoryGal;
  let floorYmd = null, floorAt = null, emptyYmd = null;
  for (let i = 0; i < horizonDays; i++) {
    const ymd = ymdAddDays(todayYmd, i);
    const full = planningByDow[dowOf(ymd)] || 0;
    const usage = i === 0 ? full * remainingFractionOfDay(hour, minute, hourlyCum) : full;
    const start = level;
    const end = start - usage;
    days.push({ ymd, start: round(start, 0), end: round(end, 0), usage: round(usage, 1) });
    if (floorYmd === null && end < floorGal) {
      floorYmd = ymd;
      floorAt = i + (usage > 0 ? Math.max(0, Math.min(1, (start - floorGal) / usage)) : 0);
    }
    if (emptyYmd === null && end < 0) emptyYmd = ymd;
    level = end;
  }
  return { days, floorYmd, floorAt, emptyYmd };
}

export function computeOrderWindow({ todayYmd, hour, config, hol, floorYmd }) {
  const lead = Number(config.leadBusinessDays ?? 2);
  const safety = Number(config.safetyDays ?? 1);
  const cutoff = Number(config.orderCutoffHour ?? 10);

  const effectiveOrderDay = (d) => {
    if (d === todayYmd) {
      if (isBusinessDay(todayYmd, hol) && hour < cutoff) return todayYmd;
      return nextBusinessDayOnOrAfter(ymdAddDays(todayYmd, 1), hol);
    }
    return nextBusinessDayOnOrAfter(d, hol);
  };
  const arrivalFor = (d) => addBusinessDays(effectiveOrderDay(d), lead, hol);

  const arrivalIfOrderedNow = arrivalFor(todayYmd);
  if (!floorYmd) {
    return { orderBy: null, daysToOrderBy: Infinity, needBy: null, arrivalIfOrderedNow, late: false, lead, safety, cutoff };
  }
  const needBy = ymdAddDays(floorYmd, -safety);
  let orderBy = null;
  for (let i = 0; i <= 90; i++) {
    const d = ymdAddDays(todayYmd, i);
    if (d > needBy) break;
    if (arrivalFor(d) <= needBy) orderBy = d; else break;
  }
  if (orderBy === null) {
    return { orderBy: null, daysToOrderBy: -1, needBy, arrivalIfOrderedNow, late: true, lead, safety, cutoff };
  }
  return {
    orderBy,
    daysToOrderBy: daysBetween(todayYmd, orderBy),
    needBy,
    arrivalIfOrderedNow,
    arrivalIfOrderedOnOrderBy: arrivalFor(orderBy),
    late: false, lead, safety, cutoff,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Price statistics
// ───────────────────────────────────────────────────────────────────────────────
/**
 * @param closes [{ymd, close}] ascending, settled sessions only (not today's live bar)
 * @param live   current front-month price
 */
export function priceStats({ closes, live, prevClose, nextMonth, sessionYmd, config }) {
  if (!Number.isFinite(live) || !closes?.length) return null;
  const cutoff = ymdAddDays(sessionYmd || closes[closes.length - 1].ymd, -(config.priceWindowDays || 60));
  const win = closes.filter(c => c.ymd >= cutoff && Number.isFinite(c.close));
  const all = [...win.map(c => c.close), live];
  const n = all.length;
  const pctRank = all.filter(v => v <= live).length / n;
  const last20 = closes.slice(-20).map(c => c.close);
  const ma20 = last20.length ? mean(last20) : live;
  const ref5 = closes.length >= 5 ? closes[closes.length - 5].close : closes[0].close;
  const chg5d = ref5 ? live / ref5 - 1 : 0;
  const intraday = prevClose ? live / prevClose - 1 : 0;
  const med = median(all);
  const curveSlope = (nextMonth?.price && live) ? (nextMonth.price - live) / live : null;
  return {
    live: round(live, 4),
    prevClose: prevClose ? round(prevClose, 4) : null,
    sessionYmd,
    pctRank: round(pctRank, 3),
    ma20: round(ma20, 4),
    devFromMa20: round(live / ma20 - 1, 4),
    chg5d: round(chg5d, 4),
    intraday: round(intraday, 4),
    windowMin: round(Math.min(...all), 4),
    windowMax: round(Math.max(...all), 4),
    windowMedian: round(med, 4),
    windowDays: win.length,
    nextMonth: nextMonth || null,
    curveSlope: curveSlope === null ? null : round(curveSlope, 4),
    cheap: pctRank <= (config.cheapPct ?? 0.33),
    rich: pctRank >= (config.richPct ?? 0.67),
    risingFast: chg5d >= (config.risingFastPct ?? 0.04) || intraday >= (config.intradayJumpPct ?? 0.025),
    fallingFast: chg5d <= (config.fallingFastPct ?? -0.04) || intraday <= -(config.intradayJumpPct ?? 0.025),
    contangoStrong: curveSlope !== null && curveSlope >= (config.contangoStrongPct ?? 0.015),
    backwardated: curveSlope !== null && curveSlope < -0.005,
  };
}

/** basis = supplier quote − HO close of the prior trading day; median of recent pairs */
export function computeBasis(quotes, hoDaily) {
  // quotes: {[ymd]: {price}}, hoDaily: {[ymd]: close}
  const closeDates = Object.keys(hoDaily).sort();
  const samples = [];
  for (const q of Object.keys(quotes).sort().slice(-15)) {
    const price = Number(quotes[q]?.price);
    if (!Number.isFinite(price)) continue;
    let ref = null;
    for (let i = closeDates.length - 1; i >= 0; i--) {
      if (closeDates[i] < q) { ref = hoDaily[closeDates[i]]; break; }
    }
    if (Number.isFinite(ref)) samples.push(round(price - ref, 4));
  }
  if (!samples.length) return null;
  return { median: round(median(samples), 4), samples: samples.length, latest: samples[samples.length - 1] };
}

// ───────────────────────────────────────────────────────────────────────────────
// Supplier price sheet parser (Lakes Community Coop "Commercial Daily" PDF → text)
// Works on pdftotext -layout / -raw output and on Google Docs PDF conversion:
// every line is "label … price [price …]"; a label-less price line continues the
// previous label (how -raw prints the 12-month strip and the winter Clear/Dyed pair).
// ───────────────────────────────────────────────────────────────────────────────
const PRICE_TOKEN = /^\d{1,2}\.\d{2,4}$/;
const MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(20\d\d)\b/g;

export function parsePriceSheet(text) {
  const rawLines = String(text || '').replace(/\r/g, '').split('\n');
  const lines = rawLines.map(l => l.replace(/\$/g, ' ').replace(/\s+/g, ' ').trim());
  const entries = [];
  let dateYmd = null, blend = null;
  const months = [];
  const dm = lines.join('\n').match(/\bDATE\b[\s:]*\n?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);   // "DATE 10/13/26", or DATE on one line and the date on the next
  if (dm) {
    const yy = dm[3].length === 2 ? `20${dm[3]}` : dm[3];
    dateYmd = `${yy}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}`;
  }
  let pending = [];                      // text-only lines seen since the last entry (cells split across lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) { if (!rawLines[i].trim()) pending = []; continue; }   // a lone "$" cell is not a blank line
    const bm = line.match(/\b(B5|B20|B11|B10|B2)\s+MONTHS\b/i);
    if (bm && !blend) blend = bm[1].toUpperCase();
    let mm; MONTH_RE.lastIndex = 0;
    while ((mm = MONTH_RE.exec(line))) months.push(`${mm[1]} ${mm[2]}`);
    const tokens = line.split(' ');
    const prices = [];
    while (tokens.length && PRICE_TOKEN.test(tokens[tokens.length - 1])) prices.unshift(Number(tokens.pop()));
    const label = tokens.join(' ').trim();
    if (!prices.length) {
      if (label && !/^(DATE|CONTRACTS)\b/i.test(label) && !MONTH_RE.test(label) && label.length < 48) pending.push(label); else pending = [];
      MONTH_RE.lastIndex = 0;
      continue;
    }
    if (label) { entries.push({ label, prices }); pending = []; }
    else if (pending.length) { entries.push({ label: pending.slice(-2).join(' '), prices }); pending = []; }
    else if (entries.length) entries[entries.length - 1].prices.push(...prices);
  }
  const uniqMonths = [...new Set(months)].slice(0, 12);
  const spot = {}, contracts = {}, propane = {}, winter = {};
  for (const e of entries) {
    const L = e.label;
    if (/propane|lease|commercial$|grain dryer/i.test(L) && !/B\d+|#\d/.test(L)) { propane[L] = e.prices; continue; }
    if (e.prices.length >= 6) { contracts[L] = e.prices; continue; }
    // clear carries road tax, so it's always the higher of the pair; the sheet's column order isn't reliable
    if (/blend/i.test(L) && e.prices.length >= 2) { const [a, b] = e.prices; winter[L] = { clear: Math.max(a, b), dyed: Math.min(a, b) }; spot[L] = Math.max(a, b); continue; }
    spot[L] = e.prices[0];
  }
  return { date: dateYmd, blend, spot, winter, contracts, months: uniqMonths, propane, entries };
}

// Firebase keys can't contain . $ # [ ] / — sheet labels like "B5 #2 Clear B5" or "N/L 87" do.
// Store the label maps as row arrays and turn them back into maps when reading.
const toRows = (obj) => Object.entries(obj || {}).map(([label, value]) => ({ label, value }));
const fromRows = (rows) => Array.isArray(rows) ? Object.fromEntries(rows.filter(r => r && r.label != null).map(r => [r.label, r.value])) : (rows || {});
export function sheetForStorage(sheet) {
  return { ...sheet, spot: toRows(sheet.spot), winter: toRows(sheet.winter), contracts: toRows(sheet.contracts), propane: toRows(sheet.propane), entries: undefined };
}
export function sheetFromStorage(stored) {
  if (!stored) return stored;
  const out = { ...stored, spot: fromRows(stored.spot), winter: fromRows(stored.winter), contracts: fromRows(stored.contracts), propane: fromRows(stored.propane), months: stored.months || [] };
  for (const [l, w] of Object.entries(out.winter)) if (w && Number.isFinite(w.clear) && Number.isFinite(w.dyed)) {
    out.winter[l] = { clear: Math.max(w.clear, w.dyed), dyed: Math.min(w.clear, w.dyed) }; out.spot[l] = out.winter[l].clear;   // repair sheets stored before the fix
  }
  return out;
}

// Lines on the Lakes Community sheet, matched by label
export const PRODUCTS = {
  b20rm: { name: 'B20 Roadmaster', pattern: '^B20 RM\\b' },
  b5rm: { name: 'B5 Roadmaster', pattern: '^B5 RM\\b' },
  seasonal: { name: 'Seasonally Enhanced blend (clear)', pattern: 'Seasonally Enhanced' },
  wintermaster: { name: 'Wintermaster 70/30 blend (clear)', pattern: 'Wintermaster' },
  no1rm: { name: '#1 diesel, no soy (RM)', pattern: '#1 Cenex RM' },
  b5clear: { name: 'B5 #2 Clear', pattern: '^B5 #2 Clear' },
  b20clear: { name: 'B20 #2 Clear', pattern: '^B20 #2 Clear' },
};
/** which product the schedule says you're buying on a given date */
export function productForDate(config, ymd) {
  const sched = (Array.isArray(config.productSchedule) ? config.productSchedule : [])
    .filter(r => r && /^\d{2}-\d{2}$/.test(r.from) && PRODUCTS[r.product]).sort((a, b) => a.from.localeCompare(b.from));
  if (!sched.length) return null;
  const md = ymd.slice(5);
  let cur = sched[sched.length - 1];                      // wraps from last entry of the previous year
  for (const r of sched) if (r.from <= md) cur = r;
  return cur.product;
}
/** label pattern + display name for the product in force on ymd */
export function productSpec(config, ymd) {
  if (config.productMode !== 'manual') {
    const key = productForDate(config, ymd);
    if (key) return { key, name: PRODUCTS[key].name, pattern: PRODUCTS[key].pattern, blend: null };
  }
  return { key: 'manual', name: config.quoteProductPattern || 'manual', pattern: config.quoteProductPattern || '\\bRM\\b', blend: 'config' };
}

/** choose the product line + supplier curve for the configured product */
export function selectQuoteFromSheet(sheet, config, ymd) {
  const spec = productSpec(config, ymd || sheet.date || '2000-01-01');
  const pattern = new RegExp(spec.pattern, 'i');
  const blend = spec.blend === null ? null
    : (config.quoteBlend && config.quoteBlend !== 'auto') ? config.quoteBlend.toUpperCase() : (sheet.blend || null);
  const labels = Object.keys(sheet.spot || {});
  const matches = labels.filter(l => pattern.test(l));
  let label = matches.find(l => blend && new RegExp(`\\b${blend}\\b`, 'i').test(l)) || matches[0] || null;
  if (!label) return null;
  const price = sheet.spot[label];
  // supplier curve: pick strip row
  const dyedish = /dyed|\bFM\b|fieldmaster/i.test(label);
  const rowPattern = (config.contractRowPattern && config.contractRowPattern !== 'auto')
    ? new RegExp(config.contractRowPattern, 'i')
    : (dyedish ? /\bFM\b.*#2/i : /\bRM\b.*#2/i);
  const rowLabel = Object.keys(sheet.contracts || {}).find(l => rowPattern.test(l)) || null;
  let curve = null;
  if (rowLabel) {
    // offset the strip to the product actually bought (e.g. #2 Clear sits ~5¢ under Roadmaster)
    const bNum = blend || (label.match(/^(B\d+)\b/i)?.[1] || null);
    const stripSpotLabel = labels.find(l => (dyedish ? /\bFM\b/i : /\bRM\b/i).test(l) && !/#1/.test(l) && (!bNum || new RegExp(`\\b${bNum}\\b`, 'i').test(l)));
    const offset = stripSpotLabel && Number.isFinite(sheet.spot[stripSpotLabel]) ? round(price - sheet.spot[stripSpotLabel], 4) : 0;
    curve = {
      row: rowLabel, offset,
      months: sheet.months.slice(0, sheet.contracts[rowLabel].length),
      prices: sheet.contracts[rowLabel].map(p => round(p + offset, 4)),
      raw: sheet.contracts[rowLabel],
    };
  }
  return { label, price, blend, curve, product: spec.key, productName: spec.name };
}

// ───────────────────────────────────────────────────────────────────────────────
// Decision engine — pure function
// ───────────────────────────────────────────────────────────────────────────────
function money(v, d = 2) { return v === null || v === undefined || !Number.isFinite(v) ? '—' : `$${Number(v).toFixed(d)}`; }
function pct(v, d = 1) { return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`; }
function gal(v) { return `${Math.round(v).toLocaleString('en-US')} gal`; }
function ordinal(p) { const n = Math.round(p * 100); const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

export function decide(input) {
  const { config, tank, usage, price, quote, basis, now } = input;
  const problems = [...(input.problems || [])];
  const reasons = [];
  const hol = holidaySet(config, now.ymd);

  const capacity = Number(tank?.capacityGal) || 0;
  const inventory = Number(tank?.inventoryGal);
  const floorGal = capacity * (config.floorPct / 100);
  const maxFillGal = capacity * (config.maxFillPct / 100);
  // a "full load" can't exceed the usable room (max fill − floor); smaller tanks just see smaller loads
  const loadGal = Math.min(Math.max(0, Number(config.loadGal) || 0), Math.max(0, maxFillGal - floorGal));
  const worthwhileDropGal = loadGal || Math.max(config.minDropGal, capacity * 0.35);

  if (!capacity || !Number.isFinite(inventory)) {
    return {
      state: 'HOLD', watch: false, headline: 'Waiting for tank data',
      reasons: ['No tank reading yet — check the FuelCloud connection in Settings.'],
      problems: [...problems, 'no_tank_data'], computedAt: now.iso,
    };
  }

  // ── projection ────────────────────────────────────────────────────────────
  const planningByDow = usage?.planningByDow || [0, 0, 0, 0, 0, 0, 0];
  const noUsage = !usage || planningByDow.every(v => !v);
  if (noUsage) problems.push('no_usage_data');
  const proj = projectInventory({
    inventoryGal: inventory, todayYmd: now.ymd, hour: now.hour, minute: now.minute,
    planningByDow, floorGal, hourlyCum: usage?.hourlyCum || null,
  });
  const order = computeOrderWindow({ todayYmd: now.ymd, hour: now.hour, config, hol, floorYmd: proj.floorYmd });

  const levelOn = (ymd) => {
    const d = proj.days.find(x => x.ymd === ymd);
    return d ? d.start : proj.days[proj.days.length - 1].end;
  };
  const roomNow = Math.max(0, maxFillGal - inventory);
  const arrivalYmd = order.arrivalIfOrderedNow;
  const roomAtArrival = Math.max(0, maxFillGal - levelOn(arrivalYmd));
  const fillGal = Math.floor(Math.min(roomAtArrival, loadGal || roomAtArrival) / 50) * 50;
  const fullLoadFits = !loadGal || roomAtArrival >= loadGal;
  // first day a full load would fit (at the lead-time-adjusted arrival)
  const windowOpenYmd = loadGal ? (proj.days.find(d => d.start >= floorGal && maxFillGal - d.start >= loadGal)?.ymd || order.orderBy || null) : now.ymd;
  const planningDaily = usage ? (usage.planningWeekly / 7) : 0;
  // floorAt counts from the start of today; subtract the part of today already gone
  const daysToFloor = proj.floorAt === null ? null : round(Math.max(0, proj.floorAt - (now.hour + now.minute / 60) / 24), 1);

  // ── tank narrative ────────────────────────────────────────────────────────
  const pctFull = inventory / capacity;
  reasons.push(
    `Tank: ${gal(inventory)} of ${gal(capacity)} (${Math.round(pctFull * 100)}%).` +
    (noUsage
      ? ' No pump transactions found yet, so no burn rate.'
      : ` Planning burn ≈ ${Math.round(usage.weekdayAvg * (1 + config.usageSafetyPct / 100))} gal on weekdays, ${Math.round(usage.weekendAvg * (1 + config.usageSafetyPct / 100))} on weekends.`) +
    (proj.floorYmd ? ` You reach the ${config.floorPct}% floor (${gal(floorGal)}) around ${fmtDate(proj.floorYmd)}.` : ` You stay above the ${config.floorPct}% floor for 60+ days.`)
  );
  if (loadGal && !fullLoadFits && windowOpenYmd) {
    reasons.push(`A full ${gal(loadGal)} load fits from ${fmtDate(windowOpenYmd)} (room at arrival now: ${gal(roomAtArrival)}).`);
  }
  if (proj.floorYmd) {
    reasons.push(
      `Lead time ${order.lead} business day${order.lead === 1 ? '' : 's'} + ${order.safety} safety day → fuel must land by ${fmtDate(order.needBy)}; ` +
      (order.late
        ? `even an order placed now arrives ${fmtDate(order.arrivalIfOrderedNow)}.`
        : `last day to order is ${fmtDate(order.orderBy)}${order.orderBy === now.ymd ? ` (before ${order.cutoff}:00)` : ''}.`)
    );
  }

  // ── price narrative ───────────────────────────────────────────────────────
  const quotePrice = Number.isFinite(Number(quote?.price)) ? Number(quote.price) : null;
  const estDelivered = price && basis ? round(price.live + basis.median, 3) : null;
  const quoteIsToday = quote?.ymd === now.ymd;
  if (price) {
    reasons.push(
      `HO futures ${money(price.live, 3)} (${price.intraday >= 0 ? 'up' : 'down'} ${(Math.abs(price.intraday) * 100).toFixed(1)}% vs. prior settle), ` +
      `${ordinal(price.pctRank)} percentile of the last ${config.priceWindowDays} days (${price.cheap ? 'cheap end' : price.rich ? 'expensive end' : 'middle of the range'}), ` +
      `${pct(price.chg5d)} over 5 sessions.`
    );
    if (price.curveSlope !== null) {
      reasons.push(
        price.backwardated
          ? `Curve: next month trades ${pct(price.curveSlope)} below the front — the market expects lower prices (backwardation).`
          : price.contangoStrong
            ? `Curve: next month is ${pct(price.curveSlope)} above the front — forward prices are higher (contango), which favors buying now.`
            : `Curve: next month is ${pct(price.curveSlope)} vs. the front — roughly flat.`
      );
    }
  } else {
    problems.push('no_price_data');
    reasons.push('No futures price available right now — decision is based on tank level only.');
  }
  if (quotePrice !== null) {
    reasons.push(
      `${quote.source === 'delivery' ? 'Delivered price logged' : `${config.supplierName} quote`}: ${money(quotePrice, 3)}/gal${quoteIsToday ? ' today' : ` (${fmtDate(quote.ymd)}, no sheet yet today)`}` +
      (basis ? `; your basis over HO runs about ${money(basis.median, 3)}, so tomorrow's sheet should be near ${money(estDelivered, 2)}.` : '.')
    );
  } else if (estDelivered !== null) {
    reasons.push(`No supplier quote logged; estimated delivered price ≈ ${money(estDelivered, 2)}/gal (HO + your usual basis).`);
  }

  // supplier's own forward strip (from the daily sheet) — does the market expect a drop?
  const curve = (input.supplierCurve?.prices?.length ? input.supplierCurve : null) || (quote?.curve && quote.curve.prices?.length ? quote.curve : null);
  let contractView = null;
  if (curve && quotePrice !== null) {
    const next3 = curve.prices.slice(0, 3);
    const avg3 = mean(next3);
    const vsSpot = avg3 / quotePrice - 1;
    contractView = { row: curve.row, months: curve.months.slice(0, 3), avg3: round(avg3, 3), vsSpot: round(vsSpot, 4), nextMonth: curve.prices[0], nextMonthLabel: curve.months[0] || null };
    contractView.perLoad = round((quotePrice - avg3) * (loadGal || 7500), 0);
    if (vsSpot <= -(config.contractAlertPct ?? 0.05)) {
      reasons.push(`${config.supplierName}'s contract strip: ${curve.months.slice(0, 3).join(', ')} average ${money(avg3, 2)} — ${pct(vsSpot)} vs. today's spot, about $${contractView.perLoad.toLocaleString('en-US')} per ${gal(loadGal || 7500)} load. The market expects lower prices; buy what you need now, and ask about locking that forward volume.`);
    } else if (vsSpot >= (config.contractAlertPct ?? 0.05)) {
      reasons.push(`${config.supplierName}'s contract strip runs ${pct(vsSpot)} above today's spot — forward prices are higher, which favors buying now.`);
    }
  }
  const expectDrop = Boolean((price && price.curveSlope !== null && price.curveSlope <= -0.03) || (contractView && contractView.vsSpot <= -(config.contractAlertPct ?? 0.05)));

  // ── decision ──────────────────────────────────────────────────────────────
  let state = 'HOLD', headline = '', recommendedGal = 0, watch = false, flavor = null;
  const mustOrder = proj.floorYmd && (order.late || order.orderBy === now.ymd);
  const dAvg = planningDaily || (usage?.avgLookback || 0);

  if (mustOrder) {
    state = 'ORDER_NOW';
    if (price?.rich && price?.fallingFast && dAvg > 0) {
      flavor = 'bridge';
      recommendedGal = Math.min(roomAtArrival, Math.max(config.minDropGal, Math.ceil(dAvg * config.bridgeDays / 50) * 50));
      headline = order.late
        ? `Order today — you're past the safe order date. Take a short load (${gal(recommendedGal)}): price is high and falling.`
        : `Order today (before ${order.cutoff}:00) — short load of ${gal(recommendedGal)}; price is high and falling.`;
      reasons.push(`Price is in the expensive end and dropping fast, so buy only ~${config.bridgeDays} days of fuel and re-check next week.`);
    } else {
      recommendedGal = fillGal;
      headline = order.late
        ? `Order today — fuel arrives ${fmtDate(order.arrivalIfOrderedNow)}, after your safe date. Fill: ${gal(recommendedGal)}.`
        : `Order today (before ${order.cutoff}:00): ${gal(recommendedGal)} for ${fmtDate(order.arrivalIfOrderedNow)} delivery.`;
    }
    if (order.late && proj.floorYmd && proj.floorYmd < order.arrivalIfOrderedNow) {
      const dip = levelOn(order.arrivalIfOrderedNow);
      reasons.push(`Projected level when the truck arrives: ${gal(Math.max(0, dip))} — ${dip < 0 ? 'you could run dry' : 'below your floor'}. Ask about an expedited drop.`);
    }
  } else if (proj.floorYmd && fullLoadFits && order.daysToOrderBy <= config.buyAheadWindowDays && price && (price.risingFast || price.contangoStrong)) {
    state = 'BUY_AHEAD';
    recommendedGal = fillGal;
    headline = `Order now rather than waiting until ${fmtDate(order.orderBy)} — price is moving up. ${gal(recommendedGal)} fills you at arrival.`;
    reasons.push(price.risingFast
      ? `You'd have to order within ${order.daysToOrderBy} day${order.daysToOrderBy === 1 ? '' : 's'} anyway, and HO is ${pct(price.chg5d)} over 5 sessions. Day-to-day moves are close to a coin flip, so this only pulls the order forward inside your safe window.`
      : `You'd have to order within ${order.daysToOrderBy} days anyway, and the forward curve says later is pricier — ordering now inside the window costs nothing.`);
  } else if (price?.cheap && fullLoadFits && roomAtArrival >= worthwhileDropGal && ((!price.fallingFast && !expectDrop) || order.daysToOrderBy <= 2)) {
    state = 'FILL_UP';
    recommendedGal = fillGal;
    headline = `Good day to order — price is in the cheap end and a ${loadGal ? 'full load' : gal(recommendedGal)} fits. Order ${gal(recommendedGal)} today rather than waiting until ${fmtDate(order.orderBy)}.`;
    reasons.push(`Price sits in the cheap end of its ${config.priceWindowDays}-day range and the tank can take ${gal(roomAtArrival)} by ${fmtDate(arrivalYmd)}. This picks a day inside your window; it is not a bet on the market.`);
  } else {
    state = 'HOLD';
    watch = proj.floorYmd ? order.daysToOrderBy <= config.watchWindowDays : false;
    if (noUsage) {
      headline = `Tank at ${Math.round(pctFull * 100)}% — burn rate unknown yet (no pump transactions found), so no timing advice.`;
    } else if (loadGal && !fullLoadFits) {
      headline = `Hold — a full load doesn't fit until ${fmtDate(windowOpenYmd)}${proj.floorYmd ? `; order by ${fmtDate(order.orderBy)}` : ''}.`;
    } else if (price?.cheap && roomAtArrival < worthwhileDropGal) {
      headline = `Hold — price is cheap but the tank only has room for ${gal(roomAtArrival)} (worth a trip at ${gal(worthwhileDropGal)}+).`;
    } else if (price?.cheap && price.fallingFast) {
      headline = `Hold a day — price is cheap and still falling; you have until ${fmtDate(order.orderBy)} to order.`;
    } else if (price?.cheap && expectDrop) {
      headline = `Hold — price looks cheap vs. the last ${config.priceWindowDays} days, but the forward curve says lower is coming; you have until ${fmtDate(order.orderBy)} to order.`;
    } else if (price?.rich) {
      headline = proj.floorYmd
        ? `Hold — price is in the expensive end and you don't need to order until ${fmtDate(order.orderBy)}.`
        : 'Hold — price is in the expensive end and the tank is comfortable.';
    } else {
      headline = proj.floorYmd
        ? `Hold — mid-range price, ${order.daysToOrderBy} day${order.daysToOrderBy === 1 ? '' : 's'} until you need to order (${fmtDate(order.orderBy)}).`
        : 'Hold — nothing to do; tank is comfortable.';
    }
    if (watch) reasons.push(`Watch: order-by date ${fmtDate(order.orderBy)} is inside the next ${config.watchWindowDays} days — any dip is a buying chance.`);
  }

  // ── dollar framing ────────────────────────────────────────────────────────
  let vsMedianPerGal = null, dollarImpact = null;
  if (price && recommendedGal > 0) {
    const ref = quotePrice ?? estDelivered ?? price.live;
    const medRef = basis ? price.windowMedian + basis.median : price.windowMedian;
    vsMedianPerGal = round(ref - medRef, 3);
    dollarImpact = round(vsMedianPerGal * recommendedGal, 0);
    reasons.push(
      vsMedianPerGal <= 0
        ? `${gal(recommendedGal)} at today's price is about $${Math.abs(dollarImpact).toLocaleString('en-US')} below the 60-day median cost.`
        : `${gal(recommendedGal)} at today's price is about $${dollarImpact.toLocaleString('en-US')} above the 60-day median cost.`
    );
  }

  return {
    state, watch, flavor, headline, reasons, problems,
    recommendedGal,
    tank: {
      inventoryGal: round(inventory, 0), capacityGal: round(capacity, 0), pct: round(pctFull * 100, 1),
      floorGal: round(floorGal, 0), maxFillGal: round(maxFillGal, 0), roomNow: round(roomNow, 0), roomAtArrival: round(roomAtArrival, 0),
      worthwhileDropGal: round(worthwhileDropGal, 0), loadGal, readAt: tank.readAt || null, source: tank.source || null, name: tank.name || null,
    },
    timing: {
      floorYmd: proj.floorYmd, daysToFloor, emptyYmd: proj.emptyYmd, windowOpenYmd, fullLoadFits,
      needBy: order.needBy, orderBy: order.orderBy, daysToOrderBy: order.daysToOrderBy === Infinity ? null : order.daysToOrderBy,
      late: order.late, arrivalIfOrderedNow: order.arrivalIfOrderedNow, cutoffHour: order.cutoff,
      leadBusinessDays: order.lead, safetyDays: order.safety,
    },
    projection: proj.days.slice(0, 35),
    usage: usage ? { planningByDow: usage.planningByDow, weekdayAvg: usage.weekdayAvg, weekendAvg: usage.weekendAvg, avg7: usage.avg7, avgLookback: usage.avgLookback, sampleDays: usage.sampleDays } : null,
    price: price ? { ...price } : null,
    quote: quotePrice !== null ? { ymd: quote.ymd, price: quotePrice, product: quote.product || null, isToday: quoteIsToday, source: quote.source || null } : null,
    supplierCurve: curve ? { row: curve.row, months: curve.months, prices: curve.prices, offset: curve.offset ?? 0, sheetDate: curve.sheetDate || null } : null,
    contractView,
    expectDrop,
    basis: basis || null,
    estDelivered,
    vsMedianPerGal, dollarImpact,
    computedAt: now.iso,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Alert policy — pure function
// ───────────────────────────────────────────────────────────────────────────────
const H = 3600 * 1000;
export function decideAlerts({ plan, prev, nowMs, local, config, deliveryDetected }) {
  prev = prev || {};
  const pushes = [];
  const next = { ...prev, lastState: plan.state };
  const inQuiet = local.hour >= (config.quietStart ?? 21) || local.hour < (config.quietEnd ?? 6);
  const isWeekday = local.dow >= 1 && local.dow <= 5;
  const q = plan.quote ? `${plan.quote.isToday ? 'Quote' : 'Last quote'} $${plan.quote.price.toFixed(3)}` : (plan.estDelivered ? `Est. delivered $${plan.estDelivered.toFixed(2)}` : 'no quote');
  const ho = plan.price ? `HO $${plan.price.live.toFixed(3)} (${plan.price.intraday >= 0 ? '+' : ''}${(plan.price.intraday * 100).toFixed(1)}%)` : 'HO n/a';
  const tankLine = `${plan.tank.inventoryGal.toLocaleString('en-US')} gal (${Math.round(plan.tank.pct)}%)`;

  let sentAction = false;
  if (ACTION_STATES.has(plan.state)) {
    const changed = plan.state !== prev.lastSentState;
    const since = nowMs - (prev.lastSentAt || 0);
    const reminderEvery = plan.state === 'FILL_UP' ? 44 * H : 20 * H;
    const critical = plan.state === 'ORDER_NOW';
    if ((changed || since > reminderEvery) && (!inQuiet || critical)) {
      const title = plan.state === 'ORDER_NOW' ? '⛽ Order diesel today'
        : plan.state === 'BUY_AHEAD' ? '📈 Price moving up — order ahead'
          : '✅ Good day to order';
      pushes.push({
        kind: plan.state, tag: 'fueldesk-action', title,
        body: `${plan.headline} ${tankLine}. ${q}; ${ho}.`,
      });
      next.lastSentAt = nowMs; next.lastSentState = plan.state; sentAction = true;
    }
  } else if (prev.lastSentState && ACTION_STATES.has(prev.lastSentState)) {
    // dropped back to HOLD (a delivery landed or price moved) — go quiet, allow re-alert later
    next.lastSentState = null;
  }

  if (config.digestEnabled !== false && local.hour >= (config.digestHour ?? 7) && prev.digestSentOn !== local.ymd &&
      (!config.digestWeekdaysOnly || isWeekday) && !sentAction && !inQuiet) {
    const t = plan.timing;
    const timing = t.orderBy ? `order by ${fmtDate(t.orderBy)}${t.daysToOrderBy === 0 ? ' (today)' : ` (${t.daysToOrderBy}d)`}` : 'no order needed soon';
    pushes.push({
      kind: 'DIGEST', tag: 'fueldesk-digest',
      title: `FuelDesk: ${STATE_LABEL[plan.state]}${plan.watch ? ' · watch' : ''}`,
      body: `${tankLine}, ${timing}. ${q}; ${ho}.`,
    });
    next.digestSentOn = local.ymd;
  }

  if (plan.problems?.length && prev.attentionSentOn !== local.ymd && !inQuiet) {
    pushes.push({
      kind: 'ATTENTION', tag: 'fueldesk-attention', title: 'FuelDesk needs attention',
      body: plan.problems.map(problemText).join(' '),
    });
    next.attentionSentOn = local.ymd;
  }

  if (deliveryDetected && prev.deliveryNoticeOn !== local.ymd && !inQuiet) {
    pushes.push({
      kind: 'DELIVERY', tag: 'fueldesk-delivery', title: 'Looks like a delivery landed',
      body: `Tank jumped +${Math.round(deliveryDetected.gallons).toLocaleString('en-US')} gal. Log it with the invoice price so I can learn your basis.`,
    });
    next.deliveryNoticeOn = local.ymd;
  }
  return { pushes, next };
}

export function problemText(code) {
  return {
    no_tank_data: 'No tank reading from FuelCloud.',
    no_usage_data: 'No pump transactions in the lookback window — burn rate unknown.',
    no_price_data: 'Could not fetch HO futures (Yahoo and fallback both failed).',
    fuelcloud_auth: 'FuelCloud rejected the API token — re-create credentials in the portal (Settings → API) and update the Worker secrets.',
    fuelcloud_error: 'FuelCloud API call failed; using the last stored reading.',
    tank_stale: 'Tank reading is more than 36 hours old.',
    inventory_implausible: 'FuelCloud inventory is negative or above capacity — check deliveries were entered.',
    quote_stale: 'No supplier quote in the last 3 business days — the price-email script may have stopped.',
    firebase_error: 'Firebase write failed.',
  }[code] || code;
}

// ───────────────────────────────────────────────────────────────────────────────
// Firebase RTDB (REST, database-secret auth)
// ───────────────────────────────────────────────────────────────────────────────
export function makeDb(env, fetchImpl = fetch) {
  const base = (env.FIREBASE_URL || '').replace(/\/+$/, '');
  const root = (env.DB_ROOT || 'fueldesk').replace(/^\/+|\/+$/g, '');
  const auth = env.FIREBASE_SECRET ? `auth=${encodeURIComponent(env.FIREBASE_SECRET)}` : '';
  const url = (path, extra = '') => `${base}/${root}/${path.replace(/^\/+/, '')}.json?${auth}${extra ? `&${extra}` : ''}`;
  async function call(method, path, body, extra) {
    if (!base) throw new Error('FIREBASE_URL not set');
    const r = await fetchImpl(url(path, extra), {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Firebase ${method} ${path} → ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300));
    return r.json();
  }
  return {
    get: (path, extra) => call('GET', path, undefined, extra),
    last: (path, n) => call('GET', path, undefined, `orderBy=%22%24key%22&limitToLast=${n}`),
    set: (path, value) => call('PUT', path, value),
    update: (path, value) => call('PATCH', path, value),
    push: (path, value) => call('POST', path, value),
    remove: (path) => call('DELETE', path),
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// FuelCloud client
// ───────────────────────────────────────────────────────────────────────────────
function fcBase(env) { return (env.FUELCLOUD_BASE || 'https://api.fuelcloud.com').replace(/\/+$/, ''); }
function fcPrefix(env) { return env.FUELCLOUD_API_PREFIX || '/rest/v1.0'; }
function bearer(tok) { return /^bearer /i.test(tok || '') ? tok : `Bearer ${tok}`; }

export async function fcLoadTokens(db, env) {
  let t = null;
  try { t = await db.get('fuelcloud/tokens'); } catch { /* fall through to bootstrap */ }
  if (!t?.refresh) {
    if (!env.FUELCLOUD_REFRESH_TOKEN) throw Object.assign(new Error('No FuelCloud tokens configured'), { code: 'fuelcloud_auth' });
    t = {
      access: (env.FUELCLOUD_ACCESS_TOKEN || '').replace(/^bearer /i, ''),
      refresh: env.FUELCLOUD_REFRESH_TOKEN, expiresAt: 0, source: 'env',
    };
  }
  return t;
}

/**
 * Token refresh. FuelCloud hands out a 30-minute access token and a 90-day refresh
 * token; every refresh returns a NEW pair and retires the old refresh token.
 * Shape below follows the public PsFuelCloud wrapper (GET /rest/refresh-token/{token}
 * with the old access token in Authorization). If your developer docs
 * (portal → Settings → API) show a different call, change only this function.
 */
export async function fcRefresh(db, env, tokens, fetchImpl = fetch) {
  const r = await fetchImpl(`${fcBase(env)}${env.FUELCLOUD_REFRESH_PATH || '/rest/refresh-token/'}${encodeURIComponent(tokens.refresh)}`, {
    method: 'GET',
    headers: { Authorization: bearer(tokens.access || ''), Accept: 'application/json' },
  });
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch { /* not json */ }
  const access = j.access_token || j.data?.access_token;
  if (!r.ok || !access) {
    throw Object.assign(new Error(`FuelCloud refresh failed (${r.status}): ${text.slice(0, 200)}`), { code: 'fuelcloud_auth' });
  }
  const refresh = j.refresh_token || j.data?.refresh_token || tokens.refresh;
  const expiresIn = Number(j.expires_in || j.data?.expires_in || 1800);
  const next = { access, refresh, expiresAt: Date.now() + expiresIn * 1000 - 60_000, updatedAt: Date.now(), source: 'refresh' };
  // persist BEFORE using it: a rotated refresh token that isn't saved breaks the chain
  await db.set('fuelcloud/tokens', next);
  return next;
}

export async function fcGet(db, env, tokens, pathOrUrl, fetchImpl = fetch) {
  if (!tokens.access || Date.now() > (tokens.expiresAt || 0)) {
    Object.assign(tokens, await fcRefresh(db, env, tokens, fetchImpl));
  }
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${fcBase(env)}${fcPrefix(env)}${pathOrUrl}`;
  const doFetch = () => fetchImpl(url, { headers: { Authorization: bearer(tokens.access), Accept: 'application/json' } });
  let r = await doFetch();
  if (r.status === 401 || r.status === 403) {
    Object.assign(tokens, await fcRefresh(db, env, tokens, fetchImpl));
    r = await doFetch();
  }
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`FuelCloud ${r.status}: ${text.slice(0, 200)}`), { code: r.status === 401 ? 'fuelcloud_auth' : 'fuelcloud_error' });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('FuelCloud returned non-JSON'), { code: 'fuelcloud_error' }); }
}

export async function fcListAll(db, env, tokens, path, fetchImpl = fetch, maxPages = 25) {
  const out = [];
  let next = path, pages = 0;
  while (next && pages++ < maxPages) {
    const j = await fcGet(db, env, tokens, next, fetchImpl);
    const data = Array.isArray(j) ? j : (j.data || []);
    out.push(...data);
    next = j.meta?.next || null;
  }
  return out;
}

export function pickTank(tanks, config) {
  if (!tanks?.length) return null;
  if (config.tankId) {
    const t = tanks.find(x => String(x.id) === String(config.tankId));
    if (t) return t;
  }
  return tanks.find(t => /diesel/i.test(t.product?.product_category || '') || /diesel/i.test(t.product?.product_name || '') || /diesel/i.test(t.name || ''))
    || tanks[0];
}

export function normalizeTank(t) {
  return {
    id: t.id, name: t.name || `Tank ${t.id}`,
    capacityGal: num(t.tank_capacity), inventoryGal: num(t.current_inventory),
    lowLevelPct: t.low_level ?? null, criticalLowPct: t.critical_low_level ?? null, highLevelPct: t.high_level ?? null,
    productName: t.product?.product_name || null, productCategory: t.product?.product_category || null,
    pricePerUnit: t.price_per_unit ?? null, unit: t.inventory_unit || 'Gallons', inventoryLevel: t.inventory_level || null,
    site: t.site?.name || null,
  };
}

function txTime(tx) {
  const v = tx.created_utc ?? tx.created_at ?? tx.transaction_date ?? tx.date ?? tx.timestamp;
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
  const n = Number(v);
  if (Number.isFinite(n) && String(v).length >= 10) return new Date(n > 1e12 ? n : n * 1000);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return isNaN(d) ? null : d;
}
// FuelCloud formats big volumes with thousands commas ("7,503.000")
export function num(v) { if (typeof v === 'number') return v; if (v == null || v === '') return NaN; return Number(String(v).replace(/[,\s$]/g, '')); }
function txTankId(tx) { return tx.tank_id ?? tx.tank?.id ?? tx.tankId ?? null; }
// FuelCloud: transaction_type 1 = pump (dispense), 2 = fill (delivery)
function txType(tx) {
  const t = tx.transaction_type ?? tx.type ?? tx.kind;
  if (t === 1 || t === '1') return 'pump';
  if (t === 2 || t === '2') return 'fill';
  const s = String(t || '').toLowerCase();
  if (/fill|deliver|receipt/.test(s)) return 'fill';
  if (/adjust|inventory/.test(s)) return 'adjust';
  return 'pump';
}
function txIsDispense(tx) { return txType(tx) === 'pump'; }

/** fills (deliveries) and end-of-day inventory for one tank, from FuelCloud transactions */
export function fillsAndHistoryFromTransactions(transactions, tankId, tz) {
  const fills = [], lastOfDay = {};
  for (const tx of transactions) {
    const tid = txTankId(tx);
    if (tankId != null && tid != null && String(tid) !== String(tankId)) continue;
    const when = txTime(tx); if (!when) continue;
    const { ymd, hour, minute } = localParts(when, tz);
    const inv = num(tx.inventory);
    if (Number.isFinite(inv) && (!lastOfDay[ymd] || when > lastOfDay[ymd].when)) lastOfDay[ymd] = { when, inv };
    if (txType(tx) !== 'fill') continue;
    const vol = num(tx.volume), price = num(tx.price);
    if (!Number.isFinite(vol) || vol <= 0) continue;
    fills.push({ fcId: tx.id ?? null, txId: tx.transaction_id ?? null, date: ymd, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      gallons: round(vol, 1), pricePerGal: Number.isFinite(price) && price > 0 ? round(price, 4) : null, inventoryAfter: Number.isFinite(inv) ? round(inv, 0) : null });
  }
  const history = Object.fromEntries(Object.entries(lastOfDay).map(([d, v]) => [d, { inventoryGal: round(v.inv, 1), readAt: v.when.toISOString(), source: 'transactions' }]));
  return { fills, history };
}

/** FuelCloud's transaction list returns pumps unless asked for fills: filter[transaction_type]=2 */
export async function fcFetchFills(db, env, tokens, tankId, sinceDate, untilDate, fetchImpl = fetch) {
  const fmt = (d) => d.toISOString().slice(0, 19);
  let q = `/transaction?start_date=${encodeURIComponent(fmt(sinceDate))}&end_date=${encodeURIComponent(fmt(untilDate))}&${encodeURIComponent('filter[transaction_type]')}=2`;
  if (tankId) q += `&${encodeURIComponent('filter[tank_id]')}=${encodeURIComponent(tankId)}`;
  return fcListAll(db, env, tokens, q, fetchImpl, 10);
}

/** fold FuelCloud fills into the delivery log; returns the records to write (keyed) */
export function mergeFillsIntoDeliveries(fills, deliveries, config) {
  const out = {};
  const list = Object.entries(deliveries || {});
  for (const f of fills) {
    if (list.some(([, d]) => (f.txId && d.fuelCloudTransactionId === f.txId) || (f.fcId != null && String(d.fcId) === String(f.fcId)))) continue;
    // a manually logged row for the same drop: link it instead of adding a duplicate
    const twin = list.find(([, d]) => !d.fcId && d.date === f.date && Math.abs(Number(d.gallons) - f.gallons) <= 25);
    if (twin) {
      const [id, d] = twin;
      out[id] = { ...d, fcId: f.fcId, fuelCloudTransactionId: d.fuelCloudTransactionId || f.txId, pricePerGal: d.pricePerGal ?? f.pricePerGal };
      continue;
    }
    const spec = productSpec(config, f.date);
    out[`fc-${f.fcId ?? f.txId}`] = {
      date: f.date, time: f.time, gallons: f.gallons, pricePerGal: f.pricePerGal,
      total: f.pricePerGal ? round(f.gallons * f.pricePerGal, 2) : null, product: spec.key, productName: spec.name,
      invoice: null, notes: 'imported from FuelCloud', source: 'fuelcloud', createdAt: new Date().toISOString(),
      postedToFuelCloud: true, fuelCloudResponse: null, fuelCloudTransactionId: f.txId, fcId: f.fcId,
    };
  }
  return out;
}

/** gallons dispensed per local day for one tank */
export function dailyGallonsFromTransactions(transactions, tankId, tz) {
  const daily = {};
  const hourly = new Array(24).fill(0);   // weekday gallons by local hour → fueling-time profile
  let matched = 0;
  for (const tx of transactions) {
    const tid = txTankId(tx);
    if (tankId !== null && tankId !== undefined && tid !== null && String(tid) !== String(tankId)) continue;
    if (!txIsDispense(tx)) continue;
    const vol = num(tx.volume ?? tx.quantity ?? tx.gallons);
    const when = txTime(tx);
    if (!Number.isFinite(vol) || vol <= 0 || !when) continue;
    const { ymd, hour, dow } = localParts(when, tz);
    daily[ymd] = round((daily[ymd] || 0) + vol, 2);
    if (dow >= 1 && dow <= 5) hourly[hour] += vol;
    matched++;
  }
  return { daily, hourly, matched };
}

// Observed at Steve's: trucks fuel at ~6am and over the 10am–2pm shift change (snapshot Aug–Oct 2026).
// Cumulative share of a weekday's gallons drawn by the END of each hour; replaced by the learned profile once there is data.
export const DEFAULT_HOURLY_CUM = [0, 0, 0.003, 0.035, 0.05, 0.07, 0.229, 0.276, 0.334, 0.374, 0.452, 0.588, 0.727, 0.874, 0.95, 0.982, 0.994, 0.997, 0.999, 0.999, 1, 1, 1, 1];
export function hourlyCumFromTotals(hourly) {
  const total = (hourly || []).reduce((a, b) => a + b, 0);
  if (!total) return null;
  let c = 0; return hourly.map(v => { c += v; return round(c / total, 3); });
}

// ───────────────────────────────────────────────────────────────────────────────
// Prices — Yahoo Finance chart API (front-month continuous HO=F + next month)
// ───────────────────────────────────────────────────────────────────────────────
const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
export function hoContractSymbols(todayYmd, hol) {
  // The HO contract for delivery month M stops trading on the last business day of month M-1.
  const y = Number(todayYmd.slice(0, 4)), m = Number(todayYmd.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10);
  let lastBiz = lastDay; while (!isBusinessDay(lastBiz, hol)) lastBiz = ymdAddDays(lastBiz, -1);
  let frontOffset = todayYmd > lastBiz ? 2 : 1;
  const sym = (offset) => {
    const mm = m - 1 + offset; const yy = y + Math.floor(mm / 12); const mi = ((mm % 12) + 12) % 12;
    return `HO${MONTH_CODES[mi]}${String(yy).slice(2)}.NYM`;
  };
  return { front: sym(frontOffset), next: sym(frontOffset + 1) };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function fetchYahooChart(symbol, range, env, fetchImpl = fetch) {
  const base = (env.PRICE_BASE || 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
  const url = `${base}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Yahoo ${symbol} → ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`Yahoo ${symbol}: ${j?.chart?.error?.description || 'empty result'}`);
  const tz = res.meta?.exchangeTimezoneName || 'America/New_York';
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (!Number.isFinite(c)) continue;
    bars.push({ ymd: localParts(new Date(ts[i] * 1000), tz).ymd, close: round(c, 4) });
  }
  // de-dupe by day (keep last)
  const byDay = {}; for (const b of bars) byDay[b.ymd] = b.close;
  const days = Object.keys(byDay).sort();
  const live = Number(res.meta?.regularMarketPrice);
  const sessionYmd = days[days.length - 1] || null;
  const settled = days.filter(d => d !== sessionYmd).map(d => ({ ymd: d, close: byDay[d] }));
  const prevClose = settled.length ? settled[settled.length - 1].close : (Number(res.meta?.previousClose) || Number(res.meta?.chartPreviousClose) || null);
  return {
    symbol: res.meta?.symbol || symbol,
    live: Number.isFinite(live) ? round(live, 4) : (sessionYmd ? byDay[sessionYmd] : null),
    sessionYmd, prevClose, settled,
    marketTime: res.meta?.regularMarketTime ? new Date(res.meta.regularMarketTime * 1000).toISOString() : null,
    source: 'yahoo',
  };
}

export async function fetchStooqQuote(env, fetchImpl = fetch) {
  const base = env.STOOQ_BASE || 'https://stooq.com';
  const r = await fetchImpl(`${base}/q/l/?s=ho.f&f=sd2t2ohlcv&h&e=csv`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Stooq → ${r.status}`);
  const lines = (await r.text()).trim().split('\n');
  if (lines.length < 2) throw new Error('Stooq: empty');
  const cols = lines[1].split(',');
  const close = Number(cols[6]);
  if (!Number.isFinite(close)) throw new Error('Stooq: no close');
  return { symbol: 'HO.F', live: round(close, 4), sessionYmd: cols[1], prevClose: null, settled: [], source: 'stooq' };
}

// ───────────────────────────────────────────────────────────────────────────────
// Web Push — RFC 8291 (aes128gcm) + RFC 8292 (VAPID), pure WebCrypto
// ───────────────────────────────────────────────────────────────────────────────
export const b64u = {
  encode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = ''; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4);
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};
const te = new TextEncoder();
function concat(...arrs) {
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hkdf(ikm, salt, info, bits) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

/**
 * Encrypt a payload for a push subscription (RFC 8291, single record).
 * @param opts.asKeyPair / opts.salt — only for test vectors
 */
export async function encryptPayload(plaintextBytes, p256dhB64u, authB64u, opts = {}) {
  const uaPublic = b64u.decode(p256dhB64u);
  const authSecret = b64u.decode(authB64u);
  const asKeyPair = opts.asKeyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeyPair.privateKey, 256));
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 256);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 96);
  const padded = concat(plaintextBytes, new Uint8Array([2]));           // 0x02 = last record delimiter
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));
  const rs = new Uint8Array([0, 0, 0x10, 0]);                            // record size 4096
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ct);
}

export async function vapidHeaders(endpoint, env) {
  const pub = b64u.decode(env.VAPID_PUBLIC_KEY);
  const d = env.VAPID_PRIVATE_KEY;
  if (pub.length !== 65 || !d) throw new Error('VAPID keys missing/invalid');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), d, ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const aud = new URL(endpoint).origin;
  const header = b64u.encode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${header}.${claims}`)));
  return { Authorization: `vapid t=${header}.${claims}.${b64u.encode(sig)}, k=${env.VAPID_PUBLIC_KEY}` };
}

export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = concat(new Uint8Array([4]), b64u.decode(jwk.x), b64u.decode(jwk.y));
  return { publicKey: b64u.encode(raw), privateKey: jwk.d };
}

export async function sendWebPush(sub, payload, env, fetchImpl = fetch) {
  const body = await encryptPayload(te.encode(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth);
  const headers = {
    ...(await vapidHeaders(sub.endpoint, env)),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(payload.ttl || 6 * 3600),
    Urgency: payload.kind === 'ORDER_NOW' ? 'high' : 'normal',
  };
  if (payload.tag) headers.Topic = payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const r = await fetchImpl(sub.endpoint, { method: 'POST', headers, body });
  return { status: r.status, gone: r.status === 404 || r.status === 410 };
}

// ───────────────────────────────────────────────────────────────────────────────
// The run cycle
// ───────────────────────────────────────────────────────────────────────────────
async function loadConfig(db) {
  let saved = {};
  try { saved = (await db.get('config')) || {}; } catch { /* first run */ }
  return { ...DEFAULT_CONFIG, ...saved };
}

export async function runCycle(env, { trigger = 'cron', alerts = true, fetchImpl = fetch, nowDate = new Date() } = {}) {
  const db = makeDb(env, fetchImpl);
  const config = await loadConfig(db);
  const now = { ...localParts(nowDate, config.tz), iso: nowDate.toISOString(), ms: nowDate.getTime() };
  const hol = holidaySet(config, now.ymd);
  const problems = [];
  const log = [];

  // ── 1. FuelCloud: tank + transactions ─────────────────────────────────────
  let tank = null, usage = null, deliveryDetected = null, rawTanks = null;
  const prevTank = await db.get('tank/latest').catch(() => null);
  try {
    const tokens = await fcLoadTokens(db, env);
    const tanks = await fcListAll(db, env, tokens, '/tank', fetchImpl);
    rawTanks = tanks.map(normalizeTank);
    const chosen = pickTank(tanks, config);
    if (!chosen) throw Object.assign(new Error('No tanks returned'), { code: 'fuelcloud_error' });
    tank = { ...normalizeTank(chosen), readAt: now.iso, source: 'fuelcloud' };
    if (!(tank.inventoryGal >= 0 && tank.inventoryGal <= tank.capacityGal * 1.02)) problems.push('inventory_implausible');

    const since = new Date(nowDate.getTime() - ((config.usageLookbackDays || 28) + 1) * 86400000);
    const q = `/transaction?start_date=${encodeURIComponent(since.toISOString())}&end_date=${encodeURIComponent(nowDate.toISOString())}`;
    const txs = await fcListAll(db, env, tokens, q, fetchImpl);
    const { daily, hourly, matched } = dailyGallonsFromTransactions(txs, tank.id, config.tz);
    log.push(`fuelcloud: ${tanks.length} tank(s), ${txs.length} transactions, ${matched} for tank ${tank.id}`);
    usage = buildUsageProfile(daily, now.ymd, config, hourly);
    await db.update('usage/daily', daily).catch(() => problems.push('firebase_error'));
    if (usage) await db.set('usage/profile', { ...usage, updatedAt: now.iso }).catch(() => {});

    // fills → delivery log; end-of-day levels → tank history (one write each)
    let fillTxs = [];
    try { fillTxs = await fcFetchFills(db, env, tokens, tank.id, new Date(nowDate.getTime() - 150 * 86400000), nowDate, fetchImpl); }
    catch (e) { log.push(`fill list: ${e.message}`); }
    const { fills, history } = fillsAndHistoryFromTransactions([...txs, ...fillTxs], tank.id, config.tz);
    delete history[now.ymd];
    if (Object.keys(history).length) await db.update('tank/history', history).catch(() => {});
    if (fills.length) {
      const existing = (await db.get('deliveries').catch(() => null)) || {};
      const add = mergeFillsIntoDeliveries(fills, existing, config);
      if (Object.keys(add).length) { await db.update('deliveries', add).catch(() => {}); log.push(`imported ${Object.keys(add).length} fill(s) from FuelCloud`); }
    }

    // delivery detection: a jump up vs the previous reading
    if (prevTank && Number.isFinite(prevTank.inventoryGal)) {
      const jump = tank.inventoryGal - prevTank.inventoryGal;
      if (jump >= Math.max(200, config.minDropGal * 0.5)) {
        const recent = await db.last('deliveries', 5).catch(() => null);
        const logged = recent && Object.values(recent).some(d => daysBetween(d.date, now.ymd) <= 3 && daysBetween(d.date, now.ymd) >= -1);
        if (!logged) deliveryDetected = { gallons: jump, at: now.iso };
      }
    }
    await db.set('tank/latest', tank);
    await db.update(`tank/history/${now.ymd}`, { inventoryGal: tank.inventoryGal, readAt: now.iso }).catch(() => {});
  } catch (e) {
    log.push(`fuelcloud error: ${e.message}`);
    problems.push(e.code || 'fuelcloud_error');
    tank = prevTank ? { ...prevTank, stale: true } : null;
    if (tank && nowDate.getTime() - Date.parse(tank.readAt || 0) > 36 * H) problems.push('tank_stale');
    usage = await db.get('usage/profile').catch(() => null);
  }

  // ── 2. Prices ─────────────────────────────────────────────────────────────
  let ho = null, nextMonth = null;
  const symbols = hoContractSymbols(now.ymd, hol);
  try {
    ho = await fetchYahooChart(env.PRICE_SYMBOL || 'HO=F', '1y', env, fetchImpl);
    try {
      const nm = await fetchYahooChart(symbols.next, '5d', env, fetchImpl);
      if (Number.isFinite(nm.live)) nextMonth = { symbol: symbols.next, price: nm.live };
    } catch (e) { log.push(`next-month ${symbols.next}: ${e.message}`); }
  } catch (e) {
    log.push(`yahoo error: ${e.message}`);
    try { ho = await fetchStooqQuote(env, fetchImpl); } catch (e2) { log.push(`stooq error: ${e2.message}`); }
  }
  let hoDaily = (await db.get('price/ho/daily').catch(() => null)) || {};
  if (ho) {
    const upd = {};
    for (const s of ho.settled) upd[s.ymd] = s.close;
    if (ho.sessionYmd && Number.isFinite(ho.live)) upd[ho.sessionYmd] = ho.live;   // today's live bar, converges to the settle
    if (Object.keys(upd).length) {
      await db.update('price/ho/daily', upd).catch(() => problems.push('firebase_error'));
      hoDaily = { ...hoDaily, ...upd };
    }
    await db.set('price/ho/latest', { ...ho, settled: undefined, nextMonth, fetchedAt: now.iso }).catch(() => {});
  }
  const closes = Object.keys(hoDaily).sort().filter(d => !ho?.sessionYmd || d < ho.sessionYmd).map(d => ({ ymd: d, close: Number(hoDaily[d]) })).filter(c => Number.isFinite(c.close));
  const live = ho?.live ?? (closes.length ? closes[closes.length - 1].close : null);
  const prevClose = ho?.prevClose ?? (closes.length >= 2 ? closes[closes.length - 2].close : null);
  const price = priceStats({ closes, live, prevClose, nextMonth, sessionYmd: ho?.sessionYmd || (closes.length ? closes[closes.length - 1].ymd : now.ymd), config });
  if (!price && !ho) problems.push('no_price_data');

  // ── 3. Supplier quotes + basis ────────────────────────────────────────────
  // price the product you're buying now: re-read recent sheets for that line (so a switch to a
  // winter blend re-bases at once), plus any quotes entered by hand
  const spec = productSpec(config, now.ymd);
  const quotes = {};
  const recentSheets = (await db.last('price/sheets', 20).catch(() => null)) || {};
  for (const [d, raw] of Object.entries(recentSheets)) {
    const pick = selectQuoteFromSheet(sheetFromStorage(raw), config, now.ymd);
    if (pick && Number.isFinite(pick.price)) quotes[d] = { price: pick.price, product: pick.label, source: 'sheet' };
  }
  const stored = (await db.last('price/quotes', 20).catch(() => null)) || {};
  // a hand-entered quote counts only if it was for the product you're buying now
  // (e.g. summer B20 quotes don't set the B5 markup); the schedule says what was bought on that date
  const sameProduct = (d) => spec.key === 'manual' || (productForDate(config, d) || spec.key) === spec.key;
  for (const [d, q] of Object.entries(stored)) {
    if (!sameProduct(d)) continue;
    if (q?.source === 'manual' || (!quotes[d] && q?.source !== 'sheet' && q?.source !== 'delivery')) quotes[d] = q;
  }
  const quoteDays = Object.keys(quotes).sort();
  let quote = null;
  if (quoteDays.length) {
    const d = quoteDays[quoteDays.length - 1];
    quote = { ymd: d, ...quotes[d] };
    // stale if older than 3 business days
    let bizGap = 0, cur = d; while (cur < now.ymd) { cur = ymdAddDays(cur, 1); if (isBusinessDay(cur, hol)) bizGap++; }
    if (bizGap > 3) problems.push('quote_stale');
  }
  const basis = computeBasis(quotes, hoDaily);
  if (basis) await db.set('price/basis', { ...basis, updatedAt: now.iso }).catch(() => {});
  let supplierCurve = null;
  try {
    // not every day's sheet carries the 12-month strip: use the newest one that does (up to 3 weeks old)
    for (const k of Object.keys(recentSheets).sort().reverse()) {
      if (daysBetween(k, now.ymd) > 21) break;
      const pick = selectQuoteFromSheet(sheetFromStorage(recentSheets[k]), config, now.ymd);
      if (pick?.curve) { supplierCurve = { ...pick.curve, sheetDate: k }; break; }
    }
  } catch { /* no sheets yet */ }

  // ── 4. Decide ─────────────────────────────────────────────────────────────
  const plan = decide({ config, tank, usage, price, quote, basis, supplierCurve, now, problems: [...new Set(problems)] });
  plan.lastRun = { at: now.iso, trigger, log };
  plan.product = { key: spec.key, name: spec.name };
  await db.set('plan/latest', plan).catch(() => {});
  await db.set(`plan/history/${now.ymd}`, {
    state: plan.state, inventoryGal: plan.tank?.inventoryGal ?? null, daysToOrderBy: plan.timing?.daysToOrderBy ?? null,
    ho: plan.price?.live ?? null, quote: plan.quote?.price ?? null, at: now.iso,
  }).catch(() => {});

  // ── 5. Alerts ─────────────────────────────────────────────────────────────
  const sent = [];
  if (alerts && plan.tank) {
    const prev = (await db.get('alerts/state').catch(() => null)) || {};
    const { pushes, next } = decideAlerts({ plan, prev, nowMs: now.ms, local: now, config, deliveryDetected });
    if (pushes.length) {
      const subs = (await db.get('push/subs').catch(() => null)) || {};
      for (const p of pushes) {
        const results = [];
        for (const [id, sub] of Object.entries(subs)) {
          try {
            const r = await sendWebPush(sub, { ...p, url: env.APP_URL || '/', state: plan.state }, env, fetchImpl);
            results.push(`${id}:${r.status}`);
            if (r.gone) await db.remove(`push/subs/${id}`).catch(() => {});
          } catch (e) { results.push(`${id}:err ${e.message.slice(0, 60)}`); }
        }
        sent.push({ ...p, results });
        await db.push('alerts/log', { ...p, state: plan.state, at: now.iso, results }).catch(() => {});
      }
    }
    await db.set('alerts/state', next).catch(() => {});
  }

  return { plan, sent, log, rawTanks };
}

// ───────────────────────────────────────────────────────────────────────────────
// HTTP API for the PWA + Apps Script
// ───────────────────────────────────────────────────────────────────────────────
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleRequest(request, env, ctx, fetchImpl = fetch) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/health' || path === '/') return json({ ok: true, service: 'fueldesk', version: VERSION, time: new Date().toISOString() }, 200, cors);

  const key = request.headers.get('X-App-Key') || url.searchParams.get('key') || '';
  if (!env.APP_KEY || !safeEqual(key, env.APP_KEY)) return json({ error: 'unauthorized' }, 401, cors);

  const db = makeDb(env, fetchImpl);
  const body = async () => { try { return await request.json(); } catch { return {}; } };

  try {
    // ── status bundle ─────────────────────────────────────────────────────
    if (path === '/api/status' && request.method === 'GET') {
      const [plan, tank, usage, hoLatest, hoDaily, quotes, deliveries, alerts, config, subs, tankHistory, planHistory, basis, sheets] = await Promise.all([
        db.get('plan/latest'), db.get('tank/latest'), db.get('usage/profile'), db.get('price/ho/latest'),
        db.last('price/ho/daily', 270), db.last('price/quotes', 270), db.last('deliveries', 40), db.last('alerts/log', 25),
        db.get('config'), db.get('push/subs'), db.last('tank/history', 370), db.last('plan/history', 60), db.get('price/basis'),
        db.last('price/sheets', 1),
      ].map(p => p.catch(() => null)));
      const sheetKey = sheets ? Object.keys(sheets)[0] : null;
      const latestSheet = sheetKey ? { ...sheetFromStorage(sheets[sheetKey]), rawText: undefined } : null;
      // quotes carry the full curve; trim for the wire
      const quotesLite = Object.fromEntries(Object.entries(quotes || {}).map(([k, v]) => [k, { ...v, curve: undefined }]));
      return json({
        plan, tank, usage, hoLatest, hoDaily: hoDaily || {}, quotes: quotesLite, deliveries: deliveries || {}, alerts: alerts || {},
        tankHistory: tankHistory || {}, planHistory: planHistory || {}, basis, latestSheet,
        config: { ...DEFAULT_CONFIG, ...(config || {}) }, defaults: DEFAULT_CONFIG,
        pushSubscribers: subs ? Object.keys(subs).length : 0,
        vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
        fuelCloudFillEnabled: env.FUELCLOUD_FILLS !== 'off',
        products: PRODUCTS, currentProduct: productSpec({ ...DEFAULT_CONFIG, ...(config || {}) }, localParts(new Date(), (config || {}).tz || DEFAULT_CONFIG.tz).ymd),
        serverTime: new Date().toISOString(),
      }, 200, cors);
    }

    // ── config ────────────────────────────────────────────────────────────
    if (path === '/api/config' && request.method === 'GET') {
      return json({ ...DEFAULT_CONFIG, ...((await db.get('config')) || {}) }, 200, cors);
    }
    if (path === '/api/config' && (request.method === 'PUT' || request.method === 'POST')) {
      const incoming = await body();
      const clean = {};
      for (const [k, v] of Object.entries(incoming)) {
        if (!(k in DEFAULT_CONFIG)) continue;
        clean[k] = v;
      }
      if (clean.holidays && !Array.isArray(clean.holidays)) clean.holidays = String(clean.holidays).split(/[\s,]+/).filter(Boolean);
      if ('productSchedule' in clean) {
        if (!Array.isArray(clean.productSchedule)) return json({ error: 'productSchedule must be a list' }, 400, cors);
        clean.productSchedule = clean.productSchedule.filter(r => r && /^\d{2}-\d{2}$/.test(r.from) && PRODUCTS[r.product]).map(r => ({ from: r.from, product: r.product }));
        if (!clean.productSchedule.length) return json({ error: 'product schedule needs at least one row' }, 400, cors);
      }
      await db.update('config', clean);
      return json({ ok: true, config: { ...DEFAULT_CONFIG, ...((await db.get('config')) || {}) } }, 200, cors);
    }

    // ── run now ───────────────────────────────────────────────────────────
    if (path === '/api/run' && request.method === 'POST') {
      const dry = url.searchParams.get('dry') === '1';
      const out = await runCycle(env, { trigger: dry ? 'manual-dry' : 'manual', alerts: !dry, fetchImpl });
      return json({ ok: true, plan: out.plan, sent: out.sent, log: out.log }, 200, cors);
    }

    // ── supplier quote (Apps Script or manual) ────────────────────────────
    if (path === '/api/quote' && request.method === 'POST') {
      const q = await body();
      const price = Number(q.price);
      const tz = (await loadConfig(db)).tz;
      const ymd = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : localParts(new Date(), tz).ymd;
      if (!Number.isFinite(price) || price <= 0 || price > 20) return json({ error: 'price must be $/gal between 0 and 20' }, 400, cors);
      const rec = { price: round(price, 4), product: q.product || null, source: q.source || 'manual', raw: (q.raw || '').toString().slice(0, 500), messageId: q.messageId || null, receivedAt: new Date().toISOString() };
      await db.set(`price/quotes/${ymd}`, rec);
      let plan = null;
      // back-filling an old day doesn't need the full check (or alerts); only today's price does
      const isRecent = daysBetween(ymd, localParts(new Date(), tz).ymd) <= 1;
      if (q.recompute !== false && isRecent) {
        const out = await runCycle(env, { trigger: 'quote', alerts: true, fetchImpl });
        plan = out.plan;
      }
      return json({ ok: true, date: ymd, quote: rec, state: plan?.state || null }, 200, cors);
    }
    // ── supplier price sheet text (Apps Script posts the PDF's text) ──────
    if (path === '/api/sheet' && request.method === 'POST') {
      const s = await body();
      const text = String(s.text || '');
      if (text.length < 20) return json({ error: 'text required' }, 400, cors);
      const config = await loadConfig(db);
      const sheet = parsePriceSheet(text);
      const fm = String(s.filename || '').match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
      const ymd = sheet.date
        || (fm ? `${fm[3]}-${fm[1].padStart(2, '0')}-${fm[2].padStart(2, '0')}` : null)
        || (s.emailDate ? localParts(new Date(s.emailDate), config.tz).ymd : localParts(new Date(), config.tz).ymd);
      const pick = selectQuoteFromSheet(sheet, config, ymd);
      const stored = {
        date: ymd, blend: sheet.blend, spot: toRows(sheet.spot), winter: toRows(sheet.winter), contracts: toRows(sheet.contracts), months: sheet.months, propane: toRows(sheet.propane),
        picked: pick ? { label: pick.label, price: pick.price } : null,
        messageId: s.messageId || null, filename: s.filename || null, subject: s.subject || null, note: String(s.note || '').slice(0, 400) || null,
        receivedAt: new Date().toISOString(),
        rawText: text.slice(0, 6000),
      };
      await db.set(`price/sheets/${ymd}`, stored);
      let plan = null;
      if (pick) {
        await db.set(`price/quotes/${ymd}`, {
          price: round(pick.price, 4), product: pick.label, source: 'sheet', messageId: s.messageId || null,
          curve: pick.curve, receivedAt: stored.receivedAt,
        });
        if (s.recompute !== false) plan = (await runCycle(env, { trigger: 'sheet', alerts: true, fetchImpl })).plan;
      }
      return json({
        ok: true, date: ymd, picked: pick ? { label: pick.label, price: pick.price, curveRow: pick.curve?.row || null } : null,
        parsedLabels: Object.keys(sheet.spot), contractRows: Object.keys(sheet.contracts), months: sheet.months, blend: sheet.blend,
        warning: pick ? null : `No line on the sheet matched ${productSpec(config, ymd).name} — check the product schedule in Settings.`,
        state: plan?.state || null,
      }, 200, cors);
    }
    if (path.startsWith('/api/sheet/') && request.method === 'GET') {
      const ymd = path.split('/').pop();
      if (ymd === 'latest') { const s = await db.last('price/sheets', 1); const k = s ? Object.keys(s)[0] : null; return json(k ? { ...sheetFromStorage(s[k]), rawText: undefined } : null, 200, cors); }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return json({ error: 'bad date' }, 400, cors);
      return json(sheetFromStorage(await db.get(`price/sheets/${ymd}`)), 200, cors);
    }

    if (path.startsWith('/api/quote/') && request.method === 'DELETE') {
      const ymd = path.split('/').pop();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return json({ error: 'bad date' }, 400, cors);
      // a bad quote usually came from a bad sheet: drop both, or the sheet would put it back
      await db.remove(`price/quotes/${ymd}`);
      await db.remove(`price/sheets/${ymd}`).catch(() => {});
      const out = await runCycle(env, { trigger: 'quote-delete', alerts: false, fetchImpl }).catch(() => null);
      return json({ ok: true, date: ymd, state: out?.plan?.state || null }, 200, cors);
    }

    // ── deliveries ────────────────────────────────────────────────────────
    if (path === '/api/delivery' && request.method === 'POST') {
      const d = await body();
      const gallons = Number(d.gallons), ppg = Number(d.pricePerGal);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '') || !Number.isFinite(gallons) || gallons <= 0) return json({ error: 'date (YYYY-MM-DD) and gallons required' }, 400, cors);
      const rec = {
        date: d.date, gallons: round(gallons, 1), pricePerGal: Number.isFinite(ppg) ? round(ppg, 4) : null,
        total: Number.isFinite(ppg) ? round(gallons * ppg, 2) : (Number.isFinite(Number(d.total)) ? round(Number(d.total), 2) : null),
        supplier: d.supplier || null, invoice: d.invoice || null, notes: (d.notes || '').toString().slice(0, 300),
        createdAt: new Date().toISOString(), postedToFuelCloud: false, fuelCloudResponse: null,
      };
      const cfgD = await loadConfig(db);
      const specD = productSpec(cfgD, rec.date);
      rec.product = PRODUCTS[d.product] ? d.product : specD.key;
      rec.productName = PRODUCTS[rec.product]?.name || specD.name;
      // a delivered price for the scheduled product is that day's real price too
      if (rec.pricePerGal && rec.product === specD.key) {
        const existing = await db.get(`price/quotes/${rec.date}`).catch(() => null);
        if (!existing) await db.set(`price/quotes/${rec.date}`, { price: rec.pricePerGal, product: 'delivered', source: 'delivery', receivedAt: rec.createdAt }).catch(() => {});
      }
      if (d.postToFuelCloud && env.FUELCLOUD_FILLS !== 'off') {
        try {
          if (!rec.pricePerGal) throw new Error('FuelCloud needs the $/gal for a fill — add it and log again');
          const tank = await db.get('tank/latest');
          if (!tank?.id) throw new Error('no FuelCloud tank on record yet — run the check first');
          const cfg = await loadConfig(db);
          const hhmm = /^\d{1,2}:\d{2}$/.test(d.time || '') ? d.time : '12:00';
          const createdMs = localToUtcMs(rec.date, hhmm, cfg.tz);
          // deterministic id: logging the same drop twice can't double-count it in FuelCloud
          const txId = `fueldesk-${rec.date}-${Math.round(rec.gallons)}-${String(rec.invoice || 'noinv').replace(/[^\w-]/g, '').slice(0, 30)}`;
          const payload = {
            transaction_type: 2, transaction_id: txId, volume: rec.gallons, tank_id: Number(tank.id),
            created: Math.floor(createdMs / 1000), created_utc: new Date(createdMs).toISOString().replace('T', ' ').slice(0, 19),
            price: rec.pricePerGal,
          };
          const tokens = await fcLoadTokens(db, env);
          if (!tokens.access || Date.now() > (tokens.expiresAt || 0)) Object.assign(tokens, await fcRefresh(db, env, tokens, fetchImpl));
          const r = await fetchImpl(`${fcBase(env)}${env.FUELCLOUD_FILL_PATH || '/rest/v1.0/transaction'}`, {
            method: 'POST', headers: { Authorization: bearer(tokens.access), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload),
          });
          rec.fuelCloudResponse = `${r.status} ${(await r.text()).slice(0, 300)}`;
          rec.postedToFuelCloud = r.ok;
          rec.fuelCloudTransactionId = txId;
          rec.time = hhmm;
        } catch (e) { rec.fuelCloudResponse = `error: ${e.message}`; }
      }
      const { name } = await db.push('deliveries', rec);
      // reset delivery-detected notice and recompute (no alerts; a delivery is good news)
      const out = await runCycle(env, { trigger: 'delivery', alerts: false, fetchImpl });
      return json({ ok: true, id: name, delivery: rec, state: out.plan.state }, 200, cors);
    }
    if (path.startsWith('/api/delivery/') && request.method === 'DELETE') {
      const id = path.split('/').pop();
      if (!/^[-\w]+$/.test(id)) return json({ error: 'bad id' }, 400, cors);
      await db.remove(`deliveries/${id}`);
      return json({ ok: true }, 200, cors);
    }

    // ── push subscriptions ────────────────────────────────────────────────
    if (path === '/api/push/subscribe' && request.method === 'POST') {
      const { subscription, ua } = await body();
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return json({ error: 'invalid subscription' }, 400, cors);
      const id = (await sha256hex(subscription.endpoint)).slice(0, 24);
      await db.set(`push/subs/${id}`, { endpoint: subscription.endpoint, keys: subscription.keys, ua: (ua || '').slice(0, 120), createdAt: new Date().toISOString() });
      return json({ ok: true, id }, 200, cors);
    }
    if (path === '/api/push/unsubscribe' && request.method === 'POST') {
      const { endpoint } = await body();
      if (!endpoint) return json({ error: 'endpoint required' }, 400, cors);
      await db.remove(`push/subs/${(await sha256hex(endpoint)).slice(0, 24)}`);
      return json({ ok: true }, 200, cors);
    }
    if (path === '/api/push/test' && request.method === 'POST') {
      const subs = (await db.get('push/subs')) || {};
      const results = [];
      for (const [id, sub] of Object.entries(subs)) {
        try {
          const r = await sendWebPush(sub, { kind: 'TEST', tag: 'fueldesk-test', title: 'FuelDesk test', body: 'Push notifications are working.', url: env.APP_URL || '/' }, env, fetchImpl);
          results.push({ id, status: r.status });
          if (r.gone) await db.remove(`push/subs/${id}`).catch(() => {});
        } catch (e) { results.push({ id, error: e.message }); }
      }
      return json({ ok: true, results }, 200, cors);
    }

    // ── import fills from FuelCloud history (one-off backfill) ────────────
    if (path === '/api/fuelcloud/import-fills' && request.method === 'POST') {
      const days = Math.min(200, Math.max(7, Number(url.searchParams.get('days')) || 120));
      const config = await loadConfig(db);
      const tokens = await fcLoadTokens(db, env);
      const tank = await db.get('tank/latest');
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const txs = await fcListAll(db, env, tokens, `/transaction?start_date=${encodeURIComponent(since)}&end_date=${encodeURIComponent(new Date().toISOString())}`, fetchImpl, 40);
      const fillTxs = await fcFetchFills(db, env, tokens, tank?.id, new Date(Date.now() - days * 86400000), new Date(), fetchImpl);
      const { fills, history } = fillsAndHistoryFromTransactions([...txs, ...fillTxs], tank?.id, config.tz);
      const today = localParts(new Date(), config.tz).ymd; delete history[today];
      if (Object.keys(history).length) await db.update('tank/history', history);
      const existing = (await db.get('deliveries')) || {};
      const add = mergeFillsIntoDeliveries(fills, existing, config);
      if (Object.keys(add).length) await db.update('deliveries', add);
      return json({ ok: true, transactions: txs.length, fillsFound: fills.length, added: Object.keys(add).length, historyDays: Object.keys(history).length,
        fills: fills.map(f => `${f.date} ${f.gallons} gal${f.pricePerGal ? ` @ $${f.pricePerGal}` : ''}`) }, 200, cors);
    }

    // ── FuelCloud fill-query probe: which query shape returns fills ──────
    if (path === '/api/fuelcloud/probe-fills' && request.method === 'GET') {
      const tokens = await fcLoadTokens(db, env);
      const tank = await db.get('tank/latest');
      const end = new Date(), start = new Date(Date.now() - 60 * 86400000);
      const iso = (d) => d.toISOString(), plain = (d) => d.toISOString().slice(0, 19), day = (d) => d.toISOString().slice(0, 10);
      const variants = {
        encoded_plain: `/transaction?start_date=${plain(start)}&end_date=${plain(end)}&filter%5Btransaction_type%5D=2`,
        raw_plain: `/transaction?start_date=${plain(start)}&end_date=${plain(end)}&filter[transaction_type]=2`,
        raw_iso: `/transaction?start_date=${encodeURIComponent(iso(start))}&end_date=${encodeURIComponent(iso(end))}&filter[transaction_type]=2`,
        raw_tank: `/transaction?start_date=${plain(start)}&end_date=${plain(end)}&filter[transaction_type]=2&filter[tank_id]=${tank?.id}`,
        raw_day: `/transaction?start_date=${day(start)}&end_date=${day(end)}&filter[transaction_type]=2`,
        no_dates: `/transaction?filter[transaction_type]=2`,
        tank_only: `/transaction?start_date=${plain(start)}&end_date=${plain(end)}&filter[tank_id]=${tank?.id}`,
      };
      const out = {};
      for (const [name, q] of Object.entries(variants)) {
        try {
          const j = await fcGet(db, env, tokens, q, fetchImpl);
          const data = Array.isArray(j) ? j : (j.data || []);
          const types = {}; for (const t of data) types[t.transaction_type] = (types[t.transaction_type] || 0) + 1;
          out[name] = { total: j.meta?.total ?? data.length, firstPageTypes: types,
            fills: data.filter(t => String(t.transaction_type) === '2').slice(0, 6).map(t => `${t.created_utc} ${t.volume} @${t.price} tank ${t.tank_id} ${t.transaction_id}`) };
        } catch (e) { out[name] = { error: e.message.slice(0, 160) }; }
      }
      return json({ ok: true, version: VERSION, tankId: tank?.id, variants: out }, 200, cors);
    }

    // ── FuelCloud debug ───────────────────────────────────────────────────
    if (path === '/api/fuelcloud/test' && request.method === 'GET') {
      const tokens = await fcLoadTokens(db, env);
      const tanks = await fcListAll(db, env, tokens, '/tank', fetchImpl);
      const since = new Date(Date.now() - 3 * 86400000).toISOString();
      let sampleTx = null, txError = null;
      try {
        const j = await fcGet(db, env, tokens, `/transaction?start_date=${encodeURIComponent(since)}&end_date=${encodeURIComponent(new Date().toISOString())}`, fetchImpl);
        sampleTx = (j.data || j).slice ? (j.data || j).slice(0, 3) : j;
      } catch (e) { txError = e.message; }
      return json({ ok: true, tanks: tanks.map(normalizeTank), rawTank: tanks[0] || null, sampleTransactions: sampleTx, txError, tokenSource: tokens.source || 'db', tokenExpiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null }, 200, cors);
    }

    // ── admin: VAPID key generation (only until keys are configured) ──────
    if (path === '/api/admin/vapid' && (request.method === 'POST' || request.method === 'GET')) {
      if (env.VAPID_PRIVATE_KEY) return json({ error: 'VAPID keys already configured; remove the secret first if you really want to rotate' }, 409, cors);
      return json({ ok: true, ...(await generateVapidKeys()), note: 'Save these as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY secrets, then redeploy.' }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message, code: e.code || null }, 500, cors);
  }
}

export default {
  async fetch(request, env, ctx) { return handleRequest(request, env, ctx); },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycle(env, { trigger: `cron ${event.cron}` }).then(
      out => console.log(`fueldesk ${out.plan.state} · ${out.sent.length} push(es) · ${out.log.join(' | ')}`),
      err => console.error('fueldesk run failed', err),
    ));
  },
};