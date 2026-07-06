import { describe, expect, it } from "vitest";
import { findOverlappingInspection } from "../../utils/overlapUtils.js";

// Values are keyed by sk (as the app stores them); each carries ScheduledAt +
// InspectionSk. The new appointment starts at 10:00 and runs `len` minutes.
const NEW = "2026-07-05T10:00:00";
const LEN = 60;

const insp = (sk, at) => ({ InspectionSk: sk, ScheduledAt: at });

describe("findOverlappingInspection", () => {
  it("returns null when there are no inspections", () => {
    expect(findOverlappingInspection(NEW, LEN, {})).toBeNull();
  });

  it("returns null for a non-overlapping slot", () => {
    const all = { a: insp("a", "2026-07-05T08:00:00") }; // 08:00–09:00
    expect(findOverlappingInspection(NEW, LEN, all)).toBeNull();
  });

  it("detects an exact-time collision", () => {
    const all = { a: insp("a", "2026-07-05T10:00:00") };
    expect(findOverlappingInspection(NEW, LEN, all)?.InspectionSk).toBe("a");
  });

  it("detects a partial overlap", () => {
    const all = { a: insp("a", "2026-07-05T10:30:00") }; // 10:30–11:30 overlaps 10:00–11:00
    expect(findOverlappingInspection(NEW, LEN, all)?.InspectionSk).toBe("a");
  });

  it("treats a back-to-back slot as NOT overlapping", () => {
    const all = { a: insp("a", "2026-07-05T11:00:00") }; // starts exactly at new end
    expect(findOverlappingInspection(NEW, LEN, all)).toBeNull();
  });

  it("skips the excluded inspection (editing self)", () => {
    const all = { self: insp("self", "2026-07-05T10:00:00") };
    expect(findOverlappingInspection(NEW, LEN, all, "self")).toBeNull();
  });

  it("skips inspections without a ScheduledAt", () => {
    const all = { a: insp("a", null) };
    expect(findOverlappingInspection(NEW, LEN, all)).toBeNull();
  });

  it("returns the first overlapping inspection encountered", () => {
    const all = {
      a: insp("a", "2026-07-05T10:15:00"),
      b: insp("b", "2026-07-05T10:45:00"),
    };
    expect(findOverlappingInspection(NEW, LEN, all)?.InspectionSk).toBe("a");
  });
});
