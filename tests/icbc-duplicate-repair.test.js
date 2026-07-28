const assert = require("assert");
const test = require("node:test");
const { repairIcBcDuplicates, REPAIR_KEY } = require("../backend/migrations/20260728-icbc-duplicate-repair");

function row(idKey, id, extra = {}) { return { [idKey]: id, ...extra }; }
function table(rows) { return { headers: [], rows, rowCount: rows.length }; }
function fixture() {
  const expenseIds = [7262,7293,7279,7303,7885,7886,7270,7888,340,342,404,407,411,420,450,453,475,476,492,493,524,525,599,600,632,634,802,806,927,934,955,958,990,996,1162,1163];
  const amounts = {7262:7623,7293:7623,7279:635.25,7303:635.25,7885:-5000000,7886:-5000000};
  return { tables: {
    egresos: table(expenseIds.map((id) => row("id_egreso", id, { total: amounts[id] ?? 1 }))),
    pagos: table([
      [5755,"2026-06-18",7623,7262],[5786,"2026-06-18",7623,7293],[5772,"2026-06-18",635.25,7279],[5796,"2026-06-18",635.25,7303],
      [5881,"2026-06-12",-5000000,7885],[5784,"2026-07-02",40424.79,7291],[5794,"2026-07-02",40424.79,7301],
      [5785,"2026-07-03",10237.5,7292],[5795,"2026-07-03",10237.5,7302]
    ].map(([id,date,amount]) => row("id_pago",id,{fecha_pago:date,metodo:"Transferencia",banco:"ICBC",monto:amount}))),
    detalle_pagos: table([
      row("id_detalle_pago",6549,{id_pago:5786,id_egreso:7293,monto_cancelado:7623}),
      row("id_detalle_pago",6559,{id_pago:5796,id_egreso:7303,monto_cancelado:635.25}),
      row("id_detalle_pago",6650,{id_pago:5881,id_egreso:7885,monto_cancelado:-5000000})
      ,row("id_detalle_pago",6547,{id_pago:5784,id_egreso:7291,monto_cancelado:40424.79})
      ,row("id_detalle_pago",6557,{id_pago:5794,id_egreso:7301,monto_cancelado:40424.79})
      ,row("id_detalle_pago",6548,{id_pago:5785,id_egreso:7292,monto_cancelado:10237.5})
      ,row("id_detalle_pago",6558,{id_pago:5795,id_egreso:7302,monto_cancelado:10237.5})
    ]),
    otros_gastos: table([row("id_otros_gastos",5509,{id_egreso:7293}),row("id_otros_gastos",5519,{id_egreso:7303})]),
    gastos_economicos: table([row("id_gasto_economico",467,{fecha_economica:"2026-06-18",id_etiqueta:"11",concepto:"IMP S/CRED CT",tipo_economico:"operativo",tipo_movimiento:"original",importe:7623,estado:"confirmado",origen_tipo:"otro_gasto",origen_id:"5509",origen_subclave:"base_subtotal"})]),
    gastos_egresos: table([row("id_gasto_egreso",275,{id_gasto_economico:"467",id_egreso:"7293",importe_aplicado:7623,componente_egreso:"base_subtotal",componente_otro:"",tipo_aplicacion:"original",estado:"vigente"})]),
    aportes_socios: table([row("id_aporte_socio",6,{id_egreso:7886})]),
    movimientos_bancarios: table([
      [21,5784,"2026-07-02",40424.79,"IMP S/CRED CT"],[23,5784,"2026-07-02",40424.79,"R/RECAUDACION IB SIRCREB CONV."],
      [17,5785,"2026-07-03",10237.5,"R/RECAUDACION IB SIRCREB CONV."],[18,5785,"2026-07-03",10237.5,"IMP S/CRED CT"],
      [7,5814,"2026-07-07",2590.85,"R/RECAUDACION IB SIRCREB CONV."],[8,5814,"2026-07-07",2590.85,"IMP S/CRED CT"],
      [97,5838,"2026-07-17",2173.32,"IMP S/CRED CT"],[99,5838,"2026-07-17",2173.32,"R/RECAUDACION IB SIRCREB CONV."],
      [93,5835,"2026-07-20",100766.46,"IMP S/CRED CT"],[95,5835,"2026-07-20",100766.46,"R/RECAUDACION IB SIRCREB CONV."]
    ].map(([id,p,date,amount,concept]) => row("id_movimiento_bancario",id,{banco:"ICBC",fecha:date,concepto:concept,detalle:concept,debito:amount,credito:0,importe:-amount,id_pago:p,id_cobro:""})))
  }};
}

test("repara duplicados, revierte append-only y conserva ambiguos", () => {
  const source = fixture();
  const beforeAmbiguous = JSON.stringify(source.tables.movimientos_bancarios.rows.filter((r) => [7,8,97,99,93,95].includes(r.id_movimiento_bancario)));
  const result = repairIcBcDuplicates(source, { timestamp: "2026-07-28T18:00:00.000Z" });
  assert.equal(result.report.idempotent, false);
  assert.deepEqual(result.report.omittedAmbiguous, [7,8,97,99,93,95]);
  assert.equal(result.cache.tables.gastos_economicos.rows.reduce((sum,r)=>sum+Number(r.importe),0), 0);
  assert.equal(result.cache.tables.gastos_economicos.rows.at(-1).clave_idempotencia, REPAIR_KEY);
  assert.equal(result.cache.tables.gastos_egresos.rows.find((r)=>String(r.id_gasto_egreso)==="275").estado, "revertida");
  assert.equal(String(result.cache.tables.gastos_egresos.rows.find((r)=>String(r.id_gasto_egreso)==="275").id_egreso), "7262");
  assert.equal(result.cache.tables.detalle_pagos.rows.find((r)=>String(r.id_detalle_pago)==="6650").id_egreso, 7886);
  assert.equal(result.cache.tables.movimientos_bancarios.rows.find((r)=>r.id_movimiento_bancario===23).id_pago, "5794");
  assert.equal(result.cache.tables.movimientos_bancarios.rows.find((r)=>r.id_movimiento_bancario===18).id_pago, "5795");
  assert.equal(JSON.stringify(result.cache.tables.movimientos_bancarios.rows.filter((r) => [7,8,97,99,93,95].includes(r.id_movimiento_bancario))), beforeAmbiguous);
  [7293,7303,7885].forEach((id)=>assert.equal(result.cache.tables.egresos.rows.some((r)=>String(r.id_egreso)===String(id)),false));
  [5786,5796].forEach((id)=>assert.equal(result.cache.tables.pagos.rows.some((r)=>String(r.id_pago)===String(id)),false));
  assert.equal(JSON.stringify(source), JSON.stringify(fixture()));
  const replay = repairIcBcDuplicates(result.cache);
  assert.equal(replay.report.idempotent, true);
  assert.deepEqual(replay.cache, result.cache);
});

test("drift o multiplicidad abortan sin mutar", () => {
  const source = fixture();
  source.tables.detalle_pagos.rows.find((r)=>r.id_detalle_pago===6549).monto_cancelado = 7622;
  const before = JSON.stringify(source);
  assert.throws(() => repairIcBcDuplicates(source), (error) => error.code === "PRECONDITION_AMOUNT");
  assert.equal(JSON.stringify(source), before);
});

test("estado parcial con marcador se rechaza", () => {
  const applied = repairIcBcDuplicates(fixture()).cache;
  applied.tables.movimientos_bancarios.rows.find((r)=>r.id_movimiento_bancario===23).id_pago = 5784;
  assert.throws(() => repairIcBcDuplicates(applied), (error) => error.code === "PRECONDITION_LINK");
});
