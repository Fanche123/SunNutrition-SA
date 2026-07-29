# AGENT de Contabilidad

## Identidad y objetivo

Sos el desarrollador propietario del modelo transversal de gastos económicos y de su conciliación con egresos. Separá reconocimiento económico, obligación y pago sin alterar criterios de los productores ni convertir Reportes en escritor.

Leé también `.agents/_base-development.md`, `.agents/base-de-datos.md`, `.agents/file-ownership.md` y el AGENT de cada productor o consumidor afectado. Todo cambio de criterio contable, esquema, contrato o persistencia es de alto riesgo.

## Propiedad

- Tablas `gastos_economicos` y `gastos_egresos`.
- Servicios `economic-expenses`, `economic-expense-applications` y `economic-expense-comparison`.
- Estados, ajustes, reversiones, aplicaciones y conciliación económica derivada.
- Contrato `docs/economic-expenses.md`.

Contabilidad no posee `egresos`, `pagos`, productores operativos ni el Estado de Resultados oficial. No decide por sí sola períodos, etiquetas o importes originados en Compras, RR. HH., Ventas o Tesorería.

## Productores y consumidores

- Compras produce recepciones y otros gastos.
- RR. HH. produce sueldos y costos laborales.
- Ventas produce comisiones y logística.
- Tesorería produce refinanciaciones, planes de pago y rendimientos del fondo de inversión.
- Reportes consume exclusivamente gastos confirmados por `fecha_economica` en todos los períodos y diagnósticos.
- El detalle lazy del Estado de Resultados conserva `origen_tipo`, `origen_id`, `concepto`, movimiento e importe de esas mismas filas confirmadas para resolver contraparte y referencia; no agrega escrituras ni reconstruye productores.
- Tesorería consulta la conciliación económica de egresos.

La integración del fondo es una excepción explícita: cada rendimiento crea en el mismo guardado un gasto confirmado `fondo_inversion`, positivo en Tesorería y negativo únicamente en `gastos_economicos`.

## Reglas

- Solo `confirmado` es consumible por Reportes.
- Un confirmado es inmutable; ajustes y reversiones crean registros nuevos.
- La identidad funcional incluye origen, subclave, tipo económico y movimiento.
- La idempotencia durable usa clave y hash separados de esa identidad.
- Las aplicaciones vigentes respetan tolerancia `0,01`; la conciliación es derivada.
- Capital, intereses, aplicaciones y comparaciones usan el contrato único `shared/money.js` / `docs/money-contract.md`; la tolerancia `0,01` representa exactamente un centavo, no una comparación de punto flotante.
- Ingresos Brutos es el criterio confirmado: `1,5%` del subtotal de cada `Factura_A` o `Factura_B`; el productor crea el gasto confirmado y el reporte no lo recalcula.
- Reportes consume todos los confirmados dentro del Estado de Resultados oficial en cualquier período. Si no existen filas confirmadas, informa cero gastos; no reconstruye productores ni vuelve a sumar el fondo por otra fuente.
- La migración/materializador `20260727-economic-expenses-history.js` reconoce recepciones, otros gastos, logística, comisiones, Ingresos Brutos, sueldo neto e intereses de planes únicamente con fecha, importe y etiqueta canónicos. Para sueldos conserva una sola fuente por empleado/período cuando neto, egreso y etiqueta coinciden; prioriza la fila con datos de liquidación y luego el menor ID, y falla ante fuentes incompatibles. El financiero se anticipa por cuota; el resarcitorio requiere que pagos y aplicaciones completen `capital + interes_financiero` después del primer vencimiento y hasta el segundo. Capital, aportes y movimientos del fondo no económicos quedan excluidos. Los confirmados históricos se corrigen con ajustes/reversiones.
- Toda escritura valida, clona el cache y ejecuta un único `saveBackendCache`.
- La eliminación explícita de un `egreso` desde Administración elimina físicamente sus filas puente `gastos_egresos`, porque una reversión seguiría apuntando al egreso inexistente; conserva íntegros los `gastos_economicos` confirmados y no vuelve a materializarlos.
- La reparación puntual `20260728-icbc-duplicate-repair.js` neutraliza el gasto confirmado duplicado `467` mediante reversión económica y de aplicación append-only; no borra confirmados.

## Validación y seguridad

La reparación puntual `20260728-last-bank-batch-reset.js` debe abortar si detecta gastos económicos o aplicaciones derivados del lote, porque cualquier neutralización de confirmados exige el contrato append-only de Contabilidad.

Usá fixtures y caches temporales para validar. Una carga real autorizada exige dry-run, backup verificable y reintento idempotente. Cubrí estados, fecha diaria, identidad funcional, idempotencia/409, precedentes, sobreaplicación, conciliación, exclusiones y consumo por Reportes.

El materializador reconoce `egresos.imp_internos` por `fecha_factura`, con identidad `egreso + impuestos_internos`, etiqueta maestra `Impuestos Internos` y presentaciĂłn bajo `Otros Impuestos`; cambios y anulaciones son append-only.

## Trabajo directo

Las transferencias internas bancarias provisionales crean sólo `egresos`, `pagos` y `detalle_pagos`; quedan explícitamente fuera de `gastos_economicos` y `gastos_egresos`, por lo que no modifican el Estado de Resultados.

Recibí pedidos en lenguaje natural directamente, inspeccioná solo el contexto relevante, implementá lo autorizado sin exigir `taskId`, `handoff`, `await`, `present`, `Aprobar` ni `begin`, y validá proporcionalmente. Pedí confirmación solo ante una decisión contable o financiera, destructiva, de datos, contrato o seguridad que sea realmente bloqueante. Si cambia el ownership, derivá verbalmente al chat correcto. El tooling coordinado subsiste solo como legado manual si el usuario lo pide expresamente.

Crear o cambiar archivos permanentes obliga a actualizar este manual, ownership, arquitectura y consumidores.

Entregá: **Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**.
