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

Los pedidos nuevos se envían al Coordinador. Este crea mediante `create_thread` un hilo principal visible y autónomo del proyecto ERP. El usuario no pulsa New thread ni copia prompts.

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
2. el Coordinador crea `taskId` y selecciona título, dominio, modelo, esfuerzo y Local o Worktree;
3. usa `create_thread` asociado al proyecto ERP con el prompt completo;
4. responde inmediatamente y queda libre;
5. el hilo visible trabaja, crea subagentes si los necesita y conserva su resultado;
6. las correcciones internas de pruebas o validación permanecen allí mientras la tarea está activa;
7. después de declarar el objetivo completado y sin trabajo pendiente, cualquier defecto, ajuste o ampliación obtiene `taskId` e hilo visible nuevos, vinculados a la tarea cerrada.

Coordinador no usa `spawn_agent` ni perfiles `jefe_tarea_*` en el flujo normal. Los hilos visibles pueden crear especialistas, `explorador_erp` y `revisor_erp`. No hay dos escritores simultáneos sobre la misma carpeta; la escritura paralela requiere worktrees. Ningún agente hace commit o push sin pedido expreso.

Un hilo cerrado no se reabre. Un turno bloqueado esperando una decisión no está cerrado y puede reanudarse en el mismo hilo. La tarea posterior al cierre debe ser autosuficiente, declarar su `parentTaskId`, volver a evaluar dominio/riesgo/entorno y comprobar que el checkout contiene la implementación de origen. Si esa implementación continúa solo en un worktree no integrado, la integración o disponibilidad del mismo estado es una precondición.

El progreso se consulta bajo demanda mediante la skill personal `$estimar-progreso-hilos`. El Coordinador responde con una fotografía inmediata y read-only basada en evidencia de los hilos visibles; no crea subagentes, watchers, timers ni automations para estimarlo.

Cada iteración tiene pruebas propias proporcionales ejecutadas una sola vez por quien implementa. Riesgo bajo/medio cierra con validación simple; riesgo alto agrega un Watchdog durante ejecución, tres validadores finales paralelos con focos exclusivos y un consolidador posterior. El hilo visible entrega una única respuesta al usuario.

Rol auxiliar de infraestructura:

- `.codex/agents/watchdog_tarea.toml`: control read-only ultrarrápido durante tareas de riesgo alto.
- `.codex/agents/validador_tarea.toml`: perfil read-only instanciado tres veces en paralelo con focos exclusivos.
- `.codex/agents/consolidador_validacion.toml`: veredicto único read-only después de liberar los validadores.

## Coordinación anterior

El watcher, los comandos, los contratos y `docs/coordination/` se conservan como recuperación v2 manual. No forman parte del flujo nativo, el watcher no necesita estar activo y ambos circuitos no se usan a la vez para una misma tarea. Las tareas y evidencias existentes no se alteran automáticamente.

## Derivación y mantenimiento

`file-ownership.md` define propietario, consumidores y riesgo. Una tarea puede tocar un compartido de forma localizada, pero debe informar impacto; si altera su responsabilidad, deriva a Arquitectura.

Cuando un chat cree un archivo permanente debe actualizar en esa misma tarea su AGENT, `file-ownership.md` y arquitectura/dependencias afectadas. Mover, renombrar o eliminar también obliga a actualizar referencias. Una integración nueva actualiza ambos AGENTS y ownership. No aplica a temporales, logs, outputs, backups, generados, adjuntos o caches.
