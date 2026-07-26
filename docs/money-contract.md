# Contrato monetario del ERP

## Fuente canónica

`shared/money.js` es la única fuente de normalización, aritmética básica, comparación, parsing y formato de dinero. Se publica como `ErpMoney` para los scripts clásicos del navegador y como módulo CommonJS para el backend y las pruebas.

`assets/js/core/formatters.js` conserva nombres históricos (`parseMoney`, `formatMoney`, `formatBankMoney`) únicamente como adaptadores del contrato canónico. `shared/money-columns.js` define qué columnas operativas representan dinero para que el editor, SQL y el guardado genérico compartan la misma clasificación. Los módulos de dominio no deben crear otro `Intl.NumberFormat` monetario ni interpretar importes con `parseFloat`, `Number(textoLocalizado)` o reemplazos parciales de separadores.

## Reglas

- El límite financiero es el centavo. Todo valor se normaliza una vez con `toCents()` y se calcula o compara mediante enteros seguros.
- El rango canónico llega hasta `999999999999999` centavos (`$ 9.999.999.999.999,99`); fuera de ese límite el valor se rechaza.
- `fromCents()` devuelve el número que se envía al backend o persiste; los ceros finales pertenecen solo a la presentación.
- Las sumas usan centavos. Los porcentajes, multiplicaciones y divisiones monetarias redondean una sola vez, a medio centavo hacia afuera de cero, al terminar la operación.
- La interfaz argentina muestra siempre `$ 1.234,50`. Los inputs con adornos propios usan `1.234,50`, sin duplicar el símbolo.
- La igualdad financiera usa `equals()` o igualdad de centavos, nunca igualdad de `float`.
- No se redondea ni trunca a pesos enteros.

## Ingreso manual

`parseInput()` acepta números finitos y estas variantes textuales:

- `999645,25`
- `999645.25`
- `999.645,25`
- `$ 999.645,25`

Rechaza letras, separadores ambiguos, valores fuera del rango canónico y más de dos decimales. El vacío se informa de manera explícita mediante `empty`; con `allowEmpty: false` devuelve `EMPTY_NOT_ALLOWED`, y cada campo decide si es obligatorio. Los inputs monetarios se identifican con `data-money-input`: al perder foco recuperan formato argentino con dos decimales y conservan la misma cantidad en centavos que se utilizará al guardar.

Las escrituras backend validan payloads nuevos con `backend/utils/money-input.js` antes de persistir. Ese límite también se aplica al CRUD operativo genérico según `shared/money-columns.js`; los datos históricos ya guardados solo se normalizan al leer o calcular y no se migran.

En los inputs de la interfaz los negativos están bloqueados por defecto. Un flujo que contractualmente los admita debe declararlo con `data-money-allow-negative`; actualmente se usa solo para el ingreso no comercial generado desde conciliación bancaria. El parser interno puede habilitarlos explícitamente para cálculos y movimientos cuyo signo ya forma parte del contrato.

## Consumidores

El contrato se aplica a RRHH, Tesorería, planes de pago, comisiones, compras y recepciones, ventas y cobros, cheques, inventario valorizado, dashboard, Estado de Resultados, cashflow y columnas monetarias conocidas del editor administrativo/SQL.

Las fórmulas de negocio permanecen en sus módulos. `shared/money.js` no conoce categorías, tasas de dominio, impuestos ni criterios contables.

## Excepciones deliberadas

- Porcentajes, cantidades físicas, horas, unidades e IDs conservan sus parsers y precisión propios.
- La consola SQL solo aplica formato monetario cuando el backend identifica una tabla y la columna figura en el mapa semántico administrativo. Una expresión o alias arbitrario queda sin formato monetario para no confundir dinero con cantidades o tasas.
- Los números persistidos siguen siendo numéricos; no se migran datos históricos ni se agregan columnas para almacenar ceros finales.

## Validación mínima

Los cambios al contrato deben ejecutar `tests/money.test.js`, `tests/money-domain-contract.test.js`, las suites financieras afectadas, `node --check` y `git diff --check`. Un cambio de fórmula requiere una tarea contable separada; no forma parte del mantenimiento de precisión.
