// Shift timing rules, shared by the dashboard (app.js) and the Employee Portal (employee-app.js).
//
// Each employee has a default shift (employees/{uid}.shiftStart / shiftEnd, "HH:MM", 9-6 if unset).
// A single day can be overridden from the dashboard Calendar:
//   employees/{uid}.shiftOverrides["YYYY-MM-DD"] = { start, end }
// Kept on the employee document so the existing rules (staff write, employee reads own) already apply.

const DEFAULT_SHIFT = { start: "09:00", end: "18:00" };

// A completed day counts as a Full Day when the hours worked are at most this far below the shift
// length, and a Half Day when at least half the shift was worked. Less than that is a Short Day.
const FULL_DAY_TOLERANCE_MINS = 60;

function formatTimeAmPm(timeString) {
  if (!timeString) return "";
  const [hStr, mStr] = String(timeString).split(":");
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return "";
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  // Digits only: the result is inserted into HTML by several callers.
  const minutes = String(mStr || "").replace(/\D/g, "").slice(0, 2).padStart(2, "0");
  return `${h}:${minutes} ${period}`;
}

function validShiftTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function toMinutes(timeString) {
  if (!timeString) return null;
  const [h, m] = String(timeString).split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

function employeeDefaultShift(employee) {
  if (employee && validShiftTime(employee.shiftStart) && validShiftTime(employee.shiftEnd)) {
    return { start: employee.shiftStart, end: employee.shiftEnd };
  }
  return { ...DEFAULT_SHIFT };
}

function shiftForEmployee(employee, dateKey) {
  const overrides = employee && typeof employee.shiftOverrides === "object" ? employee.shiftOverrides : null;
  const override = overrides && dateKey ? overrides[dateKey] : null;
  if (override && validShiftTime(override.start) && validShiftTime(override.end)) {
    return { start: override.start, end: override.end, custom: true };
  }
  return { ...employeeDefaultShift(employee), custom: false };
}

function formatShift(shift) {
  return `${formatTimeAmPm(shift.start)} - ${formatTimeAmPm(shift.end)}`;
}

function shiftLengthMins(shift) {
  const s = toMinutes(shift.start);
  let e = toMinutes(shift.end);
  if (s === null || e === null) return 0;
  if (e <= s) e += 24 * 60;
  return e - s;
}

function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m} min`;
}

// Compare a record's check-in / check-out with the shift for that day, to the minute.
function shiftTiming(record, shift) {
  const result = { lateMins: 0, earlyArrivalMins: 0, earlyLeaveMins: 0, overtimeMins: 0, hasIn: false, hasOut: false };
  const startM = toMinutes(shift.start);
  let endM = toMinutes(shift.end);
  if (startM === null || endM === null) return result;
  if (endM <= startM) endM += 24 * 60; // overnight shift

  const inM = toMinutes(record?.checkIn);
  if (inM !== null) {
    result.hasIn = true;
    if (inM > startM) result.lateMins = inM - startM;
    else result.earlyArrivalMins = startM - inM;
  }
  let outM = toMinutes(record?.checkOut);
  if (outM !== null) {
    result.hasOut = true;
    if (outM < startM && endM > 24 * 60) outM += 24 * 60;
    if (outM < endM) result.earlyLeaveMins = endM - outM;
    else result.overtimeMins = outM - endM;
  }
  return result;
}

function inRemark(timing) {
  if (!timing.hasIn) return "";
  if (timing.lateMins > 0) return `${formatDuration(timing.lateMins)} late`;
  return "On time";
}

function outRemark(timing) {
  if (!timing.hasOut) return "";
  if (timing.earlyLeaveMins > 0) return `Left ${formatDuration(timing.earlyLeaveMins)} early`;
  if (timing.overtimeMins > 0) return `${formatDuration(timing.overtimeMins)} overtime`;
  return "Full shift";
}

function workedMins(record) {
  const inM = toMinutes(record?.checkIn);
  const outM = toMinutes(record?.checkOut);
  if (inM === null || outM === null) return 0;
  let mins = outM - inM;
  if (mins < 0) mins += 24 * 60;
  return mins;
}

// What kind of day this was, and how many minutes are deducted (late arrival + early leave).
//   type: "Full Day" | "Half Day" | "Short Day" | "Present" (still in) | "No Check-Out" (past day,
//         never checked out) | "Absent" (past day) | "Not In Yet" (today) | "" (future)
//   tone: a pill colour - "done" | "info" | "late" | "error" | ""
function dayType(record, shift, dateKey, today) {
  const timing = shiftTiming(record, shift);
  const deductionMins = timing.lateMins + timing.earlyLeaveMins;
  const base = { timing, deductionMins, workedMins: workedMins(record) };
  if (!record || !record.checkIn) {
    if (dateKey < today) return { ...base, type: "Absent", tone: "error" };
    if (dateKey === today) return { ...base, type: "Not In Yet", tone: "" };
    return { ...base, type: "", tone: "" };
  }
  if (!record.checkOut) {
    return dateKey < today
      ? { ...base, type: "No Check-Out", tone: "late" }
      : { ...base, type: "Present", tone: "info" };
  }
  const length = shiftLengthMins(shift);
  if (base.workedMins >= length - FULL_DAY_TOLERANCE_MINS) return { ...base, type: "Full Day", tone: "done" };
  if (base.workedMins >= length / 2) return { ...base, type: "Half Day", tone: "late" };
  return { ...base, type: "Short Day", tone: "error" };
}
