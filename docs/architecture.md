# Arquitectura del ERP

## Estructura

El proyecto conserva CommonJS, JavaScript clasico en navegador y arranque con `node server.js`.

## Fuente unica de verdad

Las tablas persistidas por `backend/data-store.js` son la unica fuente de verdad transaccional.

- Pantallas, reportes, SQL y procesos leen exclusivamente `loadCache()` o los endpoints `/api/backend/tables/*`.
- Las operaciones escriben mediante `saveBackendCache()` y servicios de dominio.
- El alta canónica de pedidos usa `POST /api/sales/orders/full-entry`: valida referencias y contenido, genera IDs en backend y persiste encabezado y detalles con un único `saveBackendCache()`.
- No existen endpoints de fuentes, refresh ni imports externos.
- Inventario y compras escriben directamente `inventarios`, `detalle_inventarios`, `compras` y `detalle_compras`.
- El OCR de adjuntos o fotos solo interpreta el archivo entregado por el usuario; no constituye una fuente de tablas.

- `server.js`: composicion del servidor y dominios backend operativos aun no extraidos.
- `backend/config/`: paths, columnas oficiales y proyecciones/aliases de tablas.
- `backend/migrations/`: transformaciones versionadas e inertes que solo se ejecutan de forma explícita sobre un destino autorizado; nunca durante el arranque.
- `backend/repositories/`: persistencia de archivos locales; no contiene reglas de negocio.
- `backend/routes/router.js`: despacho HTTP y manejo comun de CORS, 404 y errores.
- `backend/services/`: servicios extraidos por dominio.
- `backend/utils/`: helpers de HTTP, archivos e IDs.
- `backend/data-store.js`: acceso y persistencia de las tablas que constituyen la base backend.
- `backend/table-registry.json`: registro publico de tablas y fuentes.
- `shared/money.js`: contrato monetario único para frontend, backend y pruebas; se carga antes de los scripts de dominio y también se importa mediante CommonJS.
- `shared/money-columns.js`: clasificación única de columnas monetarias usada por editor, SQL y escritura operativa genérica.
- `backend/utils/money-input.js`: validación estricta de payloads monetarios antes de persistir, incluida la prohibición de subcentavos.
- `assets/js/app.js`: punto de entrada del frontend y modulos historicos aun acoplados al estado global.
- `assets/js/modules/`: dominios frontend extraidos que se exponen como namespaces de `window` para conservar el sistema de scripts clasicos.
- `index.html`: shell y vistas. El markup permanece junto porque la inicializacion actual consulta todos los IDs de forma sincrona durante `DOMContentLoaded`.

## Flujo HTTP

1. `server.js` carga `.env`, configura repositorios/servicios y crea el servidor nativo de Node.
2. `backend/routes/router.js` aplica CORS y selecciona la ruta sin modificar el pathname ni el metodo existentes.
3. La ruta delega al handler/servicio inyectado.
4. Los servicios consultan `backend/data-store.js` o su repositorio especifico.
5. `backend/utils/http.js` conserva el formato JSON y los codigos HTTP.
6. Las rutas no API terminan en el servidor de archivos estaticos de `backend/utils/files.js`.

Antes del despacho, `access-control.service.js` valida el origen y concentra el punto futuro de autenticacion, sesion, roles y autorizacion. `backend/config/access.js` fuerza por defecto modo local y bind `127.0.0.1`; el modo LAN no puede arrancar mientras autenticacion/autorizacion no esten implementadas.

## Dominios extraidos

- `economic-expenses.service.js`, `economic-expense-applications.service.js` y `economic-expense-comparison.service.js`: dominio Contabilidad; gestionan el modelo económico paralelo, aplicaciones y diagnóstico sin modificar productores ni el resultado oficial.
- `attachments.service.js`: adjuntos de recepciones, lectura de facturas/PDF y escala salarial.
- `purchase-entry.service.js`, `reception-entry.service.js` y `other-expense-entry.service.js`: coordinan altas compuestas del dominio Compras con validación previa y un único guardado del cache; recepción agrega compensación del adjunto.
- `backend-table.service.js`: lectura y edicion generica de tablas del backend.
- `admin-table.service.js`: lectura y edicion manual limitada por `admin-table-policy.js`; no sustituye escrituras operativas.
- `cashflow.service.js`: armado de eventos, agrupacion semanal y saldos de cashflow.
- `bank-reconciliation.service.js`: handlers HTTP y coordinacion del analisis/aplicacion bancaria.
- `bank-persistence.service.js`: movimientos conciliados, pagos, egresos y actualizacion de cheques.
- `bank-parser.service.js`: lectura de CSV y clasificacion de cada movimiento.
- `bank-matching.service.js`: candidatos, identidades y seleccion de coincidencias bancarias.
- `inventory-entry.service.js`: endpoints de carga, fecha mas reciente y plantilla de inventario.
- `inventory-photo.service.js`: lectura OCR, revision y preparacion de rangos de inventario.
- `inventory-photo-mapping.service.js`: normalizacion y mapeo puro de transcripciones.
- `inventory-valuation.service.js`: valuacion de inventarios y mapa de costos por item.
- `income-calculation.service.js`: fechas, numeros y calculos reutilizados por inventario y resultados.
- `income-statement.service.js`: composicion del Estado de Resultados backend.
- `expense-classification.service.js`: origen, categoria, acreedor y etiquetas contables de egresos.
- `payroll-summary.service.js`: agregacion salarial para el Estado de Resultados.
- `payroll-normalization.service.js`: IDs, orden, merge y etiquetas de filas salariales.
- `payroll-expense-entry.service.js`: `POST /api/payroll/expenses`; valida liquidaciones, crea el egreso y asocia los sueldos con idempotencia natural y un único `saveBackendCache()`.
- `partner-contributions.service.js`: compatibilidad del historial de aportes.
- `payment-plans.service.js`: lectura y edición específica de planes/cuotas, operaciones compuestas sobre copia del cache, idempotencia durable y compatibilidad del helper histórico no invocado.
- `assets/js/core/api.js`: requests JSON compartidos con rutas same-origin; el ERP funciona en cualquier puerto local permitido sin redirección frontend al 3000.
- `assets/js/core/formatters.js`: adaptadores de presentación y parsing sobre `shared/money.js`; no contiene una segunda implementación financiera.
- `sql.service.js`: validacion de consultas de solo lectura y ejecucion SQLite.
- `table-read-metrics.service.js`: metricas sin contenido para lecturas `all=true`.
- `app-state.repository.js`: lectura y escritura atomica del estado local.

## Agregar una ruta

1. Implementar la operacion en un servicio cohesionado de `backend/services/`.
2. Inyectar dependencias explicitas desde `server.js`; evitar que el servicio lea globals del servidor.
3. Registrar metodo/path en `backend/routes/router.js` sin cambiar contratos existentes.
4. Validar sintaxis, arranque, health, caso exitoso y error esperado.

## Agregar una vista o modulo frontend

El frontend no usa bundler ni modulos ES. Para preservar compatibilidad:

1. Crear el archivo cohesionado bajo `assets/js/modules/` o `assets/js/core/`.
2. Mantener scripts clasicos en el mismo alcance global y ordenar la carga segun el primer uso: antes de `app.js` solo si interviene en su evaluacion sincrona; en caso contrario, despues de `app.js` y antes de `DOMContentLoaded`.
3. Mantener en `app.js` el punto de entrada y la inicializacion de eventos.
4. Conservar IDs, clases, eventos y orden de inicializacion.

La extraccion del markup a fragmentos requiere primero convertir el arranque en una fase asincrona explicita. No se hizo en esta etapa porque cargar fragmentos antes de `DOMContentLoaded` alteraria el contrato temporal actual.

## Configuracion de tablas

- Columnas canonicas: `backend/config/backend-columns.js`.
- Proyecciones y aliases: `backend/config/backend-projections.js`.
- Registro, modulo y clave primaria: `backend/table-registry.json`.
- Persistencia de la base backend: `backend/data-store.js`.
- `gastos_economicos` y `gastos_egresos` pertenecen a Contabilidad, no se siembran y son de solo lectura en Administración.

## Ejecucion y validacion

```powershell
node server.js
```

Validacion de sintaxis disponible en el proyecto:

```powershell
powershell -ExecutionPolicy Bypass -File tools/check-js.ps1
```

Si Node no esta en `PATH`, usar el runtime provisto por el workspace. La verificacion minima incluye:

- `node --check` de todos los `.js`, excluyendo dependencias y artefactos;
- arranque en un puerto alternativo;
- `GET /api/health`;
- schema, tablas, fuentes y mapa;
- reportes de resultados y cashflow;
- consulta SQL de solo lectura;
- carga de `index.html` y de los scripts extraidos.

## Coordinación nativa y recuperación

El flujo predeterminado usa hilos principales visibles. El Coordinador resuelve el proyecto ERP con `list_projects`, llama `create_thread` con destino `project`, entorno `local` o `worktree` y la consigna completa, y aplica siempre `set_thread_title` al `threadId` devuelto. El hilo comienza de forma independiente y aparece con nombre específico en la barra lateral.

El Coordinador responde inmediatamente: no espera, no recibe informes, no ejecuta comandos, diff, pruebas, navegador ni cambios. El hilo nuevo asume la tarea completa y puede crear sus propios especialistas nativos.

Local se usa cuando se necesita runtime principal, localhost o archivos locales. Worktree se usa para aislamiento o cuando otra tarea escritora está activa. `create_thread` no acepta permisos como parámetro; se aplican la configuración efectiva del entorno y las restricciones expresadas en el prompt.

Las correcciones se escriben directamente en el hilo visible de tarea. `.coordination/tasks/<taskId>/` permanece como runtime opcional y no sustituye al hilo.

Cada pedido o corrección explícita termina con exactamente un subagente `validador_tarea`, configurado con `gpt-5.6-sol`, esfuerzo high y sandbox read-only. El hilo transmite taskId, diff propio y cambios preexistentes delimitados; un árbol sucio conocido no bloquea salvo superposición material. `approved` cierra; `fix_required` permite una corrección y pruebas focalizadas sin segunda validación; `blocked` detiene y consulta al usuario. Coordinador no crea ni espera al validador.

La infraestructura `.coordination/`, los comandos `coordination:*`, el watcher y el protocolo v2 se conservan sin migraciones ni limpieza como modo de recuperación. No forman parte del flujo nativo, el watcher no necesita estar activo y no se ejecutan ambos circuitos para una misma tarea.

Las tareas y revisiones existentes mantienen su historial. No se deben editar manualmente colas, estados, locks, manifests ni entregas para adaptar ese historial al flujo nativo.

### Registro histórico del protocolo v2

El 23 de julio de 2026, el protocolo v2 superó una prueba multimodal controlada con una fixture sintética de `1536×1024` y SHA-256 `13ec94835380eb3f26c2d4c9d620bf19bc763f33273928b9c4fe4f92acd818b1`. La prueba usó `gpt-5.6-terra`, validó transporte, percepción, schema, contrato y presentación, y no produjo aprobaciones ni ejecuciones. Este registro documenta una capacidad heredada; no restablece el Coordinador como flujo normal.

Si se invoca explícitamente el sistema heredado, `COORDINATOR_MODEL` continúa configurable y `gpt-5.6-terra` sigue siendo su modelo recomendado. `gpt-5.6-sol` permanece como alternativa manual para revisiones excepcionales.

Los procedimientos históricos de inicio, diagnóstico y recuperación están documentados en `docs/coordination/`. Deben interpretarse exclusivamente dentro de ese contexto opcional.

## Limite actual y continuacion segura

`server.js` funciona como raiz de composicion y arranque; la logica de dominio esta en servicios, repositorios y utilidades backend. `assets/js/app.js` conserva el punto de entrada, la coordinacion transversal y algunos bloques operativos residuales (caja/egresos, imports backend-only y entrada general). Ventas, pedidos, cobros, cheques, compras, recepciones, logistica, otros gastos, comisiones, aportes, mapa, editor y SQL ya viven en modulos separados. `index.html` sigue completo para no alterar la inicializacion sincrona de scripts clasicos.

## Arquitectura final

- `server.js`: entorno, composicion e inyeccion, router, estaticos y arranque.
- `backend/routes/`: despacho HTTP sin reglas operativas.
- `backend/services/`: validacion, transformacion y casos de uso por dominio.
- `backend/repositories/` y `backend/data-store.js`: acceso a la unica fuente de verdad backend.
- `assets/js/app.js`: bootstrap, estado coordinador, navegacion, eventos globales y composicion.
- `assets/js/core/`: API, archivos y formatos compartidos.
- `assets/js/modules/`: renderizado, eventos, payloads y coordinacion de cada dominio.

El orden de scripts es sincronico: formatos y factories requeridos al evaluar se cargan antes de `app.js`; el resto de los modulos se carga despues, pero antes de que se dispare `DOMContentLoaded`. La vista `imports` conserva su identificador publico y representa el estado de la base backend; no importa ni reconstruye tablas desde fuentes externas.

La preparacion de seguridad local/LAN, permisos administrativos, limites SQL y plan de migracion de lecturas completas se documenta en `docs/administration-security.md`.

El contrato global de centavos, entrada localizada, formato argentino y excepciones no monetarias está en `docs/money-contract.md`.

La deuda tecnica deliberada es el registro central de eventos en `app.js` y algunos campos vacios de compatibilidad del estado local. Ninguno contiene reglas financieras ni sustituye las tablas backend. La separacion estructural se considera cerrada sin fragmentar `index.html` ni introducir un bundler.
