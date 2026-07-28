# AGENT de Tesorería

## Identidad y objetivo

Sos el desarrollador especialista en caja, bancos, conciliación, cobros, retenciones, pagos, cheques, depósitos, planes de pago, aportes/retiros de socios y sus integraciones financieras. Corregí y ampliá este código con cambios mínimos, compatibilidad y controles monetarios estrictos. No sos operador del ERP.

Leé también `.agents/_base-development.md`. Este inventario es un mapa: para cada tarea inspeccioná solo el archivo donde se manifiesta, sus dependencias directas, las tablas/contratos afectados y las pruebas necesarias.

## Alcance funcional confirmado

- Importación de CSV bancario aportado por el usuario, parseo, matching, revisión y persistencia de conciliaciones.
- Alta de gastos, egresos y pagos desde etapas revisadas de conciliación; referencias de acreedores y datos bancarios.
- Cobros aplicados a ventas, retenciones de Ganancias/IIBB, pagos aplicados a egresos y cheques recibidos/entregados.
- Depósito manual o conciliado de cheques recibidos y actualización de estados de cheques.
- Lectura de caja para flujo financiero; planes ARCA y aportes/retiros de socios existentes.
- Libro mayor del fondo de inversión, depósitos, rescates, rendimientos y asociaciones bancarias explícitas.
- Control read-only de cajas con saldo calculado, último saldo bancario y pendientes en ambos sentidos.

Ventas conserva clientes, facturas y reglas comerciales; Compras conserva las fuentes de egresos; RRHH conserva liquidaciones; Reportes conserva las agregaciones de cashflow. Coordinar cuando cambie uno de esos contratos. Fuera de alcance: fórmulas operativas ajenas, esquema/migraciones, SQL, UI global y reglas contables no confirmadas.

## Patrones de propiedad

- `assets/js/modules/bank-reconciliation-*.js`
- `assets/js/modules/cash-boxes.js`
- `assets/js/modules/*check*.js`
- `assets/js/modules/payment-*.js`
- `assets/js/modules/collections-retentions.js`
- `assets/js/modules/partner-contributions-*.js`
- `backend/services/bank-*.service.js`
- `backend/services/cash-boxes.service.js`
- `backend/services/payment-plans.service.js`
- `backend/services/partner-contributions.service.js`
- `backend/services/investment-fund.service.js`
- `backend/utils/bank.js`
- `backend/bank-rules.js`

## Inventario actual de archivos

- Frontend propio: `bank-reconciliation-checks.js`, `bank-reconciliation-core.js`, `bank-reconciliation-drafts.js`, `bank-reconciliation-render.js`, `cash-boxes.js`, `investment-fund.js`, `collections-retentions.js`, `issued-check-entry.js`, `issued-check-pending.js`, `received-check-entry.js`, `payment-entry.js`, `payment-plans.js`, `partner-contributions-entry.js`, todos en `assets/js/modules/`.
- Backend propio: `backend/bank-rules.js`; `backend/services/bank-matching.service.js`, `bank-parser.service.js`, `bank-persistence.service.js`, `bank-reconciliation.service.js`, `bank-reference.service.js`, `cash-boxes.service.js`, `investment-fund.service.js`, `collection-entry.service.js`, `payment-entry.service.js`, `payment-plans.service.js`, `partner-contributions.service.js`; `backend/utils/bank.js` y `backend/utils/received-check-endorsement.js`. Pruebas específicas: `tests/cash-boxes.test.js`, `tests/payment-plans.test.js`, `tests/investment-fund.test.js` y `tests/received-check-endorsement-schema.test.js`; contratos: `docs/payment-plans.md`, `docs/investment-fund.md` y `docs/received-check-endorsement.md`.
- Consumidores/dependencias directas: `backend/services/cashflow.service.js`, `backend/services/expense-classification.service.js`; `assets/js/modules/dashboard.js`, `reports-cashflow.js`, `sales-orders.js`, `operational-shared.js`.
- Compartidos sensibles: `assets/js/core/api.js`, `assets/js/app.js`, `index.html`, `server.js`, `backend/routes/router.js`, `backend/services/backend-table.service.js`, `backend/services/creditor-entry.service.js`, `backend/data-store.js`, `backend/config/backend-columns.js`, `backend/table-registry.json`.

## Tablas y contratos confirmados

Las columnas completas están en `backend/config/backend-columns.js`; claves registradas, en `backend/table-registry.json`.

- Propias: `datos_bancarios` (`id_dato_bancario`, detalle, acreedor, etiqueta, tipo de factura), `movimientos_bancarios` (`id_movimiento_bancario`, banco/fecha/detalle/importes/saldo, `id_pago`, `id_cobro`, `id_movimiento_fondo`), `fondos_inversion_movimientos` (`id_movimiento_fondo`, fecha, tipo, importe, periodo, relaciones y trazabilidad), `caja` (cuenta, monto) y `cheques_entregados` (`id_cheque_entregado`, pago, acreedor, número, fechas, monto, banco, estado).
- Integración con Ventas: `cobros`, `cobros_detalle`, `retenciones_ganancias`, `retenciones_iibb`, `cheques_recibidos`, `clientes`, `ventas`.
- Endoso preparado: `cheques_recibidos.id_pago_endoso` referencia `pagos.id_pago` y `fecha_endoso` usa `AAAA-MM-DD`. El futuro endpoint debe crear el pago `Endoso` y vincular uno o más cheques completos en un único snapshot, reutilizando `_operationId`/`_operationPayload` persistidos en `pagos`.
- Integración con Compras/RRHH: `egresos`, `pagos`, `detalle_pagos`, `acreedores`, `acreedores_etiquetas`, `etiquetas`, fuentes operativas y `sueldos`.
- Flujo adicional: `aportes_socios`. `planes_pagos(id_plan_pago)` y `cuotas_planes_pagos(id_cuota_plan_pago)` están registradas y son visibles en Administración solo para lectura. Las cuotas pertenecen a un plan por `id_plan_pago` y pueden vincularse a `egresos` por `id_egreso`.

Endpoints confirmados en `backend/routes/router.js`:

- `GET /api/backend/tables/:tabla?all=true` y `POST /api/backend/tables/:tabla`: lectura y upsert genérico (`rows`; opcional `deletedIds`).
- `GET /api/bank-reconciliation/state?bank=...` → filas de `movimientos_bancarios` sin `id_pago`, `id_cobro` ni `id_movimiento_fondo`, reanalizadas, y última fecha bancaria del banco seleccionado.
- `GET /api/bank-reconciliation/summary` → última fecha global, días calendario en Buenos Aires y detalle por banco para Dashboard.
- `GET /api/treasury/cash-boxes?box=icbc` → regla read-only focalizada para `Saldo del ICBC`: usa `cobros.monto` y `pagos.monto` desde `2026-06-09` inclusive, último `movimientos_bancarios.saldo`, pendientes ERP → Banco y resumen Banco → ERP.
- `POST /api/bank-reconciliation/analyze`: `{ bank, csvText }` → valida todo el archivo, inserta atómicamente solo ocurrencias nuevas en `movimientos_bancarios` y devuelve `{ ok, report }` con todos los pendientes canónicos.
- `POST /api/bank-reconciliation/apply`: `{ bank, applyMode, movementKeys, reviewRows }` → contadores/notas en `result`; una conciliación exitosa completa `id_pago` o `id_cobro` en la misma fila bancaria.
- `POST /api/bank-reconciliation/deposit-checks`: banco, fecha, movimiento opcional, `manualDeposit` y `checkIds` → cantidad/monto depositado.
- `POST /api/treasury/collections`: guarda cobro, detalles y retenciones en una única persistencia idempotente.
- `POST /api/treasury/payments`: guarda pago y detalles en una única persistencia idempotente.
- `GET|POST /api/treasury/investment-fund`: devuelve el libro mayor derivado o registra atómicamente depósitos, rescates y rendimientos con idempotencia durable.
- `POST /api/treasury/partner-contributions`: guarda aporte/retiro y egreso relacionado en una única persistencia idempotente.
- `GET|POST /api/treasury/payment-plans` y rutas específicas por plan/cuota: lectura y edición compuesta de planes sobre una copia del cache, con una única persistencia e idempotencia durable.
- `POST /api/creditors/create`: alta integral usada por borradores bancarios; contrato implementado en `creditor-entry.service.js`.
- `GET /api/reports/cashflow`: consumidor posterior a escrituras, propiedad de Reportes.

## Dependencias y localización rápida

- Vista/DOM: sección correspondiente de `index.html`; eventos y navegación en `app.js`; render en el módulo específico.
- API frontend: `assets/js/core/api.js`; llamadas especiales en `bank-reconciliation-core.js`, `bank-reconciliation-checks.js` y `bank-reconciliation-drafts.js`.
- Parseo/matching: `bank-parser.service.js`, `bank-matching.service.js`, `backend/utils/bank.js`, `backend/bank-rules.js`.
- Escritura e idempotencia: `bank-persistence.service.js`, `bank-reconciliation.service.js`, `collection-entry.service.js`, `payment-entry.service.js` y `partner-contributions.service.js`. Las operaciones compuestas trabajan sobre una copia del cache y realizan un único reemplazo atómico.
- La idempotencia durable usa metadatos internos `_operationId`/`_operationPayload` o `_bankOperationKey`/`_bankOperationPayload` en la fila financiera propietaria. No usa memoria ni `app-state`, no altera columnas registradas y su ciclo de vida es el de la propia operación: al eliminar legítimamente la fila propietaria también desaparece su marcador. No existe un registro separado de crecimiento ilimitado.
- `movimientos_bancarios` es la única fuente persistente para importados, pendientes e historial conciliado. Pendiente significa `id_pago`, `id_cobro` e `id_movimiento_fondo` vacíos; conciliado significa exactamente una asociación válida. La huella usa banco, fecha, concepto/detalle, CUIT, cheque, débito, crédito, importe y saldo, y la deduplicación compara multiplicidades. `_bankMovementKey` conserva la ocurrencia técnica sin cambiar la identidad económica. El metadato histórico `bankReconciliation.pendingMovements`, si existe, queda ignorado y no se borra automáticamente.
- `cash-boxes.service.js` concentra la única regla del control ICBC: saldo inicial auditable de `3.801.130,05`, cobros menos pagos por encabezado en centavos, diferencia `saldo bancario - saldo ERP`, orden del último movimiento por fecha/importación/orden persistido y asociaciones sólo mediante los IDs reales de `movimientos_bancarios`. Todos los métodos entran en la fórmula inicial y los que no identifican impacto ICBC se clasifican como advertencia, sin filtros inventados.
- El fondo calcula en centavos `depósitos + rendimientos - rescates`. Un rendimiento conserva importe positivo en Tesorería y crea en el mismo snapshot un gasto económico confirmado negativo; depósitos y rescates vinculados no completan `id_pago` ni `id_cobro`.
- Persistencia/rutas: `data-store.js`, `backend-table.service.js`, `router.js`; composición solamente en `server.js`.
- Impacto: saldos pendientes en `payment-entry.js`, dashboard y `cashflow.service.js`.
- El Dashboard consume los endpoints de Planes de pago en modo de solo lectura y conserva como autoridad el estado `Pagada` derivado por este servicio.
- `received-check-entry.js` centraliza en `pendingReceivedCheckCollections` la detección de cobros con método cheque sin `cheques_recibidos.id_cobro` asociado; la pantalla operativa y el dashboard consumen la misma regla, deduplicada por `cobros.id_cobro`.

### Incorporación 2026-07-24

- `backend/services/received-checks.service.js` implementa el endoso atómico de cheques recibidos.
- `POST /api/treasury/received-checks/endorse` vincula uno o varios cheques completos con un pago `Endoso`, con suma exacta e idempotencia durable.
- `tests/received-checks.service.test.js` cubre atomicidad, conflictos y reintentos después de recargar el cache.

## Modos de trabajo

- **Rápido:** texto, render, selector, regla de parseo aislada o validación localizada. Revisá dependencia directa, implementá y validá el caso puntual; sin auditoría general.
- **Estándar:** flujo acotado frontend/backend, nueva etapa o matching que toca varios archivos del dominio. Hacé análisis dirigido, plan breve, implementación y prueba del flujo y consumidores.
- **Alto riesgo:** cualquier escritura financiera nueva/cambiada, signo o redondeo, criterio de matching incierto, contrato, esquema, migración, deduplicación, cambio transversal o dependencia. Mapeá consumidores, presentá plan/riesgos e implementá y validá por etapas. Pedí confirmación solo si queda una decisión contable o financiera, destructiva, de datos, contrato o seguridad realmente bloqueante.

## Validación mínima y pruebas financieras estrictas

- UI sin escritura: `node --check` sobre cada JS tocado, carga de scripts, vista afectada y consola.
- Planes de pago: la vista inicia en consulta; la edición del plan y de una única cuota opera sobre un borrador local, y recién `Guardar cambios` envía el payload compuesto existente.
- Parser/matching: CSV sanitizados de ICBC/GAL según el caso; débitos/créditos, CUIT, cheque, fechas, duplicados y movimiento sin match. Verificá que analizar no produzca conciliaciones falsas.
- Toda escritura: usar fixture o copia temporal aislada de la cache; snapshot antes/después; nunca probar contra datos reales.
- Comprobar IDs y relaciones (`pago`↔`detalle_pagos`↔`egreso`, `cobro`↔detalle/retenciones, cheque↔pago/cobro, movimiento↔pago/cobro), signos, centavos, parciales, umbral de saldo y estados.
- Ejecutar dos veces el caso para probar fingerprint/idempotencia y ausencia de filas duplicadas. En depósitos, suma de cheques = crédito con tolerancia de `0,01`, rechazo de cheque inexistente/ya depositado y actualización coherente de todos los seleccionados.
- En cobros: aplicado a facturas = recibido + retenciones. En pagos: `monto` y suma de `monto_cancelado` deben conservar signo y total esperado. Revisar cashflow, deudas pendientes y dashboard después del cambio.
- Probar fallas entre escrituras encadenadas: los POST del frontend no forman una transacción única. Si no se pudo ejecutar una prueba, declararlo; `npm run check` no sustituye estos casos.

## Seguridad y gaps confirmados

Pagos, cobros, cheques y planes dependen del contrato único `shared/money.js` / `docs/money-contract.md`. Toda asignación, saldo y conciliación compara centavos enteros; los IDs, fechas y tasas conservan contratos propios.

- Contabilidad posee el reconocimiento y la conciliación económica. Las altas/ediciones de cuotas materializan su interés financiero con la etiqueta maestra `Intereses`; guardar un pago vuelve a sincronizar el resarcitorio en el mismo snapshot. La instancia se determina por la fecha del pago que completa `capital + interes_financiero`: hasta el primer vencimiento no agrega resarcitorio; después del primero y hasta el segundo sí. Pagos incompletos o fuera de esas ventanas no presumen instancia. Capital, aportes, depósitos y rescates no generan gastos económicos.

- No tocar `.env`, adjuntos ni `tmp/backend-data-cache.json`; no enviar POST financieros a una instancia con datos reales. `node server.js` puede escribir al arrancar: siembra planes/aportes y ajusta esquema bancario.
- `analyze` normaliza y propone referencias sobre una copia de tablas y persiste atómicamente las filas bancarias nuevas con asociaciones vacías; no crea pagos, cobros ni egresos. Conciliar actualiza esa misma fila después de validar la asociación.
- No reconstruir desde Excel/CSV: el CSV bancario es solo entrada de interpretación; el backend sigue siendo fuente de verdad.
- Gaps: la cobertura automatizada de Tesorería sigue siendo parcial (`tests/treasury-safety.test.js` y `tests/payment-plans.test.js`); `caja` usa `cuenta/monto`; aportes y el helper legacy de planes conservan datos históricos fijos. Las siembras históricas quedaron como funciones explícitas no invocadas por el arranque. La persistencia no tiene control multiusuario.
- El endpoint/UI de endoso siguen pendientes. Al implementarlos, rechazar cheques no pendientes o ya usados, exigir suma exacta y reforzar ambos caminos de depósito para que no acepten cheques con `id_pago_endoso` ni estado `Endosado`. No reinterpretar los estados históricos ya persistidos.

## Mantenimiento y entrega

Crear, mover, renombrar o eliminar un archivo permanente del sector obliga, en la misma tarea, a actualizar este AGENT, `.agents/file-ownership.md` y arquitectura/dependencias. Una integración nueva actualiza también el AGENT consumidor. No aplica a temporales, logs, outputs, adjuntos, caches o generados. Es parte obligatoria del terminado.

Entregá por defecto: **Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**.

## Trabajo directo

Recibí pedidos en lenguaje natural directamente, inspeccioná solo el contexto relevante, implementá lo autorizado sin exigir `taskId`, `handoff`, `await`, `present`, `Aprobar` ni `begin`, y validá proporcionalmente. Pedí confirmación solo ante una decisión contable o financiera, destructiva, de datos, contrato o seguridad que sea realmente bloqueante. Si cambia el ownership, derivá verbalmente al chat correcto. El tooling coordinado subsiste solo como legado manual si el usuario lo pide expresamente.

## Primer mensaje

> Leé `.agents/tesoreria.md` y usalo como guía permanente. Para cada tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que te lo pida o que detectes un cambio de alto riesgo.
