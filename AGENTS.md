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

No ejecutar automáticamente toda la suite, builds completos o auditorías generales para cambios pequeños.

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

El hilo principal creado inspecciona el contexto relevante, implementa lo solicitado, valida proporcionalmente y entrega el resultado. El Coordinador no crea subagentes, no ejecuta trabajo técnico y no recibe el informe. Las correcciones del mismo objetivo continúan en el hilo visible original.

Pedir confirmación adicional solo cuando exista una decisión contable, destructiva, de datos, contrato o seguridad realmente bloqueante. La infraestructura de coordinación anterior permanece disponible únicamente como legado manual opcional; no usarla salvo pedido explícito ni alterar sus tareas o estado existentes por defecto.

---

## 16. Consulta de progreso bajo demanda

El progreso de los hilos se consulta únicamente cuando el usuario lo solicita mediante la skill personal `$estimar-progreso-hilos`. El Coordinador entrega una fotografía inmediata y read-only basada en estado, turnos, timestamps y evidencia de fases; no envía mensajes ni altera los hilos analizados.

Las tareas y correcciones futuras no crean `monitor_progreso`, watchers, timers ni automations para estimar avance. Este cambio no modifica la obligación de crear exactamente un `validador_tarea` read-only al final de cada iteración técnica.
