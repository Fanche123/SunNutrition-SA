const { fromCents, toCents } = require("../../shared/money");
const { strictMoneyToCents } = require("../utils/money-input");

function createPayrollExpenseEntryService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  failureInjector = () => {}
}) {
  async function handlePayrollExpenseEntry(request, response) {
    try {
      const body = await readJsonBody(request);
      const salaryIds = uniqueIds(body.salaryIds);
      const expense = body.expense || {};
      const concepts = Array.isArray(body.concepts) ? body.concepts : [];
      validatePayload(salaryIds, expense, concepts);

      const cache = JSON.parse(JSON.stringify(loadCache()));
      cache.tables ||= {};
      ["sueldos", "egresos", "acreedores_etiquetas", "etiquetas"].forEach((name) => ensureBackendTable(cache.tables, name));

      const salariesById = new Map(cache.tables.sueldos.rows.map((row) => [backendId(row.id_sueldo), row]));
      const selectedSalaries = salaryIds.map((id) => salariesById.get(id));
      if (selectedSalaries.some((row) => !row)) {
        return sendJson(response, 409, { ok: false, error: "Una liquidacion seleccionada ya no existe." });
      }
      const labelExists = cache.tables.etiquetas.rows.some((row) => backendId(row.id_etiqueta) === backendId(expense.id_etiqueta));
      if (!labelExists) return sendJson(response, 409, { ok: false, error: "La etiqueta del egreso ya no existe." });
      const creditorTagIds = new Set(cache.tables.acreedores_etiquetas.rows.map((row) => backendId(row.id_acreedor_etiqueta)));
      if (selectedSalaries.some((row) => !creditorTagIds.has(backendId(row.id_acreedor_etiqueta)))) {
        return sendJson(response, 409, { ok: false, error: "Una liquidacion no tiene una relacion de acreedor vigente." });
      }

      validateSalaryAmounts(selectedSalaries, concepts, expense);
      const linkedExpenseIds = new Set(selectedSalaries.map((row) => backendId(row.id_egreso)).filter(Boolean));
      if (linkedExpenseIds.size > 1 || (linkedExpenseIds.size === 1 && selectedSalaries.some((row) => !backendId(row.id_egreso)))) {
        return sendJson(response, 409, { ok: false, error: "Las liquidaciones tienen una asociacion parcial o contradictoria." });
      }

      if (linkedExpenseIds.size === 1) {
        const expenseId = [...linkedExpenseIds][0];
        const existing = cache.tables.egresos.rows.find((row) => backendId(row.id_egreso) === expenseId);
        if (!existing || !sameExpense(existing, expense) || !sameSalarySet(cache.tables.sueldos.rows, expenseId, salaryIds)) {
          return sendJson(response, 409, { ok: false, error: "La operacion existente no coincide completamente con el pedido." });
        }
        return sendJson(response, 200, { ok: true, idempotent: true, financialCompleted: true, expenseId });
      }

      if (!salaryIds.length) {
        const matches = cache.tables.egresos.rows.filter((row) => sameExpense(row, expense));
        if (matches.length === 1) {
          return sendJson(response, 200, {
            ok: true,
            idempotent: true,
            financialCompleted: true,
            expenseId: backendId(matches[0].id_egreso)
          });
        }
        if (matches.length > 1) {
          return sendJson(response, 409, { ok: false, error: "Hay mas de un egreso coincidente y no puede resolverse el reintento." });
        }
      }

      failureInjector("before-mutation");
      const expenseId = backendNextNumericId(cache.tables.egresos.rows, "id_egreso");
      const timestamp = new Date().toISOString();
      cache.tables.egresos.rows.push({
        _rowNumber: cache.tables.egresos.rows.length + 2,
        id_egreso: expenseId,
        fecha_factura: expense.fecha_factura,
        fecha_prevista_pago: expense.fecha_prevista_pago || "",
        id_etiqueta: expense.id_etiqueta,
        tipo_factura: expense.tipo_factura,
        nro_factura: expense.nro_factura,
        iva: fromCents(strictMoneyToCents(expense.iva, { emptyAsZero: true })),
        per_ret_iva: fromCents(strictMoneyToCents(expense.per_ret_iva, { emptyAsZero: true })),
        per_ret_iibb: fromCents(strictMoneyToCents(expense.per_ret_iibb, { emptyAsZero: true })),
        imp_internos: fromCents(strictMoneyToCents(expense.imp_internos, { emptyAsZero: true })),
        subtotal: fromCents(strictMoneyToCents(expense.subtotal)),
        total: fromCents(strictMoneyToCents(expense.total)),
        _editedLocallyAt: timestamp
      });
      selectedSalaries.forEach((salary) => {
        salary.id_egreso = expenseId;
        salary._editedLocallyAt = timestamp;
      });
      failureInjector("after-association");
      cache.tables.egresos.rowCount = cache.tables.egresos.rows.length;
      cache.tables.sueldos.rowCount = cache.tables.sueldos.rows.length;
      cache.generatedAt = timestamp;
      saveBackendCache(cache);
      return sendJson(response, 200, { ok: true, idempotent: false, financialCompleted: true, expenseId });
    } catch (error) {
      return sendJson(response, 400, { ok: false, financialCompleted: false, error: `No se guardo el egreso salarial: ${error.message}` });
    }
  }

  function validatePayload(salaryIds, expense, concepts) {
    if (!concepts.length) throw new Error("No hay conceptos seleccionados.");
    if (!expense.fecha_factura || !expense.id_etiqueta || !expense.tipo_factura || !expense.nro_factura) {
      throw new Error("Fecha, etiqueta, tipo y numero de comprobante son obligatorios.");
    }
    if (
      strictMoneyToCents(expense.total) <= 0
      || strictMoneyToCents(expense.subtotal) <= 0
    ) throw new Error("Subtotal y total deben ser positivos.");
    const expectedTotalCents = [
      expense.subtotal,
      expense.iva,
      expense.per_ret_iva,
      expense.per_ret_iibb,
      expense.imp_internos
    ].reduce((sum, value, index) => (
      sum + strictMoneyToCents(value, { emptyAsZero: index > 0 })
    ), 0);
    if (expectedTotalCents !== strictMoneyToCents(expense.total)) {
      throw new Error("El total no coincide con subtotal e impuestos.");
    }
    const conceptSalaryIds = uniqueIds(concepts.filter((row) => row.type === "salary").map((row) => row.salaryId));
    if (conceptSalaryIds.length !== salaryIds.length || conceptSalaryIds.some((id, index) => id !== salaryIds[index])) {
      throw new Error("Los conceptos salariales no coinciden con las liquidaciones seleccionadas.");
    }
    if (concepts.some((row) => (
      !["salary", "labor-social", "labor-cooperative"].includes(row.type)
      || strictMoneyToCents(row.amount) <= 0
    ))) {
      throw new Error("Hay conceptos salariales invalidos.");
    }
  }

  function validateSalaryAmounts(selectedSalaries, concepts, expense) {
    const conceptBySalaryId = new Map(
      concepts.filter((row) => row.type === "salary").map((row) => [
        backendId(row.salaryId),
        strictMoneyToCents(row.amount)
      ])
    );
    selectedSalaries.forEach((salary) => {
      if (toCents(backendNumber(salary.sueldo_neto)) !== conceptBySalaryId.get(backendId(salary.id_sueldo))) {
        throw new Error(`El neto de la liquidacion ${backendId(salary.id_sueldo)} cambio.`);
      }
    });
    const conceptTotalCents = concepts.reduce(
      (sum, row) => sum + strictMoneyToCents(row.amount),
      0
    );
    if (conceptTotalCents !== strictMoneyToCents(expense.subtotal)) {
      throw new Error("El subtotal no coincide con los conceptos seleccionados.");
    }
  }

  function sameExpense(existing, expected) {
    const textFields = ["fecha_factura", "fecha_prevista_pago", "id_etiqueta", "tipo_factura", "nro_factura"];
    const moneyFields = ["iva", "per_ret_iva", "per_ret_iibb", "imp_internos", "subtotal", "total"];
    return textFields.every((field) => backendId(existing[field]) === backendId(expected[field]))
      && moneyFields.every((field) => (
        toCents(backendNumber(existing[field]))
          === strictMoneyToCents(expected[field], { emptyAsZero: true })
      ));
  }

  function sameSalarySet(salaries, expenseId, expectedIds) {
    const linkedIds = uniqueIds(
      salaries.filter((row) => backendId(row.id_egreso) === backendId(expenseId)).map((row) => row.id_sueldo)
    );
    return linkedIds.length === expectedIds.length && linkedIds.every((id, index) => id === expectedIds[index]);
  }

  function uniqueIds(values) {
    return [...new Set((values || []).map(backendId).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true })
    );
  }

  return { handlePayrollExpenseEntry };
}

module.exports = { createPayrollExpenseEntryService };
