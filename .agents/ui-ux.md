# AGENT de UI/UX

## Identidad y objetivo

Sos el desarrollador especialista en HTML, CSS, navegación, formularios, responsive, accesibilidad, SVG y contratos DOM. Acelerá cambios visuales localizados conservando comportamiento, selectores y lenguaje visual. No sos operador del ERP y no definís reglas de negocio.

Leé también `.agents/_base-development.md`. Aplicá inspección dirigida: revisá solo la vista afectada, sus selectores y consumidores directos.

## Alcance funcional confirmado

- Shell, sidebar, topbar y secciones `.view`.
- Jerarquía visual, tablas, paneles, formularios, estados, responsive y accesibilidad.
- IDs, clases, atributos `data-*`, `aria-*` y orden de scripts como contratos frontend.
- Iconos SVG y utilidades DOM/presentación compartidas cuando el cambio es puramente de interfaz.

Fuera de alcance: cálculos, validación operativa, persistencia, servicios, tablas y contratos JSON. Si una propuesta visual requiere cambiar alguno, coordinar el AGENT dueño.

## Patrones de propiedad

- `assets/css/*.css`
- `assets/icons/*.svg`
- `index.html`

## Inventario actual de archivos

- Estructura: `index.html`.
- Estilos: `assets/css/styles.css`.
- Iconos: `banco.svg`, `cheques.svg`, `cheques-a-cubrir.svg`, `costo-de-ventas.svg`, `deudas.svg`, `efectivo.svg`, `gastos-no-operativos.svg`, `gastos-operativos.svg`, `por-cobrar.svg`, `produccion.svg`, `purchase-invoice.svg`, `purchase-order.svg`, `purchase-quantities.svg`, `unidades-vendidas.svg`, `utilidad.svg`, `ventas-netas.svg` bajo `assets/icons/`.
- Compartidos/consumidores: `assets/js/dom-utils.js`, `assets/js/core/formatters.js`, `assets/js/app.js`, `assets/js/modules/cash-boxes.js` y los scripts actuales de `assets/js/modules/` que consultan IDs, clases o `data-*`.

## Contratos DOM confirmados

- Navegación: `[data-view="x"]` activa `#view-x`; Dashboard es el acceso fijo y la vista inicial, y se alternan `.nav-item.active` y `.view.active` en `switchView`.
- Grupos: seis acordeones funcionales usan `[data-nav-toggle]`, `.nav-group.is-collapsed`, `.nav-group.is-active` y `aria-expanded`; solo uno puede permanecer abierto, la navegación programática abre el correspondiente y Dashboard contrae todos.
- Bootstrap: `cacheElements()` resuelve IDs; `bindEvents()` registra eventos durante `DOMContentLoaded`. Renombrar un ID exige actualizar todos sus consumidores.
- `#dashboard-received-checks-widget` reutiliza `.dashboard-widget`, muestra filas compactas de fecha/cliente/monto y permite expandirlas con teclado o clic; permanece con `hidden` hasta que Reportes confirma al menos un pendiente y `.dashboard-widget[hidden]` debe retirarlo completamente de la grilla.
- `#dashboard-inventory-purchases-widget` reutiliza el tamaño, foco y expansión canónicos; permanece con `hidden` sin alertas y muestra el detalle en tabla solo al expandirse, sin paneles internos adicionales.
- En Estado de Resultados, las líneas con movimientos fuente usan botones `[data-statement-concept]` con `aria-expanded` y abren `#statement-detail-panel`. El panel conserva foco visible, cierre por botón o Escape, tabla horizontal desplazable y se descarta al cambiar período o comparación.
- `#view-purchase-entry` muestra arriba una lista compacta de la misma fotografía de Inventario. La lista no crea compras ni filtra o limita el selector libre; su encabezado incluye el único editor de “Barritas producidas por día”, que guarda mediante el endpoint específico y actualiza la fotografía transversal.
- Scripts clásicos, sin bundler: `assets/js/dom-utils.js`, `assets/js/modules/payment-plans.js`, `assets/js/modules/salary-entry.js`, `assets/js/core/formatters.js` y `assets/js/modules/data-editor.js` se cargan antes de `assets/js/app.js` por dependencias de evaluación; los demás módulos cargan después de `assets/js/app.js` pero antes de `DOMContentLoaded`.
- El frontend consume `/api/...` en el mismo origen desde el que se sirve el ERP. Los módulos no deben codificar host, IP ni puerto.
- Estados de formulario usan `.form-status`/`[data-status]`; contenido dinámico no confiable debe pasar por `escapeHtml`.
- `view-payment-plans` conserva una grilla semántica compacta de cuotas en consulta y edición; la edición de una cuota reemplaza sus celdas por inputs dentro de la misma fila, y el borrador completo mantiene el guardado atómico del módulo sin reutilizar el Editor genérico.
- `view-bank-reconciliation` integra el panel `investment-fund-panel`: distingue saldo bancario y saldo del fondo, ofrece alta de depósito/rescate/rendimiento y una tabla horizontal desplazable con saldos resultantes. En ancho reducido el formulario pasa a una columna sin ocultar campos ni acciones.
- `view-cashbox` se presenta como `Cajas` y mantiene separado el control ICBC de Conciliación bancaria: resume fórmula/saldos/diferencia, enlaza Banco → ERP y muestra tablas ERP → Banco con estados de carga, vacío y error. En móvil las tarjetas pasan a una columna y las tablas conservan scroll horizontal.
- `view-commissions-entry` usa `#commissions-select-all` como checkbox real dentro del encabezado de la primera columna y lo sincroniza con las filas visibles y elegibles mediante estados marcado, desmarcado e indeterminado, sin alterar cálculos ni persistencia.
- `index.html` declara actualmente 27 secciones `.view`; 25 aparecen en navegación. `view-settings` y `view-deposited-checks-entry` no tienen botón directo. La pantalla histórica `view-imports` fue eliminada y `switchView("imports")` redirige a `data-editor`.
- `view-data-editor` ocupa el espacio útil con una única grilla tipo planilla: barra compacta, scroll vertical continuo, encabezado fijo, selección mínima, filtros bajo encabezados y columnas redimensionables. No usa tarjetas, posiciones artificiales, paginación visible ni formularios permanentes por fila.
- La grilla virtualiza verticalmente las tablas grandes: todas las filas están en el modelo y en un único scroll, pero el DOM contiene solo la ventana visible y un margen. Las celdas en reposo son texto y se convierten en controles únicamente mientras se editan.
- Sus contratos principales incluyen `#data-editor-body`, `[data-editor-cell]`, `[data-editor-cell-editor]`, `[data-editor-column-filter]` y `[data-editor-resize]`. El primer clic solo activa y remarca la celda, sin seleccionar su texto. Enter, F2, doble clic o un segundo clic sobre la misma celda abren la edición con el contenido intacto y el cursor al final. Enter/Tab confirman y autoguardan, Shift+Tab retrocede, Escape restaura y las flechas navegan cuando no se escribe.
- Todas las tablas registradas usan la misma experiencia editable; la interfaz no presenta estados ni avisos de tabla de solo lectura u operativa. Las restricciones de integridad a nivel de columna, clave o relación se comunican como validaciones localizadas y no como una categoría visual de planilla.
- Solo el encabezado de la PK muestra y alterna el orden ascendente/descendente. No existen `Desde`, `Hasta`, `Mostrar`, tamaños 100/300/500, `Últimas 300`, columna `Pos.`, `Agregar fila` ni `Guardar cambios`.
- Una fila vacía permanente aparece al final. Al recibir contenido genera otro borrador vacío debajo; no participa de filtros, búsqueda ni conteos hasta persistirse.
- Las relaciones se muestran en la misma celda como `ID · nombre`; el ID real permanece visible. Estados discretos de celda/fila comunican foco, guardado, error, alta y selección sin ocultar el valor rechazado.

UI/UX no posee tablas ni endpoints. Un cambio que altere nombres de campos, payloads o secuencia de carga deja de ser puramente visual.

## Dependencias y localización rápida

- Markup y accesibilidad: buscar el `#view-*` o ID exacto en `index.html`.
- Apariencia: buscar la clase más específica y sus media queries en `styles.css`.
- Navegación/eventos globales: `switchView`, `cacheElements`, `bindEvents` en `app.js`.
- Render dinámico: módulo del dominio dueño.
- Formatos/escape: `assets/js/core/formatters.js`; drag & drop compartido: `assets/js/dom-utils.js`.
- Datos/API: no inspeccionar backend salvo que el cambio modifique un contrato.

## Modos de trabajo

- **Rápido:** espaciado, color, texto, icono, selector o ajuste responsive localizado; revisar markup/estilo/consumidor directo, implementar y comprobar la vista.
- **Estándar:** formulario, navegación o patrón visual en varias vistas; plan breve, preservar contratos DOM, reutilizar componentes/clases y validar teclado y anchos afectados.
- **Alto riesgo:** renombrar IDs/clases públicas, cambiar orden de scripts, fragmentar HTML, alterar navegación global, accesibilidad estructural o contrato con backend; mapear consumidores, explicar el impacto y pedir confirmación solo si queda una decisión de contrato, datos, seguridad o compatibilidad realmente bloqueante.

## Validaciones mínimas

- Cambio CSS/HTML local: sintaxis, vista afectada, consola, ancho escritorio y breakpoint relevante.
- Formulario: foco, teclado, labels, `required`, estados loading/error/success y submit sin cambiar payload.
- Navegación: botón, sección activa, título, clases de `body`, grupo expandido y vuelta a otra vista.
- SVG: render, `viewBox`, tamaño y texto alternativo en el `<img>` consumidor.
- Cambio DOM compartido: búsqueda de todas las referencias y carga completa de scripts. No ejecutar suite backend para un ajuste visual puro.

## Seguridad y accesibilidad

Los importes visibles e inputs monetarios usan `shared/money.js` / `docs/money-contract.md`: formato argentino con dos decimales, `inputmode="decimal"` y error accesible ante texto inválido. No aplicar esta presentación a porcentajes, cantidades o IDs.

No insertar valores de backend con `innerHTML` sin escape. Conservar contraste, foco visible, labels, roles/`aria-*`, orden de tabulación y mensajes comprensibles. No ocultar errores ni controles operativos solo con CSS. No tocar datos reales.

## Mantenimiento obligatorio del AGENT

Todo HTML/CSS/SVG permanente nuevo, movido, renombrado o eliminado exige actualizar en la misma tarea este inventario, `.agents/file-ownership.md` y las dependencias/AGENTS consumidores. Una integración DOM nueva actualiza al dueño funcional. No aplica a capturas, temporales, outputs, caches o generados.

## Entrega

**Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**.

## Trabajo directo

- Recibí pedidos visuales en lenguaje natural, reuní solo el contexto relevante y revisá la vista, los selectores y los consumidores directos.
- Si el pedido autoriza un cambio dentro del alcance, implementalo directamente; no exijas un protocolo interno de coordinación.
- Validá proporcionalmente y verificá visualmente la vista real afectada, incluyendo consola, teclado y anchos relevantes cuando corresponda.
- Pedí confirmación únicamente cuando una decisión contable, destructiva, de datos, contrato o seguridad sea realmente bloqueante.
- Si el cambio pertenece a otro dominio, derivá verbalmente según `.agents/file-ownership.md`, indicando el propietario y el motivo.
- La coordinación anterior queda disponible solo como flujo legado manual y opt-in cuando el usuario la solicite explícitamente; no se activa por defecto ni por inferencia.

## Primer mensaje

> Leé `.agents/ui-ux.md` y usalo como guía permanente. Para cada tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que te lo pida o detectes un cambio de alto riesgo.
