const {
  equals: moneyEquals,
  format: formatMoney,
  fromCents,
  normalize: normalizeMoney,
  toCents
} = require("../../shared/money");

const PLAN_COLUMNS = ["id_plan_pago", "nombre", "organismo"];
const QUOTA_COLUMNS = [
  "id_cuota_plan_pago",
  "id_plan_pago",
  "nro_cuota",
  "capital",
  "interes_financiero",
  "interes_resarcitorio",
  "total_primer_vencimiento",
  "fecha_primer_vencimiento",
  "total_segundo_vencimiento",
  "fecha_segundo_vencimiento",
  "id_egreso"
];
const EDITABLE_QUOTA_COLUMNS = QUOTA_COLUMNS.filter((column) => ![
  "id_cuota_plan_pago",
  "id_plan_pago"
].includes(column));

function createPaymentPlansService({
  backendId,
  backendIsoDate,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  isIsoDate,
  loadCache,
  normalizePartnerName,
  readJsonBody,
  saveBackendCache,
  sendJson,
  failureInjector = () => {}
}) {
  function buildPlanPaymentInstallments({ startYear, startMonth, capitals, financial, firstTotal, secondTotal, resarcitorio }) {
    return capitals.map((capital, index) => {
      const monthOffset = startMonth - 1 + index;
      const year = startYear + Math.floor(monthOffset / 12);
      const month = String((monthOffset % 12) + 1).padStart(2, "0");
      return {
        nroCuota: index + 1,
        capital,
        interesFinanciero: financial[index],
        interesResarcitorio: resarcitorio,
        totalPrimerVencimiento: firstTotal,
        fechaPrimerVencimiento: `${year}-${month}-16`,
        totalSegundoVencimiento: secondTotal,
        fechaSegundoVencimiento: `${year}-${month}-26`
      };
    });
  }

  // Compatibilidad histórica explícita. No se invoca durante el arranque ni desde los endpoints.
  function ensurePaymentPlansHistory() {
    const cache = loadCache();
    if (!cache.tables) return;

    ensureBackendTable(cache.tables, "planes_pagos");
    ensureBackendTable(cache.tables, "cuotas_planes_pagos");
    ensureBackendTable(cache.tables, "egresos");

    const plans = [
      {
        nombre: "Plan de pagos ARCA 1",
        cuotas: buildPlanPaymentInstallments({
          startYear: 2026, startMonth: 3,
          capitals: [737285.75, 757561.11, 778394.04, 799799.88, 821794.37, 844393.72, 867614.55, 891473.95, 915989.48, 941117.19],
          financial: [283695.60, 263420.24, 242587.31, 221181.47, 199186.98, 176587.63, 153366.80, 129507.40, 104991.87, 79802.16],
          firstTotal: 1020981.35, secondTotal: 1030340.35, resarcitorio: 9359
        })
      },
      {
        nombre: "Plan de pagos ARCA 2",
        cuotas: buildPlanPaymentInstallments({
          startYear: 2026, startMonth: 3,
          capitals: [275632.87, 283212.77, 291001.12, 299003.65, 307226.25, 315674.87, 324356.04, 333275.83, 342440.91, 351858.04],
          financial: [106059.05, 98479.15, 90690.80, 82688.27, 74465.67, 66016.95, 57335.88, 48416.09, 39251.01, 29833.88],
          firstTotal: 381691.92, secondTotal: 385190.76, resarcitorio: 3498.84
        })
      },
      {
        nombre: "Plan de pagos ARCA 3",
        cuotas: buildPlanPaymentInstallments({
          startYear: 2026, startMonth: 7,
          capitals: [768958.32, 788049.67, 809721.04, 831988.37, 854868.05, 878376.92, 902532.29, 927351.89],
          financial: [185895.78, 164804.43, 143133.06, 120865.73, 97886.05, 74477.18, 50321.81, 25502.21],
          firstTotal: 952854.10, secondTotal: 961588.60, resarcitorio: 8734.50
        })
      }
    ];

    const planRows = cache.tables.planes_pagos.rows;
    const quotaRows = cache.tables.cuotas_planes_pagos.rows;
    const expenseRows = cache.tables.egresos.rows;
    let nextPlanId = Math.max(0, ...planRows.map((row) => Number(backendId(row.id_plan_pago)) || 0)) + 1;
    let nextQuotaId = Math.max(0, ...quotaRows.map((row) => Number(backendId(row.id_cuota_plan_pago)) || 0)) + 1;
    let nextExpenseId = Math.max(0, ...expenseRows.map((row) => Number(backendId(row.id_egreso)) || 0)) + 1;
    let changed = false;

    plans.forEach((definition) => {
      let plan = planRows.find((row) => normalizePartnerName(row.nombre) === normalizePartnerName(definition.nombre));
      if (!plan) {
        plan = { id_plan_pago: String(nextPlanId++), nombre: definition.nombre, organismo: "ARCA", _rowNumber: planRows.length + 1 };
        planRows.push(plan);
        changed = true;
      }
      const planId = backendId(plan.id_plan_pago);

      definition.cuotas.forEach((definitionQuota) => {
        let quota = quotaRows.find((row) => backendId(row.id_plan_pago) === planId && Number(row.nro_cuota) === definitionQuota.nroCuota);
        let expense = quota && expenseRows.find((row) => backendId(row.id_egreso) === backendId(quota.id_egreso));

        if (!expense) {
          expense = expenseRows.find((row) => {
            const amount = backendNumber(row.total);
            const matchesAmount = moneyEquals(amount, definitionQuota.totalPrimerVencimiento)
              || moneyEquals(amount, definitionQuota.totalSegundoVencimiento);
            const date = backendIsoDate(row.fecha_factura) || backendIsoDate(row.fecha_prevista_pago);
            return matchesAmount && (date === definitionQuota.fechaPrimerVencimiento || date === definitionQuota.fechaSegundoVencimiento);
          });
        }

        if (!expense) {
          expense = {
            id_egreso: String(nextExpenseId++),
            fecha_factura: definitionQuota.fechaPrimerVencimiento,
            fecha_prevista_pago: definitionQuota.fechaPrimerVencimiento,
            tipo_factura: "Plan de Pagos",
            nro_factura: `ARCA-${planId}-${definitionQuota.nroCuota}`,
            iva: 0,
            per_ret_iva: 0,
            per_ret_iibb: 0,
            imp_internos: 0,
            subtotal: definitionQuota.totalPrimerVencimiento,
            total: definitionQuota.totalPrimerVencimiento,
            _rowNumber: expenseRows.length + 1
          };
          expenseRows.push(expense);
          changed = true;
        }

        const values = {
          id_plan_pago: planId,
          nro_cuota: definitionQuota.nroCuota,
          capital: definitionQuota.capital,
          interes_financiero: definitionQuota.interesFinanciero,
          interes_resarcitorio: definitionQuota.interesResarcitorio,
          total_primer_vencimiento: definitionQuota.totalPrimerVencimiento,
          fecha_primer_vencimiento: definitionQuota.fechaPrimerVencimiento,
          total_segundo_vencimiento: definitionQuota.totalSegundoVencimiento,
          fecha_segundo_vencimiento: definitionQuota.fechaSegundoVencimiento,
          id_egreso: backendId(expense.id_egreso)
        };

        if (!quota) {
          quota = { id_cuota_plan_pago: String(nextQuotaId++), ...values, _rowNumber: quotaRows.length + 1 };
          quotaRows.push(quota);
          changed = true;
        } else {
          Object.entries(values).forEach(([key, value]) => {
            if (String(quota[key] ?? "") !== String(value ?? "")) {
              quota[key] = value;
              changed = true;
            }
          });
        }
      });
    });

    if (!changed) return;
    cache.tables.planes_pagos.rowCount = planRows.length;
    cache.tables.cuotas_planes_pagos.rowCount = quotaRows.length;
    cache.tables.egresos.rowCount = expenseRows.length;
    cache.generatedAt = new Date().toISOString();
    saveBackendCache(cache);
  }

  function handlePaymentPlansList(_request, response) {
    try {
      const cache = loadCache();
      const plans = planRows(cache).map((plan) => completePlan(cache, plan, false));
      return sendJson(response, 200, { ok: true, plans, expenses: selectableExpenses(cache) });
    } catch (error) {
      return failure(response, error, "No se pudieron cargar los planes de pago.");
    }
  }

  function handlePaymentPlanGet(request, response) {
    try {
      const cache = loadCache();
      const plan = requiredPlan(cache, routeIds(request).planId);
      return sendJson(response, 200, {
        ok: true,
        plan: completePlan(cache, plan, true),
        expenses: selectableExpenses(cache)
      });
    } catch (error) {
      return failure(response, error, "No se pudo cargar el plan de pago.");
    }
  }

  async function handlePaymentPlanCreate(request, response) {
    return mutate(request, response, "crear el plan", (cache, body, operationId, operationPayload) => {
      validatePlanInput(body.plan, false);
      const quotas = Array.isArray(body.quotas) ? body.quotas : [];
      quotas.forEach((quota) => validateQuotaInput(quota, false));
      validateUniqueQuotaNumbers(quotas);
      validateQuotaExpenseChanges(cache, "", quotas);

      const rows = planRows(cache);
      const planId = backendNextNumericId(rows, "id_plan_pago");
      const timestamp = new Date().toISOString();
      const plan = {
        _rowNumber: rows.length + 2,
        id_plan_pago: planId,
        nombre: cleanRequired(body.plan.nombre, "El nombre es obligatorio."),
        organismo: cleanRequired(body.plan.organismo, "El organismo es obligatorio."),
        _editedLocallyAt: timestamp
      };
      rows.push(plan);

      let nextQuotaId = backendNextNumericId(quotaRows(cache), "id_cuota_plan_pago");
      quotas.forEach((input) => quotaRows(cache).push(buildQuota(input, planId, nextQuotaId++, timestamp)));
      updateCounts(cache);
      failureInjector("before-save");
      const result = { plan: completePlan(cache, plan, true) };
      rememberOperation(plan, operationId, operationPayload, result);
      return result;
    });
  }

  async function handlePaymentPlanUpdate(request, response) {
    return mutate(request, response, "editar el plan", (cache, body, operationId, operationPayload) => {
      const { planId } = routeIds(request);
      const plan = requiredPlan(cache, planId);
      validatePlanInput(body.plan, true, planId);
      const submittedQuotas = body.quotas;
      if (submittedQuotas !== undefined && !Array.isArray(submittedQuotas)) {
        throw badRequest("Las cuotas deben enviarse como una lista.");
      }
      if (Array.isArray(submittedQuotas)) {
        submittedQuotas.forEach((quota) => validateQuotaInput(quota, Boolean(backendId(quota.id_cuota_plan_pago)), quota.id_cuota_plan_pago));
        validateUniqueQuotaNumbers(submittedQuotas);
        validateQuotaExpenseChanges(cache, planId, submittedQuotas);
        replacePlanQuotas(cache, planId, submittedQuotas);
      }
      plan.nombre = cleanRequired(body.plan.nombre, "El nombre es obligatorio.");
      plan.organismo = cleanRequired(body.plan.organismo, "El organismo es obligatorio.");
      plan._editedLocallyAt = new Date().toISOString();
      updateCounts(cache);
      const result = { plan: completePlan(cache, plan, true) };
      rememberOperation(plan, operationId, operationPayload, result);
      return result;
    });
  }

  async function handlePaymentPlanQuotaAdd(request, response) {
    return mutate(request, response, "agregar la cuota", (cache, body, operationId, operationPayload) => {
      const { planId } = routeIds(request);
      const plan = requiredPlan(cache, planId);
      validateQuotaInput(body.quota, false);
      assertQuotaNumberAvailable(cache, planId, body.quota.nro_cuota);
      validateQuotaExpenseChanges(cache, planId, [body.quota]);
      const quotaId = backendNextNumericId(quotaRows(cache), "id_cuota_plan_pago");
      const quota = buildQuota(body.quota, planId, quotaId, new Date().toISOString());
      quotaRows(cache).push(quota);
      updateCounts(cache);
      const result = { plan: completePlan(cache, plan, true), quota: publicQuota(cache, quota) };
      rememberOperation(plan, operationId, operationPayload, result);
      return result;
    });
  }

  async function handlePaymentPlanQuotaUpdate(request, response) {
    return mutate(request, response, "editar la cuota", (cache, body, operationId, operationPayload) => {
      const { planId, quotaId } = routeIds(request);
      const plan = requiredPlan(cache, planId);
      const quota = requiredQuota(cache, planId, quotaId);
      validateQuotaInput(body.quota, true, quotaId);
      assertQuotaNumberAvailable(cache, planId, body.quota.nro_cuota, quotaId);
      validateQuotaExpenseChanges(cache, planId, [body.quota], quotaId);
      EDITABLE_QUOTA_COLUMNS.forEach((column) => {
        quota[column] = normalizedQuotaValue(column, body.quota[column]);
      });
      quota._editedLocallyAt = new Date().toISOString();
      const result = { plan: completePlan(cache, plan, true), quota: publicQuota(cache, quota) };
      rememberOperation(plan, operationId, operationPayload, result);
      return result;
    });
  }

  async function handlePaymentPlanQuotaDelete(request, response) {
    return mutate(request, response, "quitar la cuota", (cache, _body, operationId, operationPayload) => {
      const { planId, quotaId } = routeIds(request);
      const plan = requiredPlan(cache, planId);
      const quota = requiredQuota(cache, planId, quotaId);
      assertQuotaCanBeDeleted(cache, quota);
      cache.tables.cuotas_planes_pagos.rows = quotaRows(cache).filter((row) => backendId(row.id_cuota_plan_pago) !== backendId(quotaId));
      updateCounts(cache);
      const result = { deletedQuotaId: backendId(quotaId), plan: completePlan(cache, plan, true) };
      rememberOperation(plan, operationId, operationPayload, result);
      return result;
    });
  }

  async function mutate(request, response, action, apply) {
    try {
      const body = await readJsonBody(request);
      validateTopLevel(body);
      const operationId = cleanRequired(body.operationId, "Falta el identificador de operación.");
      const operationPayload = stableSerialize({ path: request.url, body: { ...body, operationId: undefined } });
      const current = loadCache();
      const replay = findOperation(current, operationId);
      if (replay) {
        assertSameOperation(replay.payload, operationPayload);
        return sendJson(response, 200, { ok: true, idempotent: true, ...replay.result });
      }

      const cache = JSON.parse(JSON.stringify(current));
      ensureTables(cache);
      const result = apply(cache, body, operationId, operationPayload);
      validateRelations(cache);
      cache.generatedAt = new Date().toISOString();
      failureInjector("before-persist");
      saveBackendCache(cache);
      return sendJson(response, 200, { ok: true, idempotent: false, ...result });
    } catch (error) {
      return failure(response, error, `No se pudo ${action}.`);
    }
  }

  function completePlan(cache, plan, includeQuotas) {
    const quotas = quotaRows(cache)
      .filter((quota) => backendId(quota.id_plan_pago) === backendId(plan.id_plan_pago))
      .sort((a, b) => Number(a.nro_cuota) - Number(b.nro_cuota))
      .map((quota) => publicQuota(cache, quota));
    const totalsInCents = quotas.reduce((result, quota) => {
      result.capital += toCents(quota.capital);
      result.interes_financiero += toCents(quota.interes_financiero);
      result.interes_resarcitorio += toCents(quota.interes_resarcitorio);
      result.total_general += toCents(quota.total_segundo_vencimiento);
      result.vencidas += quota.estado === "Vencida" ? 1 : 0;
      result.proximas += quota.estado === "Próxima" ? 1 : 0;
      result.vinculadas += quota.id_egreso ? 1 : 0;
      result.pagadas += quota.estado === "Pagada" ? 1 : 0;
      result.saldo_pendiente += Math.max(
        0,
        Math.abs(toCents(quota.total_primer_vencimiento)) - Math.abs(toCents(quota.monto_pagado))
      );
      return result;
    }, {
      capital: 0,
      interes_financiero: 0,
      interes_resarcitorio: 0,
      total_general: 0,
      vencidas: 0,
      proximas: 0,
      vinculadas: 0,
      pagadas: 0,
      saldo_pendiente: 0
    });
    const totals = Object.fromEntries(Object.entries(totalsInCents).map(([key, value]) => [
      key,
      ["vencidas", "proximas", "vinculadas", "pagadas"].includes(key) ? value : fromCents(value)
    ]));
    return {
      id_plan_pago: backendId(plan.id_plan_pago),
      nombre: String(plan.nombre || ""),
      organismo: String(plan.organismo || ""),
      cantidad_cuotas: quotas.length,
      totales: totals,
      ...(includeQuotas ? { cuotas: quotas } : {})
    };
  }

  function publicQuota(cache, quota) {
    const paid = paidAmount(cache, quota.id_egreso);
    const total = normalizeMoney(backendNumber(quota.total_primer_vencimiento));
    return {
      ...Object.fromEntries(QUOTA_COLUMNS.map((column) => [column, normalizedQuotaValue(column, quota[column])])),
      estado: quotaState(quota, paid, total),
      monto_pagado: paid,
      eliminable: !backendId(quota.id_egreso)
    };
  }

  function quotaState(quota, paid, total) {
    const totalCents = toCents(total);
    if (
      backendId(quota.id_egreso)
      && totalCents !== 0
      && Math.abs(toCents(paid)) >= Math.abs(totalCents)
    ) return "Pagada";
    const dueDate = backendIsoDate(quota.fecha_primer_vencimiento);
    const today = new Date().toISOString().slice(0, 10);
    if (dueDate && dueDate < today) return "Vencida";
    if (dueDate) {
      const days = Math.ceil((new Date(`${dueDate}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
      if (days >= 0 && days <= 30) return "Próxima";
    }
    return "Pendiente";
  }

  function paidAmount(cache, expenseId) {
    const id = backendId(expenseId);
    if (!id) return 0;
    return fromCents((cache.tables?.detalle_pagos?.rows || [])
      .filter((detail) => backendId(detail.id_egreso) === id)
      .reduce((sum, detail) => sum + toCents(backendNumber(detail.monto_cancelado)), 0));
  }

  function validateTopLevel(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("El payload es inválido.");
    const allowed = new Set(["operationId", "plan", "quota", "quotas"]);
    const extras = Object.keys(body).filter((key) => !allowed.has(key));
    if (extras.length) throw badRequest(`Campos no permitidos: ${extras.join(", ")}.`);
  }

  function validatePlanInput(plan, updating, planId) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw badRequest("Los datos del plan son obligatorios.");
    const allowed = new Set(PLAN_COLUMNS);
    const extras = Object.keys(plan).filter((key) => !allowed.has(key));
    if (extras.length) throw badRequest(`Columnas de plan no permitidas: ${extras.join(", ")}.`);
    cleanRequired(plan.nombre, "El nombre es obligatorio.");
    cleanRequired(plan.organismo, "El organismo es obligatorio.");
    if (updating && Object.prototype.hasOwnProperty.call(plan, "id_plan_pago") && backendId(plan.id_plan_pago) !== backendId(planId)) {
      throw conflict("La clave del plan es contradictoria.");
    }
  }

  function validateQuotaInput(quota, updating, quotaId) {
    if (!quota || typeof quota !== "object" || Array.isArray(quota)) throw badRequest("Los datos de la cuota son obligatorios.");
    const allowed = new Set([...EDITABLE_QUOTA_COLUMNS, ...(updating ? ["id_cuota_plan_pago"] : [])]);
    const extras = Object.keys(quota).filter((key) => !allowed.has(key));
    if (extras.length) throw badRequest(`Columnas de cuota no permitidas: ${extras.join(", ")}.`);
    if (updating && Object.prototype.hasOwnProperty.call(quota, "id_cuota_plan_pago") && backendId(quota.id_cuota_plan_pago) !== backendId(quotaId)) {
      throw conflict("La clave de la cuota es contradictoria.");
    }
    EDITABLE_QUOTA_COLUMNS.forEach((column) => {
      if (!Object.prototype.hasOwnProperty.call(quota, column)) throw badRequest(`Falta el campo ${column}.`);
    });
    const number = Number(quota.nro_cuota);
    if (!Number.isInteger(number) || number <= 0) throw badRequest("El número de cuota debe ser un entero positivo.");
    const expenseId = String(quota.id_egreso ?? "").trim();
    if (expenseId && (!/^[1-9]\d*$/.test(expenseId) || !Number.isSafeInteger(Number(expenseId)))) {
      throw badRequest(`El ID egreso de la cuota ${number} debe ser un entero positivo.`);
    }
    ["capital", "interes_financiero", "interes_resarcitorio", "total_primer_vencimiento", "total_segundo_vencimiento"].forEach((column) => {
      try {
        if (toCents(quota[column]) < 0) {
          throw badRequest(`El campo ${column} debe ser un monto no negativo.`);
        }
      } catch (error) {
        if (error.statusCode) throw error;
        throw badRequest(`El campo ${column} debe ser un monto no negativo.`);
      }
    });
    ["fecha_primer_vencimiento", "fecha_segundo_vencimiento"].forEach((column) => {
      if (!isIsoDate(String(quota[column] || ""))) throw badRequest(`El campo ${column} debe ser una fecha válida.`);
    });
    if (backendIsoDate(quota.fecha_segundo_vencimiento) < backendIsoDate(quota.fecha_primer_vencimiento)) {
      throw badRequest("El segundo vencimiento no puede ser anterior al primero.");
    }
    const capitalCents = toCents(quota.capital);
    const financialInterestCents = toCents(quota.interes_financiero);
    const firstTotalCents = toCents(quota.total_primer_vencimiento);
    const firstDifferenceCents = firstTotalCents - (capitalCents + financialInterestCents);
    if (firstDifferenceCents !== 0) {
      throw badRequest(
        `La cuota ${number} tiene una diferencia de ${formatCentDifference(firstDifferenceCents)} `
        + "en el total del primer vencimiento respecto de capital más interés financiero."
      );
    }
    const secondTotalCents = toCents(quota.total_segundo_vencimiento);
    const secondDifferenceCents = secondTotalCents - (firstTotalCents + toCents(quota.interes_resarcitorio));
    if (secondDifferenceCents !== 0) {
      throw badRequest(
        `La cuota ${number} tiene una diferencia de ${formatCentDifference(secondDifferenceCents)} `
        + "en el total del segundo vencimiento respecto del primer total más interés resarcitorio."
      );
    }
  }

  function buildQuota(input, planId, quotaId, timestamp) {
    return {
      _rowNumber: 0,
      id_cuota_plan_pago: quotaId,
      id_plan_pago: planId,
      ...Object.fromEntries(EDITABLE_QUOTA_COLUMNS.map((column) => [column, normalizedQuotaValue(column, input[column])])),
      _editedLocallyAt: timestamp
    };
  }

  function replacePlanQuotas(cache, planId, inputs) {
    const allRows = quotaRows(cache);
    const current = allRows.filter((quota) => backendId(quota.id_plan_pago) === backendId(planId));
    const currentById = new Map(current.map((quota) => [backendId(quota.id_cuota_plan_pago), quota]));
    const submittedIds = new Set(inputs.map((quota) => backendId(quota.id_cuota_plan_pago)).filter(Boolean));
    current.filter((quota) => !submittedIds.has(backendId(quota.id_cuota_plan_pago)))
      .forEach((quota) => assertQuotaCanBeDeleted(cache, quota));

    let nextQuotaId = backendNextNumericId(allRows, "id_cuota_plan_pago");
    const timestamp = new Date().toISOString();
    const replacements = inputs.map((input) => {
      const quotaId = backendId(input.id_cuota_plan_pago);
      if (!quotaId) return buildQuota(input, planId, nextQuotaId++, timestamp);
      const existing = currentById.get(quotaId);
      if (!existing) throw notFound(`La cuota ${quotaId} no existe dentro del plan.`);
      EDITABLE_QUOTA_COLUMNS.forEach((column) => {
        existing[column] = normalizedQuotaValue(column, input[column]);
      });
      existing._editedLocallyAt = timestamp;
      return existing;
    });
    cache.tables.cuotas_planes_pagos.rows = [
      ...allRows.filter((quota) => backendId(quota.id_plan_pago) !== backendId(planId)),
      ...replacements
    ];
  }

  function normalizedQuotaValue(column, value) {
    if (["id_cuota_plan_pago", "id_plan_pago", "id_egreso"].includes(column)) return backendId(value);
    if (column === "nro_cuota") return Number(value) || 0;
    if (column.startsWith("fecha_")) return backendIsoDate(value) || "";
    return normalizeMoney(value);
  }

  function assertQuotaNumberAvailable(cache, planId, number, ignoredQuotaId = "") {
    const duplicate = quotaRows(cache).find((quota) => (
      backendId(quota.id_plan_pago) === backendId(planId)
      && Number(quota.nro_cuota) === Number(number)
      && backendId(quota.id_cuota_plan_pago) !== backendId(ignoredQuotaId)
    ));
    if (duplicate) throw conflict("Ya existe una cuota con ese número dentro del plan.");
  }

  function validateUniqueQuotaNumbers(quotas) {
    const numbers = quotas.map((quota) => Number(quota.nro_cuota));
    if (new Set(numbers).size !== numbers.length) throw conflict("Hay números de cuota duplicados.");
  }

  function assertQuotaCanBeDeleted(cache, quota) {
    const expenseId = backendId(quota.id_egreso);
    if (expenseId) {
      const hasPayments = (cache.tables?.detalle_pagos?.rows || []).some((detail) => backendId(detail.id_egreso) === expenseId);
      throw conflict(hasPayments
        ? "La cuota está vinculada a un egreso con pagos y no puede eliminarse."
        : "La cuota está vinculada a un egreso usado por Tesorería y no puede eliminarse.");
    }
  }

  function validateQuotaExpenseChanges(cache, planId, inputs, routeQuotaId = "") {
    const current = quotaRows(cache).filter((quota) => backendId(quota.id_plan_pago) === backendId(planId));
    const currentById = new Map(current.map((quota) => [backendId(quota.id_cuota_plan_pago), quota]));
    const requestedExpenseIds = new Set();

    inputs.forEach((input) => {
      const quotaId = backendId(input.id_cuota_plan_pago || routeQuotaId);
      const existing = quotaId ? currentById.get(quotaId) : null;
      if (quotaId && !existing) throw notFound(`La cuota ${quotaId} no existe dentro del plan.`);
      const previousExpenseId = backendId(existing?.id_egreso);
      const requestedExpenseId = backendId(input.id_egreso);

      if (previousExpenseId !== requestedExpenseId && previousExpenseId) {
        const reason = protectedExpenseReason(cache, previousExpenseId);
        if (reason) throw conflict(`No se puede cambiar el vínculo de la cuota ${existing.nro_cuota}: ${reason}`);
      }
      if (!requestedExpenseId) return;
      const expense = expenseRows(cache).find((row) => backendId(row.id_egreso) === requestedExpenseId);
      if (!expense) throw badRequest(`La cuota ${input.nro_cuota} referencia el egreso ${requestedExpenseId}, que no existe.`);
      if (expenseStateIsIncompatible(expense)) {
        throw conflict(`La cuota ${input.nro_cuota} no puede usar el egreso ${requestedExpenseId} por su estado.`);
      }
      if (requestedExpenseIds.has(requestedExpenseId)) {
        throw conflict(`La cuota ${input.nro_cuota} repite el egreso ${requestedExpenseId} dentro del plan.`);
      }
      requestedExpenseIds.add(requestedExpenseId);

      const linked = quotaRows(cache).find((quota) => (
        backendId(quota.id_egreso) === requestedExpenseId
        && backendId(quota.id_cuota_plan_pago) !== quotaId
      ));
      const linkedWillRelease = linked && inputs.some((candidate) => (
        backendId(candidate.id_cuota_plan_pago) === backendId(linked.id_cuota_plan_pago)
        && backendId(candidate.id_egreso) !== requestedExpenseId
      ));
      if (linked && !linkedWillRelease) {
        throw conflict(`La cuota ${input.nro_cuota} no puede usar el egreso ${requestedExpenseId}: ya está vinculado a la cuota ${linked.nro_cuota}.`);
      }
    });
  }

  function selectableExpenses(cache) {
    const linksByExpense = new Map();
    quotaRows(cache).forEach((quota) => {
      const expenseId = backendId(quota.id_egreso);
      if (expenseId) linksByExpense.set(expenseId, quota);
    });
    return expenseRows(cache)
      .map((expense) => {
        const expenseId = backendId(expense.id_egreso);
        const linked = linksByExpense.get(expenseId);
        const protectedReason = protectedExpenseReason(cache, expenseId);
        return {
          id_egreso: expenseId,
          fecha: backendIsoDate(expense.fecha_prevista_pago) || backendIsoDate(expense.fecha_factura),
          acreedor: String(expense.acreedor || expense._nombre_acreedor || expense.id_acreedor || expense._id_acreedor || ""),
          concepto: String(expense.detalle || [expense.tipo_factura, expense.nro_factura].filter(Boolean).join(" ") || ""),
          importe: normalizeMoney(backendNumber(expense.total)),
          estado: String(expense.estado || ""),
          cuota_vinculada: linked ? backendId(linked.id_cuota_plan_pago) : "",
          plan_vinculado: linked ? backendId(linked.id_plan_pago) : "",
          protegido: Boolean(protectedReason),
          motivo_proteccion: protectedReason || "",
          elegible: Boolean(expenseId) && !expenseStateIsIncompatible(expense)
        };
      })
      .filter((expense) => expense.id_egreso);
  }

  function protectedExpenseReason(cache, expenseId) {
    const id = backendId(expenseId);
    if (!id) return "";
    const paymentIds = new Set((cache.tables?.detalle_pagos?.rows || [])
      .filter((detail) => backendId(detail.id_egreso) === id)
      .map((detail) => backendId(detail.id_pago))
      .filter(Boolean));
    const reconciled = (cache.tables?.movimientos_bancarios?.rows || []).some((movement) => (
      paymentIds.has(backendId(movement.id_pago))
    ));
    if (reconciled) return "el egreso está relacionado con una conciliación bancaria.";
    if (paymentIds.size || (cache.tables?.detalle_pagos?.rows || []).some((detail) => backendId(detail.id_egreso) === id)) {
      return "el egreso tiene pagos aplicados.";
    }
    return "";
  }

  function expenseStateIsIncompatible(expense) {
    const state = String(expense?.estado || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return ["anulad", "cancelad", "inactiv"].some((token) => state.includes(token));
  }

  function validateRelations(cache) {
    const ids = new Set(planRows(cache).map((plan) => backendId(plan.id_plan_pago)));
    quotaRows(cache).forEach((quota) => {
      if (!ids.has(backendId(quota.id_plan_pago))) throw conflict("Una cuota quedó vinculada a un plan inexistente.");
    });
    const grouped = new Set();
    quotaRows(cache).forEach((quota) => {
      const key = `${backendId(quota.id_plan_pago)}:${Number(quota.nro_cuota)}`;
      if (grouped.has(key)) throw conflict("Hay números de cuota duplicados dentro de un plan.");
      grouped.add(key);
    });
    const expenseIds = new Set(expenseRows(cache).map((expense) => backendId(expense.id_egreso)).filter(Boolean));
    const linkedExpenses = new Set();
    quotaRows(cache).forEach((quota) => {
      const expenseId = backendId(quota.id_egreso);
      if (!expenseId) return;
      if (!expenseIds.has(expenseId)) throw badRequest(`El egreso ${expenseId} no existe.`);
      if (linkedExpenses.has(expenseId)) throw conflict(`El egreso ${expenseId} está vinculado a más de una cuota.`);
      linkedExpenses.add(expenseId);
    });
  }

  function requiredPlan(cache, id) {
    const plan = planRows(cache).find((row) => backendId(row.id_plan_pago) === backendId(id));
    if (!plan) throw notFound("El plan de pago no existe.");
    return plan;
  }

  function requiredQuota(cache, planId, quotaId) {
    const quota = quotaRows(cache).find((row) => (
      backendId(row.id_plan_pago) === backendId(planId)
      && backendId(row.id_cuota_plan_pago) === backendId(quotaId)
    ));
    if (!quota) throw notFound("La cuota no existe dentro del plan.");
    return quota;
  }

  function routeIds(request) {
    const path = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`).pathname;
    const match = path.match(/^\/api\/treasury\/payment-plans\/([^/]+)(?:\/quotas\/([^/]+))?/);
    return {
      planId: decodeURIComponent(match?.[1] || ""),
      quotaId: decodeURIComponent(match?.[2] || "")
    };
  }

  function ensureTables(cache) {
    cache.tables ||= {};
    ["planes_pagos", "cuotas_planes_pagos", "egresos", "detalle_pagos", "pagos", "movimientos_bancarios"].forEach((name) => ensureBackendTable(cache.tables, name));
  }

  function planRows(cache) {
    return cache.tables?.planes_pagos?.rows || [];
  }

  function quotaRows(cache) {
    return cache.tables?.cuotas_planes_pagos?.rows || [];
  }

  function expenseRows(cache) {
    return cache.tables?.egresos?.rows || [];
  }

  function updateCounts(cache) {
    cache.tables.planes_pagos.rowCount = planRows(cache).length;
    cache.tables.cuotas_planes_pagos.rowCount = quotaRows(cache).length;
    quotaRows(cache).forEach((quota, index) => { quota._rowNumber = index + 2; });
  }

  function findOperation(cache, operationId) {
    for (const plan of planRows(cache)) {
      const operation = plan._paymentPlanOperations?.[operationId];
      if (operation) return operation;
    }
    return null;
  }

  function rememberOperation(plan, operationId, payload, result) {
    plan._paymentPlanOperations ||= {};
    plan._paymentPlanOperations[operationId] = { payload, result };
  }

  function assertSameOperation(existingPayload, requestedPayload) {
    if (existingPayload === requestedPayload) return;
    throw conflict("La clave de operación ya fue usada con un contenido diferente.");
  }

  function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }

  function formatCentDifference(cents) {
    const absoluteCents = Math.abs(cents);
    return `${formatMoney(fromCents(absoluteCents))} (${absoluteCents} ${absoluteCents === 1 ? "centavo" : "centavos"})`;
  }

  function cleanRequired(value, message) {
    const clean = String(value ?? "").trim();
    if (!clean) throw badRequest(message);
    return clean;
  }

  function failure(response, error, prefix) {
    return sendJson(response, error.statusCode || 400, { ok: false, error: `${prefix} ${error.message}`.trim() });
  }

  function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
  }

  function notFound(message) {
    const error = new Error(message);
    error.statusCode = 404;
    return error;
  }

  function conflict(message) {
    const error = new Error(message);
    error.statusCode = 409;
    return error;
  }

  return {
    ensurePaymentPlansHistory,
    handlePaymentPlanCreate,
    handlePaymentPlanGet,
    handlePaymentPlanQuotaAdd,
    handlePaymentPlanQuotaDelete,
    handlePaymentPlanQuotaUpdate,
    handlePaymentPlanUpdate,
    handlePaymentPlansList
  };
}

module.exports = { createPaymentPlansService };
