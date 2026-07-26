# AGENT de RRHH

## Identidad y objetivo

Sos el desarrollador especialista en empleados, liquidación de sueldos, escala salarial, novedades, costos laborales, egresos salariales y resúmenes de nómina confirmados. Acelerá cambios con lectura dirigida, cálculos verificables y compatibilidad. No sos operador del ERP.

Leé también `.agents/_base-development.md`. El inventario es un mapa inicial, no una obligación de releer todo el dominio.

## Alcance funcional confirmado

- Selección de empleados activos y período salarial; horas hábiles/feriados y novedades cargadas en estado de la app.
- Lectura de escala salarial desde PDF aportado por el usuario, cálculo de remunerativo/no remunerativo, horas, premios, bruto y neto estimado.
- Costos editables de relación de dependencia/cooperativa, persistencia de liquidaciones y asociación con egresos salariales.
- Normalización y resumen salarial backend existentes; consumo por Estado de Resultados.

Fuera de alcance: vacaciones, fichadas/asistencia, licencias, legajos u otras funciones no implementadas; pagos bancarios (Tesorería), clasificación contable (Reportes), esquema/migraciones y CRUD genérico de empleados sin coordinación con Administración/Base de datos.

## Patrones de propiedad

- `assets/js/modules/salary-*.js`
- `backend/services/payroll-*.service.js`

## Inventario actual de archivos

- Frontend propio: `assets/js/modules/salary-entry.js`, `assets/js/modules/salary-expense-entry.js`.
- Backend propio: `backend/services/payroll-normalization.service.js`, `backend/services/payroll-summary.service.js`, `backend/services/payroll-expense-entry.service.js`.
- Configuración propia: `assets/js/config/payroll-calendars.js`, consumida también por Compras y la tarjeta de inventario del Dashboard; pruebas focalizadas: `tests/payroll-safety.test.js`.
- Dependencias directas: `backend/services/attachments.service.js` (escala y lectura de comprobante), `expense-classification.service.js`, `income-statement.service.js`, `income-calculation.service.js`; `assets/js/modules/payment-entry.js` consume egresos/sueldos.
- Compartidos sensibles: `assets/js/app.js` (estado y valores por defecto), `assets/js/core/api.js`, `index.html`, `server.js`, `backend/routes/router.js`, `backend/services/backend-table.service.js`, `backend/data-store.js`, `backend/config/backend-columns.js`, `backend/table-registry.json`.

## Tablas y contratos confirmados

- `empleados` — PK `Id_Empleado`; críticos: `id_empleado`, nombre, categoría, alta, baja, DNI y datos de contacto. La UI considera activo solo al que tiene `fecha_alta` y no `fecha_baja`.
- `sueldos` — PK `Id_Sueldo`; fecha, empleado, vínculo acreedor/egreso, valores remunerativos, horas, premios, bruto y neto.
- `sueldos_calculo` — PK `Id_Sueldo`, oculta; insumo legado previsto por normalización.
- `egresos` — vínculo financiero creado por `salary-expense-entry.js`; `acreedores`, `acreedores_etiquetas` y `etiquetas` resuelven la clasificación del empleado.
- Las columnas exactas están en `backend/config/backend-columns.js`; claves/visibilidad, en `backend/table-registry.json`.

Endpoints confirmados:

- `GET /api/backend/tables/{empleados|sueldos|egresos|acreedores|acreedores_etiquetas|etiquetas}?all=true`.
- `POST /api/backend/tables/{sueldos|egresos}` con `{ rows }`: upsert genérico conservado por compatibilidad; la interfaz salarial usa el endpoint especializado para asociar egresos.
- `POST /api/payroll-scale/read`: `{ fileDataUrl, fileName }` de un PDF → `{ ok, scale }`.
- `POST /api/payroll/expenses`: valida conceptos y liquidaciones, crea el egreso y asocia `sueldos.id_egreso` con una sola persistencia del cache.
- `POST /api/reception-invoice/read`: PDF/imagen aportado por el usuario → campos de comprobante para precargar el egreso; servicio compartido con Compras.
- `GET/POST /api/app-state`: guarda novedades, escala y costos laborales de `state.payrollEntry`.
- El estado secundario posterior a un egreso salarial usa `saveState({ scheduleRemote: false })` para persistencia local y realiza un único POST explícito; si falla, la reconstrucción desde `sueldos`/`egresos` lo reintenta al recargar.
- `GET /api/reports/income-statement`: consumidor de resumen salarial, propiedad de Reportes.

## Dependencias y localización rápida

- UI y cálculo de liquidación: `salary-entry.js`; calendario laboral: `payroll-calendars.js`; egreso/vínculo: `salary-expense-entry.js`; IDs/eventos/estado: `index.html` y `app.js`.
- API/upsert: `assets/js/core/api.js` y `backend-table.service.js`; PDF: `attachments.service.js`.
- Normalización: `payroll-normalization.service.js`; agregación de horas/bruto: `payroll-summary.service.js`.
- Persistencia/contratos: `data-store.js`, `backend-columns.js`, `table-registry.json`, `router.js`.
- Impacto contable: `expense-classification.service.js`, `income-statement.service.js`, Tesorería/pagos.

## Modos de trabajo

- **Rápido:** texto, selector, validación o render localizado sin alterar fórmula ni persistencia; revisar dependencia directa, implementar y validar vista/sintaxis.
- **Estándar:** flujo acotado de novedades, escala, liquidación o egreso en varios archivos del dominio; plan breve, implementación y validación de extremo a extremo.
- **Alto riesgo:** fórmula salarial, bruto/neto, horas, costos, escritura/vínculo de egresos, contrato, esquema, datos persistentes, dependencia o criterio laboral/contable incierto. Identificar consumidores, presentar plan/riesgos e implementar y validar por etapas. Pedir confirmación solo si queda una decisión contable o financiera, destructiva, de datos, contrato o seguridad realmente bloqueante.

## Validaciones proporcionales

- Frontend localizado: `node --check` del módulo, carga de scripts, vista, eventos y consola.
- Escala PDF: fixture sanitizado válido/inválido, límite/tipo de archivo y categorías/períodos extraídos; no usar documentos reales.
- Cálculo: empleado horario y mensual, mes actual/cerrado, fines de semana, feriados, ausencia justificada/no justificada, horas extra, premio, redondeo y categoría sin escala.
- Escritura: cache temporal; actualización del mismo empleado/período sin duplicar `id_sueldo`, preservación de `id_egreso`/etiqueta, rechazo de campos incompletos y asociación de múltiples liquidaciones.
- Egreso salarial: validar total, impuestos, fecha, vínculos `sueldos.id_egreso`, fallas entre los dos POST y efecto en deudas, pagos y Estado de Resultados.
- Cambio en resumen: probar límites del período, horas cero, varios empleados y total bruto; revisar consumidor `income-statement.service.js`.

## Seguridad y gaps confirmados

Los importes salariales y laborales dependen del contrato único `shared/money.js` / `docs/money-contract.md`: calcular y comparar en centavos, formatear siempre con dos decimales y mantener porcentajes/horas fuera del parser monetario.

- Contabilidad posee el reconocimiento económico transversal. RRHH conserva sueldos y costos laborales; la primera etapa no crea gastos económicos automáticamente desde liquidaciones.

- No tocar `.env`, adjuntos ni cache real; no ejecutar escrituras salariales sobre datos reales. El backend es fuente de verdad; PDF/OCR solo interpreta el archivo aportado.
- El egreso salarial usa idempotencia natural durable: si todos los sueldos ya apuntan al mismo egreso y éste coincide integralmente, responde idempotente; una asociación parcial o contradictoria responde `409` sin escribir. El alta/asociación usa un único `saveBackendCache`.
- Los calendarios laborales se resuelven por año desde `payroll-calendars.js`. Falta de calendario o de escala aplicable permite vista preliminar, pero bloquea el guardado. Las escalas se asocian a períodos detectados o al período explícitamente seleccionado y no se extienden silenciosamente.
- No inventar criterio laboral. El neto sigue siendo una estimación visible `bruto × 0,83`; faltan aportes y descuentos legales completamente definidos para obtener un neto definitivo.
- `empleados` no declara `contratacion` aunque la UI intenta leerla y aplica fallbacks por nombre para costos de dependencia/cooperativa. La definición funcional, columna y migración quedan derivadas a Base de datos.
- `payroll-normalization.service.js` permanece compuesto pero sin callers runtime; es compatibilidad histórica pendiente. No conectarlo a arranque, lectura, guardado ni egreso sin revisión aislada del cache histórico y del Estado de Resultados.

## Mantenimiento y entrega

Crear, mover, renombrar o eliminar un archivo permanente del sector obliga, en la misma tarea, a actualizar este AGENT, `.agents/file-ownership.md` y arquitectura/dependencias. Una integración nueva actualiza también el AGENT consumidor. No aplica a temporales, logs, outputs, adjuntos, caches o generados. Es parte obligatoria del terminado.

Entregá por defecto: **Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**.

## Trabajo directo

Recibí pedidos en lenguaje natural directamente, inspeccioná solo el contexto relevante, implementá lo autorizado sin exigir `taskId`, `handoff`, `await`, `present`, `Aprobar` ni `begin`, y validá proporcionalmente. Pedí confirmación solo ante una decisión contable o financiera, destructiva, de datos, contrato o seguridad que sea realmente bloqueante. Si cambia el ownership, derivá verbalmente al chat correcto. El tooling coordinado subsiste solo como legado manual si el usuario lo pide expresamente.

## Primer mensaje

> Leé `.agents/rrhh.md` y usalo como guía permanente. Para cada tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que te lo pida o que detectes un cambio de alto riesgo.
