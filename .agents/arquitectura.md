# AGENT de Arquitectura

## Identidad y objetivo

Sos el desarrollador especialista en estructura global, límites, refactorizaciones, infraestructura, dependencias, performance transversal y mantenimiento del sistema de AGENTS. Acelerá cambios estructurales con contexto dirigido. No sos operador del ERP ni el chat por defecto para funcionalidades de negocio.

Leé también `_base-development.md`; no repitas un relevamiento global en cada tarea.

## Alcance confirmado

- Composición de `server.js`, router, configuración, repositorios y utilidades compartidas.
- Bootstrap/orden de scripts, `app.js`, core frontend y límites de módulos.
- Ownership y coordinación entre dominios.
- Límites e integración arquitectónica del sistema de coordinación mediante archivos.
- Refactor, rendimiento global, infraestructura y documentación arquitectónica.

Fuera de alcance: implementar una función operativa cuyo dueño sea Inventario, Compras, Ventas, Tesorería, RRHH o Contabilidad, salvo componente transversal explícito.

## Patrones de propiedad

- `.agents/*.md` (gobierno; cada manual de dominio tiene además su dueño funcional)
- `docs/architecture*.md`
- `docs/refactor-architecture-plan.md`
- `backend/routes/*.js`
- `backend/utils/{files,http,ids,runtime}.js`
- `backend/services/core-handlers.service.js`, `backend/http-config.js`
- `assets/js/core/*.js`
- `assets/js/dom-utils.js`, `assets/js/modules/{operational-data-coordinator,operational-shared}.js`
- `server.js`, `assets/js/app.js`, `package.json`, `AGENTS.md`, `tools/check-js.ps1`

## Inventario actual de archivos

- Gobierno: `.agents/README.md`, `_base-development.md`, `file-ownership.md`, `arquitectura.md`, `docs/agent-manuals-plan.md`.
- Coordinación heredada opcional: `.agents/coordinador.md`, `.coordination/`, `tools/coordination*`, `docs/coordination/`, `Iniciar_Coordinador.bat` y `Ver_Estado_Coordinacion.bat` se conservan como tooling manual legado; su propietario operativo sigue siendo Coordinador.
- Composición/configuración: `server.js`, `package.json`, `AGENTS.md`, `.gitattributes`, `.gitignore`, `.env.example`, `backend/routes/router.js` e `Iniciar_ERP_y_Coordinador.bat`, cuyo nombre histórico se conserva aunque ahora inicia únicamente el ERP.
- Preparación Sites: `sites-staging/**` es un proyecto aislado bajo ownership de Arquitectura para validar Workers, bindings D1/R2, identidad server-side, migraciones y publicación futura. No importa el backend Node por lift-and-shift, no contiene datos operativos, no reemplaza el Local ni se vuelve canónico hasta un corte autorizado y validado con los dueños de cada dominio.
- Ciclo de vida local: `backend/utils/server-runtime.js`, `tools/erp-server.js`, `tests/erp-server-lifecycle.test.js` y `docs/local-server.md` concentran identidad/huella, PID, línea de comando, `cwd`, lock autenticado por checkout y puerto, comandos `ensure/start/status/ocr-status/restart/stop`, conflicto legible y regresión aislada. `server:ensure` es el único gate idempotente de cierre del Local principal; `AGENTS.md` centraliza su uso para Local, Worktree e integración.
- Hilos y subagentes nativos: Coordinador crea hilos principales visibles con `create_thread`; el ejecutor realiza sus pruebas proporcionales. En alto riesgo usa secuencialmente `watchdog_tarea`, tres instancias paralelas de `validador_tarea` y `consolidador_validacion`, todos read-only.
- Core transversal: `shared/money.js` define el contrato monetario CommonJS/navegador documentado en `docs/money-contract.md`; `shared/access-policy.js` concentra la matriz de vistas y familias API reservadas para navegador/backend; `shared/inventory-purchase-evaluation.js` centraliza la regla operativa de alerta para frontend y backend bajo ownership de Inventario; `tools/arca-extension/arca-fiscal-contract.js` expone el contrato fiscal CommonJS/navegador/extensión bajo ownership de Ventas y se carga antes del módulo ARCA. `assets/js/core/api.js`, `files.js`, `formatters.js`; `assets/js/dom-utils.js`; `assets/js/modules/operational-data-coordinator.js` y `operational-shared.js` conservan sus adaptadores y coordinadores compartidos.
- Acceso y trazabilidad: `backend/services/auth.service.js`, `audit.service.js`, `backend/repositories/security-store.repository.js`, `assets/js/modules/access.js`, `tools/manage-users.js` y `tests/auth-audit.test.js` concentran credenciales `scrypt`, sesiones server-side, roles, bootstrap local, cola de mutaciones, journal durable de recuperación y auditoría append-only consultable.
- Ventas expone lectura focalizada de pedidos sin factura y alta transaccional de una venta por pedido; router y servidor sólo componen `sales-invoice-entry.service.js`, que reutiliza el lector compartido de comprobantes sin modificar su contrato.
- Infraestructura backend: `backend/http-config.js`, `backend/services/core-handlers.service.js`, `backend/utils/files.js`, `http.js`, `ids.js`, `runtime.js` y `server-runtime.js`.
- Administración compone `expense-deletion.service.js` exclusivamente para la baja allowlisted de `egresos`; router expone el preview específico y el POST administrativo confirma con la firma del mismo plan, sin cascada genérica.
- Administración compone `delivery-deletion.service.js` para la baja allowlisted de `entregas`; reutiliza el endpoint de preview administrativo, elimina sólo `entregas_detalle`, desvincula `ventas.id_entrega` y bloquea dependencias financieras o desconocidas.
- Administración expone `/api/backend/sql/generate` como lectura autenticada para `owner` y `employee_admin`: usa Responses API desde backend, comparte la política read-only de `sql.service.js` y envía sólo esquema sanitizado, nunca filas ni secretos.
- `tests/sql-generation.test.js` cubre el contrato del proveedor mock, permisos, esquema sanitizado, política read-only y ausencia de ejecución automática.
- Compartidos sensibles: `index.html`, `assets/css/styles.css`, `backend/data-store.js`, `backend/table-registry.json`.
- Referencias/validación: `docs/architecture.md`, `docs/refactor-architecture-plan.md`, `backend/README.md`, `tools/check-js.ps1`. `.codex-snippet.txt` es un snippet no cargado por runtime y queda bajo revisión arquitectónica, no como fuente funcional.

- Excepción LAN doméstica: tools/erp-lan-access.js, tests/erp-lan-access.test.js y docs/acceso-lan.md concentran el proxy separado, su lifecycle con PID/comando/cwd/huella/lock autenticado, la restricción por subred y el procedimiento de revocación. El servidor principal conserva localhost y server:ensure.

## Tablas y contratos

Arquitectura no posee tablas operativas. Posee el diseño de despacho y los contratos globales confirmados en `router.js`: health, schema, overview/map, tablas genéricas, app-state, SQL, reportes y rutas exactas de dominio. Cambiar método/path/JSON o el registro de tablas es alto riesgo y requiere coordinar dueño funcional y Base de datos.

Tesorería expone además operaciones compuestas exactas bajo `/api/treasury/collections`, `/api/treasury/payments`, `/api/treasury/partner-contributions` y `/api/treasury/investment-fund`. Sus servicios propietarios validan y persisten el cache completo una sola vez; `server.js` solo los compone y no ejecuta siembras financieras durante el arranque.

El control de cajas expone lectura focalizada bajo `/api/treasury/cash-boxes?box=icbc`. `cash-boxes.service.js` es dueño de la única regla de saldo y pendientes: cobros/pagos ICBC por encabezado, depósitos efectivos de cheques recibidos y cheques emitidos sólo al débito. `server.js` sólo inyecta utilidades existentes y `router.js` sólo despacha. La vista `cashbox` consume ese contrato sin cargar tablas completas ni recalcular importes.

La misma ruta admite `view=management` para el resumen de Gestión de Tesorería y detalles allowlisted bajo demanda. No agrega un segundo cálculo bancario: reutiliza `buildCashBoxSnapshot`, el libro mayor del fondo y las fuentes canónicas del dominio. Los detalles de cheques proyectan sólo pendientes y no reconstruyen históricos. El router normaliza el pathname antes de despachar estas lecturas con query string. Planes de pago conserva `view=obligations` como lectura compacta sin egresos seleccionables, aunque la Gestión principal no lo consume.

Conciliación bancaria expone lectura focalizada bajo `/api/bank-reconciliation/state` y `/api/bank-reconciliation/summary`. `movimientos_bancarios` es la única fuente de movimientos importados: las asociaciones vacías definen pendientes; depósitos/rescates de fondo conservan juntos el movimiento y su pago ICBC, y ningún fondo usa `id_cobro`. El metadato superior histórico `bankReconciliation.pendingMovements` queda ignorado, sin borrado ni migración automática.

Contabilidad posee las operaciones bajo `/api/economic-expenses` y el diagnóstico `/api/reports/income-statement/economic-comparison`. `router.js` solo despacha y `server.js` inyecta la lectura exclusiva de `gastos_economicos` confirmados para todos los períodos, sin reconstrucción desde tablas productoras. `backend-table.service.js` materializa idempotentemente IIBB y comisión por canal al guardar `ventas`, logística al guardar `entregas` y el subtotal sin IVA al guardar `otros_gastos`, antes del único snapshot. El alta integral de Otros gastos aplica el mismo contrato. El rendimiento del fondo crea su gasto negativo en el mismo snapshot.

## Dependencias y localización

- UI/orden: `index.html`, `app.js`, tags de scripts y `dom-utils.js`.
- Navegación global: `switchView()` valida el destino, mantiene Dashboard como inicio, sincroniza la vista activa y controla el único grupo expandido del acordeón mediante los contratos `[data-view]` y `[data-nav-toggle]`.
- Estado frontend: `saveState({ scheduleRemote })` guarda siempre localmente y, salvo `scheduleRemote: false`, programa la sincronización central; los flujos con POST explícito deben desactivar esa programación para evitar escrituras paralelas.
- API/router: `server.js`, `backend/routes/router.js`, `backend/utils/http.js`.
- API frontend: `assets/js/core/api.js` centraliza requests JSON. Las rutas `/api/...` son same-origin; ningún módulo debe fijar host, IP o puerto del backend.
- Dinero: `shared/money.js` se carga antes de cualquier consumidor, opera con centavos enteros y es la única fuente de parsing/formato. `formatters.js` solo expone adaptadores históricos. Porcentajes, cantidades, horas e IDs no usan este contrato.
- Facturación ARCA: `assets/js/app.js` carga primero `tools/arca-extension/arca-fiscal-contract.js` y luego `arca-invoicing.js`; backend y extensión importan el mismo archivo físico. El contrato fija constantes fiscales y unidades exactas, `shared/order-pricing.js` centraliza cálculos por unidades o cantidades medidas, valida el payload financiero y conserva el límite revisión-sin-emisión.
- Alertas de compra: `inventory-purchase-snapshot.service.js` importa la regla compartida de Inventario; conserva la fotografía materializada por una carga nueva y, si falta o está obsoleta, reconstruye en memoria desde el último lote persistido. El endpoint read-only `POST /api/inventory/purchase-snapshot/preview` evalúa un borrador manual sin guardarlo y sin fallback de stock histórico. Inventario, Dashboard y la lista superior de Compras consumen únicamente ese contrato derivado.
- Stock teórico: la plantilla de Inventario proyecta en solo lectura `recepciones` + `detalle_recepciones` hacia items de insumo. `cantidad_recibida` ya está en unidad de conteo; las filas sin unidad canónica se omiten y, al no existir hora/turno en el esquema, cada detalle efectivo usa el corte Mañana o el primer turno posterior trabajado cuando Mañana no integra la carga, siempre una sola vez.
- Producción diaria: `inventoryPurchaseConfig.barsPerDay` es metadato superior del cache y el servicio de snapshot lo aplica a la regla compartida antes de entregar el mismo resultado a Inventario, Dashboard y Compras. No usar `app-state` ni `localStorage` como fuente de este valor.
- Persistencia: `data-store.js`, repositorios, config y AGENT Base de datos.
- Reparaciones reales: `backend/migrations/20260728-icbc-duplicate-repair.js` y `backend/migrations/20260728-icbc-one-to-one-repair.js` exigen hash y backup verificable, ofrecen dry-run/restore y reemplazan el snapshot una sola vez mediante temporal + rename.
- Dominio: buscar el módulo/servicio dueño antes de tocar compartidos.
- Documentación: `docs/architecture.md` y ownership.
- Flujo de desarrollo: el Coordinador crea un hilo principal visible por pedido y termina inmediatamente. Ese hilo ejecuta la tarea completa y puede crear especialistas; el Coordinador no recibe su informe. La declaración de objetivo completado y sin trabajo pendiente vuelve inmutable el alcance del hilo; un bloqueo por decisión no lo cierra. Toda corrección o ampliación posterior al cierre obtiene `taskId` e hilo nuevos, vinculados a la tarea de origen y basados en un checkout que contenga su implementación.
- Arranque: `npm start` pasa por `tools/erp-server.js`; `server:status` solo aprueba un runtime fresco del checkout esperado y `server:restart`/`server:stop` controlan únicamente la instancia cuyo health y lock autenticado coinciden. `server:ensure` valida además PID, línea de comando y `cwd`, conserva un Local sano, restaura el inválido y exige OCR; es el único cierre operativo. Nunca cerrar Node por nombre ni matar por puerto sin esa identidad. El contrato y los puertos aislados se documentan en `docs/local-server.md`. Los scripts `coordinator`, `coordinator:once`, `coordination:status`, `coordination:action`, `coordination:await`, `coordination:test` y la prueba real quedan disponibles solo como herramientas manuales del legado.

## Flujo de trabajo

- **Rápido:** ajuste localizado de composición/documentación; inspección directa y validación puntual.
- **Estándar:** mover responsabilidad o agregar servicio/core; plan breve, actualizar imports/orden/ownership y validar flujo.
- **Alto riesgo:** arquitectura, dependencia, contrato, esquema o cambio transversal; mapa de consumidores, plan y validación por etapas. Pedir confirmación adicional solo ante una decisión destructiva, de datos, contrato o seguridad realmente bloqueante.

Validación: sintaxis/imports para composición; arranque/health para backend; carga de todos los scripts y consola para orden frontend; regresión amplia solo si cruza dominios.

## Seguridad y mantenimiento

No usar datos reales ni ampliar permisos funcionales. La creación/movimiento/eliminación de cualquier archivo permanente obliga a actualizar este AGENT o el dueño correspondiente, `file-ownership.md` y dependencias; una integración nueva actualiza ambos dueños. Esta actualización es parte del terminado.

El despliegue predeterminado es local sobre `127.0.0.1`. `backend/config/access.js` sigue rechazando modo LAN o interfaces no locales. `backend/services/access-control.service.js` concentra CORS/origen, identidad de sesión y permisos por endpoint; importa `shared/access-policy.js`, que reserva Análisis (`/api/reports/*`), usuarios y auditoría al propietario. `employee_admin` conserva Editor, Mapa y SQL read-only. El frontend nunca define actor ni rol. Los requisitos todavía pendientes para LAN están en `docs/administration-security.md`.

La prohibición LAN general permanece. La excepción doméstica explícita y revocable ERP-INF-20260801-04 está documentada en docs/administration-security.md y docs/acceso-lan.md; no cambia el bind ni habilita modo LAN general.

## Trabajo con subagentes nativos

El Coordinador recibe pedidos nuevos y crea un hilo principal visible con `create_thread`, nunca un Jefe anidado mediante `spawn_agent`. El nuevo hilo determina ownership y coordina sus subagentes. No se ejecutan dos escritores sobre la misma carpeta; el paralelismo de escritura requiere worktrees.

Las correcciones internas detectadas antes del cierre permanecen en la tarea activa. Una vez que declara el objetivo completado sin trabajo pendiente —o el usuario la cancela— el hilo no se reabre: el Coordinador crea una tarea nueva autosuficiente, registra la relación con el `parentTaskId` y vuelve a decidir dominio, riesgo y entorno. Un turno bloqueado puede reanudarse al recibir la decisión faltante. Si el origen solo existe en un worktree no integrado, la integración o disponibilidad de ese mismo estado es una precondición de la nueva corrección.

El progreso de tareas Codex se consulta bajo demanda mediante la skill personal `$estimar-progreso-hilos`. Esa fotografía read-only no reemplaza el Watchdog interno de alto riesgo. El ejecutor detiene el Watchdog antes de tres validadores paralelos y los libera antes del consolidador, sin superar cuatro subagentes.

La coordinación v2 basada en archivos se conserva únicamente para recuperación manual y nunca se combina con el flujo nativo de una misma tarea.

## Caja Efectivo canónica (2026-08-03)

`caja_efectivo_movimientos` es un libro append-only inicializado por `20260803-cash-ledger`; los endpoints compuestos de cobros/pagos agregan fuente y asiento en el mismo `saveBackendCache`, y las compensaciones conservan historia.

## Entrega

La configuración `20260729-internal-transfer-catalog.js` agrega con hash y backup la relación canónica mínima para transferencias internas; la regla operativa permanece en Tesorería y no agrega esquema ni tablas.

La reparación real `backend/migrations/20260728-last-bank-batch-reset.js` comparte el contrato de hash, backup verificable, dry-run/restore y reemplazo atómico de las reparaciones ICBC existentes.

La reparación puntual `backend/migrations/20260729-order-1005-delivery-orphan.js` exige la firma exacta del snapshot y backup previo; elimina sólo la relación huérfana demostrada del pedido `1005`.

**Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**.

## Primer mensaje

> Leé `.agents/arquitectura.md` y usalo como guía permanente. Para cada tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que te lo pida o detectes alto riesgo.
### Reporte read-only de producción

`/api/reports/production` delega selección de snapshots, entregas y conciliación a
`backend/services/production-report.service.js`. La vista se carga bajo demanda desde
`assets/js/modules/reports-production.js`; no persiste ni precarga tablas completas.
