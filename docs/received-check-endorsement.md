# Soporte de datos para endoso de cheques recibidos

## Alcance implementado

`cheques_recibidos` incorpora dos columnas canónicas opcionales:

- `id_pago_endoso`: identificador normalizable con `backendId`, vacío en registros sin endoso y referencia lógica a `pagos.id_pago`.
- `fecha_endoso`: fecha efectiva en formato ISO `AAAA-MM-DD`, vacía en registros sin endoso.

La migración `20260724-received-check-endorsement` agrega únicamente esos headers. No modifica filas, estados, cobros, pagos, depósitos ni timestamps históricos. No se ejecuta durante el arranque y no fue aplicada al cache real.

## Compatibilidad histórica

La copia aislada revisada contenía 595 cheques y estados históricos adicionales a los tres estados del flujo nuevo. También contenía endosos históricos sin relación a pagos y algunos depósitos sin `id_deposito`.

Esos registros quedan preservados sin backfill. Las invariantes nuevas no deben aplicarse retroactivamente ni utilizarse para reinterpretar el pasado. Solo se aplican al endpoint nuevo y a filas creadas o transitadas por ese endpoint.

## Invariantes para operaciones nuevas

- `Pendiente`: sin depósito ni endoso.
- `Depositado`: con `id_deposito` y sin campos de endoso.
- `Endosado`: con `id_pago_endoso`, `fecha_endoso` ISO y sin campos de depósito.
- El pago referenciado existe y su método es `Endoso`.
- Cada cheque se usa completo y una sola vez.
- Todos los cheques de la operación apuntan al mismo pago.
- La suma en centavos de los cheques coincide con `pagos.monto`.
- Solo un cheque previamente `Pendiente` y sin marcas de uso puede transitar a `Endosado`.

`backend/utils/received-check-endorsement.js` implementa estas validaciones para reutilizarlas desde el futuro servicio de Tesorería.

## Migración, backup y rollback

`backend/migrations/20260724-received-check-endorsement.js` exporta:

- manifiesto verificable por SHA-256, tamaño y conteos;
- verificación del backup;
- migración aditiva sobre un objeto aislado;
- rollback que retira los headers únicamente mientras ambas columnas sigan vacías.

Si ya existe cualquier dato de endoso, el rollback destructivo se rechaza. La aplicación al cache real requiere autorización humana separada, destino exacto y backup verificado.

## Idempotencia del futuro endpoint

No se agrega otra columna de idempotencia. El endpoint debe reutilizar el patrón financiero durable:

1. recibir `operationId`;
2. persistir `_operationId` y `_operationPayload` en la fila propietaria de `pagos`;
3. incluir en el payload estable los IDs de cheque ordenados, fecha, importe y detalles del pago;
4. ante replay, comprobar payload idéntico y que todos los cheques sigan vinculados al mismo `id_pago`;
5. persistir pago, detalles y actualización de cheques con un único `saveBackendCache()` sobre un snapshot clonado.

## Implementación vigente

`POST /api/treasury/received-checks/endorse` recibe un pago `Endoso` ya creado y vincula uno o varios cheques completos mediante una única persistencia sobre un snapshot. No crea ni modifica egresos, cobros o detalles de pago.

La idempotencia se registra en `_operationId` y `_operationPayload` de la fila propietaria de `pagos`. Si esa fila conservaba la clave de creación del pago, se preserva en `_paymentCreationOperationId` y `_paymentCreationOperationPayload`. El marcador tiene el ciclo de vida del pago y no existe un registro separado de crecimiento ilimitado.

La navegación visible unifica cheques disponibles, depósito, carga desde cobros, pagos Endoso pendientes e historial en `Cheques recibidos`. Los estados históricos se muestran sin completar ni deducir relaciones.

`GET /api/treasury/received-checks/pending-endorsement-payments` construye los pendientes exclusivamente desde pagos reconocibles por el contrato de alta actual: marcador y payload durable de creación, detalles persistidos con la misma operación y total exacto. Después de un endoso se usa el marcador de creación preservado. Los pagos históricos que solo declaran método `Endoso`, pero no tienen ese contrato completo, no se clasifican como pendientes. No se aplica ningún corte por fecha, ID o importe.

## Handoff a Tesorería

La siguiente etapa debe crear el endpoint y la pantalla sin cambiar el esquema:

- seleccionar solo cheques `Pendiente` no usados;
- exigir método `Endoso`;
- crear un pago separado de cualquier transferencia, efectivo u otro medio;
- validar suma exacta y ausencia de parciales;
- aplicar `validateReceivedCheckEndorsementOperation`;
- guardar pago, `detalle_pagos` y cheques en una única escritura;
- rechazar reuso y replays contradictorios;
- endurecer depósito manual y conciliado para rechazar cheques endosados;
- mantener Administración en solo lectura.
