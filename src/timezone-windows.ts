export function assertValidPlainDate(
  day: string,
  label = "Invalid plain date"
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`${label}: ${day}`);
  }
  const [year, month, date] = day.split("-").map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, date, 0, 0, 0, 0));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() + 1 !== month ||
    utc.getUTCDate() !== date
  ) {
    throw new Error(`${label}: ${day}`);
  }
}

export function addDays(dayString: string, delta: number): string {
  assertValidPlainDate(dayString);
  const [year, month, day] = dayString.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day + delta, 0, 0, 0, 0));
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${String(
    date.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function getLocalDateKey(date: Date, timezone: string): string {
  return getZonedDayString(date, timezone);
}

export function getZonedDayString(date: Date, timezone: string): string {
  const { year, month, day } = getPartsInTimezone(date, timezone);
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function getLocalDayBounds(
  date: Date,
  timezone: string
): { start: Date; end: Date } {
  return getLocalDayBoundsForDateKey(getLocalDateKey(date, timezone), timezone);
}

export function getLocalDayBoundsForDateKey(
  dateKey: string,
  timezone: string
): { start: Date; end: Date } {
  assertValidPlainDate(dateKey, "Invalid date key");
  return {
    start: getUtcDateForZonedMidnight(dateKey, timezone),
    end: getUtcDateForZonedMidnight(addDays(dateKey, 1), timezone),
  };
}

export function getUtcDateForZonedMidnight(
  dayString: string,
  timezone: string
): Date {
  try {
    return localDateTimeToUtc(dayString, "00:00:00", timezone);
  } catch (error) {
    for (let minuteOfDay = 1; minuteOfDay < 24 * 60; minuteOfDay += 1) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
      try {
        return localDateTimeToUtc(dayString, time, timezone);
      } catch {
        // Day boundaries use the first representable instant on DST-skipped-midnight days.
      }
    }
    throw error;
  }
}

export function getUtcDateForZonedLocalTime(
  dayString: string,
  timezone: string,
  minutesAfterMidnight: number
): Date {
  if (
    !Number.isInteger(minutesAfterMidnight) ||
    minutesAfterMidnight < 0 ||
    minutesAfterMidnight > 24 * 60
  ) {
    throw new Error("Window bounds must be within the local day.");
  }
  if (minutesAfterMidnight === 24 * 60) {
    return getUtcDateForZonedMidnight(addDays(dayString, 1), timezone);
  }
  const hour = Math.floor(minutesAfterMidnight / 60);
  const minute = minutesAfterMidnight % 60;
  return localDateTimeToUtc(
    dayString,
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    timezone
  );
}

function getPartsInTimezone(
  date: Date,
  timezone: string
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return { year, month, day };
}

function localDateTimeToUtc(
  dateKey: string,
  time: string,
  timezone: string
): Date {
  assertValidPlainDate(dateKey);
  const [year, month, day] = dateKey
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const { hour, minute, second } = parseTimeParts(time);
  let candidate = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, 0)
  );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getZonedDateTimeParts(candidate, timezone);
    const deltaMs =
      Date.UTC(year, month - 1, day, hour, minute, second, 0) -
      Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        0
      );
    if (deltaMs === 0) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + deltaMs);
  }

  throw new Error(
    `Nonexistent local time ${dateKey} ${time} in timezone ${timezone}`
  );
}

function parseTimeParts(time: string): {
  hour: number;
  minute: number;
  second: number;
} {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new Error(`Invalid time: ${time}`);
  }
  const hour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  const second = Number.parseInt(match[3]!, 10);
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new Error(`Invalid time: ${time}`);
  }
  return { hour, minute, second };
}

function getZonedDateTimeParts(
  date: Date,
  timezone: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return normalizeZonedParts({
    year: Number.parseInt(lookup.get("year") ?? "0", 10),
    month: Number.parseInt(lookup.get("month") ?? "1", 10),
    day: Number.parseInt(lookup.get("day") ?? "1", 10),
    hour: Number.parseInt(lookup.get("hour") ?? "0", 10),
    minute: Number.parseInt(lookup.get("minute") ?? "0", 10),
    second: Number.parseInt(lookup.get("second") ?? "0", 10),
  });
}

function normalizeZonedParts(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  if (parts.hour !== 24) {
    return parts;
  }
  const rolled = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 0, parts.minute, parts.second)
  );
  rolled.setUTCDate(rolled.getUTCDate() + 1);
  return {
    year: rolled.getUTCFullYear(),
    month: rolled.getUTCMonth() + 1,
    day: rolled.getUTCDate(),
    hour: 0,
    minute: rolled.getUTCMinutes(),
    second: rolled.getUTCSeconds(),
  };
}
