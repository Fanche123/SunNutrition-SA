# Servidor local del ERP

El ciclo de vida canónico del ERP se administra desde el checkout cuyo código se quiere ejecutar. En Windows usar `npm.cmd` si PowerShell bloquea `npm.ps1`.

## Comandos

```powershell
npm.cmd start
npm.cmd run server:ensure
npm.cmd run server:status
npm.cmd run server:ocr-status
npm.cmd run server:restart
npm.cmd run server:stop
```

- `start` inicia el servidor en foreground o confirma que ya existe una instancia actual del mismo checkout.
- `server:ensure` es el único gate de cierre: opera solo sobre el Local principal `C:\Users\benja\Documents\ERP` en `127.0.0.1:3000`, conserva una instancia sana, restaura en background una instancia detenida/obsoleta/sin OCR y termina solo con `running_fresh` más `ocr_reachable`.
- `server:status` es read-only y termina con código `0` únicamente si el runtime pertenece al checkout actual, su lock coincide y la huella del código sigue vigente.
- `server:ocr-status` exige primero un runtime `running_fresh` y luego comprueba, desde ese mismo proceso servidor, conectividad sin credenciales ni documentos hacia el host de OpenAI. Es un estado separado: `running_fresh` no implica que OCR tenga salida de red.
- `server:restart` cierra y vuelve a iniciar solo una instancia verificable del mismo checkout.
- `server:stop` cierra solo una instancia verificable. Si encuentra un lock obsoleto sin servidor, retira únicamente ese archivo.

`Iniciar_ERP_y_Coordinador.bat` conserva su nombre histórico y ejecuta el mismo `npm.cmd start`. El Coordinador legado no forma parte de este arranque.

## Identidad y frescura

`GET /api/health` expone una identidad pública de runtime:

- `instanceId`, PID e instante de inicio;
- ruta del código, working directory, ejecutable y línea de comando;
- host, puerto y versión de Node;
- `sourceFingerprint`, huella SHA-256 del código backend, frontend y archivos de arranque.

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health |
  ConvertTo-Json -Depth 5
```

El lock local se guarda como `tmp/erp-server-<puerto>.lock.json`, está ignorado por Git y contiene un token aleatorio que nunca aparece en health. El cierre seguro se solicita al propio servidor mediante ese token; la herramienta no mata procesos por nombre ni usa el PID o el puerto como prueba suficiente.

Los estados relevantes de `server:status` son:

- `running_fresh`: checkout, lock y huella coinciden; se puede validar.
- `running_stale`: el servidor pertenece al checkout, pero el código cambió después de iniciarlo; ejecutar `server:restart`.
- `running_other_host`: el mismo checkout/puerto ya está activo en otro host local permitido; `start` conserva su lock y rechaza una segunda instancia. `restart` o `stop` pueden controlarlo mediante el host registrado.
- `running_foreign`: el puerto sirve otro checkout; operar desde esa ruta o liberar el puerto desde su propietario.
- `running_unmanaged`: health identifica al ERP, pero no existe un lock coincidente; cerrar desde la terminal que lo inició.
- `running_unverified`: el puerto responde sin identidad ERP; identificar a su propietario y no detenerlo automáticamente.
- `stale_lock`: no hay listener; `start`, `restart` o `stop` pueden retirar el lock sin detener ningún proceso.

Un servidor anterior a este contrato puede responder solo `{ "ok": true }`. Se considera no verificable y la herramienta se niega a cerrarlo. La transición segura es cerrarlo desde la terminal que lo inició; si esa terminal no existe, identificar y comprobar de manera independiente el proceso exacto antes de finalizarlo. Nunca usar `taskkill /IM node.exe`, `Stop-Process` por nombre, cierre por puerto ni cierres masivos.

## Conflicto de puerto

Si el puerto está ocupado, `start` no crea una segunda instancia. Antes de declarar obsoleto un lock también comprueba el host local que quedó registrado; cambiar entre `127.0.0.1`, `localhost` o `::1` no reemplaza el ownership de una instancia todavía activa. La retirada de un lock obsoleto vuelve a validar todos los hosts y reclama atómicamente el mismo snapshot antes de borrarlo; la escritura del lock nuevo es exclusiva. Dos arranques concurrentes conservan una sola instancia controlable. Si la colisión ocurre entre el preflight y `listen`, el servidor captura `EADDRINUSE`, muestra `npm.cmd run server:status` como diagnóstico y termina sin alterar al listener existente.

El puerto habitual continúa siendo `127.0.0.1:3000`. No cambiar bind, modo local ni seguridad de red para resolver una colisión.

## Gate único de cierre

La causa de los incidentes recurrentes era una secuencia manual dispersa: `status` podía ejecutarse sin OCR, la restauración quedaba separada y los reportes podían basarse solo en `running_fresh`. `server:ensure` concentra esa secuencia y falla cerrado.

El comando valida que se lo ejecute desde el checkout Local principal, sin overrides de host/puerto/modo. Antes de controlar una instancia compara health y lock autenticado, PID, línea de comando, `cwd`, checkout, host y puerto. Si ya encuentra `running_fresh` y `ocr_reachable`, devuelve inmediatamente `action=no_op`. Si debe restaurar, usa exclusivamente el shutdown autenticado y un nuevo proceso background del mismo checkout; nunca mata por PID, nombre o puerto.

Para diagnóstico read-only puede usarse:

```powershell
npm.cmd run server:ensure -- --check
```

`--check` no restaura. La tarea no puede cerrar con su diagnóstico: el gate final siempre es `npm.cmd run server:ensure`, después del cleanup y desde un contexto con acceso normal de red.

## Regla de validación y cierre para tareas

Antes de una validación HTTP o visual:

1. Ejecutar `npm.cmd run server:status` desde el checkout esperado y con el mismo `PORT`.
2. Continuar solo con `running_fresh`.
3. Si la prueba involucra OCR, ejecutar también `npm.cmd run server:ocr-status`.
4. Si una ruta nueva responde `404`, volver a comprobar el status y luego resolver el arranque o el registro real de la ruta. Un `404` atribuido a un runtime viejo no es una validación aprobada ni permite cerrar la tarea.

La fuente normativa completa es “Gate operativo obligatorio de cierre” en `AGENTS.md`. Al cerrar, toda tarea, incluso sin cambios de servidor, registra y limpia sus procesos temporales y ejecuta como última acción técnica `npm.cmd run server:ensure`. Solo exit code `0` con `running_fresh` y `ocr_reachable` habilita completitud. El probe OCR es seguro: no envía facturas, documentos ni credenciales. Si el comando falla aun con acceso normal de red, la tarea queda `blocked`.

En un Worktree, no usar el puerto Local activo ni detenerlo o reiniciarlo. Elegir un puerto aislado y conservarlo en todos los comandos de esa prueba:

```powershell
$env:PORT = '43100'
try {
  npm.cmd start
} finally {
  npm.cmd run server:stop
  Remove-Item Env:PORT -ErrorAction SilentlyContinue
}
```

Las pruebas automatizadas deben iniciar el proceso con un handle propio, aplicar timeout y ejecutar cleanup en `finally`. El fallback de terminación exacta solo puede aplicarse al proceso hijo creado por esa misma prueba; nunca a un PID descubierto únicamente por el puerto.

Al terminar un Worktree, limpiar sus procesos temporales, quitar sus overrides de entorno, cambiar al checkout Local principal y ejecutar allí `npm.cmd run server:ensure`. Si el Worktree no está integrado, el Local puede seguir sirviendo una versión anterior válida; se informa y nunca se sirve el Worktree en el puerto 3000. Solo una tarea de integración actualiza el servidor principal. Watchdog, validadores, consolidadores y Coordinador son read-only: no operan procesos; el ejecutor realiza el gate.

La regresión focalizada es:

```powershell
npm.cmd run server:test
```
