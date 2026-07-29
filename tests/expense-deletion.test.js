const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  applyExpenseDeletion,
  previewExpenseDeletion
} = require("../backend/services/expense-deletion.service");
const { createAdminTableService } = require("../backend/services/admin-table.service");
const {
  backendEditableColumns,
  backendEditablePrimaryKey,
  backendNextNumericId
} = require("../backend/utils/runtime");

const clone = (value) => JSON.parse(JSON.stringify(value));
const table = (headers, rows) => ({ headers, rows, rowCount: rows.length });

function fixture() {
  return {
    generatedAt: "fixture",
    tables: {
      egresos: table(["id_egreso", "total"], [
        { id_egreso: 7237, total: 2453865.12 },
        { id_egreso: 8000, total: 100 },
        { id_egreso: 8001, total: 50 }
      ]),
      gastos_economicos: table(["id_gasto_economico", "importe"], [
        { id_gasto_economico: 432, importe: 2284280.16 },
        { id_gasto_economico: 574, importe: 169584.96 }
      ]),
      gastos_egresos: table(["id_gasto_egreso", "id_gasto_economico", "id_egreso"], [
        { id_gasto_egreso: 240, id_gasto_economico: 432, id_egreso: 7237 },
        { id_gasto_egreso: 286, id_gasto_economico: 574, id_egreso: 7237 }
      ]),
      pagos: table(["id_pago", "monto"], [
        { id_pago: 10, monto: 150 },
        { id_pago: 11, monto: 50 }
      ]),
      detalle_pagos: table(["id_detalle_pago", "id_pago", "id_egreso", "monto_cancelado"], [
        { id_detalle_pago: 1, id_pago: 10, id_egreso: 7237, monto_cancelado: 100 },
        { id_detalle_pago: 2, id_pago: 10, id_egreso: 8000, monto_cancelado: 50 },
        { id_detalle_pago: 3, id_pago: 11, id_egreso: 8001, monto_cancelado: 50 }
      ]),
      movimientos_bancarios: table(["id_movimiento_bancario", "id_pago"], [
        { id_movimiento_bancario: 90, id_pago: 10 },
        { id_movimiento_bancario: 91, id_pago: 11 }
      ]),
      cheques_entregados: table(["id_cheque_entregado", "id_pago"], []),
      cheques_recibidos: table(["id_cheque_recibido", "id_pago_endoso"], []),
      fondos_inversion_movimientos: table(["id_movimiento_fondo", "id_pago"], []),
      otros_gastos: table(["id_otros_gastos", "id_egreso"], [
        { id_otros_gastos: 50, id_egreso: 7237 }
      ]),
      entregas: table(["id_entrega", "id_egreso"], []),
      recepciones: table(["id_recepcion", "id_egreso"], []),
      aportes_socios: table(["id_aporte_socio", "id_egreso"], []),
      cuotas_planes_pagos: table(["id_cuota_plan_pago", "id_egreso"], []),
      sueldos: table(["id_sueldo", "id_egreso"], []),
      comisiones: table(["id_comision", "id_egreso"], [])
    }
  };
}

async function run() {
  {
    const cache = fixture();
    for (const name of ["gastos_egresos", "detalle_pagos", "otros_gastos"]) cache.tables[name].rows = [];
    const plan = previewExpenseDeletion(cache, [7237]);
    assert.equal(plan.canApply, true);
    assert.deepStrictEqual(plan.deleted, []);
    assert.deepStrictEqual(plan.unlinked, []);
    const result = applyExpenseDeletion(clone(cache), [7237], plan.token);
    assert.equal(result.cache.tables.egresos.rows.some((row) => row.id_egreso === 7237), false);
  }
  {
    const cache = fixture();
    const plan = previewExpenseDeletion(cache, [7237]);
    assert.equal(plan.canApply, true);
    assert.deepStrictEqual(plan.deleted.find((item) => item.table === "gastos_egresos").ids, ["240", "286"]);
    assert.equal(plan.preserved.some((item) => item.table === "gastos_economicos" && item.count === 2), true);
    const result = applyExpenseDeletion(clone(cache), [7237], plan.token);
    assert.equal(result.cache.tables.egresos.rows.some((row) => row.id_egreso === 7237), false);
    assert.equal(result.cache.tables.gastos_egresos.rows.length, 0);
    assert.equal(result.cache.tables.gastos_economicos.rows.length, 2);
    assert.equal(result.cache.tables.otros_gastos.rows[0].id_egreso, "");
    assert.equal(result.cache.tables.detalle_pagos.rows.length, 2);
    assert.equal(result.cache.tables.pagos.rows.find((row) => row.id_pago === 10).monto, 50);
    assert.equal(result.cache.tables.movimientos_bancarios.rows.find((row) => row.id_movimiento_bancario === 90).id_pago, "");
    assert.equal(result.cache.tables.movimientos_bancarios.rows.find((row) => row.id_movimiento_bancario === 91).id_pago, 11);
  }
  {
    const cache = fixture();
    cache.tables.detalle_pagos.rows[1].monto_cancelado = 1.005;
    const untouchedVersion = cache.tables.entregas.updatedAt = "sin-cambios";
    const plan = previewExpenseDeletion(cache, [7237]);
    const result = applyExpenseDeletion(clone(cache), [7237], plan.token);
    assert.equal(result.cache.tables.pagos.rows.find((row) => row.id_pago === 10).monto, 1.01);
    assert.equal(result.cache.tables.entregas.updatedAt, untouchedVersion);
  }
  {
    const persisted = fixture();
    const before = clone(persisted);
    const plan = previewExpenseDeletion(persisted, [7237]);
    const staged = applyExpenseDeletion(clone(persisted), [7237], plan.token);
    assert.throws(() => {
      void staged;
      throw new Error("fallo de persistencia simulado");
    }, /persistencia/);
    assert.deepStrictEqual(persisted, before);
  }
  {
    const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
    const frontend = fs.readFileSync(path.resolve(__dirname, "..", "assets/js/modules/data-editor.js"), "utf8");
    assert.match(html, /id="data-editor-delete-summary" role="status" aria-live="polite"/);
    assert.match(html, /id="data-editor-delete-details"/);
    assert.match(html, /relaciones financieras/);
    assert.match(frontend, /\/delete-preview/);
    assert.match(frontend, /deletePlanToken/);
    assert.match(frontend, /confirmButton\.disabled = !payload\.plan\.canApply/);
    assert.match(frontend, /previewSequence !== dataEditorDeletePreviewSequence/);
    assert.match(frontend, /dataset\.planApplicable !== "true"/);
    assert.match(frontend, /También se eliminarán o desvincularán/);
  }
  {
    const cache = fixture();
    const plan = previewExpenseDeletion(cache, [8001]);
    const result = applyExpenseDeletion(clone(cache), [8001], plan.token);
    assert.equal(result.cache.tables.pagos.rows.find((row) => row.id_pago === 11).monto, 0);
    assert.equal(result.cache.tables.movimientos_bancarios.rows[1].id_pago, "");
  }
  {
    const cache = fixture();
    cache.tables.referencia_desconocida = table(["id_ref", "id_egreso"], [{ id_ref: 1, id_egreso: 7237 }]);
    const plan = previewExpenseDeletion(cache, [7237, 8000]);
    assert.equal(plan.canApply, false);
    assert.throws(() => applyExpenseDeletion(clone(cache), [7237, 8000], plan.token), /regla segura/);
    assert.equal(cache.tables.egresos.rows.length, 3);
  }
  {
    const cache = fixture();
    const plan = previewExpenseDeletion(cache, [7237]);
    cache.tables.otros_gastos.rows.push({ id_otros_gastos: 51, id_egreso: 7237 });
    assert.throws(
      () => applyExpenseDeletion(clone(cache), [7237], plan.token),
      (error) => error.code === "ADMIN_DELETE_PLAN_CONFLICT" && error.plan.unlinked.some((item) => item.count === 2)
    );
  }
  {
    const cache = fixture();
    const plan = previewExpenseDeletion(cache, [7237]);
    const once = applyExpenseDeletion(clone(cache), [7237], plan.token);
    const twice = applyExpenseDeletion(once.cache, [7237], plan.token);
    assert.equal(twice.idempotent, true);
    assert.equal(twice.cache.tables.egresos.rows.length, 2);
  }
  {
    const cache = fixture();
    const plan = previewExpenseDeletion(cache, [8000]);
    const before = clone(cache);
    assert.throws(() => applyExpenseDeletion(clone(cache), [8000], "token-invalido"), /vista previa/);
    assert.deepStrictEqual(cache, before);
    const result = applyExpenseDeletion(clone(cache), [8000], plan.token);
    const expenseIds = new Set(result.cache.tables.egresos.rows.map((row) => String(row.id_egreso)));
    for (const [name, target] of Object.entries(result.cache.tables)) {
      if (name === "egresos") continue;
      for (const row of target.rows) {
        if (Object.prototype.hasOwnProperty.call(row, "id_egreso") && row.id_egreso !== "") {
          assert.equal(expenseIds.has(String(row.id_egreso)), true, `${name} conserva una referencia huérfana`);
        }
      }
    }
  }
  {
    let state = fixture();
    let saves = 0;
    const policy = {
      egresos: { read: true, insert: true, update: true, delete: true, category: "administrative", validation: {} }
    };
    const registry = { tables: [{ name: "egresos", primaryKey: "id_egreso" }] };
    const response = () => ({
      status: 0,
      payload: null,
      writeHead(status) { this.status = status; },
      end(raw) { this.payload = JSON.parse(raw); }
    });
    const service = createAdminTableService({
      adminTablePolicy: policy,
      backendEditableColumns,
      backendEditablePrimaryKey,
      backendNextNumericId,
      backendOverview: () => ({ tables: registry.tables }),
      backendTable: () => {
        const current = state.tables.egresos;
        return {
          name: "egresos",
          definition: registry.tables[0],
          headers: current.headers,
          rows: current.rows,
          totalRows: current.rows.length
        };
      },
      loadCache: () => clone(state),
      loadRegistry: () => clone(registry),
      readJsonBody: async (request) => request.body,
      saveBackendCache: (next) => { state = clone(next); saves += 1; },
      sendJson: (target, status, payload) => {
        target.writeHead(status);
        target.end(JSON.stringify(payload));
      }
    });
    const plan = previewExpenseDeletion(state, [7237]);
    const body = {
      rows: [],
      newRows: [],
      deletedIds: ["7237"],
      deletePlanToken: plan.token,
      tableVersion: ":3"
    };
    const first = response();
    await service.handleAdminTableSave(
      { url: "/api/admin/tables/egresos", headers: { host: "127.0.0.1" }, body },
      first
    );
    assert.equal(first.status, 200);
    assert.equal(saves, 1);
    const retry = response();
    await service.handleAdminTableSave(
      { url: "/api/admin/tables/egresos", headers: { host: "127.0.0.1" }, body },
      retry
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.payload.idempotent, true);
    assert.equal(saves, 1);
  }
  console.log("expense-deletion.test.js: OK");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
