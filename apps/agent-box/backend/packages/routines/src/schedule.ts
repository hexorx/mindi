export type { Schedule } from "./types.js";
import { CronExpressionParser } from "cron-parser";
import { invalid, plain, str, type Schedule } from "./types.js";
export function normalizeSchedule(schedule: Schedule): Schedule {
  plain(schedule, ["kind", "at", "minutes", "expression", "timezone"]);
  if (schedule.kind === "once") {
    plain(schedule, ["kind", "at"]);
    const at = str(schedule.at, "at", 30);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at))
      invalid("Invalid UTC timestamp");
    const date = new Date(at);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().replace(".000Z", "Z") !== at.replace(".000Z", "Z")
    )
      invalid("Invalid calendar date");
    return { kind: "once", at: date.toISOString() };
  }
  if (schedule.kind === "interval") {
    plain(schedule, ["kind", "minutes"]);
    if (
      !Number.isInteger(schedule.minutes) ||
      schedule.minutes < 1 ||
      schedule.minutes > 525600
    )
      invalid("Invalid interval minutes");
    return { kind: "interval", minutes: schedule.minutes };
  }
  if (schedule.kind !== "cron") invalid("Invalid schedule kind");
  plain(schedule, ["kind", "expression", "timezone"]);
  const expression = str(schedule.expression, "expression", 200)
    .trim()
    .replace(/\s+/g, " ");
  const timezone = str(schedule.timezone, "timezone", 100);
  if (expression.split(" ").length !== 5 || /\bH\b/i.test(expression))
    invalid("Expected deterministic five-field cron");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: 0,
    }).next();
  } catch {
    invalid("Invalid cron schedule");
  }
  return { kind: "cron", expression, timezone };
}
export function nextRunAt(
  schedule: Schedule,
  now: number,
  anchor?: number,
): number | null {
  if (schedule.kind === "once") return Date.parse(schedule.at);
  if (schedule.kind === "interval") {
    const step = schedule.minutes * 60000;
    return anchor === undefined
      ? now + step
      : anchor + (Math.floor((now - anchor) / step) + 1) * step;
  }
  try {
    return CronExpressionParser.parse(schedule.expression, {
      tz: schedule.timezone,
      currentDate: now,
    })
      .next()
      .getTime();
  } catch {
    invalid("Cannot calculate next cron occurrence");
  }
}
