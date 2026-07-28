# Fondo de inversion

## Fuente persistente

`fondos_inversion_movimientos` es el libro mayor auditable del fondo. Cada fila conserva un importe positivo y uno de estos tipos:

- `deposito`: aumenta el fondo y, si se vincula a banco, exige un debito exacto;
- `rescate`: reduce el fondo, exige saldo suficiente y, si se vincula a banco, exige un credito exacto;
- `rendimiento`: aumenta el fondo y requiere mes y etiqueta economica. Es exclusivamente economico: no admite pago, cobro ni movimiento bancario propio.

El saldo se calcula exclusivamente en centavos como `depositos + rendimientos - rescates`. No se persiste un saldo duplicado: el servicio devuelve `saldo_resultante` derivado para cada fila.

## Relacion bancaria

La relacion es bilateral:

- `fondos_inversion_movimientos.id_movimiento_bancario`;
- `movimientos_bancarios.id_movimiento_fondo`.
- `fondos_inversion_movimientos.id_pago`;
- `pagos._fundMovementId` (trazabilidad interna durable).

Cada deposito crea un pago ICBC positivo y cada rescate un pago ICBC negativo. Si existe movimiento bancario, la misma fila conserva `id_movimiento_fondo` e `id_pago`; no se crea cobro. El rendimiento deja ambos vacios y solo materializa su gasto economico negativo.

La conciliacion clasifica candidatos solo cuando el detalle normalizado contiene una operacion explicita de suscripcion/rescate o compra/venta de cuotapartes y evidencia de fondo. La direccion debe ser inequivoca: debito para suscripcion y credito para rescate. Un supuesto rendimiento bancario queda en revision porque el rescate ya incorpora ese resultado. Signos contradictorios, datos incompletos, otra asociacion financiera candidata o un rescate sin saldo suficiente tampoco habilitan escritura.

Todo candidato identificado como fondo, confiable o pendiente de revision, queda excluido de las acciones genericas de gasto, egreso, pago y conciliacion. El backend aplica la misma exclusion aunque un cliente intente invocar esos modos directamente.

## Rendimiento y Estado de Resultados

El movimiento del fondo conserva el rendimiento positivo. En el mismo guardado atomico se crea un `gastos_economicos` confirmado con:

- `origen_tipo = fondo_inversion`;
- `tipo_economico = interes_financiero`;
- importe negativo;
- `fecha_economica` igual a la fecha del rendimiento, subclave mensual y etiqueta indicada por el usuario.

El Estado de Resultados consume el rendimiento junto con los demás gastos económicos confirmados en cualquier período y lo presenta en `Rendimiento Fondo`/intereses. Al restar un gasto negativo, el rendimiento aumenta el resultado sin convertirse en venta, cobro o ingreso comercial.

## API

- `GET /api/treasury/investment-fund`: saldo, historial con saldo resultante, movimientos bancarios disponibles y etiquetas.
- `POST /api/treasury/investment-fund`: alta atomica e idempotente de un movimiento.

El POST exige `fecha`, `tipo`, `importe` y `clave_idempotencia`. Rendimiento exige además `periodo_rendimiento` e `id_etiqueta`.

Los candidatos confiables usan una clave durable derivada del movimiento bancario. Un reintento devuelve la operacion existente; una asociacion previa diferente se rechaza, y fondo + pago ICBC + relacion bancaria (o fondo + gasto economico para rendimiento) se persisten en un unico snapshot.

## Migracion e inicializacion

`backend/migrations/20260728-icbc-cash-reconciliation.js` agrega `id_pago` al libro y completa el historial solo con relaciones inequivocas. Reutiliza un pago ICBC exacto por fecha/importe/signo o crea la contrapartida faltante; tambien genera filas ICBC espejo para debitos bancarios cuyo pago de origen quedo fuera del corte, y para cheques emitidos cuando numero, importe, pago original y debito coinciden. Es idempotente, ofrece rollback y exige backup verificable antes de aplicarse a datos reales.

`backend/migrations/20260727-investment-fund.js` es aditiva, idempotente y reversible mientras no existan movimientos o relaciones. Expone manifiesto SHA-256 verificable para el backup.

La inicializacion autorizada valida coincidencia unica por banco, fecha, detalle e importe antes de mutar la copia. También exige una fecha contable explícita para el rendimiento del mes. Si cualquier rescate no coincide exactamente o falta esa fecha, no inserta ninguna fila.
