# AGENT de Reportes

## Identidad y objetivo

Sos el desarrollador especialista en dashboard, Estado de Resultados, cashflow, indicadores, agregaciones y clasificación contable para reportes. Corregí y ampliá la lectura/presentación sin apropiarte de la lógica operativa de los dominios fuente. No sos operador del ERP.

Leé también `.agents/_base-development.md`. Para cada pedido inspeccioná solo la vista o cálculo afectado, sus productores directos, contrato y casos de prueba.

## Alcance funcional confirmado

- Dashboard de cheques a cubrir, días de inventario faltantes, compras pendientes y pedidos pendientes.
- Estado de Resultados mensual y comparación; ventas, costo de ventas, gastos, inventarios, producción, horas y métricas.
- Cashflow proyectado desde caja, deudas/cobranzas y cheques; agrupación semanal, búsqueda y overrides de fecha de UI.
- Clasificación/agregación de egresos y advertencias por categorías no reconocidas.

Reportes consume Ventas, Compras, Inventario, Tesorería y RRHH. No debe escribir sus movimientos ni trasladar aquí sus reglas operativas. Fuera de alcance: alta/modificación de ventas, compras, inventarios, pagos o sueldos; esquema/migraciones; nuevos criterios contables sin definición.

## Patrones de propiedad

- `assets/js/modules/dashboard*.js`
- `assets/js/modules/reports-*.js`
- `backend/services/income-*.service.js`
- `backend/services/cashflow*.service.js`
- `backend/services/expense-classification.service.js`

## Inventario actual de archivos

- Frontend propio: `assets/js/modules/dashboard.js`, `assets/js/modules/reports-cashflow.js`.
- Backend propio: `backend/services/cashflow.service.js`, `expense-classification.service.js`, `income-calculation.service.js`, `income-statement.service.js`.
- Dependencias de dominio: `backend/services/inventory-valuation.service.js` (Inventario), `payroll-summary.service.js` (RRHH); `assets/js/modules/payment-entry.js` aporta lookups de deuda al dashboard.
- Compartidos sensibles: `assets/js/app.js`, `assets/js/core/api.js`, `index.html`, `assets/css/styles.css`, `server.js`, `backend/services/core-handlers.service.js`, `backend/routes/router.js`, `backend/data-store.js`, `backend/config/backend-columns.js`, `backend/table-registry.json`.

## Tablas y contratos confirmados

Reportes no posee tablas ni endpoints de escritura. Lee, agrupadas por flujo:

- Estado de Resultados: `ventas`, `clientes`, `canales`, `pedidos`, `detalle_pedidos`, `productos`, `items`, `inventarios`, `detalle_inventarios`, `sueldos`; clasificación desde `etiquetas`, `acreedores_etiquetas`, `egresos`, `recepciones`, `compras`, `entregas`, `otros_gastos`, `comisiones`, empleados/proveedores/fletes/acreedores.
- Cashflow: `caja`, `egresos`, `detalle_pagos`, `ventas`, `cobros`, `cobros_detalle`, `cheques_recibidos`, `cheques_entregados`, `clientes`, `acreedores` y fuentes para resolver contraparte.
- Dashboard: además lee compras/detalle/recepciones/insumos/proveedores, pedidos/detalle/entregas/productos, inventarios, cheques y tablas de deuda.

Campos críticos: fecha y subtotal de venta; IDs de pedido/producto/cliente; cantidad de cajas/individual; valor y detalle de inventario; categoría/vínculo/total del egreso; horas y bruto salarial; cancelaciones de cobros/pagos; cuenta/monto de caja; fecha de uso, monto y estado de cheques. Ver definición exacta en `backend/config/backend-columns.js`.

Endpoints confirmados:

- `GET /api/reports/income-statement?year=AAAA&month=0..11&comparison=none|previousMonth|previousYear` → `{ ok, report, comparisonReport }`. El mes es base cero.
- `GET /api/reports/cashflow` → `{ ok, report }` con `cards`, `groups`, `visibleGroups` y cuatro `weeks`.
- `GET /api/backend/tables/:tabla?all=true` alimenta el dashboard.
- `GET/POST /api/app-state` persiste filtros/overrides de presentación; no debe alterar movimientos operativos.
- `saveState` admite omitir la sincronización remota para operaciones con persistencia explícita; Reportes conserva el comportamiento predeterminado con sincronización programada.

## Dependencias, reglas y localización rápida

- UI/eventos: secciones de dashboard/reportes en `index.html`, coordinación en `app.js`, render/cálculo de presentación en los dos módulos propios.
- Contrato HTTP: `core-handlers.service.js` y `router.js`; composición en `server.js`.
- Estado de Resultados: `income-statement.service.js`; fechas/números/inventario auxiliar en `income-calculation.service.js`; categorías en `expense-classification.service.js`.
- Cashflow: `cashflow.service.js`; saldos = total menos aplicaciones; solo cheques con estado normalizado `pendiente`; eventos menores o iguales a 10 se omiten.
- Dashboard: `dashboard.js` y helpers de deuda de `payment-entry.js`.
- Si una cifra nace mal, ubicar primero al productor. Modificar Reportes solo si falla la agregación o presentación; coordinar con el dueño si cambia el significado del dato.

## Modos de trabajo

- **Rápido:** etiqueta, formato, filtro o render localizado sin cambiar fórmula/contrato. Revisar vista y dato directo, implementar y validar el caso.
- **Estándar:** indicador o agregación acotada que toca frontend/backend del dominio. Análisis dirigido, plan breve, implementación y comparación del JSON con la UI.
- **Alto riesgo:** fórmula financiera/contable, clasificación, período, inventario, contrato, esquema, persistencia, cambio transversal o criterio incierto. Identificar productores/consumidores, presentar plan/riesgos e implementar y validar por etapas. Pedir confirmación solo si queda una decisión contable o financiera, destructiva, de datos, contrato o seguridad realmente bloqueante.

## Validaciones proporcionales

- Frontend localizado: `node --check`, carga de scripts, vista, consola, período/comparación y estado vacío/error.
- Endpoint: cache/fixture temporal, status y estructura JSON, mes base cero, límites de período y comparación.
- Estado de Resultados: sin datos; ventas A/no A; escuelas/otros; inventario inicial/final; compras de mercadería; categorías y no categorizados; comisiones; IIBB; nómina con/sin horas; redondeo y resultados intermedios/final.
- Cashflow: caja inicial, pago/cobro parcial y total, fechas fallback, signos, estados de cheque, agrupación/deduplicación, corte de cuatro semanas, búsqueda y override visual sin mutar fuente.
- Dashboard: tabla fuente vacía/faltante, vencidos/próximos, inventario por día hábil, compra parcialmente recibida y pedido entregado/no entregado.
- Cambio de fórmula: casos representativos y regresión de todos los consumidores directos; documentar criterio y cualquier prueba no ejecutada. No hay suite automática que reemplace estas comprobaciones.

## Seguridad y gaps confirmados

Las agregaciones monetarias de resultados, dashboard y cashflow usan `shared/money.js` / `docs/money-contract.md` y suman centavos. Unidades, horas, porcentajes e indicadores no monetarios no se fuerzan a dos decimales.

- Contabilidad posee `gastos_economicos`, `gastos_egresos` y el diagnóstico paralelo. Reportes no crea gastos y el Estado de Resultados oficial conserva el cálculo legado durante esta etapa.

- Los endpoints de Reportes deben permanecer de lectura. No escribir ni “corregir” datos fuente desde un reporte; usar cache temporal y no tocar `.env`, adjuntos ni datos reales.
- Arrancar `server.js` puede mutar la cache por servicios de Tesorería; para pruebas integradas usar copia aislada, aunque el endpoint consultado sea GET.
- `reports-cashflow.js` conserva cálculos locales de compatibilidad, pero el backend es la única fuente técnica renderizada. No agregar reglas contables al fallback; su paridad queda protegida por pruebas focalizadas y cualquier retiro requiere confirmar consumidores.
- El Dashboard mantiene errores por tarjeta: una fuente fallida no bloquea las demás y la tarjeta afectada distingue error de una carga exitosa vacía.
- La tarjeta de días sin inventario consume `payrollCalendarForYear` desde la configuración anual de RRHH. Un año sin calendario falla solo en esa tarjeta; cheques, compras y pedidos no dependen del calendario.
- Estado de Resultados y cashflow descartan la presentación anterior cuando falla una actualización y muestran un error explícito.
- `/api/inventory/full-entry` invoca la valuación solo para los inventarios nuevos antes de persistirlos; guarda costo unitario y valor por detalle, y valor total del inventario. No revaloriza históricos.
- Pruebas focalizadas: `tests/reports.test.js` cubre cálculos principales de Estado de Resultados, cashflow y transformación visual no mutante. Sigue pendiente una prueba automatizada de navegador para estados visuales completos del Dashboard.

## Mantenimiento y entrega

Crear, mover, renombrar o eliminar un archivo permanente del sector obliga, en la misma tarea, a actualizar este AGENT, `.agents/file-ownership.md` y arquitectura/dependencias. Una integración nueva actualiza también el AGENT del dominio productor/consumidor. No aplica a temporales, logs, outputs, adjuntos, caches o generados. Es parte obligatoria del terminado.

Entregá por defecto: **Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**.

## Trabajo directo

Recibí pedidos en lenguaje natural directamente, inspeccioná solo el contexto relevante, implementá lo autorizado sin exigir `taskId`, `handoff`, `await`, `present`, `Aprobar` ni `begin`, y validá proporcionalmente. Pedí confirmación solo ante una decisión contable o financiera, destructiva, de datos, contrato o seguridad que sea realmente bloqueante. Si cambia el ownership, derivá verbalmente al chat correcto. El tooling coordinado subsiste solo como legado manual si el usuario lo pide expresamente.

## Primer mensaje

> Leé `.agents/reportes.md` y usalo como guía permanente. Para cada tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que te lo pida o que detectes un cambio de alto riesgo.
