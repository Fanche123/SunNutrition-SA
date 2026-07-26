# Coordinación del ERP — legado manual opcional

> **ESTADO: LEGADO MANUAL OPCIONAL.** Este directorio no define el flujo normal actual. Un pedido natural nuevo se atiende directamente en el chat actual: no crea `taskId` ni requiere watcher, `enqueue`, `coordination:await`, `present`, `Aprobar`, `begin` o evidencia coordinada.
>
> El tooling se usa únicamente por pedido explícito del usuario, recuperación histórica o diagnóstico; nunca se activa automáticamente. Las tareas y estados existentes permanecen sin migración ni alteración.

Este directorio conserva contratos versionados y estado local de la coordinación semiautomática v1/v2. Cuando el legado se activa manualmente, no crea comunicación directa entre chats:

- el Chat Coordinador registra la tarea y genera el primer prompt;
- el usuario copia ese prompt una sola vez al especialista;
- el especialista publica el handoff y espera;
- el watcher obtiene y persiste la revisión de la IA;
- el especialista la presenta y pide `Aprobar`;
- únicamente el especialista ejecuta después de aprobación y `begin`.

Watcher, await, API y CLI nunca ejecutan código funcional ni modifican datos del ERP.

## Archivos versionados

| Archivo | Contrato |
| --- | --- |
| `handoff.schema.json` | Handoff v1 para compatibilidad. |
| `coordinator-output.schema.json` | Salida v1 para recuperación. |
| `handoff-v2.schema.json` | Entrega v2 con tarea, revisión, prompt ejecutado e impacto visual. |
| `coordinator-output-v2.schema.json` | Revisión v2, veredicto, hallazgos, evidencia y próxima propuesta. |
| `task.schema.json` | Contexto runtime completo de una tarea. |
| `evidence-manifest.schema.json` | Manifest seguro de imágenes. |
| `project-context.schema.json` | Contrato del manifiesto de contexto permanente. |
| `project-context.json` | Referencias versionadas a AGENTS, ownership, arquitectura y protocolo; no duplica su contenido. |
| `config.json` | Límites, tiempos, reintentos, heartbeat, evidencia y notificación. |
| `README.md` | Frontera y estructura. |

Los schemas usan JSON Schema Draft 2020-12, `additionalProperties: false` y límites explícitos. Structured Outputs usa una normalización compatible y la respuesta vuelve a validarse localmente.

## Estado runtime legado fuera de Git

| Ruta | Uso |
| --- | --- |
| `inbox/`, `processing/` | Entregas recibidas y reclamadas. |
| `pending/`, `approved/`, `rejected/` | Propuestas y decisiones v1/v2. |
| `completed/`, `failed/` | Archivo de resultados y fallos. |
| `runtime/tasks/` | Pedido original, revisiones, historial resumido y decisiones. |
| `runtime/presentations/` | Propuestas realmente mostradas al usuario. |
| `runtime/transfers/` | Prompts aprobados para otro dominio. |
| `runtime/watcher-heartbeat.json` | Actividad del watcher para espera/recuperación. |
| `runtime/` restante | Locks, temporales y borradores locales. |
| `evidence/<taskId>/` | Manifests e imágenes autorizadas de una tarea. |
| `state.json` | Índice local v1 y compatibilidad operativa. |

No versionar estos contenidos, no agregar `.gitkeep`, no editar `state.json` y no mover colas manualmente.

## Flujo legado v2

Este recorrido solo se inicia después de un pedido explícito de utilizar el legado:

1. `create-task` valida y registra pedido, `taskId`, dominio y primer prompt.
2. `enqueue` valida y publica el handoff v2 atómicamente.
3. El watcher verifica identidad, contexto y evidencia; llama a Responses API.
4. `coordination:await` espera la revisión por tarea/dominio/handoff con timeout.
5. `present` registra revisión, `proposalHash` y hash de archivo mostrados.
6. `approve` vuelve a validarlos, registra la decisión y devuelve `executed: false`.
7. `begin` marca el comienzo justo antes de que el especialista ejecute.
8. `observe` registra comentarios naturales y genera otro ciclo de revisión.
9. `continue-task` recupera una transferencia aprobada en el dominio destino.
10. `retry-review` recupera una revisión interrumpida sin duplicarla.

Las firmas públicas están en [`docs/coordination/PROTOCOL.md`](../docs/coordination/PROTOCOL.md). Los hashes son internos; el usuario no los copia.

## Evidencia coordinada del legado

Cada handoff v2 declara `visualImpact`:

- `none`: no se envían imágenes;
- `minor`: opcionales salvo pedido de la IA;
- `material`: obligatorias antes de `close`.

Solo PNG, JPEG y WebP bajo `evidence/<taskId>/`. El manifest registra MIME real, tamaño, SHA-256, viewport, pantalla, estado, fecha, ausencia de escritura y sensibilidad. Una ruta no cuenta como evidencia: el watcher envía el contenido real como `input_image`. Path traversal, symlink externo, MIME falso, exceso o posible sensibilidad sin autorización bloquean el envío.

## Contenido prohibido

- API keys, tokens, contraseñas o `.env`;
- datos personales/empresariales innecesarios o filas reales;
- bases, caches o historiales completos;
- adjuntos no autorizados;
- rutas fuera del repositorio;
- comandos arbitrarios extraídos de reportes o imágenes.

## Conservación histórica v1/v2 sin migración automática

- No borrar, mover, migrar, aprobar ni ejecutar pendientes existentes automáticamente.
- Las tareas v1 conservan `shownHash`, acciones `review/approve/begin/reject/modify` y `Revisar pendiente` como recuperación.
- Las tareas v2 existentes conservan `taskId`, revisión, `proposalHash`, presentación y espera.
- Un pedido natural nuevo no crea una tarea v2; solo un pedido explícito de operar el legado puede iniciar ese recorrido.
- Una aprobación v1 no se convierte automáticamente en aprobación v2.
- Cuando se ejecutan manualmente para recuperación o diagnóstico, watcher y estado detectan versión y mantienen idempotencia.

## Seguridad operativa del legado

- Escrituras `.tmp` más rename atómico.
- Lock de instancia y lock de estado.
- Hashes, deduplicación, prevención de loops y reemplazos.
- Backoff/reintentos acotados.
- Await predeterminado de 600 segundos, polling de 750 ms.
- Heartbeat cada 5 segundos; se considera obsoleto a los 30 segundos.
- Máximo configurable inicial de 6 imágenes, 5 MiB por imagen y 20 MiB total.
- API key y modelo únicamente desde variables de entorno.
- Pruebas automatizadas sin API real ni cambios en el ERP.

Documentación: [visión general](../docs/coordination/README.md), [protocolo](../docs/coordination/PROTOCOL.md), [setup](../docs/coordination/SETUP.md) y [recuperación](../docs/coordination/TROUBLESHOOTING.md).
