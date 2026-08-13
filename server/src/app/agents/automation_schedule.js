import { ApiError } from "../../errors.js";

export const AUTOMATION_SCHEDULE_TYPES = Object.freeze([
  "manual",
  "once",
  "interval",
  "daily",
  "weekly",
  "rrule",
  "event",
]);

const DAY_CODES = Object.freeze({ SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 });
const FORMATTERS = new Map();

function clean(value, max = 1_000) {
  return String(value || "").trim().slice(0, max);
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError(`${label}不是有效时间`, 400);
  return date;
}

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function normalizeTimeZone(value) {
  const timezone = clean(value || systemTimeZone(), 120);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new ApiError(`无效时区：${timezone}`, 400);
  }
  return timezone;
}

function formatter(timezone) {
  if (!FORMATTERS.has(timezone)) {
    FORMATTERS.set(timezone, new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }));
  }
  return FORMATTERS.get(timezone);
}

export function zonedDateParts(value, timezone) {
  const date = validDate(value, "时间");
  const parts = Object.fromEntries(
    formatter(normalizeTimeZone(timezone)).formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const result = {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
  return {
    ...result,
    weekday: new Date(Date.UTC(result.year, result.month - 1, result.day)).getUTCDay(),
  };
}

function wallValue(parts) {
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour || 0),
    Number(parts.minute || 0),
    Number(parts.second || 0),
  );
}

function sameWall(left, right) {
  return ["year", "month", "day", "hour", "minute", "second"]
    .every((field) => Number(left[field] || 0) === Number(right[field] || 0));
}

function offsetAt(instant, timezone) {
  const date = validDate(instant, "时间");
  return wallValue(zonedDateParts(date, timezone)) - date.getTime();
}

/**
 * Resolve a local wall-clock time in an IANA timezone.
 *
 * A repeated DST time returns the first matching instant after `after`. A
 * missing DST time moves to the first valid minute later on the same local
 * date, matching the behavior users expect from desktop calendar apps.
 */
export function zonedDateTimeToInstant(parts, timezone, { after = null } = {}) {
  const zone = normalizeTimeZone(timezone);
  const target = {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
    second: Number(parts.second || 0),
  };
  const targetValue = wallValue(target);
  const offsets = new Set([
    offsetAt(new Date(targetValue - 86_400_000), zone),
    offsetAt(new Date(targetValue), zone),
    offsetAt(new Date(targetValue + 86_400_000), zone),
  ]);
  const afterMs = after == null ? Number.NEGATIVE_INFINITY : validDate(after, "起始时间").getTime();
  const exact = [...offsets]
    .map((offset) => new Date(targetValue - offset))
    .filter((candidate) => sameWall(zonedDateParts(candidate, zone), target))
    .filter((candidate) => candidate.getTime() > afterMs)
    .sort((left, right) => left.getTime() - right.getTime());
  if (exact.length) return exact[0];

  // DST spring-forward gap. This branch only runs for a non-existent local
  // minute, so a bounded minute scan is both deterministic and inexpensive.
  const start = targetValue - 18 * 60 * 60_000;
  const end = targetValue + 18 * 60 * 60_000;
  let best = null;
  let bestWall = Number.POSITIVE_INFINITY;
  for (let instant = start; instant <= end; instant += 60_000) {
    if (instant <= afterMs) continue;
    const observed = zonedDateParts(new Date(instant), zone);
    if (
      observed.year !== target.year
      || observed.month !== target.month
      || observed.day !== target.day
    ) continue;
    const observedWall = wallValue(observed);
    if (observedWall >= targetValue && observedWall < bestWall) {
      best = new Date(instant);
      bestWall = observedWall;
    }
  }
  if (best) return best;
  throw new ApiError("无法把本地时间换算到所选时区", 400);
}

function parseLocalAt(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(clean(value, 40));
  if (!match) throw new ApiError("一次性任务时间必须是 YYYY-MM-DDTHH:MM", 400);
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  };
  if (
    parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31
    || parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59
  ) throw new ApiError("一次性任务时间无效", 400);
  return parts;
}

function normalizeClock(value = "09:00") {
  const time = clean(value || "09:00", 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ApiError("运行时间必须是 HH:MM", 400);
  return time;
}

function normalizeRRuleText(value) {
  const text = clean(value, 2_000).replace(/^RRULE:/i, "").toUpperCase();
  if (!text) throw new ApiError("自定义重复规则不能为空", 400);
  parseRRule(text);
  return text;
}

export function normalizeAutomationSchedule(value = {}, { defaultStart = new Date() } = {}) {
  const schedule = value && typeof value === "object" ? value : {};
  const type = clean(schedule.type || "manual", 20).toLowerCase();
  if (!AUTOMATION_SCHEDULE_TYPES.includes(type)) throw new ApiError("不支持的任务运行计划", 400);
  if (type === "manual") return { type };
  if (type === "interval") {
    const intervalMinutes = Math.floor(Number(schedule.interval_minutes || 0));
    if (intervalMinutes < 5 || intervalMinutes > 30 * 24 * 60) throw new ApiError("间隔时间必须在 5 分钟到 30 天之间", 400);
    const anchor = schedule.anchor_at ? validDate(schedule.anchor_at, "间隔起始时间") : validDate(defaultStart, "起始时间");
    return { type, interval_minutes: intervalMinutes, anchor_at: anchor.toISOString() };
  }
  if (type === "event") {
    const eventName = clean(schedule.event_name, 160);
    if (!/^[a-z][a-z0-9_.:-]{1,159}$/i.test(eventName)) throw new ApiError("事件名称无效", 400);
    const debounceSeconds = Math.max(0, Math.min(86_400, Math.floor(Number(schedule.debounce_seconds ?? 30))));
    const match = schedule.match && typeof schedule.match === "object" && !Array.isArray(schedule.match)
      ? schedule.match
      : {};
    return { type, event_name: eventName, debounce_seconds: debounceSeconds, match };
  }

  const timezone = normalizeTimeZone(schedule.timezone);
  if (type === "once") {
    const localAt = clean(schedule.local_at, 40) || null;
    const runAt = localAt
      ? zonedDateTimeToInstant(parseLocalAt(localAt), timezone)
      : validDate(schedule.run_at, "一次性任务时间");
    return {
      type,
      timezone,
      local_at: localAt || formatLocalAt(runAt, timezone),
      run_at: runAt.toISOString(),
    };
  }
  if (type === "rrule") {
    return {
      type,
      timezone,
      rrule: normalizeRRuleText(schedule.rrule),
      dtstart: validDate(schedule.dtstart || defaultStart, "重复起始时间").toISOString(),
    };
  }
  const time = normalizeClock(schedule.time);
  if (type === "daily") return { type, time, timezone };
  const weekday = Math.floor(Number(schedule.weekday));
  if (weekday < 0 || weekday > 6) throw new ApiError("星期必须在 0 到 6 之间", 400);
  return { type, time, weekday, timezone };
}

export function normalizeMissedPolicy(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const mode = clean(source.mode || "run_once", 30).toLowerCase();
  if (!new Set(["run_once", "skip", "within_grace"]).has(mode)) {
    throw new ApiError("错过任务后的处理方式无效", 400);
  }
  const graceMinutes = Math.max(1, Math.min(7 * 24 * 60, Math.floor(Number(source.grace_minutes || 60))));
  return { mode, grace_minutes: graceMinutes };
}

export function missedOccurrenceDecision(scheduledFor, now, policy = {}) {
  const normalized = normalizeMissedPolicy(policy);
  const latenessMs = Math.max(0, validDate(now, "当前时间").getTime() - validDate(scheduledFor, "排期时间").getTime());
  if (normalized.mode === "skip") return { action: latenessMs > 0 ? "skip" : "run", lateness_ms: latenessMs };
  if (normalized.mode === "within_grace" && latenessMs > normalized.grace_minutes * 60_000) {
    return { action: "skip", lateness_ms: latenessMs };
  }
  return { action: "run", lateness_ms: latenessMs };
}

function addCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addCalendarMonths(parts, months) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 };
}

function localDateOrdinal(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function localCandidate(dateParts, hour, minute, timezone, after) {
  return zonedDateTimeToInstant({ ...dateParts, hour, minute, second: 0 }, timezone, { after });
}

function nextDailyOrWeekly(schedule, from) {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const start = zonedDateParts(from, schedule.timezone);
  for (let offset = 0; offset < 370; offset += 1) {
    const dateParts = addCalendarDays(start, offset);
    const weekday = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
    if (schedule.type === "weekly" && weekday !== schedule.weekday) continue;
    const candidate = localCandidate(dateParts, hour, minute, schedule.timezone, from);
    if (candidate.getTime() > from.getTime()) return candidate.toISOString();
  }
  throw new ApiError("无法计算下一次运行时间", 400);
}

function parseNumberList(value, { min, max, label }) {
  if (value == null || value === "") return [];
  const result = [...new Set(String(value).split(",").map((item) => Number(item)))];
  if (result.some((item) => !Number.isInteger(item) || item < min || item > max)) {
    throw new ApiError(`${label}无效`, 400);
  }
  return result.sort((left, right) => left - right);
}

export function parseRRule(value) {
  const pairs = new Map();
  for (const part of clean(value, 2_000).replace(/^RRULE:/i, "").toUpperCase().split(";")) {
    const [key, raw] = part.split("=", 2);
    if (!key || raw == null || pairs.has(key)) throw new ApiError("自定义重复规则格式无效", 400);
    pairs.set(key, raw);
  }
  const allowed = new Set(["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE", "BYMONTHDAY", "COUNT", "UNTIL"]);
  const unknown = [...pairs.keys()].filter((key) => !allowed.has(key));
  if (unknown.length) throw new ApiError(`暂不支持重复规则字段：${unknown.join("、")}`, 400);
  const freq = pairs.get("FREQ");
  if (!new Set(["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY"]).has(freq)) {
    throw new ApiError("重复规则只支持分钟、小时、每天、每周或每月", 400);
  }
  const interval = Number(pairs.get("INTERVAL") || 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 10_000) throw new ApiError("重复间隔无效", 400);
  const byday = pairs.has("BYDAY")
    ? [...new Set(pairs.get("BYDAY").split(","))].map((code) => {
        if (!Object.hasOwn(DAY_CODES, code)) throw new ApiError("BYDAY 无效", 400);
        return DAY_CODES[code];
      }).sort((left, right) => left - right)
    : [];
  const byhour = parseNumberList(pairs.get("BYHOUR"), { min: 0, max: 23, label: "BYHOUR" });
  const byminute = parseNumberList(pairs.get("BYMINUTE"), { min: 0, max: 59, label: "BYMINUTE" });
  const bymonthday = parseNumberList(pairs.get("BYMONTHDAY"), { min: -31, max: 31, label: "BYMONTHDAY" });
  if (bymonthday.includes(0)) throw new ApiError("BYMONTHDAY 不能为 0", 400);
  const count = pairs.has("COUNT") ? Number(pairs.get("COUNT")) : null;
  if (count != null && (!Number.isInteger(count) || count < 1 || count > 100_000)) throw new ApiError("COUNT 无效", 400);
  let until = null;
  if (pairs.has("UNTIL")) {
    const raw = pairs.get("UNTIL");
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
    until = match
      ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])))
      : validDate(raw, "UNTIL");
  }
  return { freq, interval, byday, byhour, byminute, bymonthday, count, until };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthlyDays(rule, startParts, year, month) {
  const max = daysInMonth(year, month);
  const requested = rule.bymonthday.length ? rule.bymonthday : [startParts.day];
  return [...new Set(requested.map((day) => day < 0 ? max + day + 1 : day))]
    .filter((day) => day >= 1 && day <= max)
    .sort((left, right) => left - right);
}

function candidateTimes(rule, startParts) {
  const hours = rule.byhour.length ? rule.byhour : [startParts.hour];
  const minutes = rule.byminute.length ? rule.byminute : [startParts.minute];
  return hours.flatMap((hour) => minutes.map((minute) => ({ hour, minute })));
}

function rruleCandidatesForPeriod(rule, schedule, startParts, period) {
  const zone = schedule.timezone;
  const times = candidateTimes(rule, startParts);
  const localDates = [];
  if (rule.freq === "DAILY") {
    const date = addCalendarDays(startParts, period * rule.interval);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (!rule.byday.length || rule.byday.includes(weekday)) localDates.push(date);
  } else if (rule.freq === "WEEKLY") {
    const startOrdinal = localDateOrdinal(startParts);
    const weekStart = startOrdinal - startParts.weekday + period * rule.interval * 7;
    const days = rule.byday.length ? rule.byday : [startParts.weekday];
    for (const weekday of days) {
      const date = new Date((weekStart + weekday) * 86_400_000);
      localDates.push({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
    }
  } else if (rule.freq === "MONTHLY") {
    const month = addCalendarMonths(startParts, period * rule.interval);
    for (const day of monthlyDays(rule, startParts, month.year, month.month)) {
      const weekday = new Date(Date.UTC(month.year, month.month - 1, day)).getUTCDay();
      if (!rule.byday.length || rule.byday.includes(weekday)) localDates.push({ ...month, day });
    }
  }
  return localDates.flatMap((date) => times.map(({ hour, minute }) => (
    zonedDateTimeToInstant({ ...date, hour, minute, second: 0 }, zone)
  ))).sort((left, right) => left.getTime() - right.getTime());
}

function nextRRule(schedule, from) {
  const rule = parseRRule(schedule.rrule);
  const start = new Date(schedule.dtstart);
  const startParts = zonedDateParts(start, schedule.timezone);
  let emitted = 0;
  if (rule.freq === "MINUTELY" || rule.freq === "HOURLY") {
    const unit = rule.freq === "MINUTELY" ? 60_000 : 3_600_000;
    for (let period = 0; period < 100_000; period += 1) {
      const candidate = new Date(start.getTime() + period * rule.interval * unit);
      const parts = zonedDateParts(candidate, schedule.timezone);
      if (rule.byhour.length && !rule.byhour.includes(parts.hour)) continue;
      if (rule.byminute.length && !rule.byminute.includes(parts.minute)) continue;
      if (rule.until && candidate.getTime() > rule.until.getTime()) return null;
      emitted += 1;
      if (rule.count && emitted > rule.count) return null;
      if (candidate.getTime() > from.getTime()) return candidate.toISOString();
    }
    return null;
  }

  for (let period = 0; period < 100_000; period += 1) {
    const candidates = rruleCandidatesForPeriod(rule, schedule, startParts, period);
    for (const candidate of candidates) {
      if (candidate.getTime() < start.getTime()) continue;
      if (rule.until && candidate.getTime() > rule.until.getTime()) return null;
      emitted += 1;
      if (rule.count && emitted > rule.count) return null;
      if (candidate.getTime() > from.getTime()) return candidate.toISOString();
    }
  }
  return null;
}

export function nextAutomationRunAt(schedule, from = new Date()) {
  const origin = validDate(from, "起始时间");
  const normalized = normalizeAutomationSchedule(schedule, { defaultStart: origin });
  if (normalized.type === "manual" || normalized.type === "event") return null;
  if (normalized.type === "once") {
    const runAt = new Date(normalized.run_at);
    return runAt.getTime() > origin.getTime() ? runAt.toISOString() : null;
  }
  if (normalized.type === "interval") {
    const intervalMs = normalized.interval_minutes * 60_000;
    const anchor = new Date(normalized.anchor_at).getTime();
    if (anchor > origin.getTime()) return new Date(anchor).toISOString();
    const steps = Math.floor((origin.getTime() - anchor) / intervalMs) + 1;
    return new Date(anchor + steps * intervalMs).toISOString();
  }
  if (normalized.type === "rrule") return nextRRule(normalized, origin);
  return nextDailyOrWeekly(normalized, origin);
}

export function formatLocalAt(value, timezone) {
  const parts = zonedDateParts(value, timezone);
  const pad = (number) => String(number).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export default {
  AUTOMATION_SCHEDULE_TYPES,
  formatLocalAt,
  missedOccurrenceDecision,
  nextAutomationRunAt,
  normalizeAutomationSchedule,
  normalizeMissedPolicy,
  normalizeTimeZone,
  parseRRule,
  systemTimeZone,
  zonedDateParts,
  zonedDateTimeToInstant,
};
