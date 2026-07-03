# AGENTS.md — Reglas permanentes del proyecto ERP

## Objetivo general

Este proyecto debe mantenerse simple, liviano, rápido, ordenado y fácil de entender.  
Cada cambio debe mejorar la aplicación sin acumular código innecesario.

---

## 1. Limpieza obligatoria después de cada cambio

Después de cada modificación, revisar y eliminar:

- Código muerto.
- Imports no utilizados.
- Variables no utilizadas.
- Funciones no utilizadas.
- Componentes que ya no se usan.
- Archivos reemplazados por versiones nuevas.
- CSS huérfano o duplicado.
- Dependencias innecesarias del `package.json`.
- Comentarios viejos que ya no describen el comportamiento real.

Nunca dejar código comentado “por si sirve después”.  
Si no se usa, se elimina.

---

## 2. No duplicar lógica

Antes de crear una nueva función, componente o archivo, revisar si ya existe algo similar.

Si existe:
- reutilizarlo,
- extenderlo,
- o refactorizarlo.

Evitar tener dos formas distintas de resolver el mismo problema.

---

## 3. Documentación clara del código

El código debe poder entenderse meses después.

Agregar comentarios útiles en:

- Archivos principales.
- Funciones importantes.
- Cálculos financieros.
- Transformaciones de datos.
- Lógica de filtros, agrupaciones y reportes.
- Decisiones que no sean evidentes.

Los comentarios deben explicar principalmente el “por qué”, no solo el “qué”.

No comentar cosas obvias.

---

## 4. Nombres descriptivos

Usar nombres claros para:

- variables,
- funciones,
- componentes,
- archivos,
- clases CSS,
- estructuras de datos.

Evitar nombres genéricos como:

- `data`
- `item`
- `temp`
- `x`
- `result`

Salvo que el contexto sea muy evidente.

---

## 5. Mantener la app liviana

Evitar cargar datos innecesarios en memoria.

No recalcular información si puede reutilizarse.

No renderizar tablas completas si no hace falta.

Evitar funciones que recorran grandes listas muchas veces sin necesidad.

Si se trabaja con ventas, egresos o inventarios grandes, priorizar:

- filtros eficientes,
- cálculos centralizados,
- reutilización de resultados,
- separación entre datos crudos y datos procesados.

---

## 6. Separación de responsabilidades

Mantener separado:

- carga de datos,
- limpieza de datos,
- cálculos,
- presentación visual,
- estilos,
- configuración.

No mezclar lógica financiera compleja directamente dentro del HTML o del render visual.

---

## 7. Estructura modular

Cada archivo debe tener una responsabilidad clara.

Si un archivo crece demasiado, dividirlo en partes más chicas.

Evitar archivos gigantes que mezclen muchas funciones distintas.

---

## 8. Reglas para cálculos financieros

Los cálculos del ERP deben ser claros y verificables.

Para estado de resultados, ventas, egresos, IVA, subtotales, retenciones, costos e inventarios:

- usar funciones específicas,
- documentar la fórmula,
- evitar cálculos duplicados,
- centralizar criterios contables,
- no cambiar fórmulas existentes sin avisar.

Si hay duda sobre un criterio contable, consultarlo antes de implementarlo.

---

## 9. No romper funcionalidades existentes

Antes de modificar una parte del sistema, revisar qué depende de ella.

No eliminar ni cambiar una función si puede afectar otra pantalla o cálculo.

Si una modificación puede tener impacto en otras partes, explicarlo antes.

---

## 10. Estilo visual consistente

Mantener el mismo criterio visual en toda la app:

- títulos,
- botones,
- tablas,
- colores,
- espaciados,
- tarjetas,
- filtros,
- desplegables.

No crear estilos nuevos si ya existe uno reutilizable.

---

## 11. Código simple antes que sofisticado

Preferir soluciones simples y legibles.

No agregar librerías, frameworks o abstracciones complejas si se puede resolver con código claro.

Evitar sobreingeniería.

---

## 12. Control de errores

Toda carga de datos debe manejar errores de forma clara.

Si falta un dato, una columna o un archivo, mostrar un mensaje entendible.

Evitar errores silenciosos.

---

## 13. Validaciones

Validar especialmente:

- fechas,
- montos,
- categorías,
- proveedores,
- tipos de factura,
- valores vacíos,
- datos importados desde Google Sheets o Excel.

No asumir que los datos siempre vienen perfectos.

---

## 14. Performance

Antes de finalizar cada tarea, revisar si el cambio puede volver lenta la app.

Evitar:

- bucles innecesarios,
- listeners duplicados,
- timers sin limpiar,
- renderizados repetidos,
- cálculos pesados en cada interacción,
- guardar grandes objetos duplicados en memoria.

---

## 15. Explicación final de cada cambio

Al terminar cada tarea, informar brevemente:

- qué archivos se modificaron,
- qué se agregó,
- qué se eliminó,
- qué lógica cambió,
- si se limpió código muerto,
- si queda algo pendiente o riesgoso.

---

## 16. Regla de seguridad para eliminar

Si algo parece no usarse pero hay duda, no eliminarlo directamente.

Primero marcarlo y explicar:

- qué parece obsoleto,
- por qué podría eliminarse,
- qué riesgo habría al borrarlo.

---

## 17. Prioridad del proyecto

La prioridad siempre es:

1. Que los cálculos sean correctos.
2. Que la app sea rápida.
3. Que el código sea entendible.
4. Que no haya código muerto.
5. Que el diseño sea claro y consistente.