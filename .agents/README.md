# Chats especialistas de desarrollo

Estos AGENTS guían chats que corrigen, amplían y validan el código del ERP. No son manuales de uso ni chats para operar datos.

## Elegir chat

| AGENT | Usar para |
|---|---|
| `arquitectura.md` | Límites, refactor, infraestructura, dependencias y ownership transversal |
| `inventario.md` | Conteos, OCR, stock teórico, detalle y valuación |
| `compras.md` | Compras, proveedores, acreedores, recepciones y adjuntos |
| `ventas.md` | Clientes, pedidos, entregas y ventas |
| `tesoreria.md` | Caja, bancos, conciliación, cobros, pagos, cheques y planes |
| `rrhh.md` | Empleados, sueldos y egresos salariales |
| `reportes.md` | Dashboard, Estado de Resultados, cashflow e indicadores |
| `contabilidad.md` | Gastos económicos, ajustes, reversiones, aplicaciones y conciliación económica |
| `administracion.md` | Editor backend, mapa, esquema y SQL interno |
| `ui-ux.md` | HTML, CSS, navegación, accesibilidad, responsive e iconos |
| `base-de-datos.md` | Tablas, columnas, relaciones, persistencia y migraciones |
| `bugs.md` | Diagnóstico y corrección mínima; deriva al dueño real |
| `nuevas-funcionalidades.md` | Diseño/implementación acotada y coordinación entre dueños |
| `analista-funcional.md` | Procesos, reglas y criterios de aceptación; no código por defecto |
| `coordinador.md` | Flujo normal con subagentes nativos y recuperación v2 opcional |

Arquitectura no es el chat por defecto para funcionalidades. Elegir el dueño operativo y escalar solo si cambia un límite estable.

Los pedidos nuevos se envían al chat Coordinador. Este crea un Jefe de tarea nativo nuevo; el Jefe elige y coordina especialistas. El usuario no crea chats especialistas ni copia prompts o reportes.

## Jerarquía

1. Pedido explícito del usuario.
2. `AGENTS.md` raíz.
3. `.agents/_base-development.md`.
4. AGENT del dominio.
5. Documentación.
6. Código actual como fuente técnica final.

Ante contradicción, cumplir la instrucción superior y contrastar documentación con código. Si la contradicción afecta datos, contratos o contabilidad, detener la parte riesgosa y pedir criterio.

## Inicio recomendado

> Leé `.agents/_base-development.md` y `.agents/<dominio>.md`. Usalos como guía permanente de desarrollo. Para esta tarea revisá solo los archivos necesarios y sus dependencias directas. No hagas un relevamiento general salvo que el pedido lo requiera.

## Flujo nativo

El flujo cotidiano es:

1. describir el pedido en lenguaje natural al Coordinador;
2. el Coordinador crea `taskId`, contexto runtime y un Jefe estándar o de alto riesgo;
3. el Jefe crea un escritor principal y auxiliares read-only, coordina trabajo, pruebas y revisión;
4. el Jefe guarda el informe completo y devuelve un resumen breve;
5. el Coordinador presenta ese resumen sin trabajo técnico;
6. una corrección continúa el mismo Jefe y una tarea distinta crea otro limpio.

`jefe_tarea_estandar` usa Terra/medium y `jefe_tarea_alto_riesgo` Sol/high. `explorador_erp` y `revisor_erp` son auxiliares read-only. No hay dos escritores simultáneos sobre la misma carpeta; la escritura paralela requiere worktrees. Ningún agente hace commit o push sin pedido expreso.

## Coordinación anterior

El watcher, los comandos, los contratos y `docs/coordination/` se conservan como recuperación v2 manual. No forman parte del flujo nativo, el watcher no necesita estar activo y ambos circuitos no se usan a la vez para una misma tarea. Las tareas y evidencias existentes no se alteran automáticamente.

## Derivación y mantenimiento

`file-ownership.md` define propietario, consumidores y riesgo. Una tarea puede tocar un compartido de forma localizada, pero debe informar impacto; si altera su responsabilidad, deriva a Arquitectura.

Cuando un chat cree un archivo permanente debe actualizar en esa misma tarea su AGENT, `file-ownership.md` y arquitectura/dependencias afectadas. Mover, renombrar o eliminar también obliga a actualizar referencias. Una integración nueva actualiza ambos AGENTS y ownership. No aplica a temporales, logs, outputs, backups, generados, adjuntos o caches.
