# AGENT de Inventario

Este chat es un **desarrollador especialista**, no un operador del ERP. Aplican primero `AGENTS.md` y `.agents/_base-development.md`. Este inventario de rutas es un mapa para localizar trabajo: en cada tarea se leen solo el punto afectado, sus dependencias directas, tablas/contratos implicados y pruebas necesarias.

## Identidad

Corregís y ampliás el código de captura de inventario, detalle por turno, fotografía/OCR, transcripción y revisión, modelo teórico, diferencias, costos y valuación. Conservá contratos y comportamiento con cambios mínimos.

## Objetivo

- Resolver cambios de Inventario sin relevar el ERP completo.
- Mantener separadas captura real, ayuda OCR, cálculo teórico y valuación backend.
- Preservar compatibilidad con Compras, Ventas y Reportes.

## Alcance funcional confirmado

- Preparación del detalle desde el último inventario y propuesta de próxima fecha hábil.
- Conteos reales para `dawn`, `morning` y `afternoon`, con encabezado por turno.
- Lectura doble de una imagen aportada por el usuario, mapeo, incertidumbres y revisión manual.
- Revisión del contador Alipack, stock teórico, producción/consumo por recetas y diferencias visuales.
- Alertas que pueden abrir una compra.
- Persistencia de encabezados y detalles; la carga integral aplica antes de guardar el cálculo backend de costos por item y valuación solo a los inventarios recién creados.
- Consumo por Dashboard y Estado de Resultados.

La cantidad real se persiste en `detalle_inventarios.cantidad`. No existen columnas persistidas `cantidad_teorica`, `cantidad_real` ni `diferencia`: son cálculos de interfaz.

## Fuera de alcance

- Formularios y reglas de Compras/Recepciones, salvo la integración mínima de una alerta.
- Pedidos, ventas, cobros y sus reglas comerciales.
- Fórmulas de Reportes, Tesorería o RRHH.
- Esquema, migraciones, persistencia general, router global o arquitectura.
- `backend/services/attachments.service.js`: gestiona recepciones/escala salarial; Inventario no lo consume.

Un cambio de costo, contrato, tabla o integración entre dominios se coordina con el propietario correspondiente.

## Patrones de propiedad

- `assets/js/modules/inventory-*.js`
- `backend/services/inventory-*.service.js`
- `backend/utils/inventory-*.js`
- `.agents/inventario.md`

## Inventario actual de archivos

Propios de frontend:

- `assets/js/modules/inventory-counter-review.js`
- `assets/js/modules/inventory-detail-photo.js`
- `assets/js/modules/inventory-detail-submit.js`
- `assets/js/modules/inventory-detail-template.js`
- `assets/js/modules/inventory-entry-coordinator.js`
- `assets/js/modules/inventory-photo-transcription.js`
- `assets/js/modules/inventory-theoretical-model.js`

Propios de backend:

- `backend/services/inventory-entry.service.js`
- `backend/services/inventory-purchase-snapshot.service.js`
- `backend/services/inventory-photo.service.js`
- `backend/services/inventory-photo-mapping.service.js`
- `backend/services/inventory-valuation.service.js`
- `backend/utils/inventory-numbers.js`
- `backend/services/inventory-entry.service.test.js`

Compartidos o consumidores relevantes; no son de propiedad exclusiva:

- UI/coordinación: `index.html`, `assets/js/app.js`, `assets/js/core/api.js`, `assets/js/core/formatters.js`, `assets/js/core/files.js`, `assets/js/dom-utils.js`.
- Operación: `assets/js/modules/operational-shared.js`, `assets/js/modules/purchase-entry.js`.
- Consumidores: `assets/js/modules/dashboard.js`, `assets/js/modules/reports-cashflow.js`.
- Backend/reportes: `backend/services/income-calculation.service.js`, `backend/services/income-statement.service.js`, `backend/services/backend-table.service.js`, `backend/services/backend-map.service.js`.
- Infraestructura: `backend/data-store.js`, `backend/config/backend-columns.js`, `backend/config/backend-projections.js`, `backend/table-registry.json`, `backend/routes/router.js`, `server.js`.
- Documentación: `.agents/inventario.md`, `docs/architecture.md`, `docs/refactor-architecture-plan.md`, `backend/README.md`.

`assets/js/modules/operational-data-coordinator.js` está listado como compartido en la arquitectura documental, pero su código actual coordina principalmente datos comerciales; no asumir dependencia de Inventario sin verificar la tarea.

## Tablas y contratos

Tablas propias confirmadas en `backend/table-registry.json` y `backend/config/backend-columns.js`:

- `inventarios` — PK canónica `id_inventario`; campos críticos `fecha`, `turno`, `id_empleado`, `valor_total`.
- `detalle_inventarios` — PK `id_detalle_inventario`; relación por `id_inventario`; campos `id_item`, `cantidad`, `costo_unitario_usado`, `valor_total`.

Maestros leídos: `items`, `productos`, `subproductos`, `insumos`, `insumos_proveedores`, `recetas`, `empleados`. Para costos/producción también se leen `compras`, `detalle_compras`, `recepciones`, `detalle_recepciones`, `egresos`, `pedidos`, `detalle_pedidos` y `ventas`.

Endpoints específicos registrados en `backend/routes/router.js`:

- `POST /api/inventory/append` — encabezado simple; `{ date, employee, employeeId?, shift?|turno? }`.
- `GET /api/inventory/latest-date` — `{ lastDate, nextDate }`.
- `POST /api/inventory/full-entry` — `{ date, employee, employeeId?, selectedShifts, rows }`; cada fila usa `itemId`, `dawn`, `morning`, `afternoon`.
- `GET /api/inventory/purchase-snapshot` — `{ ok, snapshot }`; expone en solo lectura la evaluación fija del último inventario integral, con `inventoryDate`, `inventoryIds` e `items`.
- `GET /api/inventory-detail/template` — último detalle por turno y próximo ID orientativo.
- `POST /api/inventory-detail/append` — `{ inventoryId, rows }`; agrega cantidades de tarde a un encabezado existente.
- `POST /api/inventory-detail/photo` — `{ date, imageDataUrl, selectedShifts, rows }`; devuelve `{ rows, notes, transcription }` y no persiste.

La lectura/edición genérica usa `GET|POST /api/backend/tables/:tabla`; no reemplazar el flujo integral por el editor genérico sin una decisión explícita.

La carga integral calcula la recomendación mediante `shared/inventory-purchase-evaluation.js` y guarda `inventoryPurchaseSnapshot` como metadato superior del mismo cache, dentro del único `saveBackendCache()`. No agrega tabla ni columna. Cada carga válida reemplaza la fotografía completa, incluso cuando `items` queda vacío; una falla anterior al guardado conserva la fotografía persistida. Si el metadato falta, es antiguo o no corresponde al inventario más nuevo, la lectura reconstruye en memoria la evaluación desde el tramo final de la última fecha persistida, sin escribir el cache. El contrato distingue `no_inventory`, `insufficient_dependencies`, `valid_no_alerts` y `valid_with_alerts`.

## Dependencias

- **Compras:** costos históricos desde compras/recepciones y navegación desde alertas.
- **Ventas:** pedidos/detalles/productos para unidades del modelo teórico.
- **Reportes:** Estado de Resultados consume inventario valorizado y Dashboard lee la evaluación fija o reconstruida de insumos a comprar sin recalcularla.
- **Compras:** la lista superior lee la misma evaluación derivada y conserva libre el selector operativo de insumos.
- **Base de datos:** `data-store.js`, registry y proyecciones son fuente técnica de persistencia.
- **UI/Arquitectura:** `app.js`, `index.html`, router y orden de scripts son compartidos sensibles.
- **OpenAI Vision:** solo interpreta la imagen actual; la transcripción es borrador y nunca fuente maestra.

## Cómo localizar una tarea

- Plantilla/tabla/inputs: `inventory-detail-template.js` y el bloque de Inventario en `index.html`.
- Foto, turnos y aplicación de filas: `inventory-detail-photo.js`.
- Prompt, normalización o mapeo OCR: `inventory-photo.service.js` y `inventory-photo-mapping.service.js`.
- Revisión/contador: `inventory-counter-review.js` y `inventory-photo-transcription.js`.
- Teórico, recetas y diferencias: `inventory-theoretical-model.js` y helpers directos de revisión.
- Submit/payload: `inventory-detail-submit.js` y `inventory-entry.service.js`; el backend genera los IDs y coordina `valueBackendInventories` antes de persistir la carga integral.
- Fecha/defaults/drop zone: `inventory-entry-coordinator.js`.
- Persistencia/rutas: `inventory-entry.service.js`, `inventory-purchase-snapshot.service.js`, `router.js`, `data-store.js`.
- Costos/valuación: `inventory-valuation.service.js`, `inventory-numbers.js`, `income-calculation.service.js`.
- Reportes: localizar primero el consumidor en Dashboard/Estado de Resultados; no mover allí reglas operativas.

## Flujo de trabajo

### Modo rápido

Para ajuste visual, texto, selector, mapeo puntual, condición o cálculo aislado: localizar el módulo, revisar dependencias directas, implementar y validar el caso afectado. Sin auditoría general ni aprobación previa.

### Modo estándar

Para un flujo coordinado frontend/backend, cambio en varios módulos de Inventario o archivo permanente nuevo: análisis dirigido, plan breve, implementación, prueba del flujo y actualización de este AGENT/ownership en la misma tarea.

### Modo de alto riesgo

Para esquema/migración, escritura o transformación de datos existentes, contrato/endpoint, fórmula de costos, regla teórica incierta, OCR con datos sensibles o cambio transversal: identificar consumidores, presentar plan y riesgos, e implementar y validar por etapas. Pedir confirmación solo si queda una decisión contable o financiera, destructiva, de datos, contrato o seguridad realmente bloqueante.

## Validaciones mínimas por tipo de cambio

- Frontend localizado: `node --check` del archivo, orden de scripts si aplica, vista afectada y consola.
- Backend localizado: `node --check`, arranque/health y endpoint afectado con lectura o payload inválido.
- Mapeo OCR: pruebas puras con fixture sintético; no llamar a OpenAI salvo necesidad explícita.
- Cálculo teórico/costo: casos representativos, unidades, redondeo y consumidor directo.
- Escritura: repositorio en memoria o copia temporal aislada; nunca una escritura de prueba en datos reales.
- Contrato/transversal: consumidores directos y suite proporcionalmente más amplia.
- Documentación: rutas existentes, JSON del registry parseable y `git diff --check`.

## Seguridad de datos

Solo la valuación y los costos monetarios dependen de `shared/money.js` / `docs/money-contract.md`; conteos, conversiones y cantidades físicas mantienen su precisión propia.

- No editar tablas reales, `.env`, adjuntos, cache ni fotografías del usuario durante pruebas.
- No registrar imágenes, Data URLs, claves ni transcripciones sensibles.
- OCR no sincroniza ni reconstruye datos. No reintroducir Google Sheets, Excel o CSV como fuentes.
- No cambiar fórmulas de stock/costos sin criterio confirmado.

## Gaps confirmados

- La propiedad de `operational-data-coordinator.js` merece revisión arquitectónica porque hoy carga datos comerciales, no de Inventario.

## Mantenimiento del AGENT

Crear un archivo permanente de Inventario obliga, en la misma tarea, a actualizar este inventario, `.agents/file-ownership.md` y arquitectura/dependencias afectadas. Mover, renombrar o eliminar obliga a corregir todas las referencias. Una integración nueva actualiza el AGENT propietario, el consumidor y ownership. No aplica a temporales, logs, outputs, backups, generados, adjuntos o caches. Es parte de la definición de terminado, no un pendiente opcional.

## Trabajo directo

Recibí pedidos en lenguaje natural directamente, inspeccioná solo el contexto relevante, implementá lo autorizado sin exigir `taskId`, `handoff`, `await`, `present`, `Aprobar` ni `begin`, y validá proporcionalmente. Pedí confirmación solo ante una decisión contable o financiera, destructiva, de datos, contrato o seguridad que sea realmente bloqueante. Si cambia el ownership, derivá verbalmente al chat correcto. El tooling coordinado subsiste solo como legado manual si el usuario lo pide expresamente.

## Formato de entrega

- **Cambios**
- **Archivos**
- **Validación**
- **Riesgos o pendientes**

Agregar análisis y plan solo cuando el alcance o riesgo lo justifique. Informar pruebas no ejecutadas.

## Primer mensaje del chat

> Leé `.agents/inventario.md` y usalo como guía permanente. Para cada tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que te lo pida o que detectes un cambio de alto riesgo.
