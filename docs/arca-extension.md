# Asistente local de Facturación ARCA

Consulta técnica y fiscal: 30 de julio de 2026.

La extensión completa únicamente datos preparados y validados por SunNutrition ERP. No emite
comprobantes, no obtiene CAE y no confirma, firma ni presenta información fiscal.

## Instalación en Chrome o Edge

1. Abrir `chrome://extensions` o `edge://extensions`.
2. Activar **Modo de desarrollador**.
3. Elegir **Cargar extensión sin empaquetar** y seleccionar `tools/arca-extension`.
4. Copiar el identificador de 32 caracteres mostrado por el navegador.
5. En ERP > Ventas > Facturación ARCA, pegar ese identificador y usar **Verificar extensión**.

La instalación es manual. No se distribuye ni actualiza automáticamente. La versión `1.1.6`
negocia el contrato fiscal `4` con el ERP antes de preparar o abrir una sesión; después de modificar
o actualizar estos archivos hay que presionar **Recargar** en `chrome://extensions`.
Si la extensión informa que el ERP preparó un contrato incompatible aunque la verificación sea
correcta, el proceso backend local sigue ejecutando una versión anterior: reiniciar el servidor,
recargar el ERP y preparar nuevamente. El rechazo limpia cualquier sesión efímera anterior.

## Permisos exactos

- `https://auth.afip.gob.ar/*`: mostrar el aviso de login manual. La extensión no lee ni modifica
  campos de clave, MFA, OTP o CAPTCHA.
- `https://fe.afip.gob.ar/*`: reconocer la selección de empresa y las pantallas actuales de
  Comprobantes en línea.
- `https://serviciosjava2.afip.gob.ar/*`: reconocer etapas de Comprobantes en línea y completar
  campos no secretos.
- `http://127.0.0.1/*` en `externally_connectable`: habilitación declarativa de Chrome/Edge. El
  service worker aplica además una verificación estricta de origen y acepta exclusivamente
  `http://127.0.0.1:3000`.
- `storage`: usa exclusivamente `chrome.storage.session`, memoria efímera privada de la extensión,
  para conservar el pedido preparado si Chrome suspende y reinicia el service worker durante el
  login manual. No usa `storage.local` ni `storage.sync`, y el content script no accede directamente
  a ese almacenamiento.
- `alarms`: agenda únicamente el vencimiento de la sesión preparada para que el service worker
  descarte el payload a los cinco minutos incluso si no hay polling, navegación ni mensajes.

No solicita `cookies`, `webRequest`, historial, descargas, certificados ni acceso a otros sitios.
El payload vive solamente en memoria de sesión del navegador: sobrevive a la suspensión normal del
service worker, pero se elimina al desactivar, recargar o actualizar la extensión y al reiniciar el
navegador.

Cada preparación se vuelve a validar contra el backend justo antes de abrir ARCA, incluye una
revisión SHA-256 del snapshot y vence a los cinco minutos. Cambiar de pedido, filtrar, paginar,
salir de la solapa o cerrar/recargar el ERP cancela la sesión. El service worker y el content script
también descartan el payload por TTL aunque el ERP deje de responder.

El seguimiento visible distingue: espera de login manual, validación y selección automática de
`SUNNUTRITION S.A.` por coincidencia exacta y única con el nombre legal visible (ARCA no muestra
el CUIT en esa pantalla), apertura exacta de Generar comprobantes,
etapa intermedia que se está completando, revisión final o interrupción concreta. Cada mensaje interno se correlaciona
con la pestaña creada para el pedido; otro pedido, pestaña, host o frame no recibe el payload.

El flujo intermedio usa únicamente coincidencias únicas y exactas: punto de venta `00001`,
Factura A o B, fecha preparada, concepto Productos, actividad Elaboración de alimentos o bases de
cereales, condición de venta Cheque, código 4, descripción Barra Pop y unidad Unidades. Factura A
deriva IVA Responsable Inscripto y Factura B deriva IVA Sujeto Exento. La clasificación comercial
del cliente no participa de la condición frente al IVA. Todas las líneas usan IVA 21%. La extensión
selecciona primero el punto de venta y espera que ARCA cargue sus comprobantes dependientes; luego
acepta Factura A o Factura B exclusivamente por el texto visible. La extensión puede accionar únicamente la opción inicial
Generar comprobantes y los botones Continuar de las etapas reconocidas.

La pantalla inicial también admite el HTML legado observado en ARCA, donde los textos de ambos
campos están en celdas de tabla y no en elementos `label`. Para operar exige conjuntamente el
título completo de esa pantalla, una única fila para cada texto exacto y un único `select` por fila;
la carga asincrónica del segundo selector se reevalúa al incorporarse sus opciones.

El paso **Datos de emisión (paso 1 de 4)** exige el path
`/rcel/jsp/genComDatosEmisor.do`, un único `datosEmisorForm` POST con action
`/rcel/jsp/genComDatosReceptor.do` y los IDs/names exportados por el DOM real. Aplica en `#fc` la
fecha preparada por el ERP en formato `dd/mm/aaaa`, selecciona `#idconcepto` por value `1` y texto
normalizado `Productos`, exige `#monedaextranjera` desmarcada, selecciona `#actiAsociadaId` por el
value único `106131` y deja `#refComEmisor` vacío. No toca moneda, tipo de cambio ni cancelación en
moneda extranjera. Solo tras reverificar los cinco estados acciona una vez el único
`input[type="button"]` con value exacto `Continuar >` dentro del formulario; ante path/action,
controles, opciones o valores inesperados se detiene con el selector técnico concreto.

El paso **Datos del receptor (paso 2 de 4)** exige el path
`/rcel/jsp/genComDatosReceptor.do`, el título `RCEL` y un único
`form#formulario[name="datosReceptorForm"]` POST con action
`/rcel/jsp/genComDatosOperacion.do`. Selecciona la condición fiscal canónica del payload: para
Factura A exige conjuntamente texto `IVA Responsable Inscripto` y value `1`; para Factura B acepta
`IVA Sujeto Exento` solo cuando ARCA expone una única opción con ese texto, sin adivinar su value.
Normaliza el CUIT a once dígitos, dispara sus eventos de edición y espera hasta cinco segundos a que
ARCA complete la razón social read-only y un único domicilio seleccionado. No escribe razón social,
domicilio ni email. Marca exclusivamente `Cheque`, mantiene compradores múltiples en `N`, exige
vacíos los campos de comprobantes asociados y conserva datos adicionales en `0`. Tras reverificar
todo, acciona una vez el único `input[type="button"]` con value exacto `Continuar >` dentro del
formulario. Nunca pulsa `Agregar`, `+`, `-`, `< Volver` ni `Menú Principal`.

## Invariante de no emisión

- El contrato exige `mode: "review_only"` y `finalSubmissionAllowed: false`.
- No existe un comando externo genérico de click, submit o ejecución de JavaScript.
- La extensión sólo despacha navegación intermedia para una coincidencia única esperada en la etapa
  reconocida. No llama `click()`, `submit()` ni `requestSubmit()`.
- Las acciones con textos Confirmar, Emitir, Generar, Obtener CAE, Firmar o Presentar se consideran
  finales. Los eventos sintéticos sobre esos controles se bloquean, salvo la coincidencia exacta
  `Generar comprobantes` dentro del menú inicial reconocido.
- Al reconocer la revisión final, descarta el payload salvo el ID del pedido y reporta
  `review_reached`.
- Si falta un selector, vence la sesión o la pantalla no es inequívoca, reporta una interrupción y
  no continúa por aproximación.

Los botones manuales de ARCA permanecen bajo control del usuario. Antes de emitir, el usuario debe
revisar importes, destinatario, punto de venta, tipo y fecha.

## Riesgos y mantenimiento

ARCA puede cambiar textos, selectores o pasos sin aviso. En ese caso la extensión abortará y deberá
actualizarse contra una pantalla oficial verificada, usando datos ficticios y sin emitir. No se debe
ampliar el permiso a sitios no oficiales ni reemplazar los selectores estrictos por aproximaciones.
Si la primera pantalla posterior a elegir SunNutrition no se reconoce, registrar únicamente su URL
y una captura sin CUIT, razón social, importes ni otros datos sensibles.

La extensión no corrige datos maestros del ERP y alcanzar la revisión no marca el pedido como
facturado. La venta se registra únicamente mediante el flujo existente de lectura/importación de la
factura ya emitida.

## Propiedad y consumidores

- Ventas es propietario de la elegibilidad, revisión local y estados del pedido.
- Contabilidad fiscal es propietaria de las reglas A/B/C, IVA y totales compartidos en
  `shared/order-pricing.js`.
- Arquitectura es propietaria del contrato `review_only`, permisos, TTL y puente local.
- Reportes consume únicamente `individualUnits`; la extensión no consume ni modifica reportes,
  ventas persistidas ni documentos leídos.

## Desinstalación

En `chrome://extensions` o `edge://extensions`, localizar **SunNutrition - Asistente ARCA** y elegir
**Quitar**. La extensión no deja credenciales, cookies ni datos persistidos. El historial no sensible
del ERP queda en `tmp/arca-invoicing-audit.jsonl` y puede conservarse para auditoría operativa.

## Fuentes oficiales

- https://arca.gob.ar/fe/
- https://www.arca.gob.ar/fe/ayuda/tutoriales.asp
- https://serviciosweb.afip.gob.ar/genericos/guiasPasoPaso/VerGuia.aspx?id=163
- https://www.arca.gob.ar/facturacion/regimen-general/comprobantes.asp
- https://www.arca.gob.ar/facturacion/comprobantes/emision.asp
- https://www.arca.gob.ar/fe/ayuda/tablas.asp
- https://arca.gob.ar/iva/documentos/Libro-IVA-Digital-Tablas-del-Sistema.pdf
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/reference/api/storage
