# Plan y estado de manuales AGENT

Última revisión: **2026-07-24**. Fuente técnica: código actual, `backend/table-registry.json` y `backend/routes/router.js`. Los reportes/auditorías históricas se usan como contexto, no prevalecen sobre el código.

## Estado

| Manual | Estado | Patrones principales | Tablas principales | Endpoints específicos |
|---|---|---|---|---|
| Arquitectura | Creado | core, router, utils, composición | Ninguna propia | Todos como diseño |
| Base de datos | Creado | config, repositories, data-store, SQL tools | Las 43 registradas | schema, tables, map, SQL |
| Inventario | Creado | `inventory-*` | items/maestros, inventarios/detalle | `/api/inventory*`, `/api/inventory-detail*` |
| Compras | Creado | `purchase-*`, `reception-*`, acreedores | compras, recepciones, egresos y relacionados | purchases/full-entry, creditors/create, adjuntos |
| Ventas | Creado | `sales-*` | clientes, pedidos, entregas, ventas | tablas genéricas; sin servicio específico de ventas |
| Tesorería | Creado | bank, checks, payments, collections | banco, caja, cobros, pagos, cheques | conciliación y depósito; tablas genéricas |
| RRHH | Creado | `salary-*`, `payroll-*` | empleados, sueldos, sueldos_calculo | payroll-scale/read; tablas genéricas |
| Reportes | Creado | dashboard, reports, income, cashflow | Consume tablas de todos los dominios | income-statement, cashflow |
| Contabilidad | Creado | economic expenses, applications, comparison | gastos_economicos, gastos_egresos | gastos económicos, aplicaciones y diagnóstico |
| Administración | Creado | data editor/map/sql | Todas por herramientas internas | schema, tables, map, SQL |
| UI/UX | Creado | HTML, CSS, SVG | Ninguna | Ninguno propio |
| Bugs | Creado | Derivación | Según dominio | Según dominio |
| Nuevas funcionalidades | Creado | Definición transversal | Según dueño | Según alcance |
| Analista funcional | Creado | Especificaciones | Según proceso | No implementa por defecto |
| Coordinador | Legado opcional | `.coordination/`, `tools/coordination*`, protocolo histórico | No accede a tablas operativas | Responses API solo por activación manual explícita |

## Inventario técnico actual

- Frontend: 3 archivos core y 34 módulos en `assets/js/modules/`.
- Backend: 24 servicios, 1 repositorio, 1 router, 3 archivos config principales y 6 utilidades.
- Tablas: 43 definiciones registradas, agrupadas en `maestros`, `inventario`, `ventas`, `compras` y `tesoreria`.
- Router: rutas globales de health/esquema/tablas/mapa/app-state/reportes y 16 rutas exactas, verificadas en código.
- Ownership concreto y patrones: `.agents/file-ownership.md`.

## Archivos actuales por propietario

| Propietario | Archivos de runtime principales |
|---|---|
| Arquitectura | `server.js`, `assets/js/app.js`, `assets/js/dom-utils.js`, `assets/js/core/{api,files,formatters}.js`, `assets/js/modules/{operational-data-coordinator,operational-shared}.js`, `backend/routes/router.js`, `backend/http-config.js`, `backend/services/core-handlers.service.js`, `backend/utils/{files,http,ids,runtime}.js`, `tools/check-js.ps1` |
| Inventario | siete módulos `inventory-*`, cuatro servicios `inventory-*` y `backend/utils/inventory-numbers.js` |
| Compras | `purchase-entry.js`, `reception-entry.js`, `reception-options.js`, `other-expense-entry.js`, `purchase-entry.service.js`, `creditor-entry.service.js`, `attachments.service.js` |
| Ventas | `sales-orders.js`, `logistics-entry.js`, `commissions-entry.js`; no hay servicio backend propio |
| Tesorería | cuatro módulos `bank-reconciliation-*`, módulos de cobros/pagos/cheques/planes/aportes, cinco servicios `bank-*`, servicios de planes/aportes, `backend/bank-rules.js`, `backend/utils/bank.js` |
| RRHH | `salary-entry.js`, `salary-expense-entry.js`, `payroll-normalization.service.js`, `payroll-summary.service.js` |
| Reportes | `dashboard.js`, `reports-cashflow.js`, `cashflow.service.js`, `expense-classification.service.js`, `income-calculation.service.js`, `income-statement.service.js` |
| Contabilidad | `economic-expenses.service.js`, `economic-expense-applications.service.js`, `economic-expense-comparison.service.js`, sus pruebas y `docs/economic-expenses.md` |
| Administración | `data-editor.js`, `data-map.js`, `sql-console.js`, `backend-map.service.js`, `backend-table.service.js`, `sql.service.js` |
| UI/UX | `index.html`, `assets/css/styles.css` y los 16 SVG de `assets/icons/` |
| Base de datos | `backend/data-store.js`, `backend/table-registry.json`, `backend/config/{backend-columns,backend-projections,paths}.js`, `backend/repositories/app-state.repository.js`, herramientas de auditoría/SQL |

Los inventarios concretos completos están en cada AGENT; las asignaciones de compartidos y documentación están en `.agents/file-ownership.md`.

## Tablas y endpoints verificados

- **Maestros (9):** `etiquetas`, `acreedores`, `otros_acreedores`, `acreedores_etiquetas`, `proveedores`, `clientes`, `empleados`, `canales`, `fletes`.
- **Inventario (8):** `items`, `productos`, `subproductos`, `insumos`, `insumos_proveedores`, `recetas`, `inventarios`, `detalle_inventarios`.
- **Ventas/tesorería comercial (15):** `pedidos`, `detalle_pedidos`, `entregas`, `entregas_detalle`, `ventas`, `cobros`, `cobros_detalle`, `retenciones_ganancias`, `retenciones_iibb`, `caja`, `cheques_entregados`, `cheques_recibidos`, `datos_bancarios`, `movimientos_bancarios`, `comisiones`.
- **Compras/RRHH (11):** `compras`, `detalle_compras`, `recepciones`, `detalle_recepciones`, `otros_gastos`, `aportes_socios`, `egresos`, `pagos`, `detalle_pagos`, `sueldos`, `sueldos_calculo`.
- **Rutas dinámicas/globales:** `/api/health`, `/api/backend/schema`, `/api/backend/tables`, `/api/backend/tables/:tabla`, `/api/backend/map`, `/api/backend/sql`, `/api/app-state`, `/api/reports/income-statement`, `/api/reports/cashflow`.
- **Rutas exactas de dominio:** tres `/api/bank-reconciliation/*`; `/api/reception-attachments`; `/api/reception-invoice/read`; `/api/payroll-scale/read`; `/api/creditors/create`; `/api/inventory/append`; `/api/inventory/latest-date`; `/api/inventory/full-entry`; tres `/api/inventory-detail/*`; `/api/purchases/full-entry`. Métodos y contratos se detallan en los AGENTS propietarios y se implementan en `backend/routes/router.js`.

## Dependencias cruzadas principales

- Inventario lee compras/recepciones para costos, pedidos para teórico y alimenta Reportes.
- Compras crea egresos que Tesorería paga y Reportes clasifica; recepciones alimentan costos de Inventario.
- Ventas alimenta cobros de Tesorería, inventario teórico y Reportes.
- RRHH alimenta egresos y Reportes.
- Tesorería concilia movimientos con operaciones de Compras/Ventas.
- Contabilidad separa reconocimiento económico, obligación y pago; recibe conceptos de los productores, concilia aplicaciones con egresos y expone solo confirmados a Reportes.
- Reportes consume todos los dominios sin apropiarse de sus escrituras.
- Administración/Base de datos exponen herramientas transversales con límites estrictos.
- El flujo predeterminado es directo entre usuario y especialista. El Coordinador conserva handoffs y tooling únicamente como legado manual para recuperación o diagnóstico solicitados expresamente; no interviene en pedidos nuevos.

## Gaps confirmados

- Ventas/pedidos no tienen servicio backend específico: persisten por el endpoint genérico de tablas.
- `purchase-entry.js` persiste hoy por tablas genéricas y no llama a `/api/purchases/full-entry`; el endpoint específico existe, pero no es el contrato usado por esa UI.
- Las claves del registry de `entregas_detalle`, `cobros_detalle`, `caja`, `cheques_entregados`, `cheques_recibidos`, `otros_gastos` y `detalle_pagos` ya están alineadas con las columnas canónicas y el runtime; los aliases históricos permanecen disponibles en proyecciones.
- `planes_pagos` y `cuotas_planes_pagos` siguen fuera del registry. Su incorporación debe exponerlas en esquema/mapa sin habilitar edición genérica desde Administración, documentar sus relaciones con `egresos` y reemplazar los datos codificados de `payment-plans.js` por lectura backend en coordinación con Tesorería y Administración.
- Mientras el ERP sea exclusivamente local se mantiene como requisito operativo validar cambios estructurales sobre copias aisladas y generar un backup verificable antes de aplicarlos.
- Antes de habilitar varias computadoras deben implementarse migraciones versionadas, dry-run, backup/restore verificables, versión de esquema, mutex o cola de escrituras, temporales únicos, lock entre procesos y detección de escrituras sobre una revisión antigua.
- Varias entidades operativas comparten `backend-table.service.js`; un cambio de validación por dominio puede justificar servicio propio.
- `operational-data-coordinator.js` coordina ventas, cobros, cheques, logística y comisiones; se asigna a Arquitectura como core compartido porque no tiene un único dueño operativo inequívoco.
- `inventory-valuation.service.js` expone valuación sin caller activo confirmado y referencia `EXPECTED_BACKEND_COLUMNS` sin import/inyección.
- El registry conserva módulos históricos amplios: `sueldos`, pagos y otros gastos figuran bajo `compras`; ownership funcional de AGENTS prevalece para desarrollo, sin cambiar el registry.
- Los documentos de auditoría del 18/07 son históricos y pueden describir arquitectura anterior a la refactorización.
- `.codex-snippet.txt` conserva una copia aislada de `renderPaymentPlans`; no se carga en runtime. Se asigna a Arquitectura para decidir su retiro en una tarea separada, sin tratarlo como fuente funcional.

## Mantenimiento

El chat que crea, mueve, renombra o elimina un archivo permanente actualiza en la misma tarea su AGENT, ownership y dependencias. Arquitectura revisa periódicamente archivos sin dueño, solapamientos, rutas/servicios nuevos y manuales desactualizados, pero esa revisión no reemplaza la responsabilidad primaria del creador.

Pendiente recurrente: comparar `rg --files`, registry y router contra ownership durante cambios estructurales; no hacerlo para cada corrección pequeña.
