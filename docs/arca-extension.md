# Asistente local de Facturación ARCA

Consulta técnica y fiscal: 31 de julio de 2026.

La extensión completa únicamente datos preparados y validados por SunNutrition ERP. No emite
comprobantes, no obtiene CAE y no confirma, firma ni presenta información fiscal.

## Instalación en Chrome o Edge

1. Abrir `chrome://extensions` o `edge://extensions`.
2. Activar **Modo de desarrollador**.
3. Elegir **Cargar extensión sin empaquetar** y seleccionar `tools/arca-extension`.
4. Copiar el identificador de 32 caracteres mostrado por el navegador.
5. En ERP > Ventas > Facturación ARCA, pegar ese identificador y usar **Verificar extensión**.

La instalación es manual. No se distribuye ni actualiza automáticamente. La versión `1.1.26`
negocia el contrato fiscal `5` con el ERP antes de preparar o abrir una sesión; después de modificar
o actualizar estos archivos hay que presionar **Recargar** en `chrome://extensions`.
Si la extensión informa que el ERP preparó un contrato incompatible aunque la verificación sea
correcta, el proceso backend local sigue ejecutando una versión anterior: reiniciar el servidor,
recargar el ERP y preparar nuevamente. El rechazo limpia cualquier sesión efímera anterior.

## Permisos exactos

En `https://auth.afip.gob.ar/*`, la versión `1.1.21` reconoce el login únicamente con HTTPS, host
exacto `auth.afip.gob.ar`, puerto estándar y path exacto `/contribuyente_/login.xhtml` (admite la
query o fragmento de la redirección canónica y un slash final). Además exige el título, formulario
POST, action y controles únicos esperados. Completa exclusivamente el CUIT autorizado
`20398041063` y pulsa **Siguiente** una vez. En la pantalla siguiente descifra la clave guardada
just-in-time, entrega destructivamente esa copia transitoria al content script, aplica el setter
nativo al único campo password validado,
despacha `input` y `change` y pulsa **Ingresar** exactamente una vez. Antes del clic final vuelve a
validar la sesión, la pantalla, el formulario, el action y el botón único. Nunca lee la clave desde
el DOM ni la devuelve al service worker.
Ante CAPTCHA visible, MFA, error, foco rechazado o contrato DOM inesperado se detiene. Un clic
sintético no reemplaza validaciones de seguridad adicionales. Después de **Ingresar**, la selección
de representación y todas las etapas posteriores conservan el flujo. No hay sondeo del campo ni
reintentos si ARCA permanece o rechaza el acceso.

- `https://auth.afip.gob.ar/*`: automatizar únicamente el CUIT autorizado, **Siguiente**, la carga
  de la clave descifrada transitoriamente en el único password validado y un único **Ingresar**. La extensión no lee
  el password del DOM ni modifica MFA, OTP o CAPTCHA.
- `https://fe.afip.gob.ar/*`: reconocer la selección de empresa y las pantallas actuales de
  Comprobantes en línea.
- `https://serviciosjava2.afip.gob.ar/*`: reconocer etapas de Comprobantes en línea y completar
  campos no secretos.
- `http://127.0.0.1/*` en `externally_connectable`: habilitación declarativa de Chrome/Edge. El
  service worker aplica además una verificación estricta de origen y acepta exclusivamente
  `http://127.0.0.1:3000`.
- `storage`: usa `chrome.storage.session` para el pedido preparado y `chrome.storage.local`
  exclusivamente para el registro AES-GCM (`ciphertext`, IV y metadatos de versión/CUIT). La
  `CryptoKey` no extraíble se guarda separada en IndexedDB del origen de la extensión. No usa
  `storage.sync`, y el content script no accede directamente a esos almacenamientos.
- `alarms`: agenda únicamente el vencimiento de la sesión preparada para que el service worker
  descarte el payload a los cinco minutos incluso si no hay polling, navegación ni mensajes.
- `clipboardWrite`: permite copiar desde el popup únicamente la traza circular sanitizada de la
  sesión. El portapapeles nunca recibe el payload fiscal, CUIT, revisión completa ni secretos.

No solicita `cookies`, `webRequest`, historial, descargas, certificados ni acceso a otros sitios.
El payload fiscal vive solamente en memoria de sesión del navegador: sobrevive a la suspensión
normal del service worker, pero se elimina al desactivar, recargar o actualizar la extensión y al
reiniciar el navegador. El vault cifrado es independiente y persiste hasta **Olvidar clave**,
desinstalar/limpiar los datos de la extensión o detectar corrupción.

## Clave ARCA cifrada persistente

1. En `chrome://extensions`, presionar **Recargar** en la extensión.
2. Abrir el ícono de **SunNutrition - Asistente ARCA**.
3. Escribir la clave en el campo enmascarado.
4. Presionar **Guardar cifrada** y verificar el estado **Clave cifrada guardada**.
5. Recién entonces iniciar el flujo desde **Ventas > Facturación ARCA**.

El service worker genera una clave AES-GCM de 256 bits no extraíble y la persiste como `CryptoKey`
en IndexedDB. Cada guardado usa un IV aleatorio nuevo y AAD con versión de formato y CUIT autorizado
`20398041063`; `chrome.storage.local` recibe sólo ciphertext autenticado, IV y esos metadatos. La
clave en texto plano no se guarda en storage, IndexedDB, archivos, cookies, logs, payloads del ERP,
estados ni errores. El popup nunca recupera la clave al campo ni muestra longitud, hash o prefijo.
**Olvidar clave** elimina tanto ciphertext como `CryptoKey`. Un tag inválido, metadatos inesperados,
corrupción o ausencia de la `CryptoKey` también limpia el vault y exige guardarla nuevamente.

Si el flujo vuelve a detenerse, abrir el mismo popup y pulsar **Copiar diagnóstico seguro** antes
de preparar otra sesión. El botón copia como JSON una traza circular de hasta 40 eventos. Cada
entrada contiene solamente `sequence`, timestamp, tipo de evento, host y una categoría cerrada de
ruta (`/login`, `/representative`, `/service`, `/erp`, `/popup` u `/other`), estado y etapa
antes/después, motivo de una lista cerrada, flags booleanos y resultado. Nunca conserva el
`pathname` recibido. No incluye payload,
CUIT, pedido, cliente, importes, contraseña, ciphertext, IV, `CryptoKey`, `sessionId` completo ni
revisión completa. Preparar, cancelar o expirar una sesión limpia la traza anterior.

En cada preparación, `sessionId`, `revision` y la `generation` devuelta por el service worker deben
coincidir en todas las autorizaciones internas y también en `CANCEL_SESSION`. El ERP conserva esa
generación junto con la preparación activa; una cancelación tardía de una generación anterior se
rechaza aunque coincidan sesión y revisión. El
service worker descifra sólo después de validar pestaña, frame, host, path, sesión, revisión y etapa;
la respuesta transitoria se limpia después de enviarla y el content script borra su referencia en
`finally`. Cancelar o vencer una preparación no borra el vault persistente.

Límite de seguridad: el cifrado protege la clave en reposo y evita guardarla junto a una clave
exportable, pero código que se ejecute con privilegios de esta misma extensión y perfil podría
solicitar el descifrado. No equivale al Administrador de contraseñas de Chrome ni al almacén de
credenciales del sistema.

Cada preparación se vuelve a validar contra el backend justo antes de abrir ARCA, incluye una
revisión SHA-256 del snapshot y vence a los cinco minutos. Cambiar de pedido, filtrar, paginar,
salir de la solapa o cerrar/recargar el ERP cancela la sesión. El service worker y el content script
también descartan el payload por TTL aunque el ERP deje de responder.

El seguimiento visible distingue: espera de login, validación y selección automática de
`SUNNUTRITION S.A.` únicamente en HTTPS `fe.afip.gob.ar`, path exacto
`/rcel/jsp/index_bis.jsp`, sin query/fragmento, título `RCEL` y prompt normalizado exacto aunque
contenga espacios, saltos o nodos anidados. Exige un único `form[name="seleccionaEmpresaForm"]`
sin id, método GET y action exacta `/rcel/jsp/setearContribuyente.do`, con el hidden único
`#idcontribuyente[name="idContribuyente"]` y exactamente dos `input[type="button"].btn_empresa`
habilitados: uno cuyo valor normalizado sea `DE MAYO BENJAMIN` y uno cuyo valor normalizado sea
`SUNNUTRITION S.A.`. La acción de cabecera `Salir` queda fuera del conjunto y nunca se considera
una empresa. Después de la autorización, la extensión vuelve a resolver todo el contrato en el DOM
vivo, exige la misma identidad de control y el valor normalizado exacto antes de un único clic.
Nunca acciona la opción personal y muestra el motivo específico de cualquier mismatch.
Luego continúa con la apertura exacta de Generar comprobantes,
etapa intermedia que se está completando, revisión final o interrupción concreta. Cada mensaje interno se correlaciona
con la pestaña creada para el pedido; otro pedido, pestaña, host o frame no recibe el payload.

Desde `1.1.26`, cada documento autorizado monta primero el estado visible `init_recovering` y recién
después recupera la preparación desde el service worker. La ausencia total de ese bloque en una
navegación nueva indica que el content script no fue cargado. Si el script cargó pero no puede
continuar, el bloque informa un código no sensible: `init_runtime_error`,
`init_response_missing`, `session_absent`, `session_terminal`, `session_replaced`,
`session_expired`, `session_rejected` o `init_exception`. Un contrato DOM inválido informa
`selector_changed` y una transición que el service worker no autoriza informa
`authorization_rejected`. Todos esos estados ejecutan cero acciones.

En el login, el banner y la recuperación comienzan en `document_start`, pero la evaluación del
contrato espera `DOMContentLoaded`, `body` y `documentElement`. Referencias repetidas al mismo
`form#F1[name="F1"]` se deduplican por identidad; dos formularios reales siguen bloqueados. El CUIT
se escribe con setter y eventos y, antes del único clic en **Siguiente**, se vuelve a exigir el mismo
formulario, campo y submit vivos.

El lifecycle persistido es una máquina de estados explícita. Una sola función reductora puede
producir nuevos valores de `status`, `stage`, flags de login o `payload`; cada evento declara los
estados de origen permitidos en una tabla. Todas las mutaciones pasan por una cola por `sessionId` y
una sección crítica de storage: dentro de ella se relee el registro actual, se valida correlación y
recién entonces se reduce y escribe. Cada preparación obtiene una `generation` persistida y cada
evento aceptado incrementa `sequence`. Un handler de una generación anterior se rechaza aunque
coincidan `sessionId` y revisión, por lo que nunca puede sobrescribir una preparación nueva.

`AUTHORIZE_LOGIN_ACTION` consume cada acción una sola vez sin terminar el workflow. La autorización
de **Ingresar** deja la sesión activa en `waiting_representative`, y `COMPLETE_LOGIN_ACTION` registra
el progreso del documento auth. El estado permanece en etapa `login` hasta que el sender exacto
`https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp` presenta el contrato DOM completo y reclama
`representative`. Ese claim valida pestaña, frame, sesión, revisión, generación, origen, path y
contrato DOM, completa `loginCompleted` si el callback del documento saliente aún no llegó y cambia
la etapa a `representative` atómicamente. Nunca elige `DE MAYO BENJAMIN`.

`selector_changed`, pantalla no reconocida, `MutationObserver`, `pagehide` y `unload` son
diagnósticos recuperables: detienen acciones en el documento inseguro, pero no cambian hacia atrás
el estado ni borran el payload. El content script no emite un `UPDATE_SESSION` terminal genérico.
Sólo pueden terminalizar una sesión activa y borrar el payload la cancelación externa explícita y
correlacionada, el reemplazo por una preparación nueva, un TTL/alarma ya vencido, un rechazo de
seguridad no recuperable autenticado para la etapa vigente y `review_reached`. Si falla la creación
o asociación inicial de la pestaña, la preparación todavía no activa se revierte y elimina sin
crear un estado terminal persistido.

El flujo intermedio usa únicamente coincidencias únicas y exactas: punto de venta `00001`,
Factura A o B, fecha preparada, concepto Productos, actividad Elaboración de alimentos o bases de
cereales, condición de venta Cheque y código 4. La descripción y unidad se derivan de cada línea
validada del pedido. Factura A
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

El paso **Datos de la operación (paso 3 de 4)** exige el path
`/rcel/jsp/genComDatosOperacion.do`, el título `RCEL` y un único
`form[name="datosOperacionForm"]` POST con action `/rcel/jsp/genComResumenDatos.do`. Completa
únicamente las filas superiores ya disponibles: nunca pulsa `Agregar línea descripción`,
`Agregar otro Tributo` ni los botones `X`. Si faltan filas para los productos preparados, se
detiene sin crear controles ni modificar tributos.
La fila de tributos que ARCA muestra de forma predeterminada permanece inactiva cuando conserva
`Seleccionar...` y sus campos editables están vacíos o contienen únicamente ceros automáticos;
los metadatos ocultos de esa fila no se interpretan como un tributo cargado. Una opción real o
cualquier contenido material en un campo editable detiene el flujo.
Cada fila usa código `4`; la descripción `{cantidad} {producto} - Entrega: {domicilio}` reemplaza
guiones bajos por espacios solo en el texto preparado. Los productos cuyo nombre normalizado
comienza con `Barra` usan `unidades` value `7` y cajas por unidades individuales de producto. El
producto exacto `Materia Prima pochoclo dulce` usa `kilogramos` value `1` y toma como kg la
cantidad persistida del detalle, que es la fuente histórica directa de esas ventas y admite
decimales; no multiplica por `cantidad_individual`. Cualquier otro producto queda bloqueado.
La selección de unidad exige simultáneamente value y texto para distinguir `unidades` del
placeholder que también usa value `7`. Conserva precio unitario y bonificación del pedido, exige
IVA `21%` value `5`, ambas precisiones en `2`, tributos vacíos y subtotales coherentes. Solo
después de reverificar form, filas y cálculos despacha una vez el único `Continuar >` del
formulario y se detiene al alcanzar el resumen.

## Invariante de no emisión

- El contrato exige `mode: "review_only"` y `finalSubmissionAllowed: false`.
- No existe un comando externo genérico de click, submit o ejecución de JavaScript.
- La extensión sólo despacha navegación intermedia para una coincidencia única esperada en la etapa
  reconocida. No llama `submit()` ni `requestSubmit()`; la única llamada directa a `click()` es la
  del campo de clave, después de validar el contrato y antes de aplicar el secreto efímero.
- Las acciones con textos Confirmar, Emitir, Generar, Obtener CAE, Firmar o Presentar se consideran
  finales. Los eventos sintéticos sobre esos controles se bloquean, salvo la coincidencia exacta
  `Generar comprobantes` dentro del menú inicial reconocido.
- Al reconocer la revisión final, descarta el payload salvo el ID del pedido y reporta
  `review_reached`.
- Si falta un selector o la pantalla no es inequívoca, reporta un diagnóstico recuperable y no
  continúa por aproximación; el payload permanece disponible para la navegación correlacionada.
  Sólo un TTL realmente vencido convierte esa situación en expiración terminal.

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
- Reportes consume únicamente sus contratos existentes; la extensión no consume ni modifica reportes,
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
