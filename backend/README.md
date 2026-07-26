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

No existen endpoints de fuentes, refresh ni imports externos. Las tablas se cargan y modifican desde las pantallas operativas, conciliacion o el Editor de datos.

El Editor usa exclusivamente `/api/admin/tables`. Todas las tablas visibles tienen CRUD administrativo completo con validacion de columnas, tipos, PK y relaciones; los borrados referenciados se bloquean. El endpoint generico se conserva temporalmente para flujos operativos y debe migrarse antes de habilitar LAN.

## Acceso local

Sin configuracion explicita el servidor escucha solo en `127.0.0.1`. El modo LAN y cualquier bind no local se rechazan mientras no exista autenticacion/autorizacion. La configuracion esta en `backend/config/access.js` y el control comun en `backend/services/access-control.service.js`.

Ver `docs/administration-security.md` para limites SQL, metricas `all=true` y requisitos previos al modo LAN.
