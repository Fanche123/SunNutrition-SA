const PAYROLL_HOLIDAYS_BY_YEAR = Object.freeze({
  2026: Object.freeze([
    "2026-01-01",
    "2026-02-16",
    "2026-02-17",
    "2026-03-23",
    "2026-03-24",
    "2026-04-02",
    "2026-04-03",
    "2026-05-01",
    "2026-05-25",
    "2026-06-15",
    "2026-06-20",
    "2026-07-09",
    "2026-07-10",
    "2026-08-17",
    "2026-10-12",
    "2026-11-23",
    "2026-12-07",
    "2026-12-08",
    "2026-12-25"
  ])
});

function payrollCalendarForYear(year) {
  const dates = PAYROLL_HOLIDAYS_BY_YEAR[Number(year)];
  return dates ? { configured: true, dates: new Set(dates) } : { configured: false, dates: new Set() };
}

if (typeof module === "object" && module.exports) {
  module.exports = { PAYROLL_HOLIDAYS_BY_YEAR, payrollCalendarForYear };
}
