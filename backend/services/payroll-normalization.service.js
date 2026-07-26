function createPayrollNormalizationService(dependencies) {
  const { backendId, backendIsoDate, backendNextNumericId, creditorOriginTypeKey, ensureBackendTable, expectedBackendColumns } = dependencies;

  function mergePayrollCalculationRowsIntoSalaries(cache) {
    const tables = cache.tables || {};
    const calculationTable = tables.sueldos_calculo;
  
    if (!calculationTable) return;
    ensureBackendTable(tables, "sueldos");
  
    const legacySalaryRows = tables.sueldos.rows || [];
    const calculationRows = (calculationTable.rows || []).map(normalizePayrollCalculationRow);
    const calculationKeys = new Set(calculationRows.map(payrollMonthEmployeeKey).filter(Boolean));
  
    calculationRows.forEach((calculationRow) => {
      const matchingLegacySalary = legacySalaryRows.find((salaryRow) => payrollRowsReferToSameSalary(salaryRow, calculationRow));
      if (matchingLegacySalary) fillBlankPayrollFields(calculationRow, matchingLegacySalary);
    });
  
    const unmatchedLegacyRows = legacySalaryRows
      .filter((salaryRow) => !calculationKeys.has(payrollMonthEmployeeKey(salaryRow)))
      .map(normalizePayrollCalculationRow);
    const mergedSalaryRows = [...calculationRows, ...unmatchedLegacyRows];
  
    tables.sueldos.headers = expectedBackendColumns.sueldos;
    tables.sueldos.rows = mergedSalaryRows;
    tables.sueldos.rowCount = mergedSalaryRows.length;
    tables.sueldos.source = {
      ...(tables.sueldos.source || {}),
      mergedFrom: ["Sueldos.xlsx · Calculo"]
    };
  
    // Calculo se usa como insumo interno para completar Sueldos. Borrarlo de la cache evita
    // que aparezca como una segunda tabla en el mapa, editor o consola SQL.
    delete tables.sueldos_calculo;
  }
  
  function normalizePayrollCalculationRow(row) {
    const normalized = {};
    expectedBackendColumns.sueldos.forEach((column) => {
      normalized[column] = row[column] ?? "";
    });
    normalized._rowNumber = row._rowNumber;
    normalized._empleado_nombre = row._empleado_nombre || "";
    normalized._etiqueta_gasto = row._etiqueta_gasto || "Sueldos";
    normalized._tipo_factura = row._tipo_factura || "Recibo_Sueldo";
    normalized._nro_factura = row._nro_factura || "";
    normalized._neto = row._neto || row.sueldo_neto || "";
    return normalized;
  }
  
  function payrollRowsReferToSameSalary(left, right) {
    const leftMonthEmployee = payrollMonthEmployeeKey(left);
    const rightMonthEmployee = payrollMonthEmployeeKey(right);
    if (!leftMonthEmployee || leftMonthEmployee !== rightMonthEmployee) return false;
    const leftEmployee = backendId(left?.id_empleado);
    const rightEmployee = backendId(right?.id_empleado);
    return Boolean(leftEmployee && rightEmployee);
  }
  
  function payrollMonthEmployeeKey(row) {
    const date = backendIsoDate(row?.fecha);
    const employeeId = backendId(row?.id_empleado);
    if (!date || !employeeId) return "";
    return `${date.slice(0, 7)}|${employeeId}`;
  }
  
  function fillBlankPayrollFields(target, source) {
    expectedBackendColumns.sueldos.forEach((column) => {
      if (target[column] === "" || target[column] === null || target[column] === undefined) {
        target[column] = source[column] ?? "";
      }
    });
    ["_empleado_nombre", "_etiqueta_gasto", "_tipo_factura", "_nro_factura", "_neto"].forEach((column) => {
      if (!target[column] && source[column]) target[column] = source[column];
    });
  }
  
  function assignPayrollCreditorTags(cache) {
    const tables = cache.tables || {};
    const salaries = tables.sueldos?.rows || [];
    if (!salaries.length) return;
  
    const creditorIdByEmployeeId = new Map();
    (tables.acreedores?.rows || []).forEach((creditor) => {
      if (creditorOriginTypeKey(creditor.origen_tipo_acreedor) !== "empleado") return;
      const employeeId = backendId(creditor.origen_id_acreedor);
      const creditorId = backendId(creditor.id_acreedor);
      if (employeeId && creditorId && !creditorIdByEmployeeId.has(employeeId)) {
        creditorIdByEmployeeId.set(employeeId, creditorId);
      }
    });
  
    const firstCreditorTagByCreditorId = new Map();
    (tables.acreedores_etiquetas?.rows || []).forEach((relation) => {
      const creditorId = backendId(relation.id_acreedor);
      const creditorTagId = backendId(relation.id_acreedor_etiqueta);
      if (creditorId && creditorTagId && !firstCreditorTagByCreditorId.has(creditorId)) {
        firstCreditorTagByCreditorId.set(creditorId, creditorTagId);
      }
    });
  
    salaries.forEach((salary) => {
      if (backendId(salary.id_acreedor_etiqueta)) return;
      const employeeId = backendId(salary.id_empleado);
      const creditorId = creditorIdByEmployeeId.get(employeeId);
      const creditorTagId = firstCreditorTagByCreditorId.get(creditorId);
      if (creditorTagId) salary.id_acreedor_etiqueta = creditorTagId;
    });
  }
  
  function sortBackendSalaryRows(cache) {
    const salaries = cache.tables?.sueldos?.rows;
    if (!Array.isArray(salaries)) return;
  
    salaries.sort((left, right) => {
      const leftId = Number(backendId(left.id_sueldo));
      const rightId = Number(backendId(right.id_sueldo));
      if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
      if (Number.isFinite(leftId) && !Number.isFinite(rightId)) return -1;
      if (!Number.isFinite(leftId) && Number.isFinite(rightId)) return 1;
      return backendIsoDate(left.fecha).localeCompare(backendIsoDate(right.fecha))
        || backendId(left.id_empleado).localeCompare(backendId(right.id_empleado));
    });
  }
  
  function ensureUniqueBackendSalaryIds(cache) {
    const salaries = cache.tables?.sueldos?.rows;
    if (!Array.isArray(salaries)) return;
  
    const usedIds = new Set();
    let nextId = backendNextNumericId(salaries, "id_sueldo");
    salaries.forEach((salary) => {
      const id = backendId(salary.id_sueldo);
      if (id && !usedIds.has(id)) {
        usedIds.add(id);
        return;
      }
  
      while (usedIds.has(String(nextId))) nextId += 1;
      salary.id_sueldo = nextId;
      usedIds.add(String(nextId));
      nextId += 1;
    });
  }

  return { assignPayrollCreditorTags, ensureUniqueBackendSalaryIds, mergePayrollCalculationRowsIntoSalaries, sortBackendSalaryRows };
}

module.exports = { createPayrollNormalizationService };
