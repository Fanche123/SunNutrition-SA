# Protocolo de coordinación — nativo y recuperación v2

## Contrato del flujo nativo

Para cada tarea nueva, el Coordinador crea `taskId`, título y prompt, resuelve el proyecto ERP mediante `list_projects`, ejecuta `create_thread` con destino `project` y entorno `local` o `worktree`, y llama obligatoriamente `set_thread_title` con el `threadId` devuelto antes de responder. El resultado es un hilo principal independiente y visible con nombre específico.

El Coordinador no usa `spawn_agent` ni perfiles `jefe_tarea_*`, no espera el resultado y no realiza trabajo técnico. Responde inmediatamente con nombre, taskId, modo y estado `hilo iniciado`.

El hilo visible lee AGENTS y el manual del dominio, ejecuta la tarea completa, mantiene su contexto técnico y puede crear subagentes nativos. El resultado queda dentro de ese hilo; no vuelve al Coordinador.

Al finalizar su implementación y pruebas, el hilo crea exactamente un `validador_tarea` read-only y espera ese único veredicto. El prompt incluye taskId explícito, intención, objetivo, exclusiones, dominio, riesgo, impacto visual, archivos propios, diff relevante, pruebas, evidencias, riesgos, cambios preexistentes identificados y estado relevante del working tree. Un árbol sucio conocido no bloquea salvo superposición material.

`approved` termina directamente. `fix_required` permite aplicar una sola ronda concreta, repetir pruebas afectadas y terminar sin segunda validación ni afirmar aprobación final. `blocked` detiene el hilo y consulta al usuario. Una corrección explícita posterior constituye otra iteración con un nuevo validador único.

El Coordinador no crea, espera, lee ni procesa validadores.

Las correcciones se escriben directamente en el hilo de tarea. Local se usa para runtime principal o localhost; Worktree para aislamiento o si otra tarea escritora está activa. Escritura concurrente exige worktrees. Ningún agente hace commit o push automático.

`create_thread` recibe proyecto, entorno y prompt. Modelo y esfuerzo pueden fijarse si el usuario o la clasificación lo requieren; si se omiten, usa los valores configurados. El título se ajusta con `set_thread_title`. Los permisos no son un parámetro de esta primitiva y provienen del entorno efectivo.

La coordinación v2 descrita debajo es exclusivamente recuperación y compatibilidad. El watcher no participa del flujo nativo y ambos circuitos nunca se ejecutan para la misma tarea.

> **ESTADO: RECUPERACIÓN V2 MANUAL OPCIONAL.** Este protocolo no forma parte del flujo nativo. Un pedido nuevo usa `taskId` y subagente nativo, pero no requiere watcher, `enqueue`, `coordination:await`, `present`, `Aprobar`, `begin` ni evidencia v2.
>
> Las herramientas se usan únicamente por pedido explícito del usuario, recuperación histórica o diagnóstico; nunca se activan automáticamente. Las tareas existentes no se migran ni se alteran por este cambio.

Este es el contrato técnico preservado entre Chat Coordinador, especialista, watcher, IA coordinadora y usuario cuando se activa expresamente el legado. La coordinación legado es por archivos; los chats no se despiertan ni se envían mensajes directamente. Las secciones numeradas siguientes describen solo ese recorrido histórico.

## Invariantes del legado

- El usuario copia contenido una sola vez: el primer prompt del Chat Coordinador al especialista.
- El watcher y la herramienta de espera nunca ejecutan prompts ni modifican el ERP.
- Una revisión de la IA nunca equivale a aprobación.
- `approve` registra una decisión y devuelve `executed: false`.
- Solo el especialista registra `begin` y ejecuta, después de una aprobación válida.
- `close` no contiene un prompt de modificación ejecutable.
- La tarea conserva el mismo `taskId` aunque cambie de revisión o dominio.
- Las escrituras son atómicas y el estado runtime no se edita a mano.

## 1. Crear una tarea legado por pedido explícito

Solo si el usuario pide expresamente usar la coordinación legado, abre el chat **Coordinador** y explica el cambio. Entonces el chat:

1. lee `.agents/coordinador.md`, la base común, ownership y contexto permanente relevante;
2. conserva literalmente la intención original y pregunta solo lo bloqueante;
3. selecciona el dominio responsable, sin derivar por defecto a Bugs o Nuevas funcionalidades;
4. registra la solicitud, crea `taskId` y revisión inicial;
5. genera un primer prompt completo con `taskId`, objetivo, alcance, exclusiones, archivos iniciales, validaciones y criterio de cierre;
6. indica exactamente en qué chat especialista debe pegarse.

Internamente publica el registro inicial con:

```powershell
npm run coordination:action -- create-task <archivo-json-relativo|->
```

La entrada declara `sourceChat`, `originalRequest`, `objective`, `initialDomain` e `initialPrompt`; `taskId` puede generarlo el tooling. La acción valida y persiste esos datos. El usuario no ejecuta este comando ni completa el identificador manualmente.

El Chat Coordinador no modifica código. Ese envío del usuario al especialista es la autorización humana para ejecutar únicamente el primer prompt.

## 2. Ejecutar, validar y reportar dentro del legado

El especialista:

1. recupera `taskId`, revisión y dominio del prompt;
2. inspecciona solo archivos y dependencias necesarias;
3. ejecuta la instrucción autorizada;
4. valida proporcionalmente;
5. prepara el reporte estructurado;
6. clasifica `visualImpact`:
   - `none`: sin cambio visible;
   - `minor`: cambio visual localizado;
   - `material`: interfaz, navegación, formulario, tabla, modal, responsive, estado vacío o jerarquía relevante;
7. genera evidencia cuando corresponde;
8. publica el handoff v2 con:

   ```powershell
   npm run coordination:action -- enqueue <archivo-json-relativo|->
   ```

El handoff conserva pedido original, prompt ejecutado, revisión, observaciones relevantes, cambios, archivos, pruebas, riesgos y referencias de evidencia. No contiene secretos ni datos reales.

## 3. Evidencia visual coordinada del legado

Las evidencias viven exclusivamente en:

```text
.coordination/evidence/<taskId>/
```

El manifest registra por archivo: `taskId`, nombre, ruta relativa, MIME real, tamaño, SHA-256, viewport, pantalla, estado, fecha, `visualImpact`, confirmación de ausencia de escrituras e indicador de sensibilidad.

Reglas:

- `none`: no enviar imágenes de backend, SQL, endpoint, persistencia, validación o refactor interno.
- `minor`: evidencia opcional; la IA puede pedirla si el reporte no alcanza.
- `material`: evidencia real obligatoria. Sin ella la IA devuelve `continue` o `fix_required`, nunca `close`.
- Solo PNG, JPEG y WebP.
- Rechazar path traversal, symlink externo, MIME/extensión discordantes, hash inválido y límites excedidos.
- Si puede haber información sensible, no enviar; crear pregunta bloqueante y pedir captura sanitizada o autorización explícita.

La Responses API recibe el contenido como `input_image`. Una ruta local escrita no cuenta como imagen. La revisión devuelve hallazgos concretos por captura sobre jerarquía, márgenes, alineación, legibilidad, estados, responsive, overflow, consistencia y claridad de acciones.

## 4. Publicar y esperar dentro del legado

El especialista publica mediante tooling; no copia archivos a `inbox/` manualmente. Después ejecuta:

```powershell
npm run coordination:await -- --task-id <id> --domain <dominio> --handoff-hash <sha256> --submission-id <id-entrega> --revision <n> --timeout 600
```

La espera:

- solo observa estado/archivos;
- comprueba tarea, dominio, handoff, entrega y revisión;
- detecta reemplazo, rechazo, fallo, watcher inactivo o heartbeat vencido;
- libera watchers, timers y handles al terminar;
- no llama a OpenAI, no aprueba, no ejecuta y no modifica el ERP;
- usa 600 segundos por defecto y polling acotado.

Dentro del flujo legado activado explícitamente, el especialista mantiene abierto el turno hasta recibir la revisión. Ante timeout o error informa la causa y ofrece `Reintentar revisión`; no inventa resultados.

## 5. Revisión por la IA dentro del legado

La IA recibe solo contexto relevante:

- solicitud original;
- `taskId`, revisión e historial resumido;
- prompt aprobado que ejecutó el especialista;
- dominio y decisiones permanentes;
- observaciones del usuario;
- AGENTS, ownership y arquitectura pertinentes;
- reporte, archivos modificados y diff acotado;
- pruebas, riesgos y evidencia autorizada real.

Produce una salida estricta con `version`, `taskId`, `revision`, `domain`, `targetDomain`, `verdict`, `summary`, `findings`, `risks`, `blockingQuestions`, `visualReview`, `nextPrompt`, `userReviewInstructions`, `closeReason`, `evidenceRequired`, `proposalHash`, `sourceHash`, `approvalRequired` y `commitMessage`.

Veredictos:

- `continue`;
- `fix_required`;
- `close`;
- `rejected`;
- `blocked`.

`continue` y `fix_required` incluyen `nextPrompt` ejecutable solo cuando no existen preguntas bloqueantes. `close` exige razón y no contiene cambios ejecutables.

## 6. Registrar manualmente la presentación del legado

Al recibir la revisión de una tarea legado, el especialista conserva también el hash del archivo y registra manualmente la versión como presentada:

```powershell
npm run coordination:action -- present <dominio> --task-id <id> --revision <n> --proposal-hash <hash> --file-hash <hash> --reviewer <chat>
```

El runtime conserva:

- identidad de tarea/dominio/revisión;
- fecha y presentador;
- veredicto;
- prompt resumido y completo;
- resultado esperado de `Aprobar`;
- estado de presentación.

Luego responde, sin JSON interno:

```text
TRABAJO REALIZADO
[resumen]

VALIDACIONES
[resumen]

REVISIÓN DE LA IA COORDINADORA
[resultado]

PRÓXIMA ACCIÓN PROPUESTA
[mini resumen]

COMMIT SUGERIDO
[commitMessage; el Coordinador no crea el commit]

REVISIÓN DEL USUARIO
Revisá el contenido de la aplicación.

APROBACIÓN
Para ejecutar el prompt recomendado, escribí exactamente: Aprobar.
```

Si hay preguntas bloqueantes, se muestran y no se pide aprobar un prompt ejecutable.

## 7. `Aprobar` dentro del legado

Ante el mensaje exacto `Aprobar`, el especialista verifica desde archivos:

- `taskId`, dominio y revisión vigente;
- `proposalHash`;
- que la propuesta fue presentada en ese chat;
- que no fue reemplazada;
- que no existen preguntas bloqueantes;
- que no fue aprobada, cerrada ni ejecutada.

Después:

1. registra aprobación y actor con:

   ```powershell
   npm run coordination:action -- approve <dominio> --task-id <id> --revision <n> --proposal-hash <hash> --file-hash <hash> --actor usuario
   ```

2. exige `executed: false`;
3. si el veredicto es `close`, registra cierre terminal y no ejecuta;
4. si `targetDomain` es el mismo, registra inmediatamente antes de ejecutar:

   ```powershell
   npm run coordination:action -- begin <dominio> --task-id <id> --revision <n> --proposal-hash <hash>
   ```

5. ejecuta, valida, genera otro handoff y vuelve a esperar.

La aprobación vale para una única revisión y `proposalHash`; no autoriza tareas futuras.

## 8. Observaciones naturales dentro del legado

Si el usuario escribe, por ejemplo, “no me gusta el margen”, “la tabla sigue vacía” o “no cambies esa parte”, el especialista:

1. registra el texto contra la versión presentada:

   ```powershell
   npm run coordination:action -- observe <dominio> --task-id <id> --revision <n> --proposal-hash <hash> --file-hash <hash> --text "<observación>"
   ```

2. no modifica código;
3. solicita una nueva revisión de la IA;
4. espera con timeout;
5. presenta la propuesta nueva;
6. vuelve a pedir `Aprobar`.

No se exige la sintaxis `Modificar:`. La intención original y las observaciones tienen prioridad. `Modificar:` puede conservarse solo como compatibilidad v1.

## 9. Transferencia de dominio dentro del legado

Si `targetDomain` cambia:

1. el especialista actual no ejecuta fuera de ownership;
2. presenta la transferencia y pide aprobación;
3. la aprobación registra el prompt y la transferencia, pero no ejecuta;
4. el usuario abre el chat destino y escribe `Continuar tarea`;
5. el nuevo especialista recupera desde runtime la tarea, revisión, `proposalHash` y prompt aprobado con:

   ```powershell
   npm run coordination:action -- continue-task <dominio> --task-id <id>
   ```

6. valida que la transferencia le pertenece;
7. registra `begin` y ejecuta.

Se mantiene el mismo `taskId`. No se copian nuevamente reportes ni prompts completos.

## 10. Contexto compartido del legado

### Permanente y versionable

- `AGENTS.md` y `.agents/*.md`;
- `.agents/file-ownership.md`;
- `docs/architecture.md`;
- decisiones, reglas, contratos y criterios visuales estables en documentación de dominio;
- deuda técnica aceptada.

### Runtime fuera de Git

- tareas y revisiones;
- pedido original e historial resumido;
- prompts, aprobaciones y presentaciones;
- observaciones;
- handoffs/reportes;
- transferencias y ejecución;
- errores y reintentos;
- manifests y evidencias.

La API recibe resúmenes por tarea y dominio. No se duplica documentación estable ni se vuelca todo el historial.

## 11. Recuperación histórica

`Revisar pendiente` no pertenece al flujo directo actual. Se usa únicamente para recuperar el legado si:

- terminó inesperadamente el turno;
- venció la espera;
- se detuvo el watcher;
- falló la API;
- quedó una tarea huérfana;
- se retoma una tarea v1.

`Reintentar revisión` reencola de forma idempotente:

```powershell
npm run coordination:action -- retry-review --task-id <id> --submission-id <entrega> --revision <n> --domain <dominio>
```

Después se vuelve a ejecutar `coordination:await`. No aprobar una revisión que nunca fue presentada.

Para tareas anteriores a v2:

1. no borrar ni mover pendientes existentes;
2. consultar estado de solo lectura;
3. usar `Revisar pendiente` en el chat del dominio;
4. completar la decisión con el contrato v1 de `shownHash`;
5. no convertirla silenciosamente a v2 ni aprobar/ejecutar durante la migración;
6. no migrar la tarea; una entrega v2 posterior solo se crea ante un pedido explícito de operar el legado.

Las acciones v1 `review`, `approve --shown-hash`, `begin --shown-hash`, `reject` y `modify` permanecen únicamente para esta recuperación.

## 12. Seguridad y concurrencia del legado

- API key solo desde `OPENAI_API_KEY`; modelo configurable con `COORDINATOR_MODEL`, con `gpt-5.6-terra` como recomendación al operar el legado.
- Structured Outputs y validación local estricta.
- Escritos `.tmp` más rename atómico.
- Lock de watcher y lock de estado.
- Hashes para handoff, evidencia y propuesta.
- Un pendiente compatible por tarea/revisión; deduplicación y prevención de loops.
- Backoff, reintentos acotados, heartbeat y recuperación tras reinicio.
- Límites de contexto, imagen, respuesta y archivos.
- Sin `.env`, claves, caches, bases completas, adjuntos no autorizados ni datos reales.
- Suite automatizada sin API real y sin modificar el ERP.

## 13. Prueba real controlada del legado

La prueba real es un diagnóstico legado opt-in y solo se ejecuta por pedido explícito. Usa watcher real, una tarea e imagen sintéticas, el modelo configurado y cero cambios funcionales/datos. Debe demostrar texto+imagen real, espera, revisión, registro de presentación y pedido final de `Aprobar`, sin ejecutar.

El runner respeta `COORDINATOR_MODEL` y reporta tanto el valor configurado como el ID exacto informado por Responses API. No existe escalamiento automático. `gpt-5.6-sol` queda disponible únicamente como alternativa manual futura para revisiones excepcionales.

La prueba final del 23 de julio de 2026 pasó con `gpt-5.6-terra`, revisión `valid_initially`, una llamada a Responses API y una carga de imagen. Aprobó transporte, percepción, schema, contrato, categorías, correcciones y presentación; obtuvo 6/7 categorías deliberadas, 7 anclas y 8 correcciones ejecutables. Terminó con el veredicto sintético esperado `fix_required`, 0 aprobaciones, 0 inicios de ejecución y sin modificar el ERP real, `.env` ni datos. El prompt generado para esa fixture no forma parte de una tarea operativa y no se ejecuta.

```powershell
$env:COORDINATION_REAL_TEST = "1"
npm run coordination:test:real
```

Si faltan `OPENAI_API_KEY` o `COORDINATOR_MODEL`, no se simula un éxito: se deja el comando reproducible y se validan los demás casos con mocks.
