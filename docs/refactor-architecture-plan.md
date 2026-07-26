# Plan de refactorizacion arquitectonica

## Linea base (2026-07-22)

- `server.js`: 7.924 lineas. Crea el servidor HTTP, despacha todas las rutas y contiene configuracion de tablas, persistencia, imports, Google Sheets, adjuntos, lectura de comprobantes, SQL, inventario, costos, sueldos, planes de pago, aportes de socios, estado de resultados, cashflow y conciliacion bancaria.
- `index.html`: 2.931 lineas y 27 vistas `view-*`.
- `assets/js/app.js`: 14.472 lineas; usa un unico alcance global y se carga como script clasico despues de `assets/js/dom-utils.js`.
- Backend existente: `backend/data-store.js`, `backend/table-registry.json`, `backend/bank-rules.js` y `backend/http-config.js`.
- No hay dependencias npm declaradas ni framework de rutas/build.

La linea base pasa `node --check` para `server.js`, `assets/js/app.js` y `assets/js/dom-utils.js`. El servidor inicia con `node server.js`; `GET /api/health`, `GET /api/backend/tables` y `GET /api/backend/schema` respondieron correctamente. El cache expone 42 tablas. El runtime Node del workspace se usa por ruta absoluta porque `node` y `npm` no estan en el `PATH` de la sesion.

## Mapa de rutas

El bloque de despacho actual se divide en estos dominios:

- Backend y datos: health, schema, tables, sources, map, refresh y SQL.
- Reportes: estado de resultados y cashflow.
- Tesoreria: analisis/aplicacion de conciliacion y deposito de cheques.
- Acreedores: alta integral.
- Adjuntos y lectura: comprobantes de recepcion y escala salarial.
- Estado local: lectura y escritura de app-state.
- Imports y Google Sheets.
- Inventario: append, fecha mas reciente, carga completa, detalle, plantilla y foto.
- Compras: carga integral.
- Archivos estaticos y fallback 404.

## Dependencias compartidas relevantes

- El cache y registry se acceden mediante `backend/data-store.js`.
- Normalizacion de texto, numeros, fechas e IDs es consumida por casi todos los dominios.
- La conciliacion bancaria depende de egresos, pagos, cobros, cheques, acreedores, etiquetas y reglas bancarias.
- Estado de resultados comparte valorizacion de inventario, categorias de egresos, sueldos y helpers de fechas/numeros.
- Imports finaliza y relaciona multiples tablas; debe extraerse antes que los servicios que quieran reutilizar su normalizacion.

## Vistas

`results`, `cashflow`, `payment-plans`, `bank-reconciliation`, `dashboard`, entradas generales, compras, recepciones, cheques, caja, egresos, sueldos, logistica, otros gastos, aportes, comisiones, pagos, ventas, pedidos, cobros, imports, mapa, acreedores, editor, SQL y configuracion.

## Estrategia

1. Extraer paths, configuracion de columnas/proyecciones y utilidades puras.
2. Centralizar repositorios de cache y app-state.
3. Extraer servicios por dominio, empezando por los menos acoplados; conciliacion al final.
4. Reemplazar el `if` de rutas por un router CommonJS pequeno, sin cambiar endpoints ni contratos.
5. Mantener `server.js` como composicion, estaticos, errores y arranque.
6. En frontend, preservar scripts clasicos y orden global. Extraer dominios solo cuando puedan recibir dependencias explicitas sin duplicarlas. Si fragmentar HTML obliga a carga asincrona y cambia el orden de inicializacion, conservar el markup y documentar el motivo.
7. Tras cada bloque: `node --check`, arranque, health y endpoints GET afectados; al final, validacion integral y busqueda de referencias rotas.

## Reglas de migracion

- No modificar caches, datos, `.env`, tablas, columnas, selectores ni contratos.
- No corregir defectos funcionales preexistentes durante la extraccion.
- Eliminar cada implementacion original cuando su modulo pase las validaciones.
- Evitar un modulo compartido generico: separar HTTP, texto, numeros, fechas, IDs y archivos.

## Segunda etapa completada (2026-07-22)

### Frontend

- Conciliacion bancaria salio de `assets/js/app.js` y se dividio en cuatro scripts clasicos: core de carga/analisis, renderizado, depositos de cheques y borradores/acciones.
- La entrada detallada de inventario se dividio en seis scripts: plantilla, foto, modelo teorico, revision de contador, transcripcion y envio.
- Los scripts de dominio se cargan inmediatamente despues de `app.js`. Esto conserva el entorno lexico compartido de scripts clasicos y garantiza que las funciones existan antes de `DOMContentLoaded`, sin introducir carga asincrona ni cambiar eventos.
- `index.html` conserva todas las vistas y selectores.

### Backend

- Conciliacion bancaria se dividio en `bank-reconciliation.service.js`, `bank-persistence.service.js`, `bank-parser.service.js` y `bank-matching.service.js`.
- Inventario se dividio en `inventory-entry.service.js`, `inventory-photo.service.js` e `inventory-photo-mapping.service.js`.
- El mapeo de transcripciones de inventario es un modulo puro; no accede a cache, red ni archivos.
- No se ejecutaron acciones de apply, refresh, append o persistencia durante la validacion.

### Contratos de regresion

- CSV bancario minimo: una fila, estado `revisar`, importe `-1000`, fecha `2026-07-01`, saldo `5000` y un pendiente, igual antes y despues de la extraccion.
- `POST /api/inventory-detail/photo` con payload vacio conserva respuesta 400.
- Los GET de inventario alcanzan el servicio, pero en el proceso de prueba aislado Google Sheets queda bloqueado por red (`EACCES`). No se elevo acceso ni se ejecuto refresh externo.
- La aplicacion se abrio en navegador: las vistas de conciliacion e inventario quedaron activas al navegar y no se registraron errores de consola.

### Siguiente frontera

- Frontend: compras/recepciones, sueldos, pagos, ventas/cobros, cheques y reportes.
- Backend: costos de inventario, sueldos, estado de resultados, imports/Google Sheets y entidades operativas restantes.

## Tercera etapa completada (2026-07-22)

### Frontend

- Sueldos se separo en `salary-entry.js` (periodo, escala, novedades y calculo) y `salary-expense-entry.js` (alta del egreso salarial).
- Compras/pagos se redujeron mediante `reception-options.js`, `issued-check-pending.js` y `payment-entry.js`.
- Estado de Resultados y cashflow salieron juntos a `reports-cashflow.js`, porque comparten el reporte mensual, clasificaciones y render principal.
- Dashboard salio a `dashboard.js`; sus widgets, estados de carga y tablas quedaron separados del reporte.
- Los helpers de acceso generico al backend y archivos salieron a `core/api.js` y `core/files.js`.
- `salary-entry.js` se carga antes de `app.js` porque el estado inicial usa el periodo salarial durante la evaluacion sincrona. Los demas scripts se cargan despues de `app.js` y antes de `DOMContentLoaded`.
- `assets/js/app.js` queda en 7.981 lineas. Sigue siendo el unico punto de entrada y `index.html` conserva intacta la estructura de vistas.

### Backend

- Clasificacion, origen, acreedor y etiquetas de egresos salieron a `expense-classification.service.js`.
- Sueldos se dividio en `payroll-summary.service.js` y `payroll-normalization.service.js`.
- Fechas, numeros y calculos compartidos del reporte salieron a `income-calculation.service.js`; la composicion del reporte quedo en `income-statement.service.js`.
- Valuacion y costos de inventario salieron a `inventory-valuation.service.js`; los helpers numericos quedaron en `utils/inventory-numbers.js`.
- `server.js` queda en 2.852 lineas. Aun contiene imports/Google Sheets y parte de la vinculacion/calendario de sueldos y entidades operativas.

### Validacion de la etapa

- `node --check` paso para los archivos backend y frontend modificados.
- El servidor arranco en el puerto alternativo 3199; `GET /api/health`, Estado de Resultados y cashflow respondieron 200.
- El payload vacio de lectura de escala salarial conservo su respuesta 400.
- En navegador cargaron Estado de Resultados, dashboard y cashflow sin errores de consola; tambien se verificaron previamente Sueldos y Pagos.
- No se ejecutaron refreshes externos, altas, apply, append ni escrituras de datos persistentes.

### Siguiente frontera

- Frontend: ventas/cobros, cheques restantes, imports/editor/mapa/SQL y bloques operativos residuales.
- Backend: Google Sheets/imports, vinculacion/calendario salarial restante y lectura/escritura de entidades operativas.
- La refactorizacion no se considera finalizada mientras estos dominios sigan dentro de los dos puntos de entrada.

## Fuente unica backend implementada (2026-07-22)

- Se eliminaron `/api/backend/sources`, `/api/backend/refresh` y `/api/imports/refresh` del router.
- Se eliminaron URLs, controles y fetches de importacion externa del frontend.
- La antigua vista Imports paso a informar el estado de la base backend y conserva el mismo identificador de vista.
- Inventario y compras dejaron de leer o escribir libros externos; ahora validan relaciones y persisten en tablas backend.
- Esquema, mapa, resumen y tablas publican `sourceOfTruth: backend` y ocultan metadata historica de origen.
- Se eliminaron los scripts offline que reconstruian el cache desde Excel o CSV.
- Las llamadas externas restantes son exclusivamente OCR/interpretacion de archivos aportados por el usuario y no reconstruyen tablas.

## Cuarta etapa completada (2026-07-22)

### Frontend

- Ventas y pedidos salieron a `sales-orders.js`; cobros y retenciones a `collections-retentions.js`.
- Las entradas de cheques recibidos y emitidos quedaron en `received-check-entry.js` e `issued-check-entry.js`.
- Compras y recepciones se separaron en `purchase-entry.js` y `reception-entry.js`.
- Logistica, otros gastos, comisiones y aportes de socios quedaron en modulos de dominio independientes.
- Mapa, editor de datos y consola SQL salieron a `data-map.js`, `data-editor.js` y `sql-console.js`.
- Los helpers operativos estrictamente compartidos quedaron en `operational-shared.js`; no se creo un segundo punto de entrada.
- `data-editor.js` se carga antes de `app.js` porque el estado inicial crea su view-state durante la evaluacion sincrona. Los otros dominios se cargan despues de `app.js` y antes de `DOMContentLoaded`.
- `assets/js/app.js` queda en 2.817 lineas. Conserva la inicializacion, el estado coordinador y los bloques residuales que todavia no justifican otra extraccion segura.

### Backend

- Altas de acreedores y compras salieron a `creditor-entry.service.js` y `purchase-entry.service.js`.
- Referencias bancarias, handlers base, mapa backend y helpers de runtime/banco quedaron en servicios y utilidades dedicados.
- Se elimino logica legacy sin consumidores que reconstruia normalizaciones, calendarios e inventario desde fuentes historicas.
- `server.js` queda en 548 lineas y se limita a entorno, composicion/inyeccion de servicios, servidor HTTP, estaticos y arranque.
- La base backend sigue siendo la unica fuente de verdad; no quedan rutas ni referencias de reconstruccion desde Google Sheets, Excel o CSV.

### Validacion de la etapa

- `node --check` paso para los 75 archivos JavaScript del backend y frontend; `table-registry.json` tambien se parseo correctamente.
- `git diff --check` no detecto errores de whitespace.
- El servidor arranco en el puerto 3199. Health, schema, listado/mapa backend, app-state, resultados, cashflow, inventario y tablas operativas respondieron correctamente.
- La consulta SQL de solo lectura `SELECT 1` respondio 200. Los payloads vacios de compras, acreedores, conciliacion e inventario conservaron rechazo 400, sin escrituras.
- En una sesion limpia de navegador se recorrieron ventas, pedidos, cobros, ambos cheques, compras, recepciones, logistica, otros gastos, comisiones, aportes, mapa, editor y SQL sin errores de consola.
- No se ejecutaron refreshes externos, altas validas, apply, append ni escrituras persistentes.

### Frontera pendiente

- `app.js` aun contiene coordinacion transversal, caja/egresos, imports backend-only y entradas generales. Puede seguir reduciendose por dominios, pero ya cumple el objetivo cuantitativo de esta etapa.
- `index.html` permanece sin fragmentar para conservar la inicializacion sincrona.
- La refactorizacion no se declara terminada: quedan responsabilidades frontend residuales y conviene revisar los nombres canonicos de algunas tablas historicas antes de ampliar pruebas funcionales de cobros.

## Cierre arquitectonico (2026-07-22)

### Arquitectura resultante

- `server.js` queda como raiz de composicion: carga entorno/configuracion, instancia repositorios y servicios, registra el router, sirve archivos estaticos y arranca el servidor. No contiene validaciones, transformaciones, acceso a tablas, calculos ni reglas de dominio.
- `assets/js/app.js` queda como punto de entrada clasico: mantiene el estado coordinador compatible, cache de nodos, bootstrap sincronico, navegacion, registro global de eventos y composicion de renderizados.
- Fechas, importes, cantidades y helpers de presentacion reutilizados por los dominios viven en `assets/js/core/formatters.js`, cargado antes de `app.js`.
- La coordinacion especifica de inventario y la carga de datos operativos viven en `inventory-entry-coordinator.js` y `operational-data-coordinator.js`.
- Se elimino el bloque sin consumidores de CSV, parseo de entidades y reconstruccion de inventario legacy. La vista historicamente identificada como `imports` informa exclusivamente la fuente backend; el ID se conserva por compatibilidad.
- `index.html` permanece completo y los scripts siguen siendo clasicos. Los helpers requeridos durante la evaluacion se cargan antes de `app.js`; los modulos de dominio se cargan despues y antes de `DOMContentLoaded`.

### Flujo de datos

1. Las pantallas consultan exclusivamente endpoints del backend.
2. El router delega en servicios; los servicios validan y usan el repositorio de tablas backend.
3. Las escrituras validas se persisten en las tablas backend y las lecturas/reportes vuelven a consultar esas tablas.
4. El estado local conserva solamente preferencias y compatibilidad de interfaz; no reconstruye tablas ni reemplaza la base.

### Conteos finales

- `assets/js/app.js`: 2.817 lineas al iniciar esta etapa; 1.909 lineas al cierre.
- `server.js`: 548 lineas al iniciar y 548 lineas al cierre.
- Frontend: 34 modulos de dominio y 3 modulos core.
- Backend: 24 servicios, repositorios, configuracion, router y utilidades.

### Validacion final

- Sintaxis validada sobre 78 archivos JavaScript y parseo correcto de todos los JSON del proyecto.
- Servidor probado en puerto 3199: health, schema, tablas, mapa, app-state, resultados, cashflow, inventario, compras, ventas, cobros, pagos, sueldos, caja y egresos respondieron 200.
- SQL de solo lectura respondio 200; conciliacion, compras, inventario, caja y egresos rechazaron payloads vacios sin persistir datos.
- Se navegaron las 27 vistas reales sin errores de consola.
- `git diff --check` correcto y busqueda sin referencias a reconstruccion externa, refresh, Google Sheets, Excel/CSV o parsers legacy.

### Deuda tecnica real

- `bindEvents` sigue siendo extenso porque centraliza el registro global requerido por scripts clasicos. Dividirlo exigiria definir APIs de binding por cada modulo; no contiene reglas de negocio y se conserva para evitar una abstraccion artificial.
- El estado local mantiene campos historicos vacios por compatibilidad con sesiones existentes. No alimenta las tablas backend.
- Algunos textos e identificadores visibles conservan el termino `imports` para no romper navegacion, IDs ni expectativas de interfaz.

Con estos limites, la refactorizacion estructural se considera terminada: no quedan varios dominios operativos grandes dentro de `app.js` o `server.js`, y ninguno fue ocultado en un nuevo modulo monolitico.

## Coordinacion semiautomatica v2 — registro historico (2026-07-23)

La coordinacion v2 se implemento y valido como tooling local separado del ERP. Sus colas, estados, hashes, contratos, watcher, pruebas y datos historicos se conservan sin migracion ni eliminacion.

Desde el 24 de julio de 2026, este sistema es legado manual opcional. El flujo predeterminado vuelve a ser directo: un pedido natural llega al especialista, se resuelve dentro de su ownership, se valida proporcionalmente y se entrega sin crear `taskId`, handoff, evidencia coordinada, revision paralela, espera, presentacion, aprobacion intermedia ni transferencia de estado.

El tooling anterior solo puede activarse por solicitud explicita para recuperar, inspeccionar o diagnosticar una tarea historica. No forma parte de `npm start`, no se inicia desde el launcher habitual y no debe alterar tareas existentes por iniciativa propia. Los detalles tecnicos preservados permanecen en `docs/coordination/`.
