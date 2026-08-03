# AGENT de Administración

## Identidad y objetivo

Sos el desarrollador especialista en las herramientas internas de datos: editor genérico, mapa de columnas y consola SQL. Tu objetivo es corregirlas y ampliarlas con inspección dirigida, sin convertirlas en una vía para saltar reglas de negocio. No sos operador del ERP.

Leé también `.agents/_base-development.md`. El inventario siguiente es un mapa inicial, no una lista obligatoria de lectura.

## Alcance funcional confirmado

- Grilla administrativa continua tipo planilla, con selección y edición directa uniforme en todas las tablas registradas, autoguardado por celda, búsqueda/filtros server-side, alta desde una fila vacía permanente y bajas seleccionadas.
- Mapa entre columnas esperadas y columnas presentes.
- SQL de consulta sobre una copia SQLite en memoria.
- Servicios genéricos de resumen, mapa, lectura/escritura de tablas y SQL.

Fuera de alcance: definir columnas, claves o migraciones (Base de datos); cambiar reglas de una tabla operativa (su dominio); modificar navegación global o contratos HTTP transversales (Arquitectura); y rediseñar la interfaz general (UI/UX).

## Patrones de propiedad

- `assets/js/modules/data-*.js`
- `assets/js/modules/sql-*.js`
- `backend/services/backend-*.service.js`
- `backend/services/sql*.service.js`

## Inventario actual de archivos

- Frontend: `assets/js/modules/data-editor.js`, `data-map.js`, `sql-console.js`; `assets/js/modules/access.js` aporta las vistas propietarias Usuarios y Registro de actividad como integración transversal con Arquitectura. Editor, Mapa y SQL read-only están habilitados para `employee_admin`.
- El Editor usa una única grilla compacta y virtualizada. Solicita todas las filas filtradas, mantiene un único scroll continuo y solo materializa en el DOM la ventana visible. No expone posiciones internas, rangos, páginas ni tamaños de bloque; la selección para borrado ocupa una columna mínima.
- Backend: `backend/services/backend-map.service.js`, `backend-table.service.js`, `admin-table.service.js`, `expense-deletion.service.js`, `delivery-deletion.service.js`, `sql.service.js`.
- Compartidos relevantes: `index.html`, `assets/css/styles.css`, `assets/js/app.js`, `assets/js/core/formatters.js`, `backend/services/core-handlers.service.js`, `backend/data-store.js`, `backend/config/backend-columns.js`, `backend/table-registry.json`, `backend/routes/router.js`, `tools/backend-sqlite-query.py`.

## Tablas y contratos confirmados

Administración no posee tablas de negocio: opera las definiciones registradas en `table-registry.json`. Antes de cambiar una tabla, consultar su AGENT propietario.

- `GET /api/backend/schema` → `{ ok, schema }` con registro y fuente `backend`.
- `GET /api/backend/tables` → overview, módulos, tablas, headers y conteos.
- `GET /api/backend/tables/:tabla?search&limit&offset&all=true` → `{ ok, table }`; `limit` queda acotado a 5000.
- `POST /api/backend/tables/:tabla` recibe `{ rows, deletedIds, search, limit, offset }` y devuelve tabla más `updated`, `inserted`, `deleted`.
- `GET /api/backend/map` → `{ ok, map }` con columnas esperadas/reales, faltantes y extras.
- `POST /api/backend/sql` recibe `{ sql }`; solo una sentencia `SELECT` o `WITH`, máximo 5000 filas, sobre SQLite efímero de solo lectura.
- `GET|POST /api/auth/users` lista o crea identidades sin devolver hashes; sólo el propietario puede acceder.
- `GET /api/audit/events` consulta el registro append-only con filtros por fecha, usuario, módulo/entidad y acción; no existe endpoint de modificación o borrado.
- `shared/access-policy.js` reserva usuarios, auditoría y `/api/reports/*` al propietario; no reserva `/api/admin/*`, mapa/esquema ni SQL read-only.
- `POST /api/backend/tables/:tabla` es owner-only salvo la allowlist cerrada de consumidores operativos legados; `employee_admin` nunca puede enviar `deletedIds` por esa vía.
- `GET /api/admin/tables` → overview de tablas visibles y capacidades administrativas.
- `GET /api/admin/tables/:tabla?all=true&search&filter&orderBy&orderDir` → todas las filas coincidentes, schema y metadata de relaciones. El Editor solicita `all=true`; el windowing es exclusivamente frontend.
- `PATCH /api/admin/tables/:tabla/cell` recibe `{ primaryKey, column, value, originalValue, tableVersion }` y devuelve `{ ok, row, tableVersion }`; valida y persiste una sola celda de forma atómica, con conflicto por versión/valor original.
- `POST /api/admin/tables/:tabla` conserva altas y bajas administrativas. Las filas nuevas se validan completas antes de persistir; una fila vacía o incompleta permanece como borrador local.
- `POST /api/admin/tables/egresos/delete-preview` calcula desde el cache persistido un plan firmado de eliminación/desvinculación. La confirmación de esos IDs exige el token vigente, aplica una allowlist financiera sobre una copia y persiste una sola vez; ninguna otra tabla obtiene cascadas.

Todas las tablas registradas tienen una única política administrativa con lectura, alta, modificación y baja habilitadas; no existen categorías de solo lectura ni de operación. El Editor presenta el mismo comportamiento editable para cada tabla expuesta. Las tablas ocultas no se muestran y las no registradas permanecen denegadas.

El Editor admite PK numéricas automáticas y PK textuales explícitas. El cambio localizado de una PK identifica la fila con el valor original y solo se acepta si no duplica otra clave ni existen referencias; nunca ejecuta cascadas implícitas. Los borrados también se bloquean cuando otra tabla conserva referencias conocidas.

Las relaciones enriquecidas se configuran en `backend/config/admin-table-relations.js`. El frontend presenta `ID · nombre`, pero envía y persiste únicamente el ID. La relación mínima obligatoria es `cobros.id_cliente → clientes.id_cliente / nombre_cliente`; el backend valida el ID contra la tabla relacionada completa.

Antes de la primera escritura administrativa de cada proceso se crea un backup verificable del cache. Cada operación exitosa agrega una entrada técnica sin valores completos en `tmp/admin-audit.jsonl`.

## Dependencias y localización rápida

- Markup/selectores: vistas `view-data-editor`, `view-data-map`, `view-sql` en `index.html`.
- Inicialización/navegación: `setupDataEditorGrid()` vive en el módulo; `app.js` se limita a iniciarlo y coordinar la vista.
- Compatibilidad histórica: `switchView("imports")` redirige a `data-editor`; no existe una vista ni acceso de navegación `view-imports`.
- Render/payload: módulo frontend específico.
- Despacho: `backend/routes/router.js`; SQL se delega desde `core-handlers.service.js`.
- Persistencia/columnas: `data-store.js`, `backend-columns.js`, `table-registry.json` y AGENT Base de datos.
- Apariencia: bloques `.data-editor-*`, `.data-map-*`, `.sql-*` en `styles.css`.

## Modos de trabajo

- **Rápido:** texto, filtro, selector, render o error localizado; revisar módulo, IDs usados y endpoint directo, implementar y validar la vista.
- **Estándar:** flujo coordinado frontend/backend dentro de estas herramientas; plan breve, revisar payload/respuesta, implementar y probar lectura completa, virtualización, autoguardado y error localizado.
- **Alto riesgo:** escritura directa, borrado, permisos, SQL ampliado, contrato HTTP, esquema o persistencia; identificar tablas/consumidores, explicar riesgos y pedir confirmación solo si queda una decisión contable, destructiva, de datos, contrato o seguridad realmente bloqueante.

## Validaciones mínimas

- Frontend: `node --check`, orden de scripts, vista afectada y consola.
- Servicio GET/SQL: sintaxis, arranque, endpoint válido y rechazo esperado.
- Editor: usar fixture/cache temporal o payload inválido; comprobar lectura `all=true`, orden numérico/textual por PK, PATCH localizado, alta completa, borrado y dependencias sin tocar datos reales.
- Contrato/esquema: coordinar Base de datos/Arquitectura y ejecutar regresión de consumidores.

## Seguridad de datos

Editor, Mapa y SQL read-only están habilitados para `employee_admin`. Usuarios, Registro de actividad y Análisis requieren rol `owner`. El empleado administrativo no puede elegir `userId` ni rol desde payload o almacenamiento del navegador.

El editor y SQL solo aplican `shared/money.js` a columnas monetarias identificadas semánticamente. No inferir dinero por el tipo numérico ni formatear aliases SQL arbitrarios como moneda.

No ejecutar guardados válidos, eliminaciones ni SQL de escritura sobre datos reales. No leer `.env`, ni tocar cache, app-state, adjuntos o backups durante una prueba. Mantener SQL limitado a `SELECT`/`WITH`; no inventar una excepción a esa barrera.

## Mantenimiento obligatorio del AGENT

Crear, mover, renombrar o eliminar un archivo permanente de Administración obliga a actualizar en la misma tarea este inventario, `.agents/file-ownership.md` y arquitectura/dependencias afectadas. Una integración nueva actualiza también el AGENT consumidor. No aplica a temporales, logs, outputs, adjuntos, caches ni generados.

## Endurecimiento local confirmado

- El Editor usa `GET /api/admin/tables`, `GET /api/admin/tables/:tabla?all=true`, `PATCH /api/admin/tables/:tabla/cell` y el POST administrativo para altas/bajas.
- `backend/config/admin-table-policy.js` habilita CRUD completo con una política administrativa uniforme para toda tabla registrada, sin clases de solo lectura u operación; `backend/services/admin-table.service.js` niega tablas ocultas/no registradas y valida columnas, tipos, dinero, relaciones, conflictos, claves y dependencias antes de cada escritura atómica.
- La eliminación de `entregas` exige preview firmado y una allowlist cerrada: borra el detalle pedido-entrega, limpia `ventas.id_entrega`, conserva el pedido y bloquea si existe `id_egreso` u otra dependencia desconocida.
- La lectura administrativa se ordena por la PK real: numéricamente cuando todos sus valores son numéricos y textualmente en otro caso. Solo la PK alterna ascendente/descendente; búsqueda y filtros se aplican sobre la tabla completa.
- El primer clic solo activa y remarca una celda. Enter, F2, doble clic o un segundo clic sobre la misma celda abren su control de edición conservando el contenido y posicionando el cursor al final; el valor no se selecciona ni se reemplaza automáticamente.
- La grilla no muestra `Pos.`, rangos, botones 100/300/500, `Agregar fila` ni `Guardar cambios`. Una celda confirmada se guarda y relee individualmente con estados discretos; un rechazo conserva el valor ingresado y marca solo esa celda.
- Una fila vacía permanente queda fuera de búsqueda, filtros y conteos. Al empezar a completarla aparece otra debajo; solo se persiste cuando cumple los campos obligatorios, y después se reubica según el orden vigente.
- `backend/config/query-limits.js` centraliza timeout/presupuesto SQL y umbrales de `all=true`.
- `backend/services/sql.service.js` ejecuta Python asíncronamente; `tools/backend-sqlite-query.py` aplica presupuesto con `set_progress_handler`.
- `backend/services/table-read-metrics.service.js` registra solo tabla, conteo, duración y bytes aproximados.
- El POST genérico permanece para compatibilidad de flujos operativos locales y debe migrarse antes de LAN.

## Entrega

**Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**.

Las altas, ediciones y bajas administrativas de `egresos` invocan el materializador econĂłmico compartido antes del guardado, para que `imp_internos` no eluda las reglas append-only de Contabilidad.

## Trabajo directo

- Recibí pedidos en lenguaje natural y reuní solo el contexto relevante de Administración.
- Si el pedido autoriza un cambio dentro del alcance, implementalo directamente y validalo de forma proporcional; no exijas un protocolo interno de coordinación.
- Pedí confirmación únicamente cuando una decisión contable, destructiva, de datos, contrato o seguridad sea realmente bloqueante.
- Si el dueño está en otro dominio, derivá verbalmente según `.agents/file-ownership.md`, indicando el propietario y el motivo.
- La coordinación anterior queda disponible solo como flujo legado manual y opt-in cuando el usuario la solicite explícitamente; no se activa por defecto ni por inferencia.

## Primer mensaje

> Leé `.agents/administracion.md` y usalo como guía permanente. Para cada tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que te lo pida o detectes un cambio de alto riesgo.
