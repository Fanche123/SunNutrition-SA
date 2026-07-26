# Mapa central de propiedad

Cada ruta tiene un propietario principal. Los consumidores pueden proponer cambios localizados, pero no alterar responsabilidades de forma silenciosa. Categorías: **dominio**, **core compartido**, **infraestructura**, **documentación**.

| Ruta o patrón | Propietario | Consumidores | Finalidad / categoría | Riesgo | AGENT a actualizar |
|---|---|---|---|---|---|
| `server.js`, `package.json` | Arquitectura | Todos | Composición/arranque; infraestructura | Alto | `arquitectura.md` |
| `.gitattributes`, `.gitignore`, `.env.example` | Arquitectura | Todos | Configuración versionada; infraestructura | Medio | `arquitectura.md` |
| `.coordination/README.md`, `.coordination/*.schema.json`, `.coordination/config*.json`, `.coordination/project-context.json` | Coordinador | Arquitectura | Contratos y configuración preservados del sistema de coordinación legado manual; infraestructura opcional | Alto | `coordinador.md` + `arquitectura.md` |
| `.coordination/{inbox,processing,pending,approved,rejected,completed,failed,runtime,evidence}/**`, `.coordination/state.json` | Coordinador | Recuperación histórica explícita | Estado, colas y evidencia del legado; runtime no versionado que no se altera por defecto | Alto | `coordinador.md` |
| `tools/coordination*.js`, `tools/coordination/**/*.js`, `tests/coordination*.test.js` | Coordinador | Arquitectura | Watcher, acciones, recuperación y pruebas del legado manual opcional | Alto | `coordinador.md` + `arquitectura.md` |
| `Iniciar_ERP_y_Coordinador.bat` | Arquitectura | Usuario local | Launcher habitual del ERP; conserva el nombre histórico pero no inicia el watcher | Medio | `arquitectura.md` |
| `Iniciar_Coordinador.bat`, `Ver_Estado_Coordinacion.bat` | Coordinador | Arquitectura, usuario local | Utilidades manuales identificadas como legado opcional | Medio | `coordinador.md` + `arquitectura.md` |
| `docs/coordination/*.md` | Coordinador | Arquitectura | Documentación histórica y operación manual opt-in del legado | Medio | `coordinador.md` + `arquitectura.md` |
| `.codex-snippet.txt` | Arquitectura | Tesorería | Snippet no cargado por runtime; artefacto permanente a revisar | Bajo | `arquitectura.md` |
| `assets/js/app.js` | Arquitectura | Todos frontend | Bootstrap/eventos globales y contrato `saveState({ scheduleRemote })`; core | Alto | `arquitectura.md` + afectados |
| `assets/js/core/*.js`, `assets/js/dom-utils.js` | Arquitectura | Todos frontend | API, archivos, formatos y DOM; core | Medio | `arquitectura.md` + consumidores |
| `shared/money.js`, `shared/money-columns.js`, `backend/utils/money-input.js`, `docs/money-contract.md`, `tests/money*.test.js` | Arquitectura | RRHH, Tesorería, Compras, Ventas, Inventario, Reportes, Contabilidad, Administración | Contrato monetario único frontend/backend, clasificación semántica y validación estricta de payloads | Alto | `arquitectura.md` + consumidores financieros |
| `index.html` | UI/UX | Todos frontend | Shell, vistas y contratos DOM; core | Alto | `ui-ux.md` + afectados |
| `assets/css/*.css`, `assets/icons/*.svg` | UI/UX | Todos frontend | Apariencia, responsive e iconos; dominio UI | Medio | `ui-ux.md` |
| `assets/js/modules/inventory-*.js` | Inventario | Compras, Reportes | Captura, OCR, teórico y detalle; dominio | Medio/alto | `inventario.md` |
| `assets/js/modules/operational-data-coordinator.js` | Arquitectura | Inventario, Compras, Ventas, Tesorería | Coordinación de carga y render comercial entre dominios; core compartido | Medio | `arquitectura.md` + consumidores |
| `assets/js/modules/operational-shared.js` | Arquitectura | Inventario, Compras, Tesorería | Helpers operativos; core compartido | Medio | `arquitectura.md` + consumidores |
| `assets/js/modules/purchase-*.js`, `reception-*.js` | Compras | Inventario, Tesorería | Compras y recepciones; dominio | Alto | `compras.md` |
| `assets/js/modules/logistics-entry.js` | Ventas | Compras, Tesorería, Reportes | Entregas comerciales y rama compartida de egreso logístico; dominio | Alto | `ventas.md` + consumidores |
| `assets/js/modules/commissions-entry.js` | Ventas | Tesorería, Reportes | Comisión comercial derivada de cobros; dominio | Alto | `ventas.md` + consumidores |
| `assets/js/modules/other-expense-entry.js` | Compras | Tesorería, Reportes | Alta de otros gastos como fuente de egresos; dominio | Alto | `compras.md` + consumidores |
| `assets/js/modules/sales-*.js` | Ventas | Inventario, Tesorería, Reportes | Pedidos y ventas; dominio | Alto | `ventas.md` |
| `backend/services/sales-*.service.js`, `backend/services/sales-*.service.test.js` | Ventas | Inventario, Reportes, Arquitectura | Alta integral de pedidos y pruebas aisladas de integridad; dominio | Alto | `ventas.md` |
| `assets/js/modules/collections-retentions.js` | Tesorería | Ventas, Reportes | Cobros/retenciones; dominio | Alto | `tesoreria.md` + `ventas.md` |
| `assets/js/modules/bank-reconciliation-*.js` | Tesorería | Compras, Ventas | Conciliación; dominio | Alto | `tesoreria.md` |
| `assets/js/modules/*check*.js`, `payment-entry.js`, `payment-plans.js`, `partner-contributions-entry.js` | Tesorería | Compras, Ventas, Reportes | Pagos, cheques, planes y aportes; dominio | Alto | `tesoreria.md` |
| `assets/js/modules/salary-*.js` | RRHH | Compras, Reportes | Sueldos y egreso salarial; dominio | Alto | `rrhh.md` |
| `assets/js/config/payroll-calendars.js` | RRHH | Arquitectura, Compras, Reportes | Calendarios laborales configurados por año; configuración de dominio compartida | Alto | `rrhh.md` + consumidores |
| `assets/js/modules/dashboard.js`, `reports-*.js` | Reportes | Todos | Indicadores y presentación financiera; dominio | Alto | `reportes.md` |
| `assets/js/modules/data-*.js`, `sql-console.js` | Administración | Base de datos, Arquitectura | Editor, mapa y SQL; dominio | Alto | `administracion.md` |
| `backend/services/inventory-*.service.js`, `backend/utils/inventory-*.js` | Inventario | Compras, Reportes | Inventario/OCR; la carga integral coordina valuación previa a persistencia; dominio | Alto | `inventario.md` |
| `backend/services/purchase-*.service.js`, `reception-entry.service.js`, `other-expense-entry.service.js`, `creditor-*.service.js`, `attachments.service.js` | Compras | Inventario, Tesorería, Reportes, RRHH | Altas atómicas de compras/recepciones/otros gastos, acreedores y adjuntos; dominio | Alto | `compras.md` (+ RRHH si escala) |
| `tests/purchase-integrity.test.js` | Compras | Arquitectura | Pruebas aisladas de integridad, compensación y reintentos del dominio | Medio | `compras.md` |
| `backend/services/bank-*.service.js`, `backend/utils/bank.js`, `backend/bank-rules.js` | Tesorería | Compras, Ventas | Banco y conciliación; dominio | Alto | `tesoreria.md` |
| `backend/services/collection-entry.service.js`, `payment-entry.service.js`, `payment-plans.service.js`, `partner-contributions.service.js` | Tesorería | Ventas, Compras, Reportes | Operaciones compuestas, planes y aportes; dominio | Alto | `tesoreria.md` |
| `tests/treasury-safety.test.js` | Tesorería | Arquitectura | Regresión aislada de atomicidad e idempotencia financiera; pruebas | Alto | `tesoreria.md` |
| `tests/payment-plans.test.js`, `docs/payment-plans.md` | Tesorería | Base de datos, Administración, UI/UX | Contrato y regresión aislada del módulo editable de planes; pruebas/documentación | Alto | `tesoreria.md` + consumidores |
| `backend/utils/received-check-endorsement.js`, `docs/received-check-endorsement.md` | Tesorería | Base de datos, Administración | Invariantes y contrato futuro de endoso de cheques recibidos | Alto | `tesoreria.md` + `base-de-datos.md` |
| `backend/migrations/20260724-received-check-endorsement.js`, `tests/received-check-endorsement-schema.test.js` | Base de datos | Tesorería, Administración | Migración aditiva aislada, backup/rollback y regresión del esquema de endoso | Alto | `base-de-datos.md` + consumidores |
| `backend/services/payroll-*.service.js` | RRHH | Reportes | Normalización/resumen salarial; dominio | Alto | `rrhh.md` |
| `tests/payroll-safety.test.js` | RRHH | Arquitectura, Reportes, Tesorería | Persistencia coordinada y reglas de seguridad salarial; pruebas | Alto | `rrhh.md` |
| `backend/services/income-*.service.js`, `cashflow.service.js`, `expense-classification.service.js` | Reportes | Inventario, Compras, Ventas, Tesorería, RRHH | Cálculo/agregación; dominio consumidor | Alto | `reportes.md` + dueños de reglas alteradas |
| `backend/services/economic-expenses.service.js`, `economic-expense-applications.service.js`, `economic-expense-comparison.service.js` | Contabilidad | Compras, RRHH, Ventas, Tesorería, Reportes | Gastos económicos, aplicaciones, conciliación y diagnóstico paralelo; dominio | Alto | `contabilidad.md` + consumidores |
| `tests/economic-expenses*.test.js`, `docs/economic-expenses.md` | Contabilidad | Base de datos, Administración, Reportes, Tesorería | Contrato, pruebas unitarias/HTTP y documentación del modelo económico paralelo | Alto | `contabilidad.md` + consumidores |
| `tests/reports.test.js` | Reportes | Arquitectura | Fixtures y regresión focalizada de reportes; pruebas | Medio | `reportes.md` |
| `backend/services/backend-*.service.js`, `sql.service.js` | Administración | Base de datos, Arquitectura | Tablas/mapa/SQL; dominio interno | Alto | `administracion.md` + `base-de-datos.md` |
| `backend/services/admin-table.service.js`, `table-read-metrics.service.js`, `backend/config/{admin-table-policy,admin-table-relations,query-limits}.js` | Administración | Base de datos, Arquitectura | CRUD, PATCH atómico de celda y metadata relacional del editor; límites SQL y métricas de lectura completa | Alto | `administracion.md` + `base-de-datos.md` |
| `tests/administration-hardening.test.js` | Administración | Base de datos, Arquitectura, UI/UX | Regresión aislada de acceso local, lectura completa, orden por PK, edición universal, selección/entrada de celda, relaciones, SQL y contratos estáticos del Editor | Alto | `administracion.md` + consumidores afectados |
| `backend/config/access.js`, `backend/services/access-control.service.js` | Arquitectura | Todos | Bind, CORS y punto futuro de autenticación/autorización | Alto | `arquitectura.md` |
| `backend/services/core-handlers.service.js` | Arquitectura | Administración, Reportes | Handlers transversales; infraestructura | Medio | `arquitectura.md` + consumidor |
| `backend/routes/*.js`, `backend/utils/{files,http,ids,runtime}.js`, `backend/http-config.js` | Arquitectura | Todos backend | Router/utilidades; infraestructura | Alto | `arquitectura.md` + afectados |
| `backend/data-store.js` | Base de datos | Todos backend | Fuente única/persistencia; infraestructura | Alto | `base-de-datos.md` + afectados |
| `backend/table-registry.json`, `backend/config/backend-*.js` | Base de datos | Todos | Tablas/columnas/proyecciones; infraestructura | Alto | `base-de-datos.md` + afectados |
| `backend/config/paths.js`, `backend/repositories/*.js` | Base de datos | Arquitectura | Paths/persistencia de estado; infraestructura | Alto | `base-de-datos.md` |
| `tools/audit-erp-data.js`, `tools/backend-sqlite-query.py` | Base de datos | Administración | Auditoría/SQL read-only; infraestructura | Alto | `base-de-datos.md` |
| `tools/check-js.ps1` | Arquitectura | Todos | Validación; infraestructura | Bajo | `arquitectura.md` |
| `AGENTS.md` | Arquitectura | Todos | Reglas raíz; documentación | Alto | `arquitectura.md` |
| `.agents/README.md`, `_base-development.md`, `file-ownership.md` | Arquitectura | Todos | Gobierno de AGENTS; documentación | Alto | `arquitectura.md` |
| `.agents/arquitectura.md` | Arquitectura | Todos | Guía arquitectónica; documentación | Medio | `arquitectura.md` |
| `.agents/inventario.md` | Inventario | Arquitectura | Guía de Inventario; documentación | Medio | `inventario.md` |
| `.agents/compras.md` | Compras | Arquitectura | Guía de Compras; documentación | Medio | `compras.md` |
| `.agents/ventas.md` | Ventas | Arquitectura | Guía de Ventas; documentación | Medio | `ventas.md` |
| `.agents/tesoreria.md` | Tesorería | Arquitectura | Guía de Tesorería; documentación | Medio | `tesoreria.md` |
| `.agents/rrhh.md` | RRHH | Arquitectura | Guía de RRHH; documentación | Medio | `rrhh.md` |
| `.agents/reportes.md` | Reportes | Arquitectura | Guía de Reportes; documentación | Medio | `reportes.md` |
| `.agents/contabilidad.md` | Contabilidad | Arquitectura, Base de datos, productores y consumidores | Guía del modelo económico transversal; documentación | Alto | `contabilidad.md` |
| `.agents/administracion.md` | Administración | Arquitectura | Guía de Administración; documentación | Medio | `administracion.md` |
| `.agents/ui-ux.md` | UI/UX | Arquitectura | Guía de UI/UX; documentación | Medio | `ui-ux.md` |
| `.agents/base-de-datos.md` | Base de datos | Arquitectura | Guía de Base de datos; documentación | Medio | `base-de-datos.md` |
| `.agents/bugs.md` | Bugs | Arquitectura | Guía de correcciones; documentación | Medio | `bugs.md` |
| `.agents/nuevas-funcionalidades.md` | Nuevas funcionalidades | Arquitectura | Guía de coordinación; documentación | Medio | `nuevas-funcionalidades.md` |
| `.agents/analista-funcional.md` | Analista funcional | Arquitectura | Guía de análisis; documentación | Medio | `analista-funcional.md` |
| `.agents/coordinador.md` | Coordinador | Arquitectura, todos los especialistas | Manual histórico del sistema de coordinación legado; uso opcional y explícito | Alto | `coordinador.md` + `arquitectura.md` |
| `docs/architecture.md`, `refactor-architecture-plan.md`, `agent-manuals-plan.md` | Arquitectura | Todos | Arquitectura/planes; documentación | Medio | `arquitectura.md` |
| `docs/administration-security.md` | Arquitectura | Administración, Base de datos | Seguridad local y requisitos previos a LAN | Medio | `arquitectura.md` + `administracion.md` |
| `backend/README.md` | Arquitectura | Base de datos, Administración | Entrada documental backend | Bajo | `arquitectura.md` |
| `docs/REPORTE_INTEGRAL_ERP_2026-07-18.md`, `AUDITORIA_DATOS_ERP_2026-07-18.json` | Base de datos | Arquitectura, Analista, dominios | Evidencia histórica/auditoría; documentación | Medio | `base-de-datos.md` |

| `backend/services/received-checks.service.js`, `tests/received-checks.service.test.js` | Tesorería | Ventas, Compras, Reportes | Endoso atómico e idempotente de cheques recibidos y su regresión aislada; dominio | Alto | `tesoreria.md` |

## Regla para compartidos

`app.js`, `index.html`, estilos, router, data-store y registry admiten un cambio de dominio solo si es mínimo y necesario. Informar impacto y actualizar AGENTS afectados cuando cambie una dependencia estable. Si cambia la responsabilidad del archivo, derivar a Arquitectura.

Los especialistas reciben pedidos directamente y, si cambia el ownership, indican verbalmente el chat correcto. No escriben handoffs, presentaciones, aprobaciones o transferencias por defecto ni adquieren ownership de `.coordination/`.

El Coordinador conserva la infraestructura y documentación anterior como legado manual opcional; Arquitectura conserva sus puntos de integración en `package.json` y `.gitignore`. Ningún consumidor puede activar el watcher, modificar estado histórico o convertir espera/tooling en ejecutores salvo pedido explícito del usuario.

## Mantenimiento obligatorio

Crear un archivo permanente obliga a actualizar en la misma tarea el AGENT propietario, este mapa y arquitectura/dependencias afectadas. Mover, renombrar o eliminar obliga a corregir referencias. Una integración nueva actualiza propietario, consumidor y este mapa. No aplica a temporales, logs, outputs, backups, generados, adjuntos o caches.
