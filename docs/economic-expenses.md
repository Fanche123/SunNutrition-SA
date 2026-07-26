# Gastos económicos y aplicaciones a egresos

## Alcance de la primera etapa

Contabilidad incorpora en paralelo `gastos_economicos` y `gastos_egresos`. No reemplaza el Estado de Resultados, no crea filas desde productores, no migra históricos y no modifica `egresos`, pagos, cashflow o planes.

Las tablas se registran en schema, mapa y overview, pero no se siembran en el cache. Administración las expone como solo lectura. Toda escritura usa endpoints especializados.

## Modelo físico

`gastos_economicos`:

`id_gasto_economico`, `periodo_economico`, `id_etiqueta`, `concepto`, `tipo_economico`, `tipo_movimiento`, `importe`, `estado`, `origen_tipo`, `origen_id`, `origen_subclave`, `id_gasto_precedente`, `motivo`, `clave_idempotencia`, `hash_payload`, `creado_en`, `actualizado_en`, `confirmado_en`.

`gastos_egresos`:

`id_gasto_egreso`, `id_gasto_economico`, `id_egreso`, `importe_aplicado`, `componente_egreso`, `componente_otro`, `tipo_aplicacion`, `estado`, `id_aplicacion_precedente`, `motivo`, `clave_idempotencia`, `hash_payload`, `creado_en`.

La identidad funcional incluye `origen_tipo`, `origen_id`, `origen_subclave`, `tipo_economico` y `tipo_movimiento`. `origen_subclave` es una clave técnica estable y no un texto visible.

## Estados y tipos

- Gasto: `borrador`, `confirmado`, `descartado`.
- Movimiento: `original`, `ajuste`, `reversion`.
- Tipo económico: `operativo`, `mercaderia`, `interes_financiero`, `interes_resarcitorio`, `otro_definido`.
- Aplicación: `original`, `sustitucion`, `reversion`.
- Estado de aplicación: `vigente`, `sustituida`, `revertida`.
- Componente: `base_subtotal`, `capital_refinanciado`, `interes_financiero`, `interes_resarcitorio`, `otro`.

Un confirmado no se edita ni elimina. Ajustes y reversiones crean registros confirmados nuevos con precedente y motivo. Solo aplicaciones vigentes originales o sustitutas participan de totales. La conciliación se calcula y no se persiste; expone importe documental, importe aplicado, diferencia y estado `sin_aplicaciones`, `parcial`, `conciliado` o `sobreaplicado`. La tolerancia es `0,01`.

## Endpoints

- `GET /api/economic-expenses`
- `GET /api/economic-expenses/:id`
- `POST /api/economic-expenses/drafts`
- `POST /api/economic-expenses/:id/draft`
- `POST /api/economic-expenses/:id/confirm`
- `POST /api/economic-expenses/:id/discard`
- `POST /api/economic-expenses/:id/adjustments`
- `POST /api/economic-expenses/:id/reversals`
- `POST /api/economic-expenses/applications`
- `POST /api/economic-expenses/applications/:id/replace`
- `POST /api/economic-expenses/applications/:id/reverse`
- `GET /api/economic-expenses/reconciliation/expenses/:idEgreso`
- `GET /api/reports/income-statement/economic-comparison?year=AAAA&month=0..11`

La misma clave idempotente y hash devuelve la fila existente. La misma clave con otro hash devuelve `409`.

## Diagnóstico y compatibilidad

El diagnóstico devuelve resultado legado, totales nuevos, diferencias, borradores, confirmados sin aplicaciones, sobreaplicaciones, identidades funcionales potencialmente duplicadas y productores no integrados. El resultado oficial conserva el cálculo legado.

`egresos.id_acreedor` se difiere. Sus consumidores previstos son Compras, RR. HH., Ventas, Tesorería, matching, cashflow, pagos, clasificación e históricos. `egresos.id_etiqueta` y la resolución histórica se conservan.

No existe migración ni backfill en esta etapa. Una futura migración deberá comenzar con dry-run sobre copia temporal, clasificar ambigüedades y contar con backup y rollback.
