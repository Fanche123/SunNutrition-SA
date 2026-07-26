# Recuperación y problemas del legado de coordinación v2

> **ESTADO: LEGADO MANUAL OPCIONAL.** Este documento no describe el flujo normal actual. Un pedido natural nuevo se atiende directamente en el chat actual y no crea `taskId` ni requiere watcher, `enqueue`, `coordination:await`, `present`, `Aprobar`, `begin` o evidencia coordinada.
>
> Aplicar estos procedimientos solo por pedido explícito del usuario, recuperación de tareas históricas o diagnóstico. No iniciar herramientas automáticamente ni migrar, aprobar, ejecutar o alterar tareas existentes como parte de la recuperación.

Antes de intervenir en el legado:

1. no modificar datos ni código funcional para “destrabar” la infraestructura;
2. no imprimir variables de entorno;
3. consultar `npm run coordination:status`;
4. conservar `taskId`, revisión y hashes;
5. no mover colas ni editar `state.json` manualmente.

## El Chat Coordinador legado no crea la tarea solicitada explícitamente

Solo si el usuario pidió crear una tarea legado, comprobar que el chat recibió el primer mensaje de [SETUP.md](SETUP.md), puede leer `.agents/coordinador.md` y trabaja en la raíz correcta. Debe devolver:

- `taskId`;
- chat especialista;
- primer prompt con ese `taskId`.

Si falta un criterio verdaderamente bloqueante, responderlo. No aceptar un prompt legado sin tarea registrada ni inventar un identificador desde el especialista. Un pedido natural nuevo fuera del legado no necesita esta tarea.

## Falta `OPENAI_API_KEY` o `COORDINATOR_MODEL`

Si el usuario activó el legado, el watcher debe fallar antes de llamar a la API.

- Cargar ambas variables en la terminal del watcher.
- Usar normalmente `gpt-5.6-terra` o elegir otro modelo admitido con Responses API, Structured Outputs estricto e imágenes.
- No crear `.env` ni pegar la clave en un informe.
- Reiniciar solo el watcher.

No existe fallback ni escalamiento automático de modelo. `gpt-5.6-sol` es únicamente una alternativa manual futura para revisiones excepcionales.

## Facturación, cuota, rate limit o API caída

- Revisar facturación/créditos y límites de la plataforma API, separados de ChatGPT.
- Dejar actuar el backoff en errores temporales.
- No reiniciar repetidamente ni duplicar el handoff.
- Después de resolver, usar `Reintentar revisión` o una exploración única.

El ERP puede seguir funcionando; ninguna revisión fallida autoriza ejecución.

## `coordination:await` termina por timeout

El timeout inicial de 600 segundos es un límite, no un fallo funcional.

1. Consultar estado y heartbeat.
2. Verificar que coincidan `taskId`, dominio, handoff hash, entrega y revisión.
3. Confirmar que el watcher esté vivo.
4. Escribir `Reintentar revisión` en el mismo chat; el especialista ejecuta:

   ```powershell
   npm run coordination:action -- retry-review --task-id <id> --submission-id <entrega> --revision <n> --domain <dominio>
   ```

5. Volver a ejecutar `coordination:await`.
6. Reutilizar la identidad existente; no crear otro handoff salvo que el anterior haya fallado de forma terminal.

La espera debe liberar timers/handles. No dejar procesos huérfanos ni esperar indefinidamente.

## Watcher detenido o heartbeat obsoleto

1. Confirmar que no exista otra instancia.
2. Iniciar `npm run coordinator`.
3. Consultar estado.
4. Reintentar la espera desde el especialista.

No borrar el lock si hay un proceso vivo. Un lock huérfano debe recuperarse mediante el mecanismo versionado.

## Handoff en `inbox` o `processing`

Para `inbox`, comprobar schema, tamaño, estabilidad y que fue publicado por `enqueue`.

Para `processing`, consultar error y reintentos. Después de un reinicio, el watcher debe recuperar por hash sin crear otra revisión.

No copiar un archivo nuevamente a `inbox`, no renombrar `.tmp` y no editar una entrega ya hasheada.

## Handoff en `failed`

Causas típicas:

- schema/identidad inválidos;
- contenido sensible;
- dominio inexistente;
- `taskId` reutilizado con contenido incompatible;
- respuesta de IA inválida;
- evidencia inválida;
- reintentos agotados.

Corregir el origen y crear una nueva entrega/revisión enlazada. No reinyectar el archivo fallido editándolo.

## La revisión llegó pero no se presentó

La propuesta no puede aprobarse hasta que exista un registro de presentación.

1. Mantener el mismo chat especialista.
2. Usar `Revisar pendiente` como recuperación.
3. Verificar tarea, dominio, revisión y `proposalHash`.
4. Registrar la presentación con `coordination:action -- present`, incluyendo `proposalHash` y hash del archivo.
5. Recién entonces pedir `Aprobar`.

`Revisar pendiente` no debe confundirse con el flujo directo actual ni mantenerse como paso habitual una vez recuperado el turno legado.

## `Aprobar` es rechazado

Comprobar:

- propuesta realmente presentada;
- `taskId`, dominio y revisión;
- `proposalHash` vigente;
- ausencia de reemplazo;
- preguntas bloqueantes vacías;
- no aprobada/cerrada/ejecutada previamente.

Si existe una revisión nueva, presentarla completa. No reutilizar la aprobación anterior ni pedirle al usuario que copie hashes.

## `approve` devolvió éxito pero no hay cambios

Es correcto: approval registra la decisión y devuelve `executed: false`.

- Para `close`, no debe ejecutarse nada.
- Para prompt del mismo dominio, el especialista registra `begin` justo antes de trabajar.
- Para otro dominio, se registra transferencia y se usa `Continuar tarea`.

Watcher, await y CLI nunca ejecutan código funcional.

## El usuario hizo una observación natural dentro del legado

No ejecutar una corrección inmediata.

1. Asociar el texto a tarea, revisión y propuesta.
2. Registrar la observación con el tooling.
3. Solicitar/reencolar revisión.
4. Esperar.
5. Presentar el nuevo prompt.
6. Pedir otra aprobación.

Si el sistema intenta interpretar solo `Modificar:`, es un flujo v1 o una integración desactualizada.

## `Continuar tarea` no encuentra la transferencia

Comprobar:

- que el chat corresponda a `targetDomain`;
- que la transferencia fue aprobada;
- mismo `taskId`, revisión y `proposalHash`;
- que no fue consumida, cerrada o reemplazada;
- que el especialista anterior no ejecutó fuera de ownership.

No copiar el prompt manualmente como atajo. Recuperar con:

```powershell
npm run coordination:action -- continue-task <dominio> --task-id <id>
```

Luego registrar `begin` una sola vez.

## Evidencia material ausente en una tarea legado

Una entrega con `visualImpact: material` no puede cerrar.

- Generar capturas sanitizadas de los estados necesarios.
- Crear/actualizar el manifest.
- Publicar una nueva entrega o revisión.
- Esperar el análisis visual real.

Una ruta escrita, un nombre de archivo o un informe textual no sustituyen `input_image`.

## Evidencia rechazada

Revisar:

- ubicación bajo `.coordination/evidence/<taskId>/`;
- ausencia de `..`, ruta absoluta o symlink externo;
- PNG/JPEG/WebP;
- MIME real coincidente;
- límites individual, total y cantidad;
- SHA-256;
- `taskId` del manifest;
- viewport, pantalla, estado y fecha;
- indicador de sensibilidad.

No reducir seguridad moviendo el archivo fuera de la carpeta autorizada.

## Posible información sensible en captura

1. No enviar la imagen.
2. Bloquear la revisión.
3. Generar una versión sanitizada o pedir autorización explícita.
4. Revalidar manifest, MIME y hash.

Si una clave pudo exponerse, detener watcher, revocarla en la plataforma, cerrar la terminal y revisar solo logs/archivos sanitizados. Nunca copiar el secreto a tickets, commits o handoffs.

## La IA no comenta el contenido visual

Confirmar que:

- el payload incluyó `input_image` real;
- el modelo admite imágenes;
- `visualReview` contiene hallazgos por captura;
- no se envió solo la ruta.

Una respuesta que solo confirma existencia de archivos no satisface una revisión visual material.

## Dos tareas o revisiones legado incompatibles

El sistema debe serializar revisiones incompatibles de la misma tarea/dominio. Tareas independientes pueden coexistir.

- Resolver o rechazar la revisión activa.
- No sobrescribir ni mover archivos.
- No variar timestamps para eludir deduplicación.
- Una continuación real conserva `taskId` y aumenta revisión/entrega según contrato.

## Reinicio del legado después de una caída

1. Confirmar instancia única.
2. Iniciar watcher.
3. Consultar heartbeat y estado.
4. Recuperar `processing`, espera y presentaciones por hashes.
5. Verificar que no regenere propuestas decididas ni reapruebe.

Si el estado está dañado, conservar una copia local para diagnóstico sin versionarla. La recuperación reconstruye metadatos de coordinación, nunca tablas del ERP.

## Retomar una tarea histórica v1

1. No borrar sus archivos.
2. Consultar estado.
3. Abrir el chat del dominio.
4. Escribir `Revisar pendiente`.
5. Usar el contrato v1 de `shownHash`.
6. Aprobar, rechazar o modificar solo después de mostrar esa versión.

No convertir automáticamente una aprobación v1 a `proposalHash`, no migrar ni ejecutar tareas existentes y no exigir `coordination:await` retroactivamente.

## No aparece el aviso

El watcher siempre escribe en consola. BEL es opcional y algunas terminales lo silencian.

- Consultar estado de solo lectura.
- Revisar consola.
- Comprobar `notification.enabled` si se espera sonido.

No hay toast de Windows y la falta de sonido no afecta la cola.

## Diagnóstico seguro

Compartir solo:

- `taskId`, dominio y revisión;
- estado;
- timestamp;
- hashes abreviados;
- categoría de error;
- reintentos;
- versión de Node;
- comando ejecutado.

No compartir claves, variables completas, prompts con datos, filas del ERP, caches, adjuntos ni capturas sensibles.
