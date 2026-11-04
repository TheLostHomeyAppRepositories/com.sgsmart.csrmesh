'use strict';

// A moment, as an ISO time in UTC (as the app logs and keeps it), shown in
// Homey's time zone (homey.clock.getTimezone()), summer time included, and in
// Homey's language: "4. nov. kl. 06:40", "4 Nov, 06:40", with the year only
// when it is not this year there. Apps run in UTC (process.env.TZ, SDK v3), so
// the zone is handed to Intl, as Athom shows it (upgrade-guides/
// upgrading-to-sdk-v3.md, "App timezone now always UTC"). Only the numbers
// are taken from Intl (formatToParts in en-US); the words and the order come
// from locales (time.*), so no language data in Intl is needed. When Intl
// cannot do the zone (no zone, an unknown zone, no Intl or no time zone data,
// or numbers that make no time), the reserve is the same in UTC with " UTC"
// after it.

const pad = (value) => String(value).padStart(2, '0');

// The keys of the months under time.months in locales.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const utcParts = (date) => ({
  year: date.getUTCFullYear(),
  month: date.getUTCMonth() + 1,
  day: date.getUTCDate(),
  hour: date.getUTCHours(),
  minute: date.getUTCMinutes(),
});

// { parts } with date's year, month, day, hour and minute in timeZone, or
// { why } when Intl cannot give them.
function zonedParts(date, timeZone, intl) {
  let parts;
  try {
    parts = new intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
  } catch (err) {
    return { why: `Intl failed (${(err && err.name) || 'error'})` };
  }
  const number = (type) => {
    const part = Array.isArray(parts) ? parts.find((p) => p && p.type === type) : null;
    return part && /^\d+$/.test(part.value) ? Number(part.value) : NaN;
  };
  const [year, month, day, minute] = ['year', 'month', 'day', 'minute'].map(number);
  // Midnight as 24 in some runtimes, though h23 asks for 0.
  const hour = number('hour') === 24 ? 0 : number('hour');
  const within = (value, low, high) => value >= low && value <= high;
  if (!within(month, 1, 12) || !within(day, 1, 31) || !within(hour, 0, 23) || !within(minute, 0, 59)) {
    return { why: 'Intl gave no usable time' };
  }
  // The numbers must make a time on a quarter hour no more than 14 hours from
  // UTC, as every time zone is.
  const offset = (Date.UTC(year, month - 1, day, hour, minute) - Math.floor(date.getTime() / 60000) * 60000) / 60000;
  if (!Number.isFinite(offset) || Math.abs(offset) > 14 * 60 || offset % 15 !== 0) return { why: 'Intl gave no usable time' };
  return { parts: { year, month, day, hour, minute } };
}

// { parts, zoned, why, sameYear } for iso: parts in timeZone (zoned), or in
// UTC when that cannot be done (why then says why, never the zone); sameYear
// when now is in the same year, in the same zone. parts is null when iso is
// not a time. now and intl are for the tests.
function localTime(iso, timeZone, { now = new Date(), intl = globalThis.Intl } = {}) {
  const date = typeof iso === 'string' ? new Date(iso) : new Date(NaN);
  if (Number.isNaN(date.getTime())) return { parts: null, zoned: false, why: 'no time', sameYear: false };
  const zoned = typeof timeZone === 'string' && timeZone ? zonedParts(date, timeZone, intl) : { why: 'no time zone' };
  if (zoned.parts) {
    const current = zonedParts(now, timeZone, intl).parts;
    return { parts: zoned.parts, zoned: true, why: null, sameYear: !!current && current.year === zoned.parts.year };
  }
  const parts = utcParts(date);
  return { parts, zoned: false, why: zoned.why, sameYear: utcParts(now).year === parts.year };
}

// The text of a localTime, with translate as homey.__ (Homey's language):
// time.sameYear or time.otherYear with the month from time.months, and " UTC"
// after it for the reserve. Without those texts, "YYYY-MM-DD HH:MM". null
// when there is no time.
function localText(local, translate) {
  if (!local || !local.parts) return null;
  const { year, month, day, hour, minute } = local.parts;
  const say = (key, tokens) => {
    const text = translate(key, tokens);
    return typeof text === 'string' && text && text !== key ? text : null;
  };
  const time = `${pad(hour)}:${pad(minute)}`;
  const name = say(`time.months.${MONTHS[month - 1]}`);
  const text = (name && say(local.sameYear ? 'time.sameYear' : 'time.otherYear', { day, month: name, year, time }))
    || `${year}-${pad(month)}-${pad(day)} ${time}`;
  return local.zoned ? text : `${text} UTC`;
}

module.exports = { MONTHS, localText, localTime };
