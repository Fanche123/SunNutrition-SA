# AGENTS.md — Proyecto ERP

## Objetivo

Mantener el ERP de SunNutrition simple, rápido, modular, seguro y fácil de entender.

Prioridades:

1. Exactitud de los cálculos.
2. Conservación de funcionalidades existentes.
3. Cambios mínimos y localizados.
4. Rendimiento.
5. Claridad del código.
6. Consistencia visual.

---

## 1. Alcance de cada tarea

Realizar únicamente el cambio solicitado.

Si el usuario indica archivos o un módulo:

- inspeccionar primero esos archivos;
- no recorrer todo el repositorio;
- no modificar archivos fuera del alcance;
- no hacer mejoras adicionales;
- no refactorizar código no relacionado.

Ampliar el alcance solo cuando una dependencia directa lo requiera.

Si es necesario modificar archivos adicionales, explicar brevemente por qué.

---

## 2. Cambios mínimos

Preferir siempre el menor cambio que resuelva correctamente la tarea.

No realizar por iniciativa propia:

- refactorizaciones generales;
- reorganizaciones de carpetas;
- cambios de arquitectura;
- cambios de nombres públicos;
- migraciones de base de datos;
- sustitución de librerías;
- rediseños de otras pantallas.

No instalar dependencias salvo que sea imprescindible y se haya solicitado o explicado.

---

## 3. Limpieza localizada

Después de un cambio, limpiar únicamente el código directamente afectado:

- imports que quedaron sin uso;
- variables o funciones reemplazadas por el cambio;
- estilos que quedaron huérfanos dentro del componente modificado;
- comentarios que dejaron de representar el comportamiento real.

No buscar código muerto en todo el repositorio después de cada tarea.

No eliminar archivos, componentes o dependencias globales sin comprobar sus referencias.

La limpieza general del proyecto debe realizarse como una tarea separada.

---

## 4. No duplicar lógica

Antes de crear una función, componente o estilo nuevo, buscar alternativas existentes dentro del módulo actual y en los componentes compartidos directamente relacionados.

No realizar una búsqueda exhaustiva de todo el repositorio para cambios pequeños.

Reutilizar código existente cuando sea claro y no aumente innecesariamente el acoplamiento.

---

## 5. Separación de responsabilidades

Mantener separados:

- acceso y carga de datos;
- validación y limpieza;
- cálculos;
- presentación;
- estilos;
- configuración.

No colocar lógica financiera compleja directamente dentro de componentes visuales.

Cada archivo debe tener una responsabilidad clara.

Dividir un archivo únicamente cuando su tamaño o mezcla de responsabilidades dificulte el cambio actual.

---

## 6. Cálculos financieros

Los cálculos de ventas, egresos, IVA, retenciones, costos, inventarios y estado de resultados deben ser claros y verificables.

Reglas:

- centralizar fórmulas;
- evitar cálculos duplicados;
- usar nombres descriptivos;
- documentar criterios no evidentes;
- no cambiar fórmulas existentes sin indicarlo;
- no inventar criterios contables.

Cuando falte un criterio necesario, marcarlo claramente antes de implementarlo.

---

## 7. Base de datos

No modificar esquemas, tablas, migraciones ni datos existentes salvo solicitud explícita.

Para cambios en consultas:

- conservar el resultado esperado;
- usar joins y filtros claros;
- evitar consultas innecesariamente costosas;
- validar nombres reales de tablas y columnas;
- no alterar otros módulos no relacionados.

---

## 8. Rendimiento de la aplicación

Evitar dentro del código modificado:

- cálculos repetidos innecesariamente;
- consultas duplicadas;
- renderizados evitables;
- listeners duplicados;
- timers sin limpiar;
- carga completa de datos cuando puede utilizarse paginación o filtrado;
- grandes objetos duplicados en memoria.

No realizar una auditoría completa de rendimiento después de cada cambio.

---

## 9. Validaciones

Validar según corresponda:

- fechas;
- montos;
- categorías;
- proveedores;
- tipos de factura;
- valores vacíos;
- datos importados;
- respuestas de servicios;
- errores de base de datos.

Mostrar mensajes comprensibles. Evitar errores silenciosos.

---

## 10. Comentarios y nombres

Usar nombres descriptivos para funciones, variables, componentes y archivos.

Los comentarios deben explicar decisiones, fórmulas o motivos no evidentes.

No comentar código obvio.

No renombrar elementos existentes fuera del alcance de la tarea.

---

## 11. Interfaz

Mantener el sistema visual existente:

- títulos;
- botones;
- tablas;
- colores;
- espaciados;
- tarjetas;
- filtros;
- desplegables.

Reutilizar componentes y estilos existentes cuando estén directamente relacionados.

En cambios exclusivamente visuales, no modificar lógica, servicios, base de datos ni comportamiento salvo solicitud explícita.

---

## 12. Verificación proporcional

Aplicar la verificación mínima suficiente para cada tarea.

### Cambio visual pequeño

- revisar sintaxis;
- comprobar el componente modificado;
- no ejecutar pruebas generales salvo necesidad.

### Cambio de lógica localizado

- comprobar los casos afectados;
- ejecutar pruebas relacionadas si existen;
- revisar consumidores directos.

### Cambio de módulo

- ejecutar pruebas o validaciones del módulo.

### Cambio estructural, financiero o de base de datos

- revisar dependencias;
- ejecutar pruebas más amplias;
- indicar posibles riesgos.

### Validación contra el servidor local

- antes de validar HTTP o interfaz, ejecutar `npm.cmd run server:status` desde el checkout y puerto esperados;
- continuar únicamente si informa `running_fresh`;
- en Worktrees usar un puerto aislado, timeout y cleanup garantizado;
- un `404` de una ruta recién implementada obliga a corregir el runtime o la ruta y no permite cerrar la tarea como aprobada.

No ejecutar automáticamente toda la suite, builds completos o auditorías generales para cambios pequeños.

### Gate operativo obligatorio de cierre

Esta sección es la fuente normativa transversal para toda tarea ERP. El único gate de cierre es `npm.cmd run server:ensure`, ejecutado desde `C:\Users\benja\Documents\ERP`, sin overrides de `PORT`, `ERP_HOST` ni modo. Debe ser la última acción técnica del ejecutor después de limpiar sus procesos temporales.

`server:ensure` opera exclusivamente sobre el Local principal `127.0.0.1:3000`. Verifica checkout, identidad autenticada, PID, línea de comando, `cwd`, host y puerto antes de controlar un proceso; no reinicia un servidor que ya tenga `running_fresh` y `ocr_reachable`; y restaura en background una instancia detenida, obsoleta o sin conectividad OCR únicamente mediante el shutdown autenticado existente. Después exige, en orden, `running_fresh` y `ocr_reachable`. El probe OCR no envía facturas, credenciales ni documentos.

Un exit code distinto de cero, `ensure_needs_restore`, `ensure_failed` o cualquier salida que no contenga simultáneamente `server=running_fresh` y `ocr=ocr_reachable` prohíbe declarar éxito. El ejecutor restaura desde un contexto con acceso normal de red mediante la escalación no sandboxeada necesaria; si aun así falla, la tarea permanece `blocked` y explica el diagnóstico exacto.

Cada tarea registra los procesos temporales que crea y garantiza su cleanup con handle propio, timeout y `finally`. En Worktrees, toda validación usa puerto aislado y nunca detiene, reemplaza ni reinicia el Local principal. Después del cleanup, el ejecutor cambia explícitamente al checkout Local principal y ejecuta allí `server:ensure`; si el Worktree no está integrado, informa que el Local conserva una versión anterior válida y no sirve el Worktree en 3000. Solo Integración actualiza el Local con cambios de Worktrees.

Está prohibido cerrar Node por nombre, usar `taskkill /IM node.exe`, `Stop-Process` genérico o matar el PID descubierto solo por puerto. Tampoco se libera el puerto 3000 sin comprobar primero health, lock autenticado, PID, línea de comando y `cwd`. El fallback de una prueba se limita al handle exacto del hijo que esa misma prueba creó.

La garantía es global y rápida cuando el servidor ya está sano: una tarea que no tocó runtime también ejecuta un único `server:ensure`, que devuelve `action=no_op`. El informe final siempre incluye PID, línea de comando, host/puerto, checkout/`cwd`, `running_fresh`, `ocr_reachable` y procesos temporales limpiados.

El ejecutor es el único responsable del gate. Coordinador, Watchdog, validadores, consolidadores y demás controles read-only no restauran ni reinician servidores. En riesgo alto, el ejecutor lo realiza después de liberar los tres validadores y antes del consolidador, que solo verifica la evidencia. Si una corrección posterior modifica código servido o runtime, el ejecutor limpia nuevamente sus temporales y repite `server:ensure` antes de responder.

---

## 13. Seguridad al eliminar

No eliminar elementos dudosos.

Antes de eliminar un archivo, dependencia, función compartida o componente:

- comprobar referencias;
- explicar por qué parece obsoleto;
- indicar el posible riesgo.

Para código local claramente reemplazado por el cambio actual, eliminarlo directamente.

---

## 14. Respuesta final

Al terminar, informar brevemente:

- archivos modificados;
- cambio realizado;
- código local eliminado, si corresponde;
- validaciones ejecutadas;
- riesgos o pendientes reales.

No producir explicaciones extensas cuando la tarea sea pequeña.

---

## 15. Flujo directo predeterminado

Los pedidos nuevos se envían al Coordinador. Este crea `taskId`, elige título, dominio, modelo, esfuerzo y modo, resuelve el proyecto ERP y crea mediante `create_thread` un hilo principal visible con la consigna completa. Siempre asigna un título específico con `set_thread_title` y responde de inmediato, sin esperar el resultado.

El hilo principal visible creado por el Coordinador es el ejecutor final: inspecciona, implementa, realiza sus pruebas proporcionales y entrega una única respuesta al usuario. No crea otro hilo visible ni una tarea intermedia para repetir la consigna. Todo prompt declara `taskId`, dominio, riesgo, impacto visual (`none`, `minor` o `material`), `coordinatorThreadId` y `coordinatorHostId`; estos dos identificadores corresponden al Coordinador actual y nunca se hardcodean en las reglas generales. El Coordinador no crea subagentes, ejecuta trabajo técnico ni espera el resultado.

El flujo distingue dos hitos que no son equivalentes:

- **Implementación lista para prueba del usuario:** el código solicitado está terminado, las comprobaciones propias mínimas aprobaron y el resultado quedó disponible de forma segura; todavía faltan las validaciones automáticas y el gate.
- **Tarea finalizada y aprobada:** terminaron los controles proporcionales, los validadores cuando correspondan, el gate operativo y el cierre.

Después del primer hito y antes de crear validadores finales o ejecutar el gate, el ejecutor envía directamente y exactamente una vez un mensaje al `coordinatorThreadId`/`coordinatorHostId` del prompt mediante `send_message_to_thread`. No crea subagentes, roles, timers, automations ni polling para este aviso. El mensaje comienza exactamente con **“Implementación lista para prueba del usuario; validaciones automáticas y gate todavía en curso”** y nunca usa “tarea completada”, “aprobada” o “finalizada”. El ejecutor continúa automáticamente y no espera respuesta, salvo que aparezca una decisión realmente bloqueante.

El aviso incluye `taskId` y título; estado; modo Local o Worktree; riesgo e impacto visual; cambio funcional; ruta, pantalla o comprobación concreta disponible sin inventar UI; recarga o reinicio necesario; pruebas propias ejecutadas; aclaración de controles todavía en curso; y advertencias de seguridad/datos con acciones que el usuario no debe ejecutar. En Local declara si el cambio ya está servido o qué recarga falta, sin afirmar visibilidad cuando el runtime sirve código anterior. En Worktree aclara que no está integrado en el Local principal ni puede probarse allí; solo informa un puerto aislado si quedó disponible de forma segura y temporal, y nunca reemplaza `127.0.0.1:3000`. Para dinero, datos reales, contabilidad, migraciones o acciones externas limita la prueba a lectura, sandbox o pasos expresamente seguros: no invita a confirmar, eliminar, emitir, pagar, conciliar ni mutar datos reales sin autorización separada.

Si `send_message_to_thread` no está disponible o falla, el ejecutor registra el fallo y continúa con validaciones y gate; no bloquea la implementación ni crea hilos alternativos. Al recibir el aviso, el Coordinador comunica concisamente al usuario el hito y los pasos seguros de prueba mientras la tarea sigue validando; no relanza pruebas ni lo interpreta como aprobación final.

### Controles según riesgo

- Riesgo bajo o medio: validación proporcional simple del ejecutor, salvo solicitud expresa o señal concreta.
- Riesgo alto —dinero, contabilidad, datos reales, base de datos, migraciones, integraciones complejas o arquitectura transversal—: flujo completo con un Watchdog durante la ejecución, tres validadores finales paralelos y un consolidador posterior.
- No existe asesor periódico ni otro agente recurrente que sugiera rumbo general.

Durante una tarea de riesgo alto, el ejecutor crea exactamente un `watchdog_tarea` read-only después de registrar el estado inicial o al comenzar la implementación. Cada ventana aproximada de cinco minutos, el ejecutor dispara una revisión breve mediante `followup_task` sobre ese mismo subagente, o usa el mecanismo recurrente nativo equivalente si está disponible. No se prometen temporizadores autónomos que la herramienta no garantice ni se usan sleeps bloqueantes. El Watchdog revisa únicamente última actividad, fase, comando o herramienta, tiempo sin avance, bloqueo y próximo paso declarado; solo alerta por posible estancamiento, espera injustificada, comando anormalmente largo, ausencia de progreso o bloqueo de usuario. No edita, prueba, navega UI, sugiere mejoras, cambia planes, interrumpe ni crea agentes. Una tarea menor a cinco minutos puede terminar sin una segunda revisión. Antes del aviso temprano y de validar, el ejecutor detiene el Watchdog y libera su cupo.

Solo después de completar implementación, pruebas propias, revisión del diff delimitado y el único aviso temprano directo, el ejecutor crea en paralelo tres instancias read-only de `validador_tarea`, con focos no superpuestos: financiero/datos; técnico/regresiones; y funcional/visual. Los tres reciben el mismo paquete base: taskId, intención, alcance, dominio, riesgo, impacto visual, archivos propios, diff, pruebas, evidencias, backup/datos cuando aplique, cambios preexistentes, riesgos y puntos no ejecutados. Cada uno agrega su foco exclusivo, no modifica ni crea agentes y devuelve internamente `approved`, `fix_required` o `blocked`, con hallazgos priorizados, evidencia y corrección mínima. El foco funcional/visual no fuerza navegador cuando no hay impacto visual. El ejecutor espera los tres sin emitir respuestas parciales al usuario.

Después de finalizar y liberar los tres validadores, el ejecutor crea exactamente un `consolidador_validacion` read-only. Recibe el paquete base y los tres informes completos; no repite pruebas, navegación ni inspección completa. Deduplica, expone contradicciones, prioriza riesgos y verifica evidencia. Aprueba solo si los tres aprueban o las observaciones no bloqueantes quedaron justificadamente resueltas; exige corrección si un hallazgo demostrado la requiere, y bloquea ante decisión funcional, riesgo no autorizado o contradicción irresoluble read-only. Nunca suaviza evidencia ni responde al usuario.

Con `approved`, el ejecutor termina. Con `fix_required`, corrige una sola vez y repite únicamente las pruebas afectadas, sin segunda ronda salvo pedido expreso o riesgo crítico nuevo. Con `blocked`, consulta al usuario. No hay ciclos infinitos. La capacidad se ordena en fases: ejecutor + Watchdog; luego ejecutor + tres validadores; finalmente ejecutor + consolidador. Los cinco roles de control nunca coinciden ni se requieren seis agentes simultáneos.

### Ciclo de vida de tareas y correcciones

- Mientras una tarea permanece activa, sus pruebas y, cuando corresponda, la única corrección posterior al consolidado forman parte del mismo hilo.
- Una tarea queda cerrada cuando declara el objetivo completado y sin trabajo pendiente, o cuando el usuario la cancela expresamente. Un turno `blocked` o una consulta por decisión/autorización no cierran la tarea: puede reanudarse en el mismo hilo al recibir la respuesta necesaria. Solo después del cierre confirmado el hilo no se reabre ni recibe nuevas instrucciones de implementación.
- Todo defecto, ajuste, ampliación o cambio solicitado después del cierre se registra como una tarea nueva, con `taskId` y hilo principal visible nuevos. El nuevo prompt debe identificar el `parentTaskId` o tarea de origen, describir el problema actual de forma autosuficiente y aportar solo el contexto necesario: intención, evidencia, estado de integración, archivos o módulos relevantes, pruebas relacionadas, riesgos y cambios preexistentes conocidos.
- El Coordinador vuelve a evaluar dominio, modelo, esfuerzo y modo Local o Worktree según el estado actual; no hereda esas decisiones automáticamente de la tarea cerrada.
- Si la implementación de origen existe solo en un worktree no integrado, no crear la corrección contra un checkout que todavía no contiene esos cambios. Primero integrar de forma segura el resultado cerrado o asegurar que la nueva tarea parta del mismo estado de código, sin reabrir el hilo anterior.
- Las métricas, validaciones y resultado de la corrección pertenecen exclusivamente a la tarea nueva. No se repiten controles históricos que ya estén respaldados, salvo que sean necesarios para reproducir la regresión.

Pedir confirmación adicional solo cuando exista una decisión contable, destructiva, de datos, contrato o seguridad realmente bloqueante. La infraestructura de coordinación anterior permanece disponible únicamente como legado manual opcional; no usarla salvo pedido explícito ni alterar sus tareas o estado existentes por defecto.

---

## 16. Consulta de progreso bajo demanda

El progreso de los hilos se consulta únicamente cuando el usuario lo solicita mediante la skill personal `$estimar-progreso-hilos`. El Coordinador entrega una fotografía inmediata y read-only basada en estado, turnos, timestamps y evidencia de fases; no envía mensajes ni altera los hilos analizados.

La consulta de progreso no crea `monitor_progreso`, watchers, timers ni automations y no agrega validaciones. Es distinta del único Watchdog interno de una tarea de riesgo alto: `$estimar-progreso-hilos` es una fotografía solicitada por el usuario; el Watchdog es un control read-only acotado a la ejecución.
