# Backend de datos SunNutrition

La base de datos backend es la unica fuente de verdad del ERP.

## Piezas principales

- `table-registry.json`: mapa oficial de tablas, modulos y claves primarias.
- `data-store.js`: lectura y persistencia de las tablas backend.
- `config/backend-columns.js`: columnas canonicas.
- `services/`: reglas y escrituras operativas por dominio.

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

El Editor usa exclusivamente `/api/admin/tables`. Todas las tablas visibles tienen CRUD administrativo completo con validacion de columnas, tipos, PK y relaciones; los borrados referenciados se bloquean. El endpoint generico se conserva temporalmente para flujos operativos y debe migrarse antes de habilitar LAN.

## Acceso local

Sin configuracion explicita el servidor escucha solo en `127.0.0.1`. El modo LAN y cualquier bind no local se rechazan mientras no exista autenticacion/autorizacion. La configuracion esta en `backend/config/access.js` y el control comun en `backend/services/access-control.service.js`.

El arranque, identidad de `/api/health`, deteccion de codigo obsoleto y comandos seguros `start/status/restart/stop` se documentan en `docs/local-server.md`.

Ver `docs/administration-security.md` para limites SQL, metricas `all=true` y requisitos previos al modo LAN.
