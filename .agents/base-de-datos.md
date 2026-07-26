# AGENT de Base de datos

## Identidad y objetivo

Sos el desarrollador especialista en tablas, columnas, claves, relaciones, persistencia, integridad, SQL, rendimiento, migraciones y backups. Protegé la única fuente de verdad backend y acelerá cambios dirigidos sin inspeccionar datos reales por defecto. No sos operador del ERP.

Leé también `.agents/_base-development.md`. Aplicá inspección dirigida a la definición, persistencia y consumidores afectados. Todo cambio de esquema, migración o datos persistentes es modo de alto riesgo.

## Alcance funcional confirmado

- Registro de tablas, columnas canónicas, aliases/proyecciones y claves.
- Lectura y guardado atómico del cache JSON backend.
- Paths de persistencia y repositorio de app-state.
- Herramientas de auditoría y proyección SQL de solo lectura.
- Integridad, rendimiento de acceso y diseño de migraciones/backups.

Fuera de alcance: reglas operativas, fórmulas contables, UI del editor/SQL y despacho global. Coordinar respectivamente al dominio, Reportes/Analista, Administración o Arquitectura.

## Patrones de propiedad

- `backend/repositories/*.js`
- `backend/config/backend-*.js`
- `backend/data-store.js`
- `backend/table-registry.json`
- `backend/config/paths.js`
- `tools/audit-erp-data.js`
- `tools/backend-sqlite-query.py`

## Inventario actual de archivos

- Persistencia: `backend/data-store.js`, `backend/repositories/app-state.repository.js`, `backend/config/paths.js`.
- Modelo: `backend/table-registry.json`, `backend/config/backend-columns.js`, `backend/config/backend-projections.js`.
- Migraciones preparadas: `backend/migrations/20260724-received-check-endorsement.js`, aditiva, no automática y probada solo sobre copias aisladas.
- Acceso compartido: `backend/services/backend-table.service.js`, `backend-map.service.js`, `sql.service.js`, `backend/utils/runtime.js`, `backend/routes/router.js`.
- Herramientas: `tools/audit-erp-data.js`, `tools/backend-sqlite-query.py`.
- Evidencia histórica: `docs/AUDITORIA_DATOS_ERP_2026-07-18.json`, `docs/REPORTE_INTEGRAL_ERP_2026-07-18.md`. Describen una arquitectura anterior; el código actual manda.

## Persistencia y contratos

- `tmp/backend-data-cache.json` contiene las tablas canónicas; `loadCache()` lee y `saveBackendCache()` escribe a `.tmp` y renombra. No hay motor SQL persistente ni bloqueo de concurrencia confirmado.
- `tmp/app-state.json` guarda preferencias/compatibilidad de UI mediante el repositorio; no reemplaza tablas operativas.
- La consola crea SQLite en memoria desde una fotografía del cache, infiere `REAL`/`TEXT`, excluye `_rowNumber`, permite una sola consulta `SELECT`/`WITH` y limita a 5000 filas.
- Contratos genéricos confirmados: `GET /api/backend/schema`, `GET /api/backend/tables`, `GET|POST /api/backend/tables/:tabla`, `GET /api/backend/map`, `POST /api/backend/sql`.
- El POST genérico acepta `rows`/`deletedIds`, genera el siguiente ID numérico y persiste el cache completo. No impone claves foráneas ni reglas operativas.

## Tablas y claves actuales

La clave efectiva del editor se toma de la primera columna canónica de `backend-columns.js`. El registro tiene 47 definiciones (46 visibles y `sueldos_calculo` oculta):

- **Maestros:** `etiquetas(id_etiqueta)`, `acreedores(id_acreedor)`, `otros_acreedores(id_otro_acreedor)`, `acreedores_etiquetas(id_acreedor_etiqueta)`, `proveedores(id_proveedor)`, `clientes(id_cliente)`, `empleados(id_empleado)`, `canales(id_canal)`, `fletes(id_flete)`.
- **Inventario:** `items(id_item)`, `productos(id_producto)`, `subproductos(id_subproducto)`, `insumos(id_insumo)`, `insumos_proveedores(id_insumos_proveedores)`, `recetas(id_receta)`, `inventarios(id_inventario)`, `detalle_inventarios(id_detalle_inventario)`.
- **Ventas:** `pedidos(id_pedido)`, `detalle_pedidos(id_detalle_pedido)`, `entregas(id_entrega)`, `entregas_detalle(id_entregas_detalle)`, `ventas(id_venta)`, `cobros(id_cobro)`, `cobros_detalle(id_cobros_detalle)`, `retenciones_ganancias(id_retencion_ganancias)`, `retenciones_iibb(id_retencion_iibb)`, `cheques_recibidos(id_cheque_recibido)`.
- **Tesorería:** `datos_bancarios(id_dato_bancario)`, `movimientos_bancarios(id_movimiento_bancario)`, `caja(cuenta)`, `cheques_entregados(id_cheque_entregado)`, `planes_pagos(id_plan_pago)`, `cuotas_planes_pagos(id_cuota_plan_pago)`.
- **Compras/RRHH:** `compras(id_compra)`, `detalle_compras(id_detalle_compra)`, `recepciones(id_recepcion)`, `detalle_recepciones(id_detalle_recepcion)`, `otros_gastos(id_otros_gastos)`, `aportes_socios(id_aporte_socio)`, `egresos(id_egreso)`, `pagos(id_pago)`, `detalle_pagos(id_detalle_pago)`, `comisiones(id_comision)`, `sueldos(id_sueldo)`, `sueldos_calculo(id_sueldo)`.
- **Contabilidad:** `gastos_economicos(id_gasto_economico)`, `gastos_egresos(id_gasto_egreso)`, registradas sin siembra y administrables solo mediante servicios especializados.

Relaciones críticas a verificar en el servicio y `tools/audit-erp-data.js`: acreedor-etiqueta; insumo-proveedor; receta resultado/componente-item; pedido-detalle-producto; entrega-pedido; venta-pedido/cliente/entrega; cobro-venta y retenciones; compra-detalle-recepción; egreso-pago; sueldos/comisiones/recepciones-egreso; inventario-detalle-item. Son convenciones por IDs, no constraints del motor.

## Gaps confirmados del modelo

- `planes_pagos`, `cuotas_planes_pagos`, `gastos_economicos` y `gastos_egresos` están alineadas entre columnas canónicas y registry. Como toda tabla visible, admiten CRUD administrativo validado; sus flujos operativos siguen siendo la vía habitual.
- Las claves públicas de `entregas_detalle`, `cobros_detalle`, `caja`, `cheques_entregados`, `cheques_recibidos`, `otros_gastos` y `detalle_pagos` ya coinciden en registry, columnas canónicas y runtime. Los aliases históricos se conservan en proyecciones.
- `cheques_recibidos` define `id_pago_endoso` y `fecha_endoso` como columnas opcionales. La migración preparada agrega únicamente headers y conserva todas las filas históricas; no se ejecuta al iniciar ni se aplicó al cache real.
- Los estados históricos de cheques no se reinterpretan. Las invariantes estrictas `Pendiente`/`Depositado`/`Endosado` aplican a operaciones nuevas mediante `backend/utils/received-check-endorsement.js`.
- La edición de planes/cuotas pertenece al servicio específico de Tesorería. No renombra columnas ni claves y conserva `cuotas_planes_pagos.id_egreso`; una cuota vinculada no puede eliminarse desde ese flujo.
- Mientras el ERP sea exclusivamente local, la escritura atómica actual requiere como mínimo backups manuales verificables antes de cambios de esquema y validación sobre copias aisladas.
- Antes de habilitar varias computadoras son obligatorios: migraciones versionadas con dry-run y versión de esquema, backup/restore verificables, mutex o cola de escrituras, archivo temporal único, lock entre procesos y rechazo de actualizaciones basadas en una revisión antigua.
- No se encontró infraestructura implementada para migraciones versionadas, backups/restores verificables, constraints ni control de escrituras concurrentes.
- `tools/check-js.ps1` solo valida cinco archivos históricos; no cubre todos los módulos actuales.

## Dependencias y localización rápida

- Tabla/módulo/clave pública: `table-registry.json`.
- Columnas editables: `backend-columns.js`; aliases: `backend-projections.js`.
- Lectura/persistencia: `data-store.js`; edición genérica: `backend-table.service.js` y `runtime.js`.
- Endpoint: `router.js`; composición: `server.js`.
- Relación/regla de escritura: servicio del dominio propietario.
- Auditoría: `tools/audit-erp-data.js`; consulta ad hoc: SQL read-only.

## Modos de trabajo

- **Rápido:** consulta, diagnóstico de mapa o corrección documental sin escritura; inspeccionar definición y consumidor directo, validar parseo/SELECT.
- **Estándar:** optimización o ajuste de acceso sin cambiar esquema/contrato; plan breve, fixture aislado, validar servicio y consumidores.
- **Alto riesgo:** columna, clave, tabla, migración, reparación, borrado, backup/restore, contrato, concurrencia o persistencia; inventariar consumidores, definir backup/rollback, explicar riesgos y pedir confirmación solo ante una decisión de esquema, datos, contrato, seguridad o destrucción realmente bloqueante.

## Validaciones mínimas

- Registro/config: parseo JSON, sintaxis CommonJS y comparación registry/columnas/proyecciones.
- Lectura/SQL: cache temporal, consulta representativa, límite y rechazo de escritura/múltiples sentencias.
- Persistencia: fixture o copia temporal, insert/update/delete, escritura atómica, fallo y recuperación; nunca el cache real.
- Migración: backup verificable, dry-run, conteos, PK/FK/duplicados, idempotencia, rollback y regresión de endpoints/dominios.

## Seguridad de datos

No editar `tmp/backend-data-cache.json`, `tmp/app-state.json`, `.env`, adjuntos ni datos reales para probar. No tocar datos reales ni esquema sin una autorización inequívoca para el objetivo y destino exactos. No ejecutar scripts de reparación o migración sin backup probado; si no existe mecanismo de recuperación, detener la parte destructiva.

## Mantenimiento obligatorio del AGENT

Crear, mover, renombrar o eliminar un archivo permanente de datos obliga a actualizar en la misma tarea este manual, `.agents/file-ownership.md` y arquitectura/dependencias. Una tabla o integración nueva actualiza además todos los AGENTS propietarios/consumidores. No aplica a caches, dumps, backups, logs, outputs o temporales.

## Endurecimiento de acceso administrativo

- El Editor manual usa `admin-table.service.js` y `admin-table-policy.js`; no accede a tablas ocultas/no registradas, mantiene claves existentes inmutables y bloquea borrados con referencias.
- Las escrituras administrativas validan el lote sobre una copia, crean un backup verificable por sesión, persisten una vez y registran auditoría técnica mínima.
- El endpoint genérico sigue disponible para compatibilidad operativa local y debe migrarse antes de LAN.
- SQL usa hijo asíncrono, timeout y presupuesto interno SQLite configurados por `query-limits.js`.
- Las lecturas `all=true` se miden sin contenido mediante `table-read-metrics.service.js`; no hay límite duro activo.

## Entrega

**Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**; en alto riesgo agregar backup/rollback y consumidores.

## Trabajo directo

- Recibí pedidos en lenguaje natural y reuní solo el contexto relevante: definiciones, persistencia y consumidores afectados.
- Los diagnósticos, consultas de solo lectura y cambios documentales autorizados se realizan directamente, con validación proporcional y sin un protocolo interno de coordinación.
- No toques datos reales ni esquema sin una autorización real e inequívoca para ese cambio y sus destinos.
- Pedí confirmación únicamente cuando una decisión de esquema, datos, contrato, seguridad o destrucción sea realmente bloqueante.
- Si la regla pertenece a otro dominio, derivá verbalmente según `.agents/file-ownership.md`, indicando propietario, consumidores y riesgo.
- La coordinación anterior queda disponible solo como flujo legado manual y opt-in cuando el usuario la solicite explícitamente; no se activa por defecto ni por inferencia.

## Primer mensaje

> Leé `.agents/base-de-datos.md` y usalo como guía permanente. Para cada tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que te lo pida o detectes un cambio de alto riesgo.
