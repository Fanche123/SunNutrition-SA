# Apéndice opcional de instalación del legado en Windows

> **ESTADO: LEGADO MANUAL OPCIONAL.** El flujo normal actual atiende los pedidos naturales directamente y no crea `taskId` ni requiere watcher, `enqueue`, `coordination:await`, `present`, `Aprobar`, `begin` o evidencia coordinada.
>
> Este apéndice se usa solo por pedido explícito, recuperación histórica o diagnóstico. Los comandos y launchers nunca se inician automáticamente y las tareas existentes no se migran ni se alteran.

La guía canónica del legado es [SETUP.md](SETUP.md). Este apéndice resume únicamente PowerShell y launchers.

## Variables temporales del legado

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

Los procesos iniciados desde esa terminal heredan las variables. Al cerrarla se pierden. No guardar la clave en `.env`, `.bat`, scripts o logs.

`gpt-5.6-terra` es el modelo recomendado del legado, no un fallback hardcodeado: el watcher usa exactamente el valor de `COORDINATOR_MODEL`. Otros modelos compatibles siguen admitidos. No hay escalamiento automático; `gpt-5.6-sol` se reserva como alternativa manual futura para revisiones excepcionales.

## Comandos manuales del legado

Ejecutarlos únicamente después de un pedido explícito del usuario:

```powershell
npm run coordination:test
npm run coordinator
npm run coordination:status
```

La espera del especialista es:

```powershell
npm run coordination:await -- --task-id <id> --domain <dominio> --handoff-hash <sha256> --revision <n> --timeout 600
```

## Launchers

El archivo `Iniciar_ERP_y_Coordinador.bat` conserva su nombre histórico, pero ahora inicia únicamente el ERP mediante el control seguro de puerto e identidad y puede usarse como launcher habitual. El procedimiento canónico está en [`docs/local-server.md`](../local-server.md).

Las utilidades manuales del legado son:

- `Iniciar_Coordinador.bat`
- `Ver_Estado_Coordinacion.bat`

Los launchers no contienen secretos. Las utilidades del legado no convierten el watcher en ejecutor y solo se usan por solicitud explícita.

Si `OPENAI_API_KEY` y `COORDINATOR_MODEL` se cargaron como variables temporales en PowerShell, iniciar `Iniciar_Coordinador.bat` desde esa misma terminal para que las herede. Un doble clic desde el Explorador no hereda las variables definidas únicamente en otra sesión de PowerShell.

## Flujo legado manual opcional

1. Confirmar que el usuario pidió expresamente utilizar el legado y crear la tarea en el Chat Coordinador.
2. Copiar una vez el primer prompt.
3. El especialista publica con `coordination:action -- enqueue` e invoca manualmente la espera.
4. Probar la aplicación.
5. Escribir `Aprobar` o una observación natural.
6. Usar `Continuar tarea` si cambia el dominio; el especialista recupera con `coordination:action -- continue-task`.

`Revisar pendiente` se reserva para recuperar tareas legado interrumpidas o v1; no pertenece al flujo directo actual.

## Recuperación histórica

Ante timeout, caída de API o watcher detenido, conservar `taskId`, revisión, submission y hashes; consultar `npm run coordination:status`; reiniciar el watcher si corresponde; usar `Reintentar revisión`; y volver a ejecutar `coordination:await`. No crear otro handoff ni aprobar una revisión que no fue presentada. El procedimiento completo está en [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
