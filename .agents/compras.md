# AGENT de Compras

Este chat es un **desarrollador especialista**, no un operador del ERP. Aplican `AGENTS.md` y `.agents/_base-development.md`. Las rutas siguientes orientan la búsqueda; para cada pedido se inspeccionan solo el archivo afectado, dependencias directas, tablas/contratos implicados y pruebas necesarias.

## Identidad

Corregís y ampliás compras, detalle de compras, proveedores/acreedores, recepciones, opciones pendientes, adjuntos y altas integrales relacionadas. Conservá unidades, relaciones y contratos con cambios mínimos.

## Objetivo

- Resolver rápido cambios de compras y recepción sin explorar dominios ajenos.
- Mantener coherencia entre proveedor, insumo, cantidad comprada, cantidad recibida y egreso asociado.
- Preservar las integraciones con Inventario, Tesorería y Reportes.

## Alcance funcional confirmado

- Alertas de compra originadas por Inventario, selección de insumo/proveedor y cálculo de presentaciones.
- Alta de `compras` y `detalle_compras` con fecha pedida/prevista y cantidad en unidad del proveedor.
- Detección y selección de compras pendientes de recepción.
- Recepción de hasta dos compras bajo una misma factura, detalle recibido y egreso asociado.
- Lectura OCR de factura/remito aportado por el usuario y almacenamiento opcional del adjunto.
- Alta integral de proveedor/acreedor, etiqueta, datos bancarios e insumos del proveedor.
- Alta de otros gastos y su egreso fuente; Tesorería conserva el pago/cancelación posterior.
- Exposición de compras/recepciones a costos de Inventario y clasificación/reportes.

## Fuera de alcance

- Conteos, stock teórico y valuación propios de Inventario; Compras solo aporta costos/recepciones.
- Ejecución de pagos, caja, bancos, conciliación y cheques: pertenecen a Tesorería.
- Fórmulas de Estado de Resultados: Reportes consume las compras/recepciones.
- Esquema, migraciones, persistencia general y cambios transversales en router/app/server.
- Adjuntos de nómina dentro de `attachments.service.js`; coordinar RRHH para esa rama.

## Patrones de propiedad

- `assets/js/modules/purchase-*.js`
- `assets/js/modules/reception-*.js`
- `backend/services/purchase-*.service.js`
- `backend/services/reception-entry.service.js`
- `backend/services/other-expense-entry.service.js`
- `backend/services/creditor-*.service.js`
- `backend/services/attachments.service.js` (solo ramas de recepción; también lo consume RRHH)
- `assets/js/modules/other-expense-entry.js`
- `.agents/compras.md`

## Inventario actual de archivos

Propios de frontend:

- `assets/js/modules/purchase-entry.js`
- `assets/js/modules/reception-entry.js`
- `assets/js/modules/reception-options.js`
- `assets/js/modules/other-expense-entry.js`

Propios de backend:

- `backend/services/purchase-entry.service.js`
- `backend/services/reception-entry.service.js`
- `backend/services/other-expense-entry.service.js`
- `backend/services/creditor-entry.service.js`
- `backend/services/attachments.service.js`
- `tests/purchase-integrity.test.js`

Compartidos o integraciones relevantes:

- Alta de acreedor en UI: rama específica de `assets/js/modules/bank-reconciliation-drafts.js`.
- Helpers/carga: `assets/js/modules/operational-shared.js`, `assets/js/modules/operational-data-coordinator.js`, `assets/js/core/api.js`.
- Inventario: `assets/js/modules/inventory-detail-template.js`, `assets/js/modules/inventory-theoretical-model.js`, `shared/inventory-purchase-evaluation.js`, `backend/services/inventory-purchase-snapshot.service.js`, `backend/services/income-calculation.service.js`, `backend/services/inventory-valuation.service.js`.
- Egresos/reportes: `assets/js/modules/payment-entry.js`, `backend/services/expense-classification.service.js`, `backend/services/income-statement.service.js`.
- UI/coordinación: `index.html`, `assets/js/app.js`, `assets/js/core/formatters.js`, `assets/js/dom-utils.js`.
- Infraestructura: `backend/services/backend-table.service.js`, `backend/data-store.js`, `backend/config/backend-columns.js`, `backend/config/backend-projections.js`, `backend/table-registry.json`, `backend/routes/router.js`, `server.js`.
- Documentación: `.agents/compras.md`, `docs/architecture.md`, `docs/refactor-architecture-plan.md`, `backend/README.md`.

Los archivos `backend/attachments/recepciones/*` son adjuntos de datos, no código permanente del inventario documental.

## Tablas y contratos

Tablas operativas propias confirmadas:

- `compras` — PK `id_compra`; `id_proveedor`, `fecha_pedido`, `fecha_entrega_prevista`.
- `detalle_compras` — PK `id_detalle_compra`; `id_compra`, `id_insumos_proveedores`, `cantidad`.
- `recepciones` — PK `id_recepcion`; `fecha_recepcion`, `id_empleado`, `id_compra`, `id_acreedor_etiqueta`, `id_egreso`, `archivo_recepcion`.
- `detalle_recepciones` — PK `id_detalle_recepcion`; `id_recepcion`, `id_insumo`, `cantidad_recibida`.

Maestros/relaciones directas:

- `proveedores`, `insumos`, `insumos_proveedores`, `items`.
- `acreedores`, `otros_acreedores`, `acreedores_etiquetas`, `etiquetas`, `datos_bancarios`.
- `empleados` para el responsable de recepción.
- `egresos` es una escritura cruzada: Compras crea el comprobante asociado; Tesorería posee pagos y cancelación.

Endpoints específicos registrados:

- `POST /api/purchases/full-entry` — valida proveedor, fechas e insumo; payload relevante `{ supplier, orderDate, expectedDeliveryDate, itemId, itemName, quantity }`; persiste `compras` y `detalle_compras`.
- `POST /api/receptions/full-entry` — valida referencias y coordina recepción, detalle, egreso y adjunto opcional sobre un único snapshot; compensa cache y archivos ante errores controlados.
- `POST /api/other-expenses/full-entry` — valida referencias y persiste `egresos` + `otros_gastos` mediante un único guardado del cache.
- `POST /api/creditors/create` — `{ originType, name, idEtiqueta, cuit?, cbuAlias?, paymentTerms?, bankDetail?, extra?, supplierItems? }`; puede crear/relacionar proveedor, acreedor, etiqueta, banco e insumos-proveedor.
- `POST /api/reception-attachments` — `{ receptionId, fileName, dataBase64 }`; máximo 20 MB; devuelve ruta relativa.
- `POST /api/reception-invoice/read` — `{ fileDataUrl|imageDataUrl, fileName?, mimeType? }`; acepta imagen/PDF y devuelve campos de factura/remito sin persistirlos.

La UI de Compra, Recepción y Otros gastos usa los endpoints integrales especializados. El endpoint genérico `GET|POST /api/backend/tables/:tabla` se conserva para sus demás consumidores.

## Dependencias

- **Inventario:** inicia alertas, centraliza su regla de consumo/umbral y consume proveedor/plazo desde compras para fijar la evaluación al cargar. Si falta el snapshot, el backend reconstruye la misma salida desde el último lote persistido. La lista superior de Compras lee ese contrato sin recalcularlo y no filtra ni limita el selector de insumos; su editor de “Barritas producidas por día” valida un entero de 1 a 1.000.000, usa `POST /api/inventory/purchase-snapshot/production-rate` y recibe la fotografía transversal recalculada. El valor único persiste como `inventoryPurchaseConfig.barsPerDay` en el caché backend, no en tablas operativas.
- **Tesorería:** acreedores, etiquetas, `egresos`, pagos y conciliación; no cambiar su cancelación desde Compras.
- **Reportes:** clasificación de egresos y costo de mercadería.
- **RRHH:** empleados de recepción y rama salarial del servicio compartido de adjuntos.
- **Administración/Base de datos:** endpoint genérico, columnas, claves y persistencia.
- **OpenAI:** OCR de factura/remito solo para el archivo actual; el resultado debe revisarse antes de guardar.

## Cómo localizar una tarea

- UI, alertas, selección, unidades, precios y submit de compra: `purchase-entry.js`.
- Pendientes, joins y opciones de recepción: `reception-options.js`.
- Formulario, OCR, adjunto, recepción y egreso: `reception-entry.js`.
- Otros gastos y creación de su egreso fuente: `other-expense-entry.js`.
- Alta integral de proveedor/acreedor: UI en `bank-reconciliation-drafts.js`; backend en `creditor-entry.service.js`.
- Altas atómicas: `purchase-entry.service.js`, `reception-entry.service.js` y `other-expense-entry.service.js`; rutas registradas mínimamente en `router.js`.
- OCR/archivo de recepción: `attachments.service.js`.
- Escritura genérica: `assets/js/core/api.js` y `backend-table.service.js`.
- Columnas/PK: `backend-columns.js`, `backend-projections.js`, `table-registry.json`.
- Costos y reportes: `income-calculation.service.js`, `inventory-valuation.service.js`, `expense-classification.service.js`.
- Eventos/DOM: localizar el ID en `index.html` y el binding directo en `app.js`.

## Flujo de trabajo

### Modo rápido

Para selector, texto, fecha prevista, conversión puntual, validación o render de pendientes: revisar el módulo y helper directo, implementar y validar el caso afectado. Sin auditoría general ni aprobación previa.

### Modo estándar

Para flujo compra-recepción, cambio coordinado UI/backend, alta acotada o archivo permanente nuevo: análisis dirigido, plan breve, implementación, prueba del recorrido y actualización obligatoria de AGENT/ownership.

### Modo de alto riesgo

Para esquema/migración, contratos, escrituras sobre datos existentes, unidades/precios/IVA, relación con `egresos`, OCR/adjuntos sensibles, dependencia o cambio entre dominios: identificar consumidores, presentar plan/riesgos e implementar y validar por etapas. Pedir confirmación solo si queda una decisión contable o financiera, destructiva, de datos, contrato o seguridad realmente bloqueante.

## Validaciones mínimas por tipo de cambio

- Frontend localizado: `node --check`, vista de Compra o Recepción, cálculo/selector afectado y consola.
- Backend localizado: `node --check`, arranque/health y endpoint con payload inválido o repositorio aislado.
- Conversión de unidades/precios: casos representativos en unidad proveedor, receta y conteo; revisar consumidor de costos.
- Pendientes: compras sin recepción, ya recibidas y selección doble.
- OCR/adjunto: fixture sintético, tipo/tamaño inválido y sin exponer archivo ni clave; evitar llamada externa si no es necesaria.
- Escritura: cache/repositorio en memoria o copia temporal aislada; nunca datos reales.
- Cambio cruzado con egresos: validar relación `recepciones.id_egreso` y consumidor de Tesorería/Reportes.
- Documentación: rutas existentes, registry parseable y `git diff --check`.

## Seguridad de datos

Precios, facturas, retenciones y egresos dependen de `shared/money.js` y `docs/money-contract.md`. Las cantidades físicas y unidades de compra no son dinero y no deben pasar por el parser monetario.

- No crear compras, recepciones, acreedores ni egresos de prueba en el backend real.
- No modificar `.env`, adjuntos reales, caches ni comprobantes del usuario.
- No registrar Data URLs, claves ni contenido sensible.
- No reintroducir Google Sheets, Excel o CSV como fuentes de reconstrucción.
- No inventar criterios de precio, impuestos, factura, recepción parcial o pago.

## Gaps confirmados

- Contabilidad posee gastos económicos, ajustes, reversiones y aplicaciones. Compras conserva recepciones y otros gastos como productores, sin integración automática en la primera etapa.

- El servicio especializado normaliza varios campos comerciales, pero persiste solo proveedor, fechas, vínculo insumo-proveedor y cantidad.
- La relación vigente del egreso se resuelve mediante `recepciones.id_egreso` u `otros_gastos.id_egreso`; los lectores de `egresos.origen_tipo/origen_id` se conservan solo para caches históricos.
- Cache y filesystem no forman una transacción real: recepción restaura el snapshot y limpia archivos propios ante errores controlados, pero subsiste una ventana residual ante cierre abrupto del proceso.
- La idempotencia persistente posterior a una respuesta exitosa sigue pendiente: no existe aún un repositorio técnico aprobado y no se usan memoria ni `app-state`.
- `attachments.service.js` mezcla recepción y escala salarial; cualquier división de responsabilidad corresponde a Arquitectura.

## Mantenimiento del AGENT

Crear un archivo permanente de Compras obliga, en la misma tarea, a actualizar este inventario, `.agents/file-ownership.md` y arquitectura/dependencias afectadas. Mover, renombrar o eliminar obliga a corregir referencias. Una integración nueva actualiza AGENT propietario, consumidor y ownership. No aplica a temporales, logs, outputs, backups, generados, adjuntos o caches. Es parte de terminado.

## Trabajo directo

Recibí pedidos en lenguaje natural directamente, inspeccioná solo el contexto relevante, implementá lo autorizado sin exigir `taskId`, `handoff`, `await`, `present`, `Aprobar` ni `begin`, y validá proporcionalmente. Pedí confirmación solo ante una decisión contable o financiera, destructiva, de datos, contrato o seguridad que sea realmente bloqueante. Si cambia el ownership, derivá verbalmente al chat correcto. El tooling coordinado subsiste solo como legado manual si el usuario lo pide expresamente.

## Formato de entrega

- **Cambios**
- **Archivos**
- **Validación**
- **Riesgos o pendientes**

Agregar análisis/plan solo cuando el alcance o riesgo lo requiera e informar pruebas no ejecutadas.

## Primer mensaje del chat

> Leé `.agents/compras.md` y usalo como guía permanente. Para cada tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que te lo pida o que detectes un cambio de alto riesgo.
