# Coordinación del ERP — subagentes nativos y recuperación v2

## Modo normal: subagentes nativos

El usuario describe una tarea nueva en el Coordinador. Este crea `taskId`, resuelve el proyecto ERP con `list_projects`, usa `create_thread` para abrir un hilo principal visible y llama siempre `set_thread_title` antes de responder. El hilo comienza independientemente y conserva todo el trabajo técnico y el resultado.

El Coordinador responde inmediatamente y queda libre. No espera, no lee el informe, no ejecuta comandos, no inspecciona diff, no corre pruebas, no abre navegador y no modifica código.

El hilo visible puede crear especialistas funcionales, exploradores y revisores como subagentes. Local se usa para runtime principal o localhost; Worktree para aislamiento o tareas escritoras concurrentes. Nunca hay dos escritores sobre la misma carpeta principal.

Las correcciones del mismo objetivo se escriben directamente dentro del hilo visible. Coordinador sólo crea tareas nuevas. Los perfiles `jefe_tarea_*` pueden conservarse para otros consumidores, pero Coordinador no los usa.

Antes de cerrar cada iteración, el hilo o subagente que implementó ejecuta la única validación principal y documenta criterios de completitud, pruebas proporcionales, resultados, evidencias, riesgos y controles no ejecutados. Coordinador no repite esa validación; solo revisa faltantes, inconsistencias, riesgos o decisiones.

`validador_tarea` es read-only y excepcional. Solo se crea si el hilo declara una razón concreta —alto riesgo, señales de fallo, evidencia insuficiente o alcance transversal sensible— y se enfoca en esa brecha sin repetir toda la validación principal. Si pide correcciones, el ejecutor aplica una única ronda y repite las pruebas afectadas sin segundo validador; si queda bloqueado, consulta al usuario.

El watcher no necesita estar activo. El usuario no pulsa New thread, no copia prompts o reportes y no usa `Revisar pendiente`.

## Modo de recuperación: coordinación v2

Todo lo documentado a continuación se conserva para compatibilidad, diagnóstico y recuperación histórica. No ejecutar el modo nativo y v2 simultáneamente para una misma tarea.

> **ESTADO: RECUPERACIÓN V2 MANUAL OPCIONAL.** Este sistema no forma parte del flujo nativo. Un pedido nuevo usa `taskId` y subagente nativo, pero no requiere watcher, `enqueue`, `coordination:await`, `present`, `Aprobar`, `begin` ni evidencia v2.
>
> Estas herramientas solo se usan por pedido explícito del usuario, recuperación histórica o diagnóstico. Nunca se inician ni se invocan automáticamente. Las tareas existentes permanecen sin migración ni alteración.

## Resultado histórico del flujo legado

Cuando el usuario activa explícitamente este legado, el sistema conserva los chats y aplica el siguiente recorrido histórico:

1. El usuario explica el cambio en el Chat Coordinador.
2. El Coordinador crea la tarea, elige dominio y entrega el primer prompt.
3. El usuario copia únicamente ese prompt al especialista indicado.
4. El especialista implementa, valida, publica el handoff y espera.
5. El watcher obtiene una revisión estructurada de la IA.
6. La revisión vuelve por archivos al especialista durante el mismo turno.
7. El especialista la presenta, pide que el usuario pruebe y solicita `Aprobar`.
8. `Aprobar` registra la decisión; el especialista registra `begin` y recién entonces ejecuta el próximo prompt.
9. Una observación natural del usuario puede registrarse manualmente y, por decisión explícita, iniciar otra revisión sin ejecutar cambios.
10. El ciclo termina cuando especialista, IA y usuario acuerdan el cierre.

No es comunicación directa entre chats. Dentro del legado activado manualmente, el sistema combina coordinación mediante archivos, revisión por API y ejecución dentro del chat especialista con aprobación humana.

## Responsabilidades dentro del legado

| Actor | Hace | Nunca hace |
| --- | --- | --- |
| Chat Coordinador | Interpreta pedido, consulta contexto estable, crea `taskId`, elige dominio y primer prompt. | Modificar código funcional, datos o aprobar. |
| Especialista | Ejecuta lo autorizado, valida, genera reporte/evidencia, espera, presenta y pide aprobación. | Invadir ownership o ejecutar una propuesta no presentada/aprobada. |
| Watcher | Valida, calcula hashes, reúne contexto, llama a la API y persiste revisión. | Ejecutar prompts o aprobar. |
| IA coordinadora | Revisa intención, entrega, pruebas, riesgos, observaciones y evidencia; decide próximo paso. | Sustituir al usuario o modificar el ERP. |
| Usuario | Prueba y aprueba, observa o rechaza. | La aprobación nunca se presume por silencio. |

## Arquitectura del legado

```text
Chat Coordinador
  pedido natural -> tarea + primer prompt
                         |
                  único copy/paste
                         v
Chat especialista -> enqueue -> inbox -> watcher -> Responses API
       ^                                      |
       |                                      v
       +----- await <- revisión v2 <- pending/contexto runtime
       |
       +-- present -> prueba del usuario -> Aprobar
                                      |          |
                               observación     approve (no ejecuta)
                                      |          v
                                      +----> begin -> especialista
```

`npm start` continúa independiente. El coordinador legado es opt-in, no se integra en las pantallas del ERP y permanece detenido salvo pedido explícito.

## Identidad de una propuesta legado

La autorización se ata a:

- `taskId`;
- dominio;
- revisión;
- `proposalHash`;
- registro de presentación;
- actor y timestamp.

Una propuesta reemplazada, no presentada, de otro dominio, con preguntas bloqueantes, ya aprobada o ya ejecutada no puede comenzar.

## Flujo visual del legado

Cada entrega declara:

- `none`: sin impacto visual; no se envían imágenes;
- `minor`: cambio localizado; imagen opcional salvo pedido de la IA;
- `material`: interfaz o distribución relevante; imágenes reales obligatorias.

Las imágenes autorizadas son PNG, JPEG o WebP bajo `.coordination/evidence/<taskId>/`, con manifest, hash, MIME, tamaño, viewport, pantalla, estado y control de sensibilidad. Se incorporan realmente al payload multimodal como `input_image`. Sin evidencia válida, una entrega `material` no puede cerrar.

## Contexto persistente del legado

El contexto compartido no depende de la memoria de un chat:

- **Versionado:** AGENTS, ownership, arquitectura, reglas de negocio, contratos, criterios visuales y deuda aceptada.
- **Runtime fuera de Git:** pedido original, tareas, revisiones, prompts, decisiones, observaciones, reportes, evidencias, transferencias, errores y ejecución.

El constructor de contexto selecciona resúmenes relevantes por dominio/tarea y un diff limitado. No envía todo el repositorio ni todo el historial.

## Comandos del flujo legado para el usuario

Flujo legado manual:

- pedido natural en el Chat Coordinador;
- `Aprobar` en el especialista;
- observación libre en lenguaje natural;
- `Continuar tarea` al cambiar de dominio;
- `Reintentar revisión` después de timeout/error.

Recuperación:

- `Revisar pendiente`.

Dentro de una tarea legado ya activada, el usuario no necesita pedir “Generar handoff”, consultar estado ni escribir `Modificar:`.

## Comandos del tooling legado

Estos comandos se conservan para uso manual explícito, recuperación histórica y diagnóstico. No se ejecutan automáticamente y el usuario no copia hashes:

```powershell
npm run coordinator
npm run coordinator:once
npm run coordination:status
npm run coordination:action -- create-task <archivo|->
npm run coordination:action -- enqueue <archivo|->
npm run coordination:action -- present <dominio> --task-id ID --revision N --proposal-hash HASH --file-hash HASH
npm run coordination:action -- approve <dominio> --task-id ID --revision N --proposal-hash HASH --file-hash HASH
npm run coordination:action -- begin <dominio> --task-id ID --revision N --proposal-hash HASH
npm run coordination:action -- observe <dominio> --task-id ID --revision N --proposal-hash HASH --file-hash HASH --text "<observación>"
npm run coordination:action -- continue-task <dominio> --task-id ID
npm run coordination:action -- retry-review --task-id ID --submission-id ID --revision N --domain <dominio>
npm run coordination:await -- --task-id <id> --domain <dominio> --handoff-hash <sha> --revision <n> --timeout 600
npm run coordination:test
$env:COORDINATION_REAL_TEST = "1"
npm run coordination:test:real
```

Los hashes son internos: el especialista los conserva y el usuario no los copia. La espera no llama a OpenAI. El watcher es el único proceso que solicita la revisión por API. `coordination:status` es de solo lectura y `coordination:test:real` es opt-in.

Consultar acciones y transiciones en [PROTOCOL.md](PROTOCOL.md), instalación en [SETUP.md](SETUP.md) y recuperación en [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## API y facturación del legado

Cuando se ejecuta el legado, el proceso Node lee exclusivamente:

- `OPENAI_API_KEY`;
- `COORDINATOR_MODEL`.

El valor recomendado dentro del legado para `COORDINATOR_MODEL` es `gpt-5.6-terra`. Si se activa este sistema, el modelo debe estar habilitado para la cuenta y soportar Responses API, Structured Outputs estricto y entrada de imagen para revisiones visuales. La variable es obligatoria solo para ejecutar el legado: no hay modelo implícito ni fallback hardcodeado, y otros modelos admitidos siguen siendo compatibles.

No existe escalamiento automático a otro modelo. `gpt-5.6-sol` queda como alternativa manual futura para revisiones excepcionales.

La API se administra y factura por separado de ChatGPT. Consultar [inicio rápido oficial](https://developers.openai.com/api/docs/quickstart), [facturación separada](https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform) y [precios vigentes](https://openai.com/api/pricing/).

Nunca guardar la clave en `.env`, archivos, launchers, estado, logs o handoffs.

## Notificaciones y estado del legado

Cuando el legado está activo, el watcher imprime un aviso sanitizado. La campana BEL opcional se habilita en `.coordination/config.json`; no es un toast de Windows y su ausencia no detiene ese flujo.

El estado de solo lectura muestra tareas abiertas, revisiones, presentaciones, aprobaciones, ejecución declarada, transferencias, fallos, bloqueos y última actividad. No muestra secretos ni sustituye el registro de presentación.

## Límites del legado

- Los chats no pueden abrirse, despertarse ni enviarse mensajes directamente.
- La espera mantiene el turno y observa archivos; no controla otro chat.
- El usuario todavía copia el primer prompt y abre manualmente el chat destino de una transferencia.
- El estado es local y no está integrado en el ERP.

Una futura aplicación multiagente podría administrar sesiones y eliminar esas dos intervenciones. Hasta entonces, los archivos son la frontera auditable.

## Compatibilidad histórica

Las colas, tareas y pendientes v1 no se borran, aprueban ni migran automáticamente. `Revisar pendiente` conserva la recuperación manual por `shownHash`. Las tareas v2 existentes conservan revisión, `proposalHash`, presentación y espera; un pedido natural nuevo no crea una tarea v2. Cualquier intervención requiere un pedido explícito y compatible.

## Garantías del legado

- El primer prompt es el único copy/paste normal.
- El especialista espera la revisión antes de terminar, salvo error/timeout informado.
- La IA analiza imágenes reales cuando corresponde.
- Ni watcher, await, coordinador ni tooling ejecutan código funcional.
- Ninguna propuesta se ejecuta sin aprobación humana válida.
- La suite automatizada no llama a OpenAI ni modifica datos reales.
