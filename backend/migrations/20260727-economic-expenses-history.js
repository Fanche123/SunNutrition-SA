const crypto = require("crypto");
const { EXPECTED_BACKEND_COLUMNS } = require("../config/backend-columns");
const { backendId } = require("../utils/ids");
const { backendNextNumericId } = require("../utils/runtime");
const {
  fromCents,
  multiplyCents,
  normalize: normalizeMoney,
  percentageCents,
  toCents
} = require("../../shared/money");

const MIGRATION_ID = "20260727-economic-expenses-history";
const CUTOVER_DATE = "2026-04-01";
const ECONOMIC_TABLE = "gastos_economicos";
const APPLICATION_TABLE = "gastos_egresos";
const INTERNAL_TAX_SUBKEY = "impuestos_internos";

function migrateEconomicExpenseSchema(cache) {
  const migrated = clone(cache);
  migrated.tables ||= {};
  let changed = false;
  changed = ensureTable(migrated, ECONOMIC_TABLE) || changed;
  changed = ensureTable(migrated, APPLICATION_TABLE) || changed;

  const expenseTable = migrated.tables[ECONOMIC_TABLE];
  expenseTable.rows = expenseTable.rows.map((row) => {
    if (validIsoDate(row.fecha_economica) && !Object.hasOwn(row, "periodo_economico")) return row;
    const date = validIsoDate(row.fecha_economica) || sourceDateForExistingExpense(row, migrated.tables);
    if (!date) {
      throw migrationError(
        "ECONOMIC_EXPENSE_DATE_MISSING",
        `El gasto economico ${backendId(row.id_gasto_economico) || "(sin id)"} no tiene una fecha diaria canonica.`
      );
    }
    const migratedRow = { ...row, fecha_economica: date };
    delete migratedRow.periodo_economico;
    if (migratedRow.clave_idempotencia) {
      migratedRow.hash_payload = hashPayload(expensePayload(migratedRow));
    }
    changed = true;
    return migratedRow;
  });

  const expectedExpenseHeaders = EXPECTED_BACKEND_COLUMNS[ECONOMIC_TABLE];
  const expectedApplicationHeaders = EXPECTED_BACKEND_COLUMNS[APPLICATION_TABLE];
  if (JSON.stringify(expenseTable.headers || []) !== JSON.stringify(expectedExpenseHeaders)) {
    expenseTable.headers = [...expectedExpenseHeaders];
    changed = true;
  }
  if (JSON.stringify(migrated.tables[APPLICATION_TABLE].headers || []) !== JSON.stringify(expectedApplicationHeaders)) {
    migrated.tables[APPLICATION_TABLE].headers = [...expectedApplicationHeaders];
    changed = true;
  }
  expenseTable.rowCount = expenseTable.rows.length;
  migrated.tables[APPLICATION_TABLE].rowCount = migrated.tables[APPLICATION_TABLE].rows.length;

  return {
    cache: migrated,
    changed,
    report: {
      migrationId: MIGRATION_ID,
      action: "schema",
      changed,
      expenseRows: expenseTable.rows.length,
      applicationRows: migrated.tables[APPLICATION_TABLE].rows.length
    }
  };
}

function backfillHistoricalEconomicExpenses(cache, options = {}) {
  const cutoffDate = requiredDate(options.cutoffDate || CUTOVER_DATE, "ECONOMIC_EXPENSE_CUTOFF_INVALID");
  const throughDate = requiredDate(options.throughDate || currentBuenosAiresDate(), "ECONOMIC_EXPENSE_THROUGH_INVALID");
  if (throughDate < cutoffDate) {
    throw migrationError("ECONOMIC_EXPENSE_RANGE_INVALID", "La fecha final no puede ser anterior al corte.");
  }
  const timestamp = validTimestamp(options.now) || new Date().toISOString();
  const schema = migrateEconomicExpenseSchema(cache);
  const migrated = schema.cache;
  const tables = migrated.tables;
  const expenseTable = tables[ECONOMIC_TABLE];
  const applicationTable = tables[APPLICATION_TABLE];
  const context = buildContext(tables);
  const report = createReport(cutoffDate, throughDate, schema.changed);
  let changed = schema.changed;

  const reconcile = (producer, source, definition) => {
    const date = validIsoDate(definition.date);
    if (!date) return skip(report, producer, "fecha_economica_faltante");
    if (definition.enforceRange !== false && (date < cutoffDate || date > throughDate)) return;
    report.producers[producer].seenInRange += 1;
    const sourceId = backendId(definition.sourceId);
    if (!sourceId) return skip(report, producer, "origen_id_faltante");
    const tagId = backendId(definition.tagId);
    if (!tagId || !context.tagsById.has(tagId)) return skip(report, producer, "etiqueta_no_resuelta");

    const desiredCents = toCents(normalizeMoney(storedNumber(definition.amount)));
    const matching = expenseTable.rows.filter((row) => (
      clean(row.estado) === "confirmado"
      && normalizeText(row.origen_tipo) === normalizeText(producer)
      && backendId(row.origen_id) === sourceId
      && clean(row.origen_subclave) === definition.subkey
    ));
    const currentCents = matching.reduce((sum, row) => sum + toCents(storedNumber(row.importe)), 0);
    const differenceCents = desiredCents - currentCents;
    if (!differenceCents) {
      report.producers[producer].replayed += 1;
      return { differenceCents: 0, expense: matching.at(-1) || null };
    }

    const movementType = currentCents === 0
      ? "original"
      : desiredCents === 0
        ? "reversion"
        : "ajuste";
    const precedent = matching.at(-1);
    const key = producer === "egreso" && definition.subkey === INTERNAL_TAX_SUBKEY
      ? `${MIGRATION_ID}:${producer}:${sourceId}:${definition.subkey}:${date}:${tagId}:${desiredCents}`
      : `${MIGRATION_ID}:${producer}:${sourceId}:${definition.subkey}:${desiredCents}`;
    const payload = {
      fecha_economica: date,
      id_etiqueta: tagId,
      concepto: clean(definition.concept) || `${producer} #${sourceId}`,
      tipo_economico: definition.economicType,
      tipo_movimiento: movementType,
      importe: fromCents(differenceCents),
      estado: "confirmado",
      origen_tipo: producer,
      origen_id: sourceId,
      origen_subclave: definition.subkey,
      id_gasto_precedente: backendId(precedent?.id_gasto_economico),
      motivo: movementType === "original" ? "" : clean(definition.reason),
      clave_idempotencia: key
    };
    const payloadHash = hashPayload(payload);
    const existing = expenseTable.rows.find((row) => clean(row.clave_idempotencia) === key);
    if (existing) {
      if (clean(existing.hash_payload) !== payloadHash) {
        throw migrationError("ECONOMIC_EXPENSE_IDEMPOTENCY_CONFLICT", `La clave ${key} ya existe con otro payload.`);
      }
      report.producers[producer].replayed += 1;
      return { differenceCents: 0, expense: existing };
    }
    const expense = {
      _rowNumber: expenseTable.rows.length + 2,
      id_gasto_economico: backendNextNumericId(expenseTable.rows, "id_gasto_economico"),
      ...payload,
      hash_payload: payloadHash,
      creado_en: timestamp,
      actualizado_en: timestamp,
      confirmado_en: timestamp
    };
    expenseTable.rows.push(expense);
    report.producers[producer].inserted += 1;
    report.insertedExpenses += 1;
    changed = true;
    return { differenceCents, expense };
  };

  const insert = (producer, source, definition) => {
    const date = validIsoDate(definition.date);
    if (!date || date < cutoffDate || date > throughDate) return;
    report.producers[producer].seenInRange += 1;
    const sourceId = backendId(definition.sourceId);
    if (!sourceId) return skip(report, producer, "origen_id_faltante");
    if (definition.skipReason) return skip(report, producer, definition.skipReason);
    let tagId = backendId(definition.tagId);
    if (!tagId) {
      if (definition.directTag) return skip(report, producer, "etiqueta_no_resuelta");
      if (!definition.creditorTagId) return skip(report, producer, "vinculo_etiqueta_faltante");
      const relation = context.creditorTagsById.get(backendId(definition.creditorTagId));
      tagId = backendId(relation?.id_etiqueta);
    }
    if (!tagId || !context.tagsById.has(tagId)) return skip(report, producer, "etiqueta_no_resuelta");
    if (definition.requiresUniqueExpense && definition.expenseSourceCount > 1) {
      return skip(report, producer, "egreso_compartido_sin_asignacion");
    }
    const normalizedTag = normalizeText(context.tagsById.get(tagId)?.etiqueta);
    if (normalizedTag === "iva") {
      return skip(report, producer, "iva_no_resultado");
    }
    if (definition.excludeGrossRevenueTax && normalizedTag === "ingresos brutos") {
      return skip(report, producer, "iibb_calculado_por_ventas");
    }
    const amount = normalizeMoney(storedNumber(definition.amount));
    if (!toCents(amount)) return skip(report, producer, "subtotal_economico_faltante");

    const key = `${MIGRATION_ID}:${producer}:${sourceId}:${definition.subkey}`;
    const payload = {
      fecha_economica: date,
      id_etiqueta: tagId,
      concepto: clean(definition.concept) || `${producer} #${sourceId}`,
      tipo_economico: definition.economicType,
      tipo_movimiento: "original",
      importe: amount,
      estado: "confirmado",
      origen_tipo: producer,
      origen_id: sourceId,
      origen_subclave: definition.subkey,
      id_gasto_precedente: "",
      motivo: "",
      clave_idempotencia: key
    };
    const payloadHash = hashPayload(payload);
    const existing = findExistingExpense(expenseTable.rows, payload, key, payloadHash);
    let expense = existing;
    if (existing) {
      report.producers[producer].replayed += 1;
    } else {
      expense = {
        _rowNumber: expenseTable.rows.length + 2,
        id_gasto_economico: backendNextNumericId(expenseTable.rows, "id_gasto_economico"),
        ...payload,
        hash_payload: payloadHash,
        creado_en: timestamp,
        actualizado_en: timestamp,
        confirmado_en: timestamp
      };
      expenseTable.rows.push(expense);
      report.producers[producer].inserted += 1;
      report.insertedExpenses += 1;
      changed = true;
    }

    const expenseId = backendId(definition.expenseId);
    if (!definition.createApplication) {
      if (expenseId) skipApplication(report, producer, definition.applicationSkipReason || "aplicacion_no_definida");
      return;
    }
    if (!expenseId) return skipApplication(report, producer, "egreso_faltante");
    if (!context.expensesById.has(expenseId)) return skipApplication(report, producer, "egreso_inexistente");

    const applicationPayload = {
      id_gasto_economico: backendId(expense.id_gasto_economico),
      id_egreso: expenseId,
      importe_aplicado: amount,
      componente_egreso: definition.component || "base_subtotal",
      componente_otro: "",
      tipo_aplicacion: "original",
      estado: "vigente",
      id_aplicacion_precedente: "",
      motivo: "",
      clave_idempotencia: `${key}:egreso:${expenseId}`
    };
    const applicationHash = hashPayload(applicationPayload);
    const existingApplication = findExistingApplication(
      applicationTable.rows,
      applicationPayload,
      applicationHash
    );
    if (existingApplication) {
      report.replayedApplications += 1;
      return;
    }
    if (!applicationHasCapacity(applicationTable.rows, context, applicationPayload)) {
      return skipApplication(report, producer, "componente_sobreaplicado");
    }
    applicationTable.rows.push({
      _rowNumber: applicationTable.rows.length + 2,
      id_gasto_egreso: backendNextNumericId(applicationTable.rows, "id_gasto_egreso"),
      ...applicationPayload,
      hash_payload: applicationHash,
      creado_en: timestamp
    });
    report.insertedApplications += 1;
    changed = true;
  };

  const receptionExpenseCounts = countById(tables.recepciones?.rows, "id_egreso");
  const otherExpenseCounts = countById(tables.otros_gastos?.rows, "id_egreso");
  const deliveryExpenseCounts = countById(tables.entregas?.rows, "id_egreso");

  const internalTaxesTagId = tagIdByName(context, "Impuestos Internos");
  (tables.egresos?.rows || []).forEach((row) => {
    const sourceId = backendId(row.id_egreso);
    const internalTaxCents = toCents(normalizeMoney(storedNumber(row.imp_internos)));
    const existingRows = expenseTable.rows.filter((expense) => (
      clean(expense.estado) === "confirmado"
      && normalizeText(expense.origen_tipo) === "egreso"
      && backendId(expense.origen_id) === sourceId
      && clean(expense.origen_subclave) === INTERNAL_TAX_SUBKEY
    ));
    if (!internalTaxCents && !existingRows.length) return;
    const date = validIsoDate(row.fecha_factura) || validIsoDate(existingRows.at(-1)?.fecha_economica);
    if (!date) {
      report.producers.egreso.seenInRange += 1;
      return skip(report, "egreso", "fecha_factura_faltante");
    }
    if (internalTaxCents && internalTaxMayAlreadyBeMaterialized(row, applicationTable.rows, expenseTable.rows)) {
      report.producers.egreso.seenInRange += 1;
      return skip(report, "egreso", "posible_doble_contabilizacion");
    }
    const latest = existingRows.at(-1);
    if (
      internalTaxCents
      && existingRows.length
      && existingRows.reduce((sum, expense) => sum + toCents(storedNumber(expense.importe)), 0) === internalTaxCents
      && (
        validIsoDate(latest?.fecha_economica) !== date
        || backendId(latest?.id_etiqueta) !== backendId(internalTaxesTagId)
      )
    ) {
      reconcile("egreso", row, {
        date: validIsoDate(latest?.fecha_economica) || date,
        sourceId,
        tagId: latest?.id_etiqueta || internalTaxesTagId,
        amount: 0,
        concept: `Reversion impuestos internos egreso #${sourceId}`,
        economicType: "otro_definido",
        subkey: INTERNAL_TAX_SUBKEY,
        reason: "Cambio de fecha de factura o etiqueta canonica",
        enforceRange: false
      });
    }
    const outcome = reconcile("egreso", row, {
      date,
      sourceId,
      tagId: internalTaxesTagId,
      amount: fromCents(internalTaxCents),
      concept: `Impuestos internos egreso #${sourceId}`,
      economicType: "otro_definido",
      subkey: INTERNAL_TAX_SUBKEY,
      reason: internalTaxCents
        ? "Ajuste de impuestos internos del egreso"
        : "El impuesto interno del egreso fue anulado",
      enforceRange: internalTaxCents !== 0
    });
    if (!outcome?.expense || !outcome.differenceCents) return;
    const applicationPayload = {
      id_gasto_economico: backendId(outcome.expense.id_gasto_economico),
      id_egreso: sourceId,
      importe_aplicado: fromCents(Math.abs(outcome.differenceCents)),
      componente_egreso: "otro",
      componente_otro: INTERNAL_TAX_SUBKEY,
      tipo_aplicacion: outcome.differenceCents > 0 ? "original" : "reversion",
      estado: outcome.differenceCents > 0 ? "vigente" : "revertida",
      id_aplicacion_precedente: "",
      motivo: outcome.differenceCents > 0 ? "" : "Neutralizacion append-only de impuestos internos",
      clave_idempotencia: `${clean(outcome.expense.clave_idempotencia)}:egreso:${sourceId}`
    };
    const applicationHash = hashPayload(applicationPayload);
    if (findExistingApplication(applicationTable.rows, applicationPayload, applicationHash)) {
      report.replayedApplications += 1;
      return;
    }
    applicationTable.rows.push({
      _rowNumber: applicationTable.rows.length + 2,
      id_gasto_egreso: backendNextNumericId(applicationTable.rows, "id_gasto_egreso"),
      ...applicationPayload,
      hash_payload: applicationHash,
      creado_en: timestamp
    });
    report.insertedApplications += 1;
    changed = true;
  });

  (tables.recepciones?.rows || []).forEach((row) => {
    const linkedExpense = context.expensesById.get(backendId(row.id_egreso));
    insert("recepcion", row, {
      date: row.fecha_recepcion,
      sourceId: row.id_recepcion,
      creditorTagId: row.id_acreedor_etiqueta,
      amount: linkedExpense?.subtotal,
      concept: `Recepcion #${backendId(row.id_recepcion)}`,
      economicType: "mercaderia",
      subkey: "base_subtotal",
      expenseId: row.id_egreso,
      createApplication: true,
      requiresUniqueExpense: true,
      expenseSourceCount: receptionExpenseCounts.get(backendId(row.id_egreso)) || 0
    });
  });

  (tables.otros_gastos?.rows || []).forEach((row) => {
    const linkedExpense = context.expensesById.get(backendId(row.id_egreso));
    insert("otro_gasto", row, {
      date: row.fecha_otros_gastos,
      sourceId: row.id_otros_gastos,
      creditorTagId: row.id_acreedor_etiqueta || canonicalCreditorTagIdForCreditor(
        tables,
        row.id_acreedor,
        row._etiqueta_gasto
      ),
      amount: linkedExpense?.subtotal,
      concept: row.detalle || `Otro gasto #${backendId(row.id_otros_gastos)}`,
      economicType: "operativo",
      subkey: "base_subtotal",
      expenseId: row.id_egreso,
      createApplication: true,
      requiresUniqueExpense: true,
      expenseSourceCount: otherExpenseCounts.get(backendId(row.id_egreso)) || 0,
      excludeGrossRevenueTax: true
    });
  });

  (tables.entregas?.rows || []).forEach((row) => {
    const linkedExpense = context.expensesById.get(backendId(row.id_egreso));
    insert("logistica", row, {
      date: row.fecha,
      sourceId: row.id_entrega,
      creditorTagId: row.id_acreedor_etiqueta || canonicalCreditorTagId(
        tables,
        "flete",
        row.id_flete,
        "Logistica"
      ),
      amount: linkedExpense?.subtotal,
      concept: `Logistica #${backendId(row.id_entrega)}`,
      economicType: "operativo",
      subkey: "base_subtotal",
      expenseId: row.id_egreso,
      createApplication: true,
      requiresUniqueExpense: true,
      expenseSourceCount: deliveryExpenseCounts.get(backendId(row.id_egreso)) || 0
    });
  });

  const grossRevenueTaxTagId = tagIdByName(context, "Ingresos Brutos");
  (tables.ventas?.rows || []).forEach((row) => {
    const invoiceType = normalizeText(row.tipo_factura);
    if (invoiceType !== "factura a" && invoiceType !== "factura b") return;
    insert("ingresos_brutos", row, {
      date: row.fecha_factura,
      sourceId: row.id_venta,
      tagId: grossRevenueTaxTagId,
      directTag: true,
      amount: fromCents(percentageCents(storedNumber(row.subtotal), 1.5)),
      concept: `Ingresos Brutos venta #${backendId(row.id_venta)}`,
      economicType: "operativo",
      subkey: "subtotal_1_5",
      createApplication: false
    });
  });

  (tables.ventas?.rows || []).forEach((row) => {
    const client = context.clientsById.get(backendId(row.id_cliente));
    const channel = context.channelsById.get(backendId(client?.id_canal));
    const commissionRate = normalizedRate(channel?.comision);
    const creditorTagId = canonicalCreditorTagId(
      tables,
      "canal",
      channel?.id_canal,
      "Comisiones"
    );
    const skipReason = !client
      ? "cliente_no_resuelto"
      : !channel
        ? "canal_no_resuelto"
        : !commissionRate
          ? "tasa_comision_faltante"
          : !creditorTagId
            ? "vinculo_etiqueta_faltante"
            : "";
    insert("comision_venta", row, {
      date: row.fecha_factura,
      sourceId: row.id_venta,
      creditorTagId,
      skipReason,
      amount: fromCents(multiplyCents(storedNumber(row.subtotal), commissionRate)),
      concept: `Comision venta #${backendId(row.id_venta)}`,
      economicType: "operativo",
      subkey: "subtotal_por_canal",
      createApplication: false
    });
  });

  const salaryTagId = tagIdByName(context, "Sueldos");
  const duplicateSalaryOrigins = duplicateSalaryOriginsByCanonicalSource(
    tables.sueldos?.rows || [],
    cutoffDate,
    throughDate
  );
  (tables.sueldos?.rows || []).forEach((row) => {
    const sourceId = backendId(row.id_sueldo);
    const canonicalSourceId = duplicateSalaryOrigins.get(sourceId);
    if (canonicalSourceId) skip(report, "sueldo", "fuente_duplicada_empleado_periodo");
    reconcile("sueldo", row, {
      date: row.fecha,
      sourceId,
      tagId: salaryTagId,
      amount: canonicalSourceId ? 0 : row.sueldo_neto,
      concept: `Sueldo neto #${sourceId}`,
      economicType: "operativo",
      subkey: "sueldo_neto",
      reason: canonicalSourceId
        ? `Fuente duplicada del sueldo canonico #${canonicalSourceId}`
        : "El gasto salarial se reconoce por sueldo neto"
    });
    const grossRows = expenseTable.rows.filter((expense) => (
      clean(expense.estado) === "confirmado"
      && normalizeText(expense.origen_tipo) === "sueldo"
      && backendId(expense.origen_id) === sourceId
      && clean(expense.origen_subclave) === "sueldo_bruto"
    ));
    const grossCents = grossRows.reduce((sum, expense) => sum + toCents(storedNumber(expense.importe)), 0);
    if (grossCents) {
      reconcile("sueldo", row, {
        date: row.fecha,
        sourceId,
        tagId: salaryTagId,
        amount: 0,
        concept: `Reversion sueldo bruto #${sourceId}`,
        economicType: "operativo",
        subkey: "sueldo_bruto",
        reason: "Reemplazado por reconocimiento de sueldo neto"
      });
    }
  });

  const interestTagId = tagIdByName(context, "Intereses");
  (tables.cuotas_planes_pagos?.rows || []).forEach((row) => {
    const sourceId = backendId(row.id_cuota_plan_pago);
    const firstDueDate = validIsoDate(row.fecha_primer_vencimiento);
    if (!firstDueDate) return skip(report, "plan_pago", "fecha_economica_faltante");
    reconcile("plan_pago", row, {
      date: firstDueDate,
      sourceId,
      tagId: interestTagId,
      amount: row.interes_financiero,
      concept: `Interes financiero cuota #${sourceId}`,
      economicType: "interes_financiero",
      subkey: "interes_financiero",
      reason: "Ajuste del interes financiero de la cuota",
      enforceRange: false
    });

    const paymentInstance = quotaPaymentInstance(tables, row);
    if (paymentInstance === "ambigua") skip(report, "plan_pago", "instancia_pago_ambigua");
    reconcile("plan_pago", row, {
      date: paymentInstance === "segunda"
        ? quotaCompletionDate(tables, row)
        : firstDueDate,
      sourceId,
      tagId: interestTagId,
      amount: paymentInstance === "segunda" ? row.interes_resarcitorio : 0,
      concept: `Interes resarcitorio cuota #${sourceId}`,
      economicType: "interes_resarcitorio",
      subkey: "interes_resarcitorio",
      reason: paymentInstance === "segunda"
        ? "Cuota completada en segunda instancia"
        : "La evidencia de pago no valida una segunda instancia",
      enforceRange: false
    });
  });
  reverseRemovedOrigins({
    expenseTable,
    rows: tables.cuotas_planes_pagos?.rows,
    sourceColumn: "id_cuota_plan_pago",
    producer: "plan_pago",
    reconcile,
    reason: "La cuota de origen fue eliminada"
  });
  reverseRemovedOrigins({
    expenseTable,
    rows: tables.sueldos?.rows,
    sourceColumn: "id_sueldo",
    producer: "sueldo",
    reconcile,
    reason: "El sueldo de origen fue eliminado"
  });

  reverseSupersededOtherExpenseGrossRevenueTaxes({
    applicationTable,
    context,
    expenseTable,
    report,
    timestamp,
    onChange: () => {
      changed = true;
    }
  });

  report.exclusions.aportes_socios = countRowsInRange(
    tables.aportes_socios?.rows,
    (row) => row.fecha,
    cutoffDate,
    throughDate
  );
  report.exclusions.fondo_capital = (tables.fondos_inversion_movimientos?.rows || []).filter((row) => {
    const date = validIsoDate(row.fecha);
    return date >= cutoffDate
      && date <= throughDate
      && ["deposito", "rescate"].includes(normalizeText(row.tipo));
  }).length;

  if (changed) {
    expenseTable.headers = [...EXPECTED_BACKEND_COLUMNS[ECONOMIC_TABLE]];
    expenseTable.rowCount = expenseTable.rows.length;
    expenseTable.updatedAt = timestamp;
    applicationTable.headers = [...EXPECTED_BACKEND_COLUMNS[APPLICATION_TABLE]];
    applicationTable.rowCount = applicationTable.rows.length;
    applicationTable.updatedAt = timestamp;
    migrated.generatedAt = timestamp;
  }
  report.changed = changed;
  report.idempotent = !changed;
  report.expenseRows = expenseTable.rows.length;
  report.applicationRows = applicationTable.rows.length;
  return { cache: migrated, report };
}

function buildContext(tables) {
  return {
    tagsById: rowsById(tables.etiquetas?.rows, "id_etiqueta"),
    creditorTagsById: rowsById(tables.acreedores_etiquetas?.rows, "id_acreedor_etiqueta"),
    expensesById: rowsById(tables.egresos?.rows, "id_egreso"),
    clientsById: rowsById(tables.clientes?.rows, "id_cliente"),
    channelsById: rowsById(tables.canales?.rows, "id_canal")
  };
}

function tagIdByName(context, name) {
  const target = normalizeText(name);
  const match = [...context.tagsById.values()].find((row) => normalizeText(row.etiqueta) === target);
  return backendId(match?.id_etiqueta);
}

function duplicateSalaryOriginsByCanonicalSource(rows = [], cutoffDate, throughDate) {
  const groups = new Map();
  rows.forEach((row) => {
    const sourceId = backendId(row.id_sueldo);
    const employeeId = backendId(row.id_empleado);
    const date = validIsoDate(row.fecha);
    const netCents = toCents(normalizeMoney(storedNumber(row.sueldo_neto)));
    if (
      !sourceId
      || !employeeId
      || !date
      || date < cutoffDate
      || date > throughDate
      || !netCents
    ) return;
    const key = `${date.slice(0, 7)}:${employeeId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, sourceId, netCents });
  });

  const duplicates = new Map();
  groups.forEach((entries, identity) => {
    if (entries.length < 2) return;
    const netAmounts = new Set(entries.map((entry) => entry.netCents));
    const expenseIds = new Set(entries.map((entry) => backendId(entry.row.id_egreso)).filter(Boolean));
    const creditorTagIds = new Set(entries.map((entry) => backendId(entry.row.id_acreedor_etiqueta)).filter(Boolean));
    if (netAmounts.size !== 1 || expenseIds.size > 1 || creditorTagIds.size > 1) {
      throw migrationError(
        "ECONOMIC_SALARY_IDENTITY_AMBIGUOUS",
        `El sueldo de empleado/periodo ${identity} tiene fuentes incompatibles.`
      );
    }
    const ordered = entries.slice().sort((left, right) => (
      salarySourceCompleteness(right.row) - salarySourceCompleteness(left.row)
      || left.sourceId.localeCompare(right.sourceId, "es", { numeric: true })
    ));
    const canonicalSourceId = ordered[0].sourceId;
    ordered.slice(1).forEach((entry) => duplicates.set(entry.sourceId, canonicalSourceId));
  });
  return duplicates;
}

function salarySourceCompleteness(row) {
  return [
    "sueldo_bruto",
    "valor_remunerativo",
    "valor_no_remunerativo",
    "hs_trabajadas",
    "hs_con_justificacion_medica",
    "hs_feriado",
    "hs_extra",
    "premios"
  ].reduce((score, column) => score + (clean(row[column]) ? 1 : 0), 0);
}

function canonicalCreditorTagId(tables, originType, originId, tagName) {
  const normalizedOriginType = normalizeText(originType);
  const normalizedOriginId = backendId(originId);
  const creditor = (tables.acreedores?.rows || []).find((row) => (
    normalizeText(row.origen_tipo_acreedor) === normalizedOriginType
    && backendId(row.origen_id_acreedor) === normalizedOriginId
  ));
  if (!creditor) return "";
  return canonicalCreditorTagIdForCreditor(tables, creditor.id_acreedor, tagName);
}

function canonicalCreditorTagIdForCreditor(tables, creditorId, tagName) {
  const normalizedCreditorId = backendId(creditorId);
  const normalizedTagName = normalizeText(tagName);
  if (!normalizedCreditorId || !normalizedTagName) return "";
  const tagsById = rowsById(tables.etiquetas?.rows, "id_etiqueta");
  const matches = (tables.acreedores_etiquetas?.rows || []).filter((row) => (
    backendId(row.id_acreedor) === normalizedCreditorId
    && normalizeText(tagsById.get(backendId(row.id_etiqueta))?.etiqueta) === normalizedTagName
  ));
  return matches.length === 1 ? backendId(matches[0].id_acreedor_etiqueta) : "";
}

function quotaCompletionDate(tables, quota) {
  const expenseId = backendId(quota.id_egreso);
  const requiredCents = Math.abs(toCents(storedNumber(quota.capital)))
    + Math.abs(toCents(storedNumber(quota.interes_financiero)));
  if (!expenseId || !requiredCents) return "";
  const paymentsById = rowsById(tables.pagos?.rows, "id_pago");
  const applications = (tables.detalle_pagos?.rows || [])
    .filter((row) => backendId(row.id_egreso) === expenseId)
    .map((row) => ({
      date: validIsoDate(paymentsById.get(backendId(row.id_pago))?.fecha_pago),
      id: backendId(row.id_detalle_pago),
      cents: Math.abs(toCents(storedNumber(row.monto_cancelado)))
    }))
    .filter((row) => row.date && row.cents)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  let accumulatedCents = 0;
  for (const application of applications) {
    accumulatedCents += application.cents;
    if (accumulatedCents >= requiredCents) return application.date;
  }
  return "";
}

function quotaPaymentInstance(tables, quota) {
  const expenseId = backendId(quota.id_egreso);
  const requiredCents = Math.abs(toCents(storedNumber(quota.capital)))
    + Math.abs(toCents(storedNumber(quota.interes_financiero)));
  if (!expenseId || !requiredCents) return "impaga";
  const paymentsById = rowsById(tables.pagos?.rows, "id_pago");
  const details = (tables.detalle_pagos?.rows || []).filter(
    (row) => backendId(row.id_egreso) === expenseId
  );
  const allAppliedCents = details.reduce(
    (sum, row) => sum + Math.abs(toCents(storedNumber(row.monto_cancelado))),
    0
  );
  const hasUndatedApplication = details.some((row) => (
    Math.abs(toCents(storedNumber(row.monto_cancelado)))
    && !validIsoDate(paymentsById.get(backendId(row.id_pago))?.fecha_pago)
  ));
  if (allAppliedCents >= requiredCents && hasUndatedApplication) return "ambigua";
  const completionDate = quotaCompletionDate(tables, quota);
  if (!completionDate) return "impaga";
  const firstDueDate = validIsoDate(quota.fecha_primer_vencimiento);
  const secondDueDate = validIsoDate(quota.fecha_segundo_vencimiento);
  if (!firstDueDate || !secondDueDate || secondDueDate < firstDueDate) return "ambigua";
  if (completionDate <= firstDueDate) return "primera";
  if (completionDate <= secondDueDate) return "segunda";
  return "ambigua";
}

function reverseRemovedOrigins({
  expenseTable,
  rows = [],
  sourceColumn,
  producer,
  reconcile,
  reason
}) {
  const sourceIds = new Set((rows || []).map((row) => backendId(row[sourceColumn])).filter(Boolean));
  const identities = new Map();
  expenseTable.rows
    .filter((row) => (
      clean(row.estado) === "confirmado"
      && normalizeText(row.origen_tipo) === normalizeText(producer)
      && !sourceIds.has(backendId(row.origen_id))
    ))
    .forEach((row) => {
      const key = `${backendId(row.origen_id)}:${clean(row.origen_subclave)}`;
      if (!identities.has(key)) identities.set(key, row);
    });
  identities.forEach((row) => reconcile(producer, row, {
    date: row.fecha_economica,
    sourceId: row.origen_id,
    tagId: row.id_etiqueta,
    amount: 0,
    concept: `Reversion ${clean(row.concepto)}`,
    economicType: row.tipo_economico,
    subkey: row.origen_subclave,
    reason,
    enforceRange: producer !== "plan_pago"
  }));
}

function reverseSupersededOtherExpenseGrossRevenueTaxes({
  applicationTable,
  context,
  expenseTable,
  report,
  timestamp,
  onChange
}) {
  const precedents = [...expenseTable.rows].filter((row) => (
    clean(row.estado) === "confirmado"
    && clean(row.tipo_movimiento) === "original"
    && normalizeText(row.origen_tipo) === "otro gasto"
    && normalizeText(context.tagsById.get(backendId(row.id_etiqueta))?.etiqueta) === "ingresos brutos"
  ));
  precedents.forEach((precedent) => {
    const expenseKey = `${MIGRATION_ID}:correccion_iibb_otro_gasto:${backendId(precedent.id_gasto_economico)}`;
    let reversal = expenseTable.rows.find((row) => clean(row.clave_idempotencia) === expenseKey);
    if (reversal) {
      report.corrections.iibbOtherExpenseReplayed += 1;
    } else {
      const payload = {
        fecha_economica: clean(precedent.fecha_economica),
        id_etiqueta: backendId(precedent.id_etiqueta),
        concepto: `Reversion ${clean(precedent.concepto)}`,
        tipo_economico: clean(precedent.tipo_economico),
        tipo_movimiento: "reversion",
        importe: fromCents(-toCents(precedent.importe)),
        estado: "confirmado",
        origen_tipo: clean(precedent.origen_tipo),
        origen_id: backendId(precedent.origen_id),
        origen_subclave: `${clean(precedent.origen_subclave)}:reversion_iibb_ventas`,
        id_gasto_precedente: backendId(precedent.id_gasto_economico),
        motivo: "Ingresos Brutos se reconoce al 1,5% de ventas A/B",
        clave_idempotencia: expenseKey
      };
      reversal = {
        _rowNumber: expenseTable.rows.length + 2,
        id_gasto_economico: backendNextNumericId(expenseTable.rows, "id_gasto_economico"),
        ...payload,
        hash_payload: hashPayload(payload),
        creado_en: timestamp,
        actualizado_en: timestamp,
        confirmado_en: timestamp
      };
      expenseTable.rows.push(reversal);
      report.corrections.iibbOtherExpenseInserted += 1;
      report.insertedExpenses += 1;
      onChange();
    }

    applicationTable.rows
      .filter((row) => (
        backendId(row.id_gasto_economico) === backendId(precedent.id_gasto_economico)
        && clean(row.tipo_aplicacion) !== "reversion"
      ))
      .forEach((application) => {
        const applicationKey = `${expenseKey}:aplicacion:${backendId(application.id_gasto_egreso)}`;
        const existing = applicationTable.rows.find((row) => clean(row.clave_idempotencia) === applicationKey);
        if (existing) {
          report.corrections.iibbApplicationReplayed += 1;
          return;
        }
        application.estado = "revertida";
        const payload = {
          id_gasto_economico: backendId(application.id_gasto_economico),
          id_egreso: backendId(application.id_egreso),
          importe_aplicado: normalizeMoney(storedNumber(application.importe_aplicado)),
          componente_egreso: clean(application.componente_egreso),
          componente_otro: clean(application.componente_otro),
          tipo_aplicacion: "reversion",
          estado: "revertida",
          id_aplicacion_precedente: backendId(application.id_gasto_egreso),
          motivo: "Aplicacion revertida por criterio de IIBB sobre ventas",
          clave_idempotencia: applicationKey
        };
        applicationTable.rows.push({
          _rowNumber: applicationTable.rows.length + 2,
          id_gasto_egreso: backendNextNumericId(applicationTable.rows, "id_gasto_egreso"),
          ...payload,
          hash_payload: hashPayload(payload),
          creado_en: timestamp
        });
        report.corrections.iibbApplicationInserted += 1;
        report.insertedApplications += 1;
        onChange();
      });
  });
}

function findExistingExpense(rows, payload, key, payloadHash) {
  const byKey = rows.find((row) => clean(row.clave_idempotencia) === key);
  if (byKey) {
    if (clean(byKey.hash_payload) !== payloadHash) {
      throw migrationError("ECONOMIC_EXPENSE_IDEMPOTENCY_CONFLICT", `La clave ${key} ya existe con otro payload.`);
    }
    return byKey;
  }
  const byIdentity = rows.find((row) => (
    clean(row.estado) !== "descartado"
    && clean(row.origen_tipo) === payload.origen_tipo
    && backendId(row.origen_id) === payload.origen_id
    && clean(row.origen_subclave) === payload.origen_subclave
    && clean(row.tipo_economico) === payload.tipo_economico
    && clean(row.tipo_movimiento) === payload.tipo_movimiento
  ));
  if (!byIdentity) return null;
  const comparable = expensePayload(byIdentity);
  if (JSON.stringify(comparable) !== JSON.stringify(payload)) {
    throw migrationError(
      "ECONOMIC_EXPENSE_IDENTITY_CONFLICT",
      `El origen ${payload.origen_tipo} ${payload.origen_id}/${payload.origen_subclave} ya tiene otro gasto.`
    );
  }
  return byIdentity;
}

function findExistingApplication(rows, payload, payloadHash) {
  const existing = rows.find((row) => clean(row.clave_idempotencia) === payload.clave_idempotencia);
  if (!existing) return null;
  if (clean(existing.hash_payload) !== payloadHash) {
    throw migrationError(
      "ECONOMIC_APPLICATION_IDEMPOTENCY_CONFLICT",
      `La clave ${payload.clave_idempotencia} ya existe con otro payload.`
    );
  }
  return existing;
}

function applicationHasCapacity(rows, context, payload) {
  const expense = context.expensesById.get(payload.id_egreso);
  if (!expense) return false;
  const limit = payload.componente_egreso === "base_subtotal"
    ? Math.abs(toCents(storedNumber(expense.subtotal)))
    : Math.abs(toCents(storedNumber(expense.total)));
  const applied = rows
    .filter((row) => (
      clean(row.estado) === "vigente"
      && clean(row.tipo_aplicacion) !== "reversion"
      && backendId(row.id_egreso) === payload.id_egreso
      && clean(row.componente_egreso) === payload.componente_egreso
    ))
    .reduce((sum, row) => sum + Math.abs(toCents(storedNumber(row.importe_aplicado))), 0);
  return limit > 0 && applied + Math.abs(toCents(payload.importe_aplicado)) <= limit;
}

function internalTaxMayAlreadyBeMaterialized(expense, applications, economicRows) {
  const expenseId = backendId(expense.id_egreso);
  const subtotalCents = Math.abs(toCents(storedNumber(expense.subtotal)));
  const internalTaxCents = Math.abs(toCents(storedNumber(expense.imp_internos)));
  if (!expenseId || !internalTaxCents) return false;
  const linkedExpenseIds = new Set((applications || [])
    .filter((row) => (
      clean(row.estado) === "vigente"
      && clean(row.tipo_aplicacion) !== "reversion"
      && backendId(row.id_egreso) === expenseId
      && clean(row.componente_otro) !== INTERNAL_TAX_SUBKEY
    ))
    .map((row) => backendId(row.id_gasto_economico)));
  const linkedCents = (economicRows || [])
    .filter((row) => linkedExpenseIds.has(backendId(row.id_gasto_economico)))
    .reduce((sum, row) => sum + Math.abs(toCents(storedNumber(row.importe))), 0);
  return subtotalCents > 0
    && linkedCents > subtotalCents
    && linkedCents >= subtotalCents + internalTaxCents;
}

function sourceDateForExistingExpense(row, tables) {
  const originType = normalizeText(row.origen_tipo);
  const originId = backendId(row.origen_id);
  const configs = {
    recepcion: ["recepciones", "id_recepcion", "fecha_recepcion"],
    recepciones: ["recepciones", "id_recepcion", "fecha_recepcion"],
    "otro gasto": ["otros_gastos", "id_otros_gastos", "fecha_otros_gastos"],
    "otros gastos": ["otros_gastos", "id_otros_gastos", "fecha_otros_gastos"],
    logistica: ["entregas", "id_entrega", "fecha"],
    "comision venta": ["ventas", "id_venta", "fecha_factura"],
    "ingresos brutos": ["ventas", "id_venta", "fecha_factura"],
    sueldo: ["sueldos", "id_sueldo", "fecha"],
    sueldos: ["sueldos", "id_sueldo", "fecha"],
    "fondo inversion": ["fondos_inversion_movimientos", "id_movimiento_fondo", "fecha"],
    egreso: ["egresos", "id_egreso", "fecha_factura"]
  };
  const config = configs[originType];
  if (!config) return "";
  const source = (tables[config[0]]?.rows || []).find((candidate) => backendId(candidate[config[1]]) === originId);
  return validIsoDate(source?.[config[2]]);
}

function ensureTable(cache, name) {
  if (!cache.tables[name]) {
    cache.tables[name] = {
      headers: [...EXPECTED_BACKEND_COLUMNS[name]],
      rows: [],
      rowCount: 0
    };
    return true;
  }
  const table = cache.tables[name];
  let changed = false;
  if (!Array.isArray(table.rows)) {
    table.rows = [];
    changed = true;
  }
  if (!Array.isArray(table.headers)) {
    table.headers = [];
    changed = true;
  }
  return changed;
}

function createReport(cutoffDate, throughDate, schemaChanged) {
  const producer = () => ({ seenInRange: 0, inserted: 0, replayed: 0, skipped: {}, applicationSkipped: {} });
  return {
    migrationId: MIGRATION_ID,
    action: "backfill",
    cutoffDate,
    throughDate,
    schemaChanged,
    changed: false,
    idempotent: false,
    insertedExpenses: 0,
    insertedApplications: 0,
    replayedApplications: 0,
    producers: {
      recepcion: producer(),
      otro_gasto: producer(),
      logistica: producer(),
      comision_venta: producer(),
      ingresos_brutos: producer(),
      sueldo: producer(),
      plan_pago: producer(),
      egreso: producer()
    },
    exclusions: {
      aportes_socios: 0,
      fondo_capital: 0
    },
    corrections: {
      iibbOtherExpenseInserted: 0,
      iibbOtherExpenseReplayed: 0,
      iibbApplicationInserted: 0,
      iibbApplicationReplayed: 0
    }
  };
}

function skip(report, producer, reason) {
  const skipped = report.producers[producer].skipped;
  skipped[reason] = (skipped[reason] || 0) + 1;
}

function skipApplication(report, producer, reason) {
  const skipped = report.producers[producer].applicationSkipped;
  skipped[reason] = (skipped[reason] || 0) + 1;
}

function rowsById(rows = [], column) {
  const result = new Map();
  rows.forEach((row) => {
    const id = backendId(row[column]);
    if (id && !result.has(id)) result.set(id, row);
  });
  return result;
}

function countById(rows = [], column) {
  const result = new Map();
  rows.forEach((row) => {
    const id = backendId(row[column]);
    if (id) result.set(id, (result.get(id) || 0) + 1);
  });
  return result;
}

function countRowsInRange(rows = [], dateFor, cutoffDate, throughDate) {
  return rows.filter((row) => {
    const date = validIsoDate(dateFor(row));
    return date >= cutoffDate && date <= throughDate;
  }).length;
}

function expensePayload(row) {
  return {
    fecha_economica: clean(row.fecha_economica),
    id_etiqueta: backendId(row.id_etiqueta),
    concepto: clean(row.concepto),
    tipo_economico: clean(row.tipo_economico),
    tipo_movimiento: clean(row.tipo_movimiento),
    importe: normalizeMoney(storedNumber(row.importe)),
    estado: clean(row.estado),
    origen_tipo: clean(row.origen_tipo),
    origen_id: backendId(row.origen_id),
    origen_subclave: clean(row.origen_subclave),
    id_gasto_precedente: backendId(row.id_gasto_precedente),
    motivo: clean(row.motivo),
    clave_idempotencia: clean(row.clave_idempotencia)
  };
}

function createBackupManifest(serializedCache) {
  const source = Buffer.isBuffer(serializedCache)
    ? serializedCache
    : Buffer.from(String(serializedCache), "utf8");
  const cache = JSON.parse(source.toString("utf8"));
  return {
    migrationId: MIGRATION_ID,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
    bytes: source.length,
    tableCounts: Object.fromEntries(Object.entries(cache.tables || {}).map(([name, table]) => [
      name,
      Array.isArray(table?.rows) ? table.rows.length : 0
    ]))
  };
}

function verifyBackup(serializedCache, manifest) {
  const current = createBackupManifest(serializedCache);
  if (
    current.sha256 !== manifest.sha256
    || current.bytes !== manifest.bytes
    || JSON.stringify(current.tableCounts) !== JSON.stringify(manifest.tableCounts)
  ) {
    throw migrationError("ECONOMIC_EXPENSE_BACKUP_MISMATCH", "El backup no coincide con su manifiesto verificable.");
  }
  return true;
}

function storedNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const compact = clean(value)
    .replace(/\$/g, "")
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "");
  if (!compact) return 0;
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");
  let normalized = compact;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot
      ? compact.replace(/\./g, "").replace(",", ".")
      : compact.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const decimals = compact.length - lastComma - 1;
    normalized = decimals > 0 && decimals <= 2
      ? compact.replace(/\./g, "").replace(",", ".")
      : compact.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const decimals = compact.length - lastDot - 1;
    const dotCount = (compact.match(/\./g) || []).length;
    if (dotCount > 1 || decimals === 3) normalized = compact.replace(/\./g, "");
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizedRate(value) {
  const rate = storedNumber(value);
  if (rate <= 0) return 0;
  return rate > 1 ? rate / 100 : rate;
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validIsoDate(value) {
  const candidate = clean(value);
  const match = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    ? candidate
    : "";
}

function requiredDate(value, code) {
  const date = validIsoDate(value);
  if (!date) throw migrationError(code, "La fecha debe ser valida y usar AAAA-MM-DD.");
  return date;
}

function validTimestamp(value) {
  const candidate = clean(value);
  return candidate && !Number.isNaN(new Date(candidate).getTime()) ? candidate : "";
}

function currentBuenosAiresDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeText(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
}

function clean(value) {
  return String(value ?? "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  APPLICATION_TABLE,
  CUTOVER_DATE,
  ECONOMIC_TABLE,
  MIGRATION_ID,
  backfillHistoricalEconomicExpenses,
  createBackupManifest,
  migrateEconomicExpenseSchema,
  verifyBackup
};
