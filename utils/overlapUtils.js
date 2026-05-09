import dayjs from "dayjs";

/**
 * Returns the first inspection that overlaps the given time range, or null.
 * excludeSk — skip this inspection (used when editing to ignore self).
 */
export function findOverlappingInspection(
  scheduledAt,
  apptLengthMinutes,
  allInspections,
  excludeSk = null,
) {
  const start = dayjs(scheduledAt);
  const end = start.add(apptLengthMinutes, "minute");

  for (const insp of Object.values(allInspections)) {
    if (!insp?.ScheduledAt) continue;
    if (excludeSk && insp.InspectionSk === excludeSk) continue;

    const iStart = dayjs(insp.ScheduledAt);
    const iEnd = iStart.add(apptLengthMinutes, "minute");

    // Overlap: start < iEnd && end > iStart
    if (start.isBefore(iEnd) && end.isAfter(iStart)) {
      return insp;
    }
  }

  return null;
}
