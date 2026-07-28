# Base común de desarrollo del ERP

Estas reglas aplican a todos los chats especialistas. Son chats de **desarrollo**, no de operación ni soporte al usuario final.

## Arquitectura estable

- Las tablas persistidas por `backend/data-store.js` son la única fuente de verdad.
- No reintroducir Google Sheets ni reconstrucción desde Excel/CSV. OCR solo interpreta un archivo aportado por el usuario.
- `server.js` compone infraestructura y arranca. `assets/js/app.js` hace bootstrap, navegación y coordinación transversal. No mover lógica de dominio a esos archivos: la lógica nueva pertenece a módulos o servicios con dueño claro.
- JavaScript clásico en frontend, CommonJS en backend, sin bundler ni framework.

## Inspección dirigida

Para cada tarea leer solo el archivo donde se manifiesta, sus dependencias directas, los contratos/tablas afectados y las pruebas necesarias. Los inventarios de cada AGENT son un mapa, no una lista obligatoria de lectura. Ampliar el relevamiento únicamente ante una dependencia real.

Reutilizar antes de crear, no duplicar reglas y no esconder lógica en nuevos monolitos. Un cambio localizado en `app.js`, `server.js`, `index.html`, estilos, router o data-store debe ser mínimo; si cambia su responsabilidad, derivar a Arquitectura.

## Modos de trabajo

### Rápido

Para corrección pequeña, texto, selector, condición, cálculo puntual o función/endpoint identificado: localizar, revisar dependencias directas, implementar, validar proporcionalmente e informar. Sin auditoría general ni aprobación previa.

### Estándar

Para varios archivos del mismo dominio, flujo acotado o frontend/backend coordinado: análisis dirigido, plan breve, implementación, validación del flujo y actualización documental necesaria. Solo detenerse ante ambigüedad material.

### Alto riesgo

Para esquema/migración, datos persistentes, contrato JSON o endpoint, compatibilidad, cambio transversal, dependencia, arquitectura, acción destructiva o criterio financiero incierto: identificar consumidores, explicitar plan y riesgos, y validar por etapas.

Pedir confirmación humana adicional únicamente cuando falte una decisión contable o financiera, exista una acción destructiva, se vayan a modificar datos reales, cambie un contrato público o haya una decisión de seguridad materialmente bloqueante. Si el pedido directo ya define inequívocamente el criterio y autoriza el alcance, avanzar sin una aprobación intermedia.

## Datos y validación

- No modificar datos reales durante pruebas. Usar lecturas, payloads inválidos, fixtures o repositorios/copias temporales aisladas.
- No tocar `.env`, adjuntos, caches ni temporales reales.
- Validar según riesgo: sintaxis y vista para frontend localizado; sintaxis, servidor y endpoint para backend; casos representativos y consumidores para cálculos; regresión amplia solo para cambios transversales.
- Antes de validar contra un servidor local, ejecutar `npm.cmd run server:status` desde el checkout/puerto esperado y exigir `running_fresh`. En Worktrees usar puerto aislado, timeout y cleanup en `finally`. Un `404` de una ruta nueva no puede aprobarse como “runtime viejo”: se resuelve o se declara bloqueo real. Ver `docs/local-server.md`.
- Informar con honestidad toda prueba no ejecutada.

## Mantenimiento obligatorio de AGENTS

Si una tarea crea un archivo permanente del sector, actualizar en la misma tarea el AGENT propietario, `.agents/file-ownership.md` y la arquitectura/dependencias afectadas. Al mover, renombrar o eliminar, actualizar todas sus referencias. Una integración nueva exige actualizar AGENT propietario, AGENT consumidor y ownership. No aplica a logs, temporales, outputs, backups, generados, adjuntos o caches. Esto forma parte de la definición de terminado.

## Flujo nativo y derivación

El flujo predeterminado crea hilos principales visibles:

1. el usuario describe una tarea nueva al Coordinador;
2. el Coordinador crea `taskId`, elige título, dominio, modelo, esfuerzo y modo;
3. resuelve el proyecto ERP y usa `create_thread` con entorno Local o Worktree;
4. usa siempre `set_thread_title` con un nombre específico;
5. inserta la consigna completa y deja el hilo trabajando independientemente;
6. responde inmediatamente sin esperar el resultado;
7. mientras el hilo permanece activo, resuelve sus propias pruebas y la única ronda de corrección interna permitida;
8. después de declarar el objetivo completado y sin trabajo pendiente, el hilo queda cerrado y toda corrección o ampliación posterior nace como una tarea nueva vinculada.

El Coordinador no usa `spawn_agent` ni Jefes anidados, no hace trabajo técnico y no recibe el informe. El nuevo hilo realiza toda inspección, cambio, prueba, navegador, captura y revisión, y puede crear sus propios especialistas como subagentes.

Usar Local cuando se necesiten runtime principal, localhost o archivos locales. Usar Worktree para aislamiento o cuando otra tarea escritora ya esté activa. No ejecutar dos escritores simultáneos sobre la misma carpeta principal.

### Tareas cerradas y correcciones posteriores

- El cierre requiere que el hilo declare el objetivo completado y sin trabajo pendiente, o que el usuario lo cancele expresamente. Un turno `blocked` o una pregunta por decisión/autorización no cierran la tarea y puede reanudarse en el mismo hilo.
- Después del cierre confirmado, no continuar implementación ni enviar correcciones nuevas a ese hilo.
- Un fallo, ajuste o requisito descubierto después del cierre recibe `taskId`, título e hilo principal visible nuevos, con referencia explícita a la tarea de origen.
- El prompt de la corrección debe ser autosuficiente y transportar solo intención, evidencia, estado de integración, módulos iniciales, pruebas relacionadas, riesgos y cambios preexistentes necesarios.
- La nueva tarea vuelve a evaluar ownership, riesgo y modo de trabajo. No hereda automáticamente el worktree, modelo ni validaciones de la tarea anterior.
- Si los cambios de origen aún no están integrados, primero resolver su integración o asegurar un checkout que los contenga. No corregir sobre una base que no incluye la implementación y no reabrir el hilo finalizado.
- Las correcciones internas surgidas antes del cierre —pruebas propias o una única ronda de `validador_tarea`— permanecen dentro de la tarea activa y no generan otro hilo.

## Consulta de progreso bajo demanda

Las tareas y correcciones no crean monitores automáticos. Cuando el usuario pide estado, porcentaje, tiempo transcurrido o estimación restante de tareas Codex, el Coordinador usa la skill personal `$estimar-progreso-hilos` y responde con una fotografía inmediata basada en evidencia.

La consulta es estrictamente read-only: descubre y lee hilos con las herramientas nativas, no espera su finalización, no les envía mensajes y no cambia archivos ni estado. El Coordinador no crea subagentes, watchers, timers, automations ni procesos residentes para estimar progreso.

## Validación principal única y proporcional

La única validación principal la ejecuta el mismo hilo o subagente que realizó la implementación. El hilo que delega consolida su evidencia, pero no repite comandos, navegador o inspecciones equivalentes si el ejecutor ya dejó resultados suficientes.

Antes de cerrar, el ejecutor debe:

1. convertir la intención y el alcance en criterios explícitos de completitud;
2. verificar el comportamiento solicitado y las exclusiones;
3. ejecutar sintaxis, pruebas focalizadas y casos representativos proporcionales al riesgo;
4. revisar consumidores directos y regresiones previsibles cuando corresponda;
5. validar la interfaz real y aportar evidencia si el impacto visual es `material`;
6. confirmar que no modificó datos reales durante las pruebas;
7. distinguir archivos propios de cambios preexistentes o concurrentes;
8. informar comandos o casos, resultados, evidencia verificable, riesgos y toda prueba no ejecutada.

El Coordinador revisa solamente ese resumen para detectar cobertura faltante, inconsistencias, riesgos o decisiones necesarias. No relanza validaciones rutinarias equivalentes ni exige controles ya respaldados con evidencia suficiente.

Una revisión independiente es excepcional. Solo ante una razón concreta y declarada —alto riesgo, señales de fallo, evidencia insuficiente o alcance transversal sensible— el hilo puede crear un único `validador_tarea` read-only. Debe transmitirle taskId, intención, alcance, dominio, riesgo, impacto visual, archivos propios, diff relevante, pruebas, evidencias, riesgos, cambios preexistentes y la razón de revisión. El validador enfoca su análisis en ese riesgo o brecha y no repite toda la validación principal.

- `approved`: informar la revisión excepcional y cerrar.
- `fix_required`: aplicar únicamente las correcciones concretas y repetir con el ejecutor las pruebas afectadas, sin segundo validador.
- `blocked`: detenerse y formular al usuario la decisión o autorización requerida.

No existe loop validador–corrección–validador. El Coordinador nunca crea ni espera validadores.

Clasificar el impacto visual como `none`, `minor` o `material`. Un impacto material requiere vista real o aislada, capturas y revisión de overflow, alineación, jerarquía y responsive.

La infraestructura bajo `.coordination/`, su watcher, comandos y documentación se conserva como **modo de recuperación v2**. No se usa en el flujo nativo, no requiere watcher activo y nunca se ejecutan ambos circuitos para la misma tarea.

Los subagentes no ejecutan migraciones o backfills reales, eliminaciones, operaciones financieras ni acciones destructivas sin autorización. Ningún agente hace commit o push automáticamente.

## Entrega breve

Usar por defecto: **Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**. Agregar análisis/plan solo si el riesgo o alcance lo justifican.

Derivar a Arquitectura cuando cambien límites de dominio, ownership, orden global de inicialización, infraestructura, responsabilidades de archivos compartidos o performance transversal.
