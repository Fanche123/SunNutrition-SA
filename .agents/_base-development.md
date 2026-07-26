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

## Trabajo directo y derivación

El flujo predeterminado no usa coordinación paralela:

1. el usuario envía el pedido natural al chat especialista;
2. el especialista inspecciona únicamente el contexto relevante;
3. implementa o analiza lo autorizado dentro de su ownership;
4. valida proporcionalmente;
5. entrega **Cambios**, **Archivos**, **Validación** y **Riesgos o pendientes**.

No crear `taskId`, handoffs, evidencias de coordinación, revisiones paralelas, esperas ni pasos de `Aprobar`/`begin` para pedidos nuevos. Una observación natural del usuario se incorpora directamente al trabajo en curso, salvo que cambie materialmente el alcance o introduzca una decisión bloqueante.

Si una tarea pertenece a otro dominio, detener únicamente esa parte e indicar verbalmente el chat especialista correcto. No crear una transferencia ni estado intermedio.

La infraestructura bajo `.coordination/`, su watcher, comandos y documentación se conserva como legado manual opcional. Usarla solo cuando el usuario lo solicite expresamente para una tarea histórica, recuperación o diagnóstico. No migrar, aprobar, ejecutar ni alterar tareas existentes por defecto.

La evidencia visual del desarrollo directo no requiere manifest ni API coordinadora. Cuando un cambio visible lo amerite, comprobar la interfaz con capturas o inspección local sanitizada y proporcional, sin incluir datos sensibles.

## Entrega breve

Usar por defecto: **Cambios**, **Archivos**, **Validación**, **Riesgos o pendientes**. Agregar análisis/plan solo si el riesgo o alcance lo justifican.

Derivar a Arquitectura cuando cambien límites de dominio, ownership, orden global de inicialización, infraestructura, responsabilidades de archivos compartidos o performance transversal.
