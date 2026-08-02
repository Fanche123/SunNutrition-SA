# Seguridad de Administracion y preparacion LAN

## Estado implementado

- Despliegue predeterminado `local` y bind obligatorio a `127.0.0.1`.
- Origenes locales permitidos: `http://127.0.0.1:<puerto>` y `http://localhost:<puerto>`.
- Solicitudes sin `Origin` aceptadas para navegacion directa y herramientas locales.
- Origenes externos rechazados; nunca se emite `Access-Control-Allow-Origin: *`.
- `lan` y cualquier host no local fallan antes de iniciar porque autenticacion/autorizacion aun no existen.
- Punto unico futuro de identidad y autorizacion: `access-control.service.js`.
- Editor manual separado bajo `/api/admin/tables`, con politica backend cerrada.
- SQL asincrono con timeout del hijo, presupuesto SQLite y maximo de 5000 filas.
- Lecturas `all=true` medidas sin registrar filas ni valores.

## Politica administrativa

CRUD administrativo completo para todas las tablas visibles, manteniendo como via habitual cada flujo operativo:

- maestros, acreedores y datos bancarios;
- items, productos, subproductos, insumos, proveedores y recetas;
- movimientos bancarios;
- pedidos, entregas, ventas y sus detalles;
- cobros, retenciones y cheques;
- compras, recepciones y sus detalles;
- otros gastos, aportes, egresos, pagos y sus detalles;
- comisiones, sueldos e inventarios.

Las tablas ocultas, no registradas o no declaradas no son accesibles por el contrato administrativo. Las altas admiten clave textual explícita o generación numérica; las actualizaciones exigen una clave existente e inmutable. Los borrados se rechazan si existen referencias conocidas. Antes de la primera escritura de cada proceso se crea un backup verificable y las operaciones exitosas se registran sin copiar valores sensibles. El endpoint generico se conserva para compatibilidad operativa local y debe cerrarse o migrarse antes de LAN.

## Inventario de `all=true`

| Clasificacion | Consumidores/tablas actuales | Migracion recomendada |
|---|---|---|
| Maestro pequeno | etiquetas, canales, fletes, proveedores, clientes, empleados, items, productos, insumos, acreedores | Carga completa con limite explicito futuro |
| Listado paginable | movimientos/cheques, pedidos, compras, recepciones, inventarios, pagos, cobros | Paginacion |
| Calculo agregado | Dashboard, deudas, saldos y vistas comerciales | Endpoint agregado |
| Busqueda de opciones | proveedores/insumos, empleados, clientes, compras pendientes | Endpoint filtrado con limite |
| Flujo relacionado | recepciones, pagos, conciliacion, ventas, sueldos | Endpoint operativo especializado |
| Proximo ID | coordinadores que recorren tablas completas | Generacion exclusiva en backend |

Las metricas registran solo tabla, cantidad de filas, duracion, bytes aproximados y estado de advertencia. El limite duro permanece desactivado; una futura activacion debe devolver error explicito, nunca truncar silenciosamente.

## Consola SQL

Se mantienen una sentencia `SELECT`/`WITH`, bloqueo de escritura/administracion, 5000 filas y limite de salida. El proceso Python es asincrono y se cancela por timeout. SQLite usa `set_progress_handler` para cancelar por tiempo monotonicamente medido o presupuesto de callbacks.

Codigos seguros: `SQL_TIMEOUT`, `SQL_BUDGET_EXCEEDED`, `SQL_INVALID`, `SQL_FORBIDDEN`, `SQL_EXECUTION_ERROR`.

## Requisitos pendientes para varias computadoras

Antes de cambiar el bind fuera de localhost deben implementarse y probarse:

1. Autenticacion.
2. Sesiones seguras.
3. Usuarios y roles.
4. Permisos por endpoint y dominio.
5. HTTPS mediante proxy.
6. Proteccion CSRF cuando se usen credenciales de navegador.
7. Rate limiting.
8. Auditoria de escrituras.
9. Bloqueo o control de concurrencia.
10. Versionado o control optimista de filas.
11. Estrategia probada de backup y restore.
12. Pruebas multiusuario.
13. Migracion de escrituras genericas hacia endpoints operativos.
14. Politica por rol para Editor y SQL.
15. Despliegue y firewall restringidos.

El modo LAN solo debe habilitarse despues de una integracion real y revisada de identidad/autorizacion en la configuracion y el control de acceso central. No debe agregarse un bypass de LAN insegura.

## Excepcion domestica ERP-INF-20260801-04

El usuario autorizo expresamente una excepcion local para su Wi-Fi domestico: cualquier dispositivo de la subred privada puede abrir y operar el ERP sin identidad individual, roles, HTTPS ni CSRF. La excepcion se implementa mediante tools/erp-lan-access.js, no modifica el bind local ni el control de acceso central, y queda limitada a una IPv4 privada exacta, su misma subred y una regla Windows Firewall Private/LocalSubnet sin edge traversal.

Esta excepcion no habilita un modo LAN general ni autoriza perfil Public, Internet, port forwarding, UPnP, tuneles o redes externas. El riesgo aceptado y el procedimiento de inicio, estado y revocacion se documentan en docs/acceso-lan.md.
