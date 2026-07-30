const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyDeliveryDeletion,
  previewDeliveryDeletion
} = require("../backend/services/delivery-deletion.service");
const {
  repairOrder1005DeliveryOrphan
} = require("../backend/migrations/20260729-order-1005-delivery-orphan");
const { runCli } = require("../backend/migrations/20260729-order-1005-delivery-orphan");

const table = (headers, rows) => ({ headers, rows, rowCount: rows.length });
const clone = (value) => JSON.parse(JSON.stringify(value));

function deletionFixture() {
  return {
    marker: { preserved: true },
    tables: {
      pedidos: table(["id_pedido"], [{ id_pedido: 1005 }, { id_pedido: 1006 }]),
      entregas: table(
        ["id_entrega", "id_egreso"],
        [{ id_entrega: 574, id_egreso: "" }, { id_entrega: 575, id_egreso: "" }]
      ),
      entregas_detalle: table(
        ["id_entregas_detalle", "id_entrega", "id_pedido"],
        [
          { id_entregas_detalle: 1006, id_entrega: 574, id_pedido: 1005 },
          { id_entregas_detalle: 1007, id_entrega: 575, id_pedido: 1006 }
        ]
      ),
      ventas: table(
        ["id_venta", "id_entrega", "id_pedido"],
        [
          { id_venta: 1027, id_entrega: 574, id_pedido: 1005 },
          { id_venta: 1028, id_entrega: 575, id_pedido: 1006 }
        ]
      )
    }
  };
}

test("preview y baja de entrega afectan sólo dependencias allowlisted", () => {
  const cache = deletionFixture();
  const plan = previewDeliveryDeletion(cache, [574]);
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.deleted, [
    { table: "entregas", count: 1 },
    { table: "entregas_detalle", count: 1 }
  ]);
  assert.deepEqual(plan.unlinked, [{ table: "ventas", column: "id_entrega", count: 1 }]);
  assert.equal(plan.preserved[0].count, 1);

  const result = applyDeliveryDeletion(cache, [574], plan.token);
  assert.equal(result.idempotent, false);
  assert.deepEqual(cache.marker, { preserved: true });
  assert.deepEqual(cache.tables.pedidos.rows.map((row) => row.id_pedido), [1005, 1006]);
  assert.deepEqual(cache.tables.entregas.rows.map((row) => row.id_entrega), [575]);
  assert.deepEqual(cache.tables.entregas_detalle.rows.map((row) => row.id_pedido), [1006]);
  assert.equal(cache.tables.ventas.rows[0].id_entrega, "");
  assert.equal(cache.tables.ventas.rows[1].id_entrega, 575);
  assert.equal(applyDeliveryDeletion(cache, [574], plan.token).idempotent, true);
});

test("baja aborta sin mutar ante token vencido, egreso o dependencia desconocida", () => {
  for (const mutate of [
    (cache) => { cache.tables.entregas.rows[0].id_egreso = 900; },
    (cache) => { cache.tables.otra = table(["id_otro", "id_entrega"], [{ id_otro: 1, id_entrega: 574 }]); }
  ]) {
    const cache = deletionFixture();
    mutate(cache);
    const before = clone(cache);
    const plan = previewDeliveryDeletion(cache, [574]);
    assert.equal(plan.canApply, false);
    assert.throws(() => applyDeliveryDeletion(cache, [574], plan.token), /dependencias actuales/);
    assert.deepEqual(cache, before);
  }
  const cache = deletionFixture();
  const before = clone(cache);
  const plan = previewDeliveryDeletion(cache, [574]);
  cache.tables.entregas_detalle.rows[0].id_pedido = 9999;
  assert.throws(() => applyDeliveryDeletion(cache, [574], plan.token), /cambiaron/);
  cache.tables.entregas_detalle.rows[0].id_pedido = 1005;
  assert.throws(() => applyDeliveryDeletion(cache, [574], "token-vencido"), /cambiaron/);
  assert.deepEqual(cache, before);
});

function repairFixture() {
  return {
    marker: { preserved: true },
    tables: {
      pedidos: table(["id_pedido", "id_cliente"], [
        { id_pedido: 1005, id_cliente: 37 },
        { id_pedido: 1006, id_cliente: 1 }
      ]),
      entregas: table(["id_entrega"], [{ id_entrega: 575 }]),
      entregas_detalle: table(
        ["id_entregas_detalle", "id_entrega", "id_pedido"],
        [
          { id_entregas_detalle: 1006, id_entrega: "", id_pedido: 1005 },
          { id_entregas_detalle: 1007, id_entrega: "", id_pedido: 1006 }
        ]
      ),
      ventas: table(["id_venta", "id_entrega", "id_pedido"], [
        { id_venta: 1027, id_entrega: "", id_pedido: 1005 }
      ])
    }
  };
}

test("reparación puntual elimina sólo el huérfano #1005 y es idempotente", () => {
  const source = repairFixture();
  const before = clone(source);
  const first = repairOrder1005DeliveryOrphan(source);
  assert.deepEqual(source, before);
  assert.equal(first.report.idempotent, false);
  assert.equal(first.report.removed.id_entregas_detalle, "1006");
  assert.deepEqual(
    first.cache.tables.entregas_detalle.rows.map((row) => row.id_pedido),
    [1006]
  );
  assert.deepEqual(first.cache.tables.pedidos.rows, source.tables.pedidos.rows);
  assert.deepEqual(first.cache.tables.entregas.rows, source.tables.entregas.rows);
  assert.deepEqual(first.cache.tables.ventas.rows, source.tables.ventas.rows);
  const second = repairOrder1005DeliveryOrphan(first.cache);
  assert.equal(second.report.idempotent, true);
  assert.deepEqual(second.cache, first.cache);
});

test("reparación puntual aborta ante firma distinta sin tocar el origen", () => {
  const source = repairFixture();
  source.tables.entregas_detalle.rows[0].id_entrega = 575;
  const before = clone(source);
  assert.throws(() => repairOrder1005DeliveryOrphan(source), /ORPHAN_SIGNATURE_DRIFT/);
  assert.deepEqual(source, before);
});

test("CLI acepta el snapshot reparado como no-op y rechaza cualquier tercer hash", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "order-1005-orphan-"));
  const cacheFile = path.join(directory, "cache.json");
  const backupFile = path.join(directory, "backup.json");
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(repairFixture(), null, 2));
    fs.copyFileSync(cacheFile, backupFile);
    const hash = require("node:crypto").createHash("sha256")
      .update(fs.readFileSync(cacheFile)).digest("hex").toUpperCase();
    assert.equal(runCli(["dry-run", cacheFile, backupFile], hash).report.idempotent, false);
    assert.equal(runCli(["apply", cacheFile, backupFile], hash).report.idempotent, false);
    assert.equal(runCli(["dry-run", cacheFile, backupFile], hash).report.idempotent, true);
    assert.equal(runCli(["apply", cacheFile, backupFile], hash).report.idempotent, true);
    const drift = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    drift.marker.drift = true;
    fs.writeFileSync(cacheFile, JSON.stringify(drift, null, 2));
    assert.throws(() => runCli(["dry-run", cacheFile, backupFile], hash), /SOURCE_HASH_DRIFT/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Editor exige y envía preview firmado también para entregas", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "assets", "js", "modules", "data-editor.js"),
    "utf8"
  );
  assert.match(source, /\["egresos", "entregas"\]\.includes\(view\.table\?\.name\)/);
  assert.match(source, /tables\/\$\{encodeURIComponent\(view\.table\.name\)\}\/delete-preview/);
  assert.match(source, /\["egresos", "entregas"\]\.includes\(view\.table\.name\)[\s\S]*deletePlanToken/);
});
