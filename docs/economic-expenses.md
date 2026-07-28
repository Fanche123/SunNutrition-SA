# Gastos económicos y aplicaciones a egresos

## Alcance vigente

Contabilidad mantiene `gastos_economicos` como fuente del reconocimiento económico y `gastos_egresos` como relación derivada con obligaciones financieras. `egresos`, pagos y cashflow conservan la obligación y su cancelación; no determinan por sí mismos el resultado económico.

Para todos los períodos, el Estado de Resultados consume exclusivamente gastos confirmados de `gastos_economicos`. Recepciones, egresos, otros gastos, logística, comisiones, sueldos, planes y demás productores sólo pueden poblar esa tabla; nunca completan el reporte directamente. Un período sin filas económicas confirmadas muestra gastos en cero. El mes no se persiste: se deriva de `fecha_economica`.

## Modelo físico

`gastos_economicos`:

`id_gasto_economico`, `fecha_economica`, `id_etiqueta`, `concepto`, `tipo_economico`, `tipo_movimiento`, `importe`, `estado`, `origen_tipo`, `origen_id`, `origen_subclave`, `id_gasto_precedente`, `motivo`, `clave_idempotencia`, `hash_payload`, `creado_en`, `actualizado_en`, `confirmado_en`.

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

Un confirmado no se edita ni elimina. Ajustes y reversiones crean registros confirmados nuevos con precedente y motivo. En originales, `id_gasto_precedente` y `motivo` quedan vacíos. Solo aplicaciones vigentes originales o sustitutas participan de totales. La conciliación se calcula y no se persiste; expone importe documental, importe aplicado, diferencia y estado `sin_aplicaciones`, `parcial`, `conciliado` o `sobreaplicado`. La tolerancia es `0,01`.

## Carga histórica autorizada

`backend/migrations/20260727-economic-expenses-history.js` migra el esquema y construye una carga idempotente desde `2026-04-01` hasta una fecha final explícita:

- recepción: subtotal del egreso vinculado, sin IVA;
- otro gasto: subtotal del egreso vinculado, sin IVA ni filas de Ingresos Brutos;
- logística: subtotal del egreso vinculado;
- comisión: subtotal de cada venta multiplicado por `canales.comision`, resolviendo `venta → cliente → canal`;
- Ingresos Brutos: `1,5%` del subtotal de cada venta emitida como `Factura_A` o `Factura_B`;
- sueldo: `sueldo_neto`;
- impuestos internos: `egresos.imp_internos`, por `egresos.fecha_factura`, con identidad `egreso + impuestos_internos` y etiqueta maestra `Impuestos Internos`; el Estado de Resultados la agrupa bajo `Otros Impuestos`.
- plan de pago: `interes_financiero` anticipado por cuota y `interes_resarcitorio` sólo cuando la evidencia persistida valida la segunda instancia.

`id_etiqueta` se resuelve desde `id_acreedor_etiqueta` y `acreedores_etiquetas`. Para un otro gasto histórico sin vínculo directo, `_etiqueta_gasto` solo se admite si coincide exactamente con una única relación canónica del mismo acreedor. Cuando una entrega histórica no conserva el vínculo directo, se admite la única relación canónica `Logistica` del flete. Ingresos Brutos usa la etiqueta maestra homónima porque su origen es la venta y no un acreedor. Una fila sin fecha, importe, origen o etiqueta canónica se excluye y aparece contada por motivo en el reporte de la migración. Las recepciones que comparten un mismo egreso se excluyen mientras no exista un criterio de asignación del subtotal.

Los sueldos se reconocen por neto porque cargas sociales se pagan y reconocen separadamente; no se aplican automáticamente al egreso. Un bruto confirmado previo se neutraliza con una reversión y el neto se agrega como identidad separada, sin editar ni eliminar confirmados.

La identidad salarial canónica es empleado + período mensual. Si existen varias filas fuente con el mismo neto, egreso y vínculo de etiqueta, el materializador conserva una sola: prioriza la que contiene datos de liquidación y luego el menor `id_sueldo`. Las copias equivalentes se reportan como `fuente_duplicada_empleado_periodo` y no crean otro gasto. Importes, egresos o etiquetas incompatibles para un mismo empleado/período detienen la migración.

Cada cuota crea anticipadamente sólo su interés financiero con la etiqueta maestra `Intereses`. La instancia de pago se obtiene de `detalle_pagos → pagos.fecha_pago`: se ordenan las aplicaciones y se toma la fecha en que el acumulado completa `capital + interes_financiero`, sin usar los totales históricos de vencimiento. Hasta el primer vencimiento conserva sólo el financiero; después del primero y hasta el segundo agrega el resarcitorio. Un pago incompleto, sin fecha canónica o posterior al segundo vencimiento no habilita inferencias. Si evidencia posterior deja de validar la segunda instancia, el materializador agrega una reversión idempotente del resarcitorio.

Aportes de socios, depósitos y rescates del fondo, movimientos entre cuentas, capital de cuotas e IVA quedan fuera del gasto económico. Los rendimientos del fondo conservan su integración propia como gasto negativo confirmado.

La migración crea `clave_idempotencia` y `hash_payload` determinísticos. El reintento idéntico no agrega filas; una clave o identidad funcional con otro payload falla. Antes de persistir la cache real se exige una copia verificable por SHA-256, bytes y conteos de tablas.

### Ejecución inicial del 2026-07-27

La carga real hasta `2026-07-27` creó 104 gastos confirmados: 14 recepciones, 62 otros gastos y 28 sueldos. Creó 76 aplicaciones exactas a egresos. El reintento posterior releyó las 104/76 filas sin insertar duplicados.

La ampliación de costos de venta agregó 75 gastos de Ingresos Brutos y 43 de logística, más 43 aplicaciones al subtotal de sus egresos. La cache quedó con 222 gastos económicos y 119 aplicaciones. El reintento no insertó filas. En abril de 2026 resultaron `214.200` de Ingresos Brutos y `4.143.600` de logística, ambos sin IVA.

La ampliación de comisiones agregó 89 gastos confirmados por venta, sin aplicaciones financieras. La cache quedó con 311 gastos económicos y 119 aplicaciones. En abril de 2026, 21 ventas del canal Patricia al `5%` produjeron `1.417.500` de comisiones.

La ampliación de otros gastos agregó 163 gastos confirmados y 163 aplicaciones. También creó 2 reversiones económicas y 2 reversiones de aplicaciones para neutralizar IIBB históricos que habían llegado por otros gastos: el único IIBB oficial permanece calculado al `1,5%` de ventas A/B. La cache quedó con 476 gastos económicos y 284 aplicaciones; el reintento no insertó filas.

En abril de 2026, otros gastos aportó `10.782.020,25`: `9.636.234,31` operativos (`Servicios`, `Varios`, `Alquiler` y `Administrativos`; el neto de los movimientos etiquetados `Sueldos` fue cero) y `1.145.785,94` no operativos (`Impuesto Cred`, `Impuesto Deb`, `Impuesto Sello`, `Gastos Bancarios` e `Intereses`).

Quedaron excluidos por falta de criterio o dato canónico:

- 2 recepciones que comparten un egreso y no tienen asignación de subtotal;
- 3 otros gastos sin vínculo canónico, 50 etiquetados como IVA, 6 sin subtotal económico y 31 etiquetados como Ingresos Brutos;
- 2 entregas sin subtotal económico; otras 43 resolvieron la relación canónica del flete;
- 2 ventas A/B sin subtotal económico;
- 24 sueldos sin bruto; los 21 sueldos con egreso no se aplicaron porque el egreso no representa el bruto;
- 9 cuotas de planes sin etiqueta canónica;
- 1 aporte de socio; no existían depósitos o rescates persistidos en la tabla del fondo dentro del corte;
- la tabla `comisiones` estaba vacía y no se usa como fuente económica; 2 ventas quedaron sin comisión por no tener subtotal.

Las escrituras de `ventas`, `entregas`, `otros_gastos`, `sueldos`, cuotas, pagos y detalle de pagos ejecutan el materializador idempotente antes del único guardado de la cache. Los endpoints compuestos de planes y pagos aplican el mismo contrato en su snapshot. Una venta materializa tanto Ingresos Brutos como la comisión de su canal. El reporte continúa siendo de solo lectura y nunca reconstruye estos importes.

La corrección real autorizada de intereses y sueldos netos se aplicó con backup verificable. Una primera ejecución reveló 18 fuentes salariales funcionalmente duplicadas —9 en abril por `9.047.699,27` y 9 en mayo por `8.507.944,80`—. Se restauró el backup original y se reaplicó el materializador corregido: 34 reconocimientos netos canónicos, 28 reversiones de bruto, 30 intereses financieros y 4 resarcitorios. La cache quedó con 572 gastos económicos y 284 aplicaciones; el reintento no insertó filas.

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

La misma clave idempotente y hash devuelve la fila existente. La misma clave con otro hash devuelve `409`. `GET /api/economic-expenses?periodo=AAAA-MM` conserva el filtro mensual como consulta, derivado de `fecha_economica`; no existe una columna mensual.

## Diagnóstico y compatibilidad

El diagnóstico devuelve resultado oficial, totales económicos, diferencias, borradores, confirmados sin aplicaciones, sobreaplicaciones e identidades funcionales potencialmente duplicadas. Reportes no crea ni corrige gastos.

`egresos.id_acreedor` se difiere. Sus consumidores previstos son Compras, RR. HH., Ventas, Tesorería, matching, cashflow, pagos, clasificación e históricos. `egresos.id_etiqueta` y la resolución histórica se conservan.

La reversión operativa de una carga aplicada se realiza restaurando el backup verificado completo. No se eliminan confirmados individualmente para simular un rollback.
