import { describe, test, expect } from "@jest/globals";
import { toICS, DEFAULT_ALERTS } from "../src/ics.ts";
import type { SchoolEvent } from "../src/events.ts";

const event = (over: Partial<SchoolEvent> = {}): SchoolEvent => ({
  title: "Year 3 excursion",
  kind: "event",
  date: "2026-10-27",
  letterId: "letter.txt",
  id: "abc123",
  ...over,
});

// One VEVENT block, with folded lines joined back up.
const vevent = (e: SchoolEvent, opts?: Parameters<typeof toICS>[1]) =>
  toICS([e], opts).replace(/\r\n /g, "").split("BEGIN:VEVENT")[1].split("END:VEVENT")[0];

const triggers = (block: string) => [...block.matchAll(/TRIGGER:(\S+)/g)].map((m) => m[1]);

describe("toICS calendar structure", () => {
  test("wraps events in a VCALENDAR with CRLF line endings", () => {
    const ics = toICS([event()]);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/\n/);
  });

  test("still produces a valid calendar with no events", () => {
    const ics = toICS([]);
    expect(ics).toMatch(/BEGIN:VCALENDAR/);
    expect(ics).not.toMatch(/BEGIN:VEVENT/);
  });

  test("uses the calendar name option, escaped", () => {
    expect(toICS([])).toMatch(/X-WR-CALNAME:School letters\r\n/);
    expect(toICS([], { name: "Kids, school; 2026" })).toMatch(/X-WR-CALNAME:Kids\\, school\\; 2026\r\n/);
  });

  test("gives each event a stable UID from its id", () => {
    expect(vevent(event({ id: "f00d" }))).toMatch(/UID:f00d@school-letters-rag/);
  });

  test("marks events as free time, not busy", () => {
    expect(vevent(event())).toMatch(/TRANSP:TRANSPARENT/);
  });
});

describe("toICS dates and times", () => {
  test("all-day event ends the next day (DTEND is exclusive)", () => {
    const v = vevent(event());
    expect(v).toMatch(/DTSTART;VALUE=DATE:20261027/);
    expect(v).toMatch(/DTEND;VALUE=DATE:20261028/);
  });

  test("multi-day all-day event ends the day after its last day, across a month boundary", () => {
    const v = vevent(event({ date: "2026-10-30", endDate: "2026-11-02" }));
    expect(v).toMatch(/DTSTART;VALUE=DATE:20261030/);
    expect(v).toMatch(/DTEND;VALUE=DATE:20261103/);
  });

  test("ignores an endDate that is before the start date", () => {
    expect(vevent(event({ endDate: "2026-10-01" }))).toMatch(/DTEND;VALUE=DATE:20261028/);
  });

  test("timed event uses floating local times", () => {
    const v = vevent(event({ startTime: "09:00", endTime: "14:45" }));
    expect(v).toMatch(/DTSTART:20261027T090000\r\n/);
    expect(v).toMatch(/DTEND:20261027T144500\r\n/);
  });

  test("timed event without an end time lasts one hour", () => {
    expect(vevent(event({ startTime: "09:15" }))).toMatch(/DTEND:20261027T101500/);
  });

  test("one-hour default never runs past midnight", () => {
    expect(vevent(event({ startTime: "23:30" }))).toMatch(/DTEND:20261027T235900/);
  });

  test("timed multi-day event ends on its endDate", () => {
    expect(vevent(event({ startTime: "08:00", endTime: "15:00", endDate: "2026-10-29" }))).toMatch(/DTEND:20261029T150000/);
  });
});

describe("toICS text fields", () => {
  test("prefixes deadlines with 'Due:'", () => {
    expect(vevent(event({ kind: "deadline", title: "Permission slip" }))).toMatch(/SUMMARY:Due: Permission slip/);
  });

  test("escapes commas, semicolons and backslashes", () => {
    expect(vevent(event({ title: "Hat, water; lunch \\ snacks" }))).toMatch(/SUMMARY:Hat\\, water\\; lunch \\\\ snacks\r\n/);
  });

  test("includes location only when present", () => {
    expect(vevent(event({ location: "Melbourne Museum" }))).toMatch(/LOCATION:Melbourne Museum/);
    expect(vevent(event())).not.toMatch(/LOCATION:/);
  });

  test("description lists actions, notes and the source letter, with escaped newlines", () => {
    const v = vevent(event({ actions: ["Pay $28", "Return slip"], notes: "Year 3 only" }));
    expect(v).toMatch(/DESCRIPTION:To do:\\n- Pay \$28\\n- Return slip\\n\\nYear 3 only\\n\\nFrom letter: letter\.txt/);
  });

  test("folds long lines at 75 bytes without splitting multi-byte characters", () => {
    const title = "Fête de l'école 🎉 ".repeat(10).trim();
    const ics = toICS([event({ title })]);
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics).not.toMatch(/�/);
    expect(ics.replace(/\r\n /g, "")).toContain(`SUMMARY:${title.replace(/,/g, "\\,")}`);
  });
});

describe("toICS alerts", () => {
  test("all-day event: 6pm the evening before", () => {
    expect(triggers(vevent(event()))).toEqual(["-PT6H"]);
  });

  test("all-day deadline: 6pm three evenings before, and 8am on the day", () => {
    expect(triggers(vevent(event({ kind: "deadline" })))).toEqual(["-P2DT6H", "PT8H"]);
  });

  test("timed event: still 6pm the evening before", () => {
    expect(triggers(vevent(event({ startTime: "09:00" })))).toEqual(["-PT15H"]);
    expect(triggers(vevent(event({ startTime: "23:00" })))).toEqual(["-P1DT5H"]);
    expect(triggers(vevent(event({ startTime: "09:20" })))).toEqual(["-PT15H20M"]);
  });

  test("timed event: an alert after the start is moved to 30 minutes before", () => {
    // The deadline's "8am on the day" would be after a 7:30am start.
    expect(triggers(vevent(event({ kind: "deadline", startTime: "07:30" })))).toEqual(["-P2DT13H30M", "-PT30M"]);
  });

  test("custom alert rules replace the defaults", () => {
    const alerts = { ...DEFAULT_ALERTS, event: [0, 1440] };
    expect(triggers(vevent(event(), { alerts }))).toEqual(["PT0M", "-P1D"]);
  });

  test("alarm text matches the summary", () => {
    expect(vevent(event({ kind: "deadline", title: "Slip" }))).toMatch(/BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Due: Slip\r\n/);
  });
});

describe("toICS cancelled entries", () => {
  const moved = event({ kind: "deadline", title: "Permission slip", cancelledBy: "update.txt" });

  test("are kept with STATUS:CANCELLED so calendars remove the old date", () => {
    const v = vevent(moved);
    expect(v).toMatch(/STATUS:CANCELLED/);
    expect(v).toMatch(/SUMMARY:Moved\/cancelled: Due: Permission slip/);
    expect(v).toMatch(/Superseded by letter: update\.txt/);
  });

  test("have no alarms", () => {
    expect(vevent(moved)).not.toMatch(/VALARM/);
  });

  test("active entries have no STATUS line", () => {
    expect(vevent(event())).not.toMatch(/STATUS:/);
  });
});
