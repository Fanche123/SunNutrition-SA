# Puesta en marcha opcional del legado de coordinación v2

> **ESTADO: LEGADO MANUAL OPCIONAL.** Esta puesta en marcha no corresponde al flujo normal actual. Un pedido natural nuevo se atiende directamente en el chat actual: no crea `taskId` ni requiere watcher, `enqueue`, `coordination:await`, `present`, `Aprobar`, `begin` o evidencia coordinada.
>
> Usar estas instrucciones solo por pedido explícito del usuario, recuperación histórica o diagnóstico. Nada se inicia automáticamente y las tareas existentes no se migran ni se alteran.

## Requisitos para activar manualmente el legado

- Node.js compatible con el ERP.
- Dependencias habituales del repositorio.
- Cuenta de OpenAI API con facturación/créditos y límites configurados.
- Modelo con Responses API, Structured Outputs estricto y soporte de imágenes.
- Una terminal para el watcher.

El coordinador es opcional. `npm start` conserva el funcionamiento normal del ERP.

## 1. Crear el Chat Coordinador legado

Solo si el usuario pidió expresamente activar el legado, crear o reutilizar un chat llamado **Coordinador** y enviar como primer mensaje:

> Leé `.agents/coordinador.md`, `.agents/_base-development.md` y `.agents/file-ownership.md`. Operá únicamente el sistema de coordinación legado solicitado, sin modificar código funcional, datos ni tareas ajenas.

Este texto es el mensaje canónico histórico y debe coincidir con la sección “Primer mensaje histórico” de `.agents/coordinador.md`.

Dentro de esa activación legado, el usuario describe el cambio. El Coordinador debe responder con `taskId`, chat destino y primer prompt. Ese prompt se copia una sola vez. Fuera de este caso explícito, un pedido natural se resuelve directamente y no crea una tarea coordinada.

El chat registra la tarea internamente con `coordination:action -- create-task <archivo|->`; el usuario no prepara JSON ni ejecuta el comando.

## 2. Configurar la API para el legado

La API y ChatGPT se facturan por separado. Revisar:

- [Inicio rápido de API](https://developers.openai.com/api/docs/quickstart)
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [Facturación de ChatGPT y API](https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform)
- [Precios de API](https://openai.com/api/pricing/)

En PowerShell, cargar la clave solo para la sesión actual sin mostrarla:

```powershell
$coordinationSecret = Read-Host 'OPENAI_API_KEY' -AsSecureString
$coordinationPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($coordinationSecret)
try {
  $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($coordinationPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($coordinationPointer)
  Remove-Variable coordinationPointer
  Remove-Variable coordinationSecret
}
$env:COORDINATOR_MODEL = 'gpt-5.6-terra'
```

No usar `.env`, archivos `.bat`, scripts versionados ni logs para guardar la clave. El modelo no es secreto, pero debe elegirse explícitamente por compatibilidad, costo y latencia.

Al operar el legado, `gpt-5.6-terra` es el modelo recomendado para el Coordinador. `COORDINATOR_MODEL` continúa siendo obligatorio y puede apuntar a otro modelo admitido que soporte Responses API, Structured Outputs estricto e imágenes. No existe escalamiento automático. `gpt-5.6-sol` queda documentado únicamente como alternativa manual futura para revisiones excepcionales.

## 3. Validar el legado sin API real

```powershell
npm run coordination:test
npm run coordination:status
```

La suite automatizada usa proveedor simulado, archivos temporales aislados e imágenes sintéticas. No modifica el ERP ni datos operativos.

## 4. Iniciar manualmente el legado

Watcher continuo, solo por pedido explícito:

```powershell
npm run coordinator
```

Una exploración:

```powershell
npm run coordinator:once
```

En Windows, las utilidades manuales del legado son:

```text
Iniciar_Coordinador.bat
Ver_Estado_Coordinacion.bat
```

`Iniciar_ERP_y_Coordinador.bat` conserva su nombre histórico, pero ahora inicia únicamente el ERP y no activa el watcher. Los launchers nunca contienen la clave.

## 5. Aviso local del legado

El watcher siempre imprime la tarea y el chat destino en consola. Para agregar BEL:

```json
{
  "notification": {
    "enabled": true
  }
}
```

La opción pertenece a `.coordination/config.json`. BEL puede ser silencioso según la terminal y no crea un toast de Windows.

## 6. Operación del flujo legado manual

1. Confirmar que el usuario pidió operar el legado y mantener el watcher activo solo durante esa operación.
2. Crear la tarea en el Chat Coordinador.
3. Copiar el primer prompt al especialista.
4. El especialista ejecuta, valida, hace `coordination:action -- enqueue` y corre `coordination:await`.
5. Esperar que el mismo turno presente la revisión.
6. Probar la aplicación.
7. Escribir `Aprobar` o describir naturalmente un problema.
8. Si cambia el dominio, abrir el chat indicado y escribir `Continuar tarea`; el chat usa `coordination:action -- continue-task`.

Dentro del legado, no usar `Revisar pendiente` salvo recuperación histórica.

## 7. Timeout y heartbeat del legado

La espera del legado usa:

```powershell
npm run coordination:await -- --task-id <id> --domain <dominio> --handoff-hash <sha256> --submission-id <entrega> --revision <n> --timeout 600
```

El timeout inicial es 600 segundos. La espera verifica el heartbeat del watcher, detecta estado obsoleto y libera handles. Un timeout no cancela ni aprueba la tarea; permite `Reintentar revisión`.

## 8. Evidencia coordinada del legado

Para impacto visual `material` de una tarea legado activada explícitamente, generar capturas reales sanitizadas del estado modificado. Las imágenes sintéticas se reservan para pruebas controladas. Toda evidencia se guarda en:

```text
.coordination/evidence/<taskId>/
```

El manifest debe pasar validación antes de enqueue. No colocar imágenes reales fuera de la carpeta, no usar symlinks y no enviar capturas con información sensible. `none` no debe adjuntar imágenes por rutina.

## 9. Prueba real controlada del legado

La prueba real es un diagnóstico opt-in, se ejecuta únicamente por pedido explícito y solo con variables activas. Debe usar una tarea y una imagen sintéticas, no modificar código funcional, no tocar datos y detenerse antes de cualquier ejecución.

```powershell
$env:COORDINATION_REAL_TEST = "1"
npm run coordination:test:real
```

Si falta clave o modelo:

- no inventar una revisión;
- ejecutar todas las pruebas mock;
- dejar el comando reproducible para el usuario.

## 10. Detener el legado

- Usar `Ctrl+C` en el watcher y esperar el cierre.
- El ERP iniciado por separado puede continuar.
- No borrar locks mientras exista un proceso vivo.
- Cerrar la terminal elimina las variables cargadas para esa sesión.

## 11. Conservar tareas v1/v2 existentes sin migrarlas

1. No iniciar una migración por un pedido natural nuevo.
2. Si el usuario solicita una recuperación histórica, detener primero el watcher anterior y ejecutar las pruebas v2.
3. Conservar `state.json`, colas, aprobados, rechazados, completados y fallidos.
4. No mover, aprobar ni ejecutar tareas existentes.
5. Iniciar el watcher solo durante esa recuperación explícita y consultar estado.
6. Retomar una tarea v1 con `Revisar pendiente`.
7. No crear tareas nuevas salvo pedido explícito de utilizar el legado.

No hay migración automática: no se reconstruyen tablas, no se modifican datos del ERP y no se convierten aprobaciones v1.
