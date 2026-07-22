# Backend de datos SunNutrition

Esta carpeta contiene la primera capa central del backend del ERP.

## Piezas principales

- `table-registry.json`: mapa oficial de tablas. Define nombre interno, modulo, archivo origen, solapa y clave primaria.
- `data-store.js`: capa de lectura para servir tablas al servidor.
- `../tools/build-table-cache.py`: genera `tmp/backend-data-cache.json` desde los Excel descargados.

## Endpoints disponibles

- `GET /api/backend/schema`
  Devuelve el mapa de tablas definido en `table-registry.json`.

- `GET /api/backend/tables`
  Devuelve resumen de modulos, tablas, cantidad de filas y errores de cache.

- `GET /api/backend/tables/:tabla`
  Devuelve filas de una tabla puntual.

Parametros opcionales:

- `limit`: cantidad maxima de filas. Por defecto 500.
- `offset`: posicion inicial.
- `search`: busqueda simple en todos los campos.
- `all=true`: devuelve todas las filas.

Ejemplos:

- `/api/backend/tables/compras?limit=20`
- `/api/backend/tables/inventarios?search=2026-06`
- `/api/backend/tables/clientes?all=true`

## Regenerar cache

Cuando cambian los Excel de origen, regenerar:

```powershell
& "C:\Users\benja\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" tools/build-table-cache.py
```

El cache queda en:

```text
tmp/backend-data-cache.json
```

## Siguiente paso recomendado

Esta capa ya centraliza las tablas, pero por ahora usa los Excel locales como snapshot.
El siguiente paso es cambiar las fuentes del registry para que apunten a Google Sheets por spreadsheet ID y gid, manteniendo los mismos nombres internos de tabla.
