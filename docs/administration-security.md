# Seguridad de Administración y acceso multiusuario

## Estado implementado

- Despliegue predeterminado `local` y bind obligatorio a `127.0.0.1`.
- Origenes locales permitidos: `http://127.0.0.1:<puerto>` y `http://localhost:<puerto>`.
- Navegación estática y health permanecen accesibles localmente; toda API operativa exige sesión.
- Origenes externos rechazados; nunca se emite `Access-Control-Allow-Origin: *`.
- `lan` y cualquier host no local continúan fallando antes de iniciar. Esta tarea no cambia bind, firewall, proxy ni exposición de red.
- `access-control.service.js` valida sesión y aplica permisos por endpoint; una mutación autenticada exige `Origin` permitido o `Sec-Fetch-Site: same-origin`.
- Las sesiones viven en memoria del servidor durante ocho horas y usan cookie `HttpOnly`, `SameSite=Strict`, `Path=/`; cerrar sesión invalida el token y reiniciar el servidor invalida todas las sesiones.
- Roles iniciales: `owner` y `employee_admin`. El propietario conserva acceso total. El empleado usa todas las secciones actuales salvo **Análisis**; Usuarios y Registro de actividad también permanecen reservados al propietario. Editor, Mapa y SQL están habilitados para el empleado, y SQL conserva su contrato de solo lectura.
- Editor manual separado bajo `/api/admin/tables`, con politica backend cerrada.
- SQL asincrono con timeout del hijo, presupuesto SQLite y maximo de 5000 filas.
- Lecturas `all=true` medidas sin registrar filas ni valores.

## Credenciales y alta inicial

Las credenciales se guardan en `tmp/security/users.json`, ignorado por Git, con `scrypt` (N=32768, r=8, p=1), salt aleatorio por usuario y permisos de archivo restringidos cuando el sistema operativo lo admite. Nunca se aceptan contraseñas por argumentos, variables de entorno o entrada redirigida.

El único bootstrap por terminal crea al propietario inicial con prompt oculto:

`npm.cmd run users:create -- --username <usuario> --display-name "<nombre>" --role owner`

Después del bootstrap, el propietario crea al empleado desde **Administración → Usuarios**. Cada actualización del archivo de usuarios genera primero un backup verificable en `tmp/security/backups/`. Para rollback manual, detener de forma segura el servidor, verificar el SHA-256 informado y restaurar el backup exacto sobre `users.json`; nunca combinar archivos ni copiar hashes entre usuarios.

## Auditoría operativa

`backend/services/audit.service.js` serializa las requests HTTP mutantes autenticadas dentro del proceso, toma el estado persistido antes y después y agrega exactamente un evento si la respuesta termina con estado 2xx. Los eventos se guardan append-only en `tmp/security/activity-audit.jsonl` con `requestId`, hora UTC, hora de Buenos Aires, actor/rol, ruta, acción, entidad, IDs, conteos y nombres de campos modificados.

El registro no copia valores completos, contraseñas, tokens, cookies, adjuntos ni contenidos base64. Cada línea encadena `previousHash` y `hash`; la vista **Registro de actividad** informa si la cadena perdió integridad. No existe endpoint para editar o borrar eventos.

Antes de entregar una mutación al handler se verifica la cadena, se comprueba que el archivo principal sea escribible y se guarda con `fsync` una intención mínima en `tmp/security/activity-audit-recovery.jsonl`. Al terminar, el resultado seguro se guarda primero en ese journal y luego se incorpora una sola vez a `activity-audit.jsonl`. Si el append final falla después de persistir datos, la respuesta conserva el resultado real, agrega `X-ERP-Audit-State: pending-recovery` y el evento queda consultable y recuperable por `requestId`; una solicitud posterior intenta consolidarlo sin duplicarlo. Una cadena principal o un journal corruptos bloquean nuevas mutaciones antes del handler.

La primera etapa cubre todas las mutaciones HTTP del backend, incluidas altas, ediciones, bajas y confirmaciones. Los POST que son lecturas (`SQL`, OCR/lectura de comprobantes y preparación ARCA sin emisión) se excluyen explícitamente. Quedan fuera los cambios puramente locales del navegador que no llegan al backend y las escrituras de mantenimiento ejecutadas directamente fuera del servidor; el bootstrap local deja un evento técnico propio. Los adjuntos se auditan por ruta y resultado, nunca por contenido.

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

Las tablas ocultas, no registradas o no declaradas no son accesibles por el contrato administrativo. Las altas admiten clave textual explícita o generación numérica; las actualizaciones exigen una clave existente e inmutable. Los borrados se rechazan si existen referencias conocidas. Antes de la primera escritura de cada proceso se crea un backup verificable y las operaciones exitosas se registran sin copiar valores sensibles. El endpoint administrativo `/api/admin/tables` está habilitado para ambos roles. El endpoint genérico de escritura `/api/backend/tables/:tabla` queda owner-only salvo una allowlist cerrada para los consumidores operativos vigentes (`egresos`, `comisiones`, `cheques_entregados`, `entregas`, `cheques_recibidos` y `sueldos`); el empleado no puede usarlo para borrar. Debe migrarse a endpoints de dominio antes de habilitar LAN.

La matriz compartida `shared/access-policy.js` reserva al propietario `/api/auth/users`, `/api/audit/*` y `/api/reports/*`. Para `employee_admin`, la navegación elimina el grupo Análisis y `switchView()` redirige cualquier estado previo hacia Dashboard antes de cargar el reporte; el backend rechaza igualmente la API, por lo que la restricción no depende de CSS.

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

1. HTTPS mediante proxy.
2. Política CSRF y de cookies revisada para el origen remoto exacto.
3. Rate limiting persistente/proxy para más de un cliente.
4. Lock interproceso o base transaccional; la cola actual sólo serializa mutaciones dentro de un proceso.
5. Versionado o control optimista general de filas.
6. Estrategia probada de backup y restore de datos operativos y seguridad.
7. Pruebas multiusuario concurrentes desde equipos distintos.
8. Migración de escrituras genéricas hacia endpoints operativos.
9. Despliegue, proxy y firewall restringidos.

El modo LAN solo debe habilitarse despues de una integracion real y revisada de identidad/autorizacion en la configuracion y el control de acceso central. No debe agregarse un bypass de LAN insegura.

## Excepcion domestica ERP-INF-20260801-04

La herramienta histórica `tools/erp-lan-access.js` no fue activada ni modificada por esta tarea. La autenticación central ya no admite operación anónima aunque exista un proxy previo; cualquier acceso desde otra computadora requiere una revisión separada de HTTPS, cookies, origen, proxy y firewall antes de usarse.

Esta excepcion no habilita un modo LAN general ni autoriza perfil Public, Internet, port forwarding, UPnP, tuneles o redes externas. El riesgo aceptado y el procedimiento de inicio, estado y revocacion se documentan en docs/acceso-lan.md.
