# Fondo de inversion

## Fuente persistente

`fondos_inversion_movimientos` es el libro mayor auditable del fondo. Cada fila conserva un importe positivo y uno de estos tipos:

- `deposito`: aumenta el fondo y, si se vincula a banco, exige un debito exacto;
- `rescate`: reduce el fondo, exige saldo suficiente y, si se vincula a banco, exige un credito exacto;
- `rendimiento`: aumenta el fondo, requiere mes y etiqueta economica, y no admite movimiento bancario.

El saldo se calcula exclusivamente en centavos como `depositos + rendimientos - rescates`. No se persiste un saldo duplicado: el servicio devuelve `saldo_resultante` derivado para cada fila.

## Relacion bancaria

La relacion es bilateral:

- `fondos_inversion_movimientos.id_movimiento_bancario`;
- `movimientos_bancarios.id_movimiento_fondo`.

Una fila bancaria vinculada deja de estar pendiente de conciliacion. `id_pago` e `id_cobro` permanecen vacios: un movimiento del fondo no simula pagos ni cobros comerciales.

## Rendimiento y Estado de Resultados

El movimiento del fondo conserva el rendimiento positivo. En el mismo guardado atomico se crea un `gastos_economicos` confirmado con:

- `origen_tipo = fondo_inversion`;
- `tipo_economico = interes_financiero`;
- importe negativo;
- periodo y etiqueta indicados por el usuario.

El Estado de Resultados consume unicamente estos gastos economicos originados en el fondo y los presenta en `Rendimiento Fondo`/intereses. Al restar un gasto negativo, el rendimiento aumenta el resultado sin convertirse en venta, cobro o ingreso comercial.

## API

- `GET /api/treasury/investment-fund`: saldo, historial con saldo resultante, movimientos bancarios disponibles y etiquetas.
- `POST /api/treasury/investment-fund`: alta atomica e idempotente de un movimiento.

El POST exige `fecha`, `tipo`, `importe` y `clave_idempotencia`. Rendimiento exige además `periodo_rendimiento` e `id_etiqueta`.

## Migracion e inicializacion

`backend/migrations/20260727-investment-fund.js` es aditiva, idempotente y reversible mientras no existan movimientos o relaciones. Expone manifiesto SHA-256 verificable para el backup.

La inicializacion autorizada valida coincidencia unica por banco, fecha, detalle e importe antes de mutar la copia. También exige una fecha contable explícita para el rendimiento del mes. Si cualquier rescate no coincide exactamente o falta esa fecha, no inserta ninguna fila.
