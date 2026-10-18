'use strict';

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}
const bad = (msg, extra) => new HttpError(400, msg, extra);
const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
const forbidden = () => new HttpError(403, 'You do not have permission for this action');
const conflict = (msg, extra) => new HttpError(409, msg, extra);
const unprocessable = (msg, extra) => new HttpError(422, msg, extra);

const TZ = process.env.APP_TZ || 'Asia/Kolkata';

/** Local date/time parts in the school's timezone. */
function nowParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, month: `${p.year}-${p.month}` };
}
// Tests may pin "today" with TODAY_OVERRIDE.
const today = () => process.env.TODAY_OVERRIDE || nowParts().date;
const thisMonth = () => today().slice(0, 7);

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !RE_DATE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function isValidDateTime(s) {
  return typeof s === 'string' && RE_DT.test(s) && isValidDate(s.slice(0, 10)) && RE_TIME.test(s.slice(11));
}
const isValidTime = s => typeof s === 'string' && RE_TIME.test(s);
const weekdayOf = date => new Date(date.slice(0, 10) + 'T00:00:00Z').getUTCDay();

function addMinutes(dt, mins) {
  const d = new Date(dt + ':00Z');
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().slice(0, 16);
}
const minutesOf = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function str(v, { max = 500, required = false, name = 'Field' } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${name} must be text`);
  v = String(v).trim();
  if (required && !v) throw bad(`${name} is required`, { field: name });
  if (v.length > max) throw bad(`${name} is too long (max ${max} characters)`, { field: name });
  return v || null;
}
function int(v, { min = -Infinity, max = Infinity, required = false, name = 'Field' } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`, { field: name });
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number`, { field: name });
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`, { field: name });
  return n;
}
function oneOf(v, list, { required = false, name = 'Field' } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`, { field: name });
    return null;
  }
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`, { field: name });
  return v;
}
/** Route/query id: a positive integer, or -1 (matches nothing) for anything else. */
const idParam = v => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : -1);
function bool(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

const normPhone = p => String(p || '').replace(/\D/g, '').replace(/^0+/, '');
const normName = n => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');

function inr(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN');
}

module.exports = {
  HttpError, bad, notFound, forbidden, conflict, unprocessable,
  TZ, nowParts, today, thisMonth, isValidDate, isValidDateTime, isValidTime, weekdayOf,
  addMinutes, minutesOf, str, int, oneOf, bool, idParam, normPhone, normName, inr,
};
