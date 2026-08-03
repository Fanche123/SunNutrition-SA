# Backend de datos SunNutrition

La base de datos backend es la unica fuente de verdad del ERP.

## Piezas principales

- `table-registry.json`: mapa oficial de tablas, modulos y claves primarias.
- `data-store.js`: lectura y persistencia de las tablas backend.
- `config/backend-columns.js`: columnas canonicas.
- `services/`: reglas y escrituras operativas por dominio.
- `repositories/security-store.repository.js`: usuarios con escritura atómica y backup verificable.
- `services/auth.service.js` y `services/audit.service.js`: sesiones, roles y auditoría append-only.

## Endpoints de tablas

- `GET /api/backend/schema`
- `GET /api/backend/tables`
- `GET /api/backend/tables/:tabla`
- `POST /api/backend/tables/:tabla`
- `GET /api/admin/tables`
- `GET /api/admin/tables/:tabla`
- `POST /api/admin/tables/:tabla`
- `POST /api/backend/sql` para consultas de solo lectura
- `POST /api/payroll/expenses` para crear y asociar un egreso salarial de forma coordinada e idempotente
- `GET /api/inventory/purchase-snapshot` para leer la evaluación fija de insumos asociada al último inventario integral
- `POST /api/inventory/purchase-snapshot/production-rate` para validar y persistir la producción diaria que recalcula esa evaluación

No existen endpoints de fuentes, refresh ni imports externos. Las tablas se cargan y modifican desde las pantallas operativas, conciliacion o el Editor de datos.

`POST /api/inventory/full-entry` persiste inventarios, detalles, valuación y el metadato superior `inventoryPurchaseSnapshot` con un único guardado atómico del cache. Este metadato no agrega tablas ni columnas y una nueva carga válida lo reemplaza por completo, incluso sin alertas. `GET /api/inventory/purchase-snapshot` reconstruye la evaluación en memoria desde el último lote persistido cuando el metadato falta, tiene una versión anterior o no corresponde al inventario más nuevo; la lectura no escribe datos.

La producción diaria se guarda como `inventoryPurchaseConfig.barsPerDay`, metadato superior del mismo cache. El valor compatible inicial es 30100 y el contrato admite enteros entre 1 y 1000000. El POST de configuración recalcula y guarda config y snapshot en una sola escritura atómica, sin modificar tablas operativas; si la escritura falla, permanece el último valor persistido.

El Editor usa exclusivamente `/api/admin/tables`. Todas las tablas visibles tienen CRUD administrativo completo con validacion de columnas, tipos, PK y relaciones; los borrados referenciados se bloquean. `POST /api/backend/tables/:tabla` es owner-only salvo la allowlist cerrada de tablas que todavía consumen pantallas operativas; `employee_admin` no puede enviar borrados genéricos. Estos consumidores deben migrarse antes de habilitar LAN.

## Acceso local

Sin configuración explícita el servidor escucha sólo en `127.0.0.1`. El modo LAN y cualquier bind no local continúan rechazados. La API operativa requiere una sesión server-side. `employee_admin` accede a los flujos operativos, `/api/admin/*`, SQL read-only y mapa/esquema, pero no a `/api/reports/*`, usuarios ni auditoría; el propietario conserva acceso total. Health, control autenticado del runtime y archivos estáticos conservan su contrato local.

Endpoints de acceso: `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`, `GET|POST /api/auth/users` (propietario) y `GET /api/audit/events` (propietario).

El arranque, identidad de `/api/health`, deteccion de codigo obsoleto y comandos seguros `start/status/restart/stop` se documentan en `docs/local-server.md`.

Ver `docs/administration-security.md` para limites SQL, metricas `all=true` y requisitos previos al modo LAN.
