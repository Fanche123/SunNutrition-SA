const { fromCents, toCents } = require("../../shared/money");

function createPayrollSummaryService({ backendId, backendIsoDate, backendNumber }) {
  function backendPayrollSummary(rows, startIso, endIso) {
    const employees = new Map();
    let totalGrossCents = 0;
  
    rows.forEach((row) => {
      const date = backendIsoDate(row.fecha);
      if (date < startIso || date > endIso) return;
  
      const employee = backendId(row.id_empleado) || "Sin empleado";
      if (!employees.has(employee)) {
        employees.set(employee, {
          employee,
          date,
          workedHours: 0,
          extraHours: 0,
          totalHours: 0
        });
      }
  
      const workedHours = backendNumber(row.hs_trabajadas);
      const extraHours = backendNumber(row.hs_extra);
      const summary = employees.get(employee);
      summary.workedHours += workedHours;
      summary.extraHours += extraHours;
      summary.totalHours += workedHours + extraHours;
      totalGrossCents += toCents(backendNumber(row.sueldo_bruto));
    });
  
    const summaryRows = [...employees.values()]
      .filter((row) => row.totalHours > 0)
      .sort((left, right) => right.totalHours - left.totalHours || String(left.employee).localeCompare(String(right.employee)));
  
    return {
      rows: summaryRows,
      employeeCount: summaryRows.length,
      totalHours: summaryRows.reduce((total, row) => total + row.totalHours, 0),
      totalGross: fromCents(totalGrossCents)
    };
  }

  return backendPayrollSummary;
}

module.exports = { createPayrollSummaryService };
