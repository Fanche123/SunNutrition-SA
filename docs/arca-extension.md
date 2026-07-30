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

La instalación es manual. No se distribuye ni actualiza automáticamente.

## Permisos exactos

- `https://auth.afip.gob.ar/*`: mostrar el aviso de login manual. La extensión no lee ni modifica
  campos de clave, MFA, OTP o CAPTCHA.
- `https://serviciosjava2.afip.gob.ar/*`: reconocer etapas de Comprobantes en línea y completar
  campos no secretos.
- `http://127.0.0.1/*` en `externally_connectable`: habilitación declarativa de Chrome/Edge. El
  service worker aplica además una verificación estricta de origen y acepta exclusivamente
  `http://127.0.0.1:3000`.
- `storage`: usa exclusivamente `chrome.storage.session`, memoria efímera privada de la extensión,
  para conservar el pedido preparado si Chrome suspende y reinicia el service worker durante el
  login manual. No usa `storage.local` ni `storage.sync`, y el content script no accede directamente
  a ese almacenamiento.

No solicita `cookies`, `webRequest`, historial, descargas, certificados ni acceso a otros sitios.
El payload vive solamente en memoria de sesión del navegador: sobrevive a la suspensión normal del
service worker, pero se elimina al desactivar, recargar o actualizar la extensión y al reiniciar el
navegador.

Cada preparación se vuelve a validar contra el backend justo antes de abrir ARCA, incluye una
revisión SHA-256 del snapshot y vence a los cinco minutos. Cambiar de pedido, filtrar, paginar,
salir de la solapa o cerrar/recargar el ERP cancela la sesión. El service worker y el content script
también descartan el payload por TTL aunque el ERP deje de responder.

El seguimiento visible distingue: espera de login manual, espera de selección manual de
SunNutrition, servicio Comprobantes en línea reconocido, etapa intermedia que se está completando,
campos completados, revisión final o interrupción concreta. Cada mensaje interno se correlaciona
con la pestaña creada para el pedido; otro pedido, pestaña, host o frame no recibe el payload.

## Invariante de no emisión

- El contrato exige `mode: "review_only"` y `finalSubmissionAllowed: false`.
- No existe un comando externo genérico de click, submit o ejecución de JavaScript.
- La extensión no hace click en botones, ni llama `submit()` o `requestSubmit()`.
- Las acciones con textos Confirmar, Emitir, Generar, Obtener CAE, Firmar o Presentar se consideran
  finales. Los eventos sintéticos sobre esos controles se bloquean.
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
