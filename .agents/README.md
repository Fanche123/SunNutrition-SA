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
| `coordinador.md` | Infraestructura histórica de coordinación; usar solo como legado manual opcional |

Arquitectura no es el chat por defecto para funcionalidades. Elegir el dueño operativo y escalar solo si cambia un límite estable.

Los pedidos nuevos se envían directamente al chat especialista correspondiente. Ese chat conserva la intención del usuario, inspecciona solo el contexto relevante, implementa dentro de su ownership, valida proporcionalmente y entrega el resultado sin una revisión paralela obligatoria.

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

## Trabajo directo

El flujo cotidiano es:

1. elegir el chat por ownership;
2. describir el pedido en lenguaje natural;
3. permitir que el especialista implemente o analice lo autorizado;
4. revisar su validación y resumen final.

No se crean `taskId`, handoffs, revisiones de IA, esperas ni aprobaciones intermedias por defecto. Si falta una decisión contable, destructiva, de datos, contrato o seguridad realmente bloqueante, el especialista la consulta antes de avanzar. Si cambia el ownership, indica verbalmente qué chat debe continuar.

## Coordinación anterior

El watcher, los comandos, los contratos y `docs/coordination/` se conservan como legado manual opcional para recuperación histórica o diagnóstico. No forman parte del flujo normal y solo deben activarse por pedido explícito del usuario. Las tareas y evidencias existentes no se migran, aprueban, ejecutan ni alteran automáticamente.

## Derivación y mantenimiento

`file-ownership.md` define propietario, consumidores y riesgo. Una tarea puede tocar un compartido de forma localizada, pero debe informar impacto; si altera su responsabilidad, deriva a Arquitectura.

Cuando un chat cree un archivo permanente debe actualizar en esa misma tarea su AGENT, `file-ownership.md` y arquitectura/dependencias afectadas. Mover, renombrar o eliminar también obliga a actualizar referencias. Una integración nueva actualiza ambos AGENTS y ownership. No aplica a temporales, logs, outputs, backups, generados, adjuntos o caches.
