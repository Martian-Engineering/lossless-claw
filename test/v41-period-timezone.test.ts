/**
 * Wave-10 reviewer P1 regression: parsePeriodShortcut must compute
 * day-boundary periods in the operator's local timezone, not UTC.
 *
 * # Why this exists
 *
 * Previously the function anchored "today" / "yesterday" / etc at UTC
 * midnight. A Bangkok operator (UTC+7) at 02:00 local time asking
 * "yesterday" got UTC-yesterday — which is ~17 hours earlier than
 * local-yesterday. Operator scenarios like "what did we work on
 * yesterday?" must mean LOCAL yesterday.
 *
 * # What's tested
 *
 * The test fixes `nowMs` to a known instant where local-day and
 * UTC-day differ for both target timezones, and verifies the
 * returned (since, before) bounds are correct in the local frame.
 */

import { describe, expect, it } from "vitest";
import { parsePeriodShortcut } from "../src/tools/lcm-synthesize-around-tool.js";

describe("parsePeriodShortcut — local-timezone day boundaries (Wave-10 reviewer P1)", () => {
  // Anchor: 2026-05-07T02:00:00 in Bangkok = 2026-05-06T19:00:00 UTC.
  // At this moment:
  //   Bangkok local "today"     = 2026-05-07
  //   Bangkok local "yesterday" = 2026-05-06
  //   UTC          "today"     = 2026-05-06
  //   UTC          "yesterday" = 2026-05-05
  // So a Bangkok operator's "yesterday" must NOT be UTC's 2026-05-05.
  const bangkokNowUtcMs = Date.UTC(2026, 4, 6, 19, 0, 0);

  // Anchor: 2026-05-07T01:00:00 in Los Angeles (UTC-7 PDT) = 2026-05-07T08:00:00 UTC.
  // At this moment:
  //   LA local "today"     = 2026-05-07
  //   LA local "yesterday" = 2026-05-06
  //   UTC      "today"     = 2026-05-07 (matches LA today by coincidence)
  //   UTC      "yesterday" = 2026-05-06
  // We pick a different LA anchor: 23:00 PDT (LA's late evening, UTC's
  // already next day) so the LA-vs-UTC day differ.
  // 2026-05-07T23:00:00 in LA (UTC-7 PDT) = 2026-05-08T06:00:00 UTC.
  // Here:
  //   LA local "today"     = 2026-05-07
  //   LA local "yesterday" = 2026-05-06
  //   UTC      "today"     = 2026-05-08
  //   UTC      "yesterday" = 2026-05-07
  const laNowUtcMs = Date.UTC(2026, 4, 8, 6, 0, 0);

  // Helper: assert ISO date matches expected y/m/d (ignoring time-of-day).
  function assertIsoDate(date: Date, expectedYmd: string) {
    const iso = date.toISOString();
    expect(iso.startsWith(expectedYmd)).toBe(true);
  }

  it("Bangkok 'yesterday' returns local-yesterday (2026-05-06), NOT UTC-yesterday (2026-05-05)", () => {
    const r = parsePeriodShortcut("yesterday", {
      nowMs: bangkokNowUtcMs,
      timezone: "Asia/Bangkok",
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    // Bangkok local-yesterday = 2026-05-06 in Bangkok.
    // Bangkok 2026-05-06 00:00 = 2026-05-05T17:00:00 UTC.
    // Bangkok 2026-05-07 00:00 = 2026-05-06T17:00:00 UTC.
    expect(r.since.toISOString()).toBe("2026-05-05T17:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-06T17:00:00.000Z");
    expect(r.label).toBe("yesterday");
  });

  it("Bangkok 'today' returns local-today (2026-05-07)", () => {
    const r = parsePeriodShortcut("today", {
      nowMs: bangkokNowUtcMs,
      timezone: "Asia/Bangkok",
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.since.toISOString()).toBe("2026-05-06T17:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-07T17:00:00.000Z");
  });

  it("Los Angeles 'yesterday' (PDT, UTC-7) at 23:00 local returns LA-yesterday (2026-05-06), NOT UTC-yesterday (2026-05-07)", () => {
    const r = parsePeriodShortcut("yesterday", {
      nowMs: laNowUtcMs,
      timezone: "America/Los_Angeles",
    });
    if ("error" in r) throw new Error(r.error);
    // LA 2026-05-06 00:00 PDT = 2026-05-06T07:00:00 UTC.
    // LA 2026-05-07 00:00 PDT = 2026-05-07T07:00:00 UTC.
    expect(r.since.toISOString()).toBe("2026-05-06T07:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-07T07:00:00.000Z");
    expect(r.label).toBe("yesterday");
  });

  it("UTC 'yesterday' returns UTC-yesterday (control case)", () => {
    const r = parsePeriodShortcut("yesterday", {
      nowMs: bangkokNowUtcMs,
      timezone: "UTC",
    });
    if ("error" in r) throw new Error(r.error);
    // UTC 2026-05-05 00:00 = 2026-05-05T00:00:00 UTC.
    expect(r.since.toISOString()).toBe("2026-05-05T00:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-06T00:00:00.000Z");
  });

  it("'last-7-days' is timezone-independent (now-anchored, not day-anchored)", () => {
    const rUtc = parsePeriodShortcut("last-7-days", {
      nowMs: bangkokNowUtcMs,
      timezone: "UTC",
    });
    const rBkk = parsePeriodShortcut("last-7-days", {
      nowMs: bangkokNowUtcMs,
      timezone: "Asia/Bangkok",
    });
    if ("error" in rUtc) throw new Error(rUtc.error);
    if ("error" in rBkk) throw new Error(rBkk.error);
    expect(rUtc.since.toISOString()).toBe(rBkk.since.toISOString());
    expect(rUtc.before.toISOString()).toBe(rBkk.before.toISOString());
  });

  it("'last-12h' is timezone-independent (now-anchored)", () => {
    const r = parsePeriodShortcut("last-12h", {
      nowMs: bangkokNowUtcMs,
      timezone: "Asia/Bangkok",
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.before.toISOString()).toBe("2026-05-06T19:00:00.000Z");
    expect(r.since.toISOString()).toBe("2026-05-06T07:00:00.000Z");
  });

  it("'this-month' uses local-month boundaries (Bangkok at month start)", () => {
    // Bangkok 2026-05-01 00:01:00 BKK = 2026-04-30T17:01:00 UTC.
    const justAfterMonthStartBkk = Date.UTC(2026, 3, 30, 17, 1, 0);
    const r = parsePeriodShortcut("this-month", {
      nowMs: justAfterMonthStartBkk,
      timezone: "Asia/Bangkok",
    });
    if ("error" in r) throw new Error(r.error);
    // Bangkok May 2026 starts at Bangkok 2026-05-01 00:00 = 2026-04-30T17:00 UTC.
    expect(r.since.toISOString()).toBe("2026-04-30T17:00:00.000Z");
    // Bangkok June 2026 starts at Bangkok 2026-06-01 00:00 = 2026-05-31T17:00 UTC.
    expect(r.before.toISOString()).toBe("2026-05-31T17:00:00.000Z");
  });

  it("Invalid timezone falls back to UTC gracefully (no crash)", () => {
    const r = parsePeriodShortcut("yesterday", {
      nowMs: bangkokNowUtcMs,
      timezone: "Not/A/Timezone",
    });
    if ("error" in r) throw new Error(r.error);
    // Should fall back to UTC behavior.
    expect(r.since.toISOString()).toBe("2026-05-05T00:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-06T00:00:00.000Z");
  });
});

// ────────────────────────────────────────────────────────────────────
// Wave-11 reviewer P1: half-hour offsets + DST robustness
// ────────────────────────────────────────────────────────────────────

describe("parsePeriodShortcut — fractional-offset + DST robustness (Wave-11 reviewer P1)", () => {
  it("Asia/Kolkata 'yesterday' (UTC+5:30) returns local-yesterday boundaries", () => {
    // 2026-05-07 02:00 IST = 2026-05-06 20:30 UTC.
    // Kolkata local "yesterday" = 2026-05-06 (00:00-23:59 IST).
    // Kolkata 2026-05-06 00:00 IST = 2026-05-05 18:30 UTC.
    // Kolkata 2026-05-07 00:00 IST = 2026-05-06 18:30 UTC.
    const r = parsePeriodShortcut("yesterday", {
      nowMs: Date.UTC(2026, 4, 6, 20, 30, 0),
      timezone: "Asia/Kolkata",
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.since.toISOString()).toBe("2026-05-05T18:30:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-06T18:30:00.000Z");
  });

  it("Asia/Kathmandu 'today' (UTC+5:45) handles 15-minute offsets", () => {
    // 2026-05-07 06:00 NPT = 2026-05-07 00:15 UTC.
    // Kathmandu local "today" = 2026-05-07 (00:00-23:59 NPT).
    // Kathmandu 2026-05-07 00:00 NPT = 2026-05-06 18:15 UTC.
    const r = parsePeriodShortcut("today", {
      nowMs: Date.UTC(2026, 4, 7, 0, 15, 0),
      timezone: "Asia/Kathmandu",
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.since.toISOString()).toBe("2026-05-06T18:15:00.000Z");
    // "today" duration in Kathmandu (no DST) is exactly 24h.
    expect(r.before.toISOString()).toBe("2026-05-07T18:15:00.000Z");
  });

  it("America/Los_Angeles spring-forward day: 'today' duration is 23h", () => {
    // US DST 2026 starts March 8 02:00 PST → 03:00 PDT (spring forward).
    // Local "today" on 2026-03-08 in LA is 23 hours: 00:00 PST to 00:00
    // PDT next day = 23h elapsed UTC instead of 24h.
    // 2026-03-08 12:00 LA local = 2026-03-08 19:00 UTC (post-spring).
    const r = parsePeriodShortcut("today", {
      nowMs: Date.UTC(2026, 2, 8, 19, 0, 0),
      timezone: "America/Los_Angeles",
    });
    if ("error" in r) throw new Error(r.error);
    // LA 2026-03-08 00:00 PST = 2026-03-08 08:00 UTC (start of spring-forward day).
    expect(r.since.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    // LA 2026-03-09 00:00 PDT = 2026-03-09 07:00 UTC (next day start).
    expect(r.before.toISOString()).toBe("2026-03-09T07:00:00.000Z");
    // Verify duration is 23h.
    const durMs = r.before.getTime() - r.since.getTime();
    expect(durMs).toBe(23 * 60 * 60 * 1000);
  });
});
