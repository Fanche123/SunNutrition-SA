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
7. el usuario continúa correcciones y revisión dentro del hilo visible creado.

El Coordinador no usa `spawn_agent` ni Jefes anidados, no hace trabajo técnico y no recibe el informe. El nuevo hilo realiza toda inspección, cambio, prueba, navegador, captura y revisión, y puede crear sus propios especialistas como subagentes.

Usar Local cuando se necesiten runtime principal, localhost o archivos locales. Usar Worktree para aislamiento o cuando otra tarea escritora ya esté activa. No ejecutar dos escritores simultáneos sobre la misma carpeta principal.

## Validación independiente única

Al finalizar cada pedido o corrección explícita, el hilo principal prepara una entrega preliminar y crea exactamente un `validador_tarea` read-only. Le entrega taskId explícito, intención, alcance, dominio, riesgo, impacto visual, archivos propios, resumen del diff relevante, pruebas, evidencias, riesgos, cambios preexistentes identificados y estado relevante del working tree.

- `approved`: entregar `TRABAJO REALIZADO`, `VALIDACIONES`, `VALIDACIÓN INDEPENDIENTE` y `REVISIÓN DEL USUARIO`, indicando validador, aprobación y ausencia de correcciones posteriores.
- `fix_required`: aplicar únicamente las correcciones concretas, repetir pruebas afectadas y terminar sin otro validador. Declarar: “Se aplicaron las correcciones solicitadas en la única revisión independiente. No se ejecutó una segunda revisión, conforme al flujo definido.”
- `blocked`: detenerse y formular al usuario la decisión o autorización requerida; no convertir el bloqueo en una corrección técnica.

No existe loop validador–corrección–validador. La regla se reinicia únicamente ante un nuevo pedido o una corrección explícita posterior del usuario dentro del mismo hilo. Coordinador nunca crea ni espera validadores.

Clasificar el impacto visual como `none`, `minor` o `material`. Un impacto material requiere vista real o aislada, capturas y revisión de overflow, alineación, jerarquía y responsive.

La infraestructura bajo `.coordination/`, su watcher, comandos y documentación se conserva como **modo de recuperación v2**. No se usa en el flujo nativo, no requiere watcher activo y nunca se ejecutan ambos circuitos para la misma tarea.

Los subagentes no ejecutan migraciones o backfills reales, eliminaciones, operaciones financieras ni acciones destructivas sin autorización. Ningún agente hace commit o push automáticamente.

## Entrega breve

Usar por defecto: **Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**. Agregar análisis/plan solo si el riesgo o alcance lo justifican.

Derivar a Arquitectura cuando cambien límites de dominio, ownership, orden global de inicialización, infraestructura, responsabilidades de archivos compartidos o performance transversal.
