# Planes de pago

## Propiedad y fuente de verdad

Tesorería es propietaria del flujo. `planes_pagos` y `cuotas_planes_pagos` son la única fuente de verdad; el frontend no contiene planes ni cuotas codificados. Ambas tablas aparecen en esquema, mapa, overview y Editor administrativo, pero allí son de solo lectura.

Claves y relaciones:

- `planes_pagos.id_plan_pago`: clave del plan.
- `cuotas_planes_pagos.id_cuota_plan_pago`: clave de la cuota.
- `cuotas_planes_pagos.id_plan_pago`: plan propietario.
- `cuotas_planes_pagos.id_egreso`: vínculo financiero opcional conservado por la edición.

## Contrato operativo

- `GET /api/treasury/payment-plans`: listado con totales y conteos derivados.
- `GET /api/treasury/payment-plans/:id`: plan completo y cuotas.
- `POST /api/treasury/payment-plans`: alta integral con cero o más cuotas.
- `POST /api/treasury/payment-plans/:id`: edición integral de datos generales y snapshot de cuotas.
- `POST /api/treasury/payment-plans/:id/quotas`: alta individual.
- `POST /api/treasury/payment-plans/:id/quotas/:quotaId`: edición individual.
- `POST /api/treasury/payment-plans/:id/quotas/:quotaId/delete`: eliminación segura.

Las escrituras validan el payload completo, clonan el cache, aplican y verifican relaciones en memoria y ejecutan un único `saveBackendCache`. `operationId` se registra de forma persistente en metadatos internos del plan; un reintento idéntico no duplica filas y la misma clave con otro contenido devuelve `409`.

El módulo frontend usa `requestBackendApi()` con rutas relativas `/api/...`. El host y puerto son siempre los mismos desde los que se sirve el ERP.

## Reglas financieras

La edición no crea, modifica ni elimina egresos, pagos, caja, conciliaciones o movimientos bancarios. El vínculo opcional `cuotas_planes_pagos.id_egreso` se ingresa explícitamente como un ID entero positivo; no existe matching, selector ni autocompletado. Un egreso no puede vincularse a más de una cuota. El vínculo puede asignarse, reemplazarse o retirarse cuando el egreso anterior no tiene aplicaciones en `detalle_pagos` ni una conciliación bancaria asociada; los conflictos devuelven `409` sin persistencia parcial y los formatos o IDs inexistentes devuelven `400`. Una cuota con vínculo debe desvincularse de forma explícita antes de poder quitarse del plan.

“Guardar cambios” incorpora automáticamente cualquier cuota que todavía esté abierta en el editor en línea. El frontend solo abandona el borrador después de confirmar el `POST` y releer el plan desde el backend.

El estado es derivado y usa el día calendario de `America/Argentina/Buenos_Aires`: pagada por aplicaciones en `detalle_pagos`; próxima durante los 30 días anteriores y en `fecha_primer_vencimiento`; en `Segundo vencimiento` desde el día posterior al primer vencimiento hasta `fecha_segundo_vencimiento` inclusive; y vencida recién desde el día posterior al segundo vencimiento. En los demás casos queda pendiente. Si alguna fecha falta, es inválida o el segundo vencimiento es anterior al primero, la cuota no se clasifica falsamente como vencida ni en segundo vencimiento. La mera existencia de `id_egreso` no implica cancelación. El saldo pendiente suma, por cuota, `max(0, abs(total_primer_vencimiento) - abs(monto_pagado))`; de este modo una cuota impaga aporta su total y una aplicación parcial reduce solo el importe efectivamente cancelado. El matching bancario continúa reconociendo cuotas a través de sus egresos.

El Dashboard consume el listado y el detalle de estos endpoints sin escribir datos. Para cada cuota cuyo estado derivado no sea `Pagada`, selecciona una sola fecha aplicable: primer vencimiento si todavía no pasó; en caso contrario, segundo vencimiento si es hoy o futuro. El importe mostrado es el total canónico correspondiente a esa fecha. La alerta abarca desde hoy hasta cinco días hábiles inclusive y agrupa cantidad e importe por fecha. Actualmente los días hábiles son lunes a viernes: el calendario anual disponible pertenece a RRHH y no constituye un calendario financiero general, por lo que los feriados quedan como criterio pendiente hasta contar con una fuente empresarial aplicable.

Los importes derivados se calculan y validan en centavos enteros. El primer total
es la suma normalizada de capital e interés financiero; el segundo total conserva
la regla vigente de primer total más interés resarcitorio. Una diferencia real de
un centavo se rechaza y se informa sin persistir parcialmente el plan.

## Concurrencia

El ERP local no tiene mutex, revisión optimista ni lock entre procesos. La escritura de archivo es atómica, pero antes de un modo multiusuario se requiere serialización de escrituras y rechazo de actualizaciones basadas en una revisión antigua.
