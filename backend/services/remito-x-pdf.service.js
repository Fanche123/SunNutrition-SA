const crypto = require("crypto");

const { expectedOrderSubtotal } = require("./sales-invoice-entry.service");

const TEMPLATE_SHA256 = "985aad0c288b0449afb7b2ffab9ae764a0001ea6fd3cc50f7c10d0c62294fdf7";
const TEMPLATE_OBJECTS = Object.freeze({
  size: 24,
  root: 1,
  info: 23,
  pages: 3,
  page: 4,
  contents: 5,
  fonts: [7, 12, 17]
});
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const LINES_PER_PAGE = 13;

function normalizeReceiptType(value) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const invoice = normalized.match(/^factura_?([ab])$/);
  if (invoice) return `Factura_${invoice[1].toUpperCase()}`;
  return normalized === "remito_x" || normalized === "remitox" ? "Remito_X" : "";
}

function buildRemitoXData(cache, orderId, backendId) {
  const tables = cache?.tables || {};
  const normalizedOrderId = backendId(orderId);
  const order = (tables.pedidos?.rows || [])
    .find((row) => backendId(row.id_pedido) === normalizedOrderId);
  if (!order) throw remitoError(404, "El pedido ya no existe.");

  const client = (tables.clientes?.rows || [])
    .find((row) => backendId(row.id_cliente) === backendId(order.id_cliente));
  if (!client) throw remitoError(422, "El pedido no tiene un cliente válido asociado.");
  if (normalizeReceiptType(client.tipo_comprobante) !== "Remito_X") {
    throw remitoError(409, "El cliente del pedido no está configurado para Remito X.");
  }

  const productsById = new Map((tables.productos?.rows || [])
    .map((row) => [backendId(row.id_producto), row]));
  const details = (tables.detalle_pedidos?.rows || [])
    .filter((row) => backendId(row.id_pedido) === normalizedOrderId)
    .map((detail) => {
      const productId = backendId(detail.id_producto);
      const product = productsById.get(productId) || {};
      return {
        id_producto: productId,
        producto: product.nombre_producto || "",
        cantidad_cajas: detail.cantidad_cajas,
        unidades_por_caja: product.cantidad_individual,
        precio_unitario: detail.precio_ud,
        bonificacion: detail.bonificacion
      };
    });
  const pricing = expectedOrderSubtotal(details);
  const missing = [];
  const clientName = requiredText(client.nombre_cliente, "nombre del cliente", missing);
  const address = requiredText(client.direccion, "domicilio del cliente", missing);
  const locality = requiredText(client.localidad, "localidad del cliente", missing);
  const deliveryDate = validIsoDate(order.fecha_entrega) ? order.fecha_entrega : "";
  if (!deliveryDate) missing.push("fecha de entrega prevista del pedido");
  const cuit = formatCuit(client.cuit || client.CUIT);
  if (!details.length) missing.push("detalle del pedido");
  details.forEach((detail, index) => {
    if (!detail.id_producto) missing.push(`código del producto en la línea ${index + 1}`);
    if (!String(detail.producto || "").trim()) missing.push(`nombre del producto en la línea ${index + 1}`);
  });
  if (pricing.estado !== "calculable") {
    (pricing.campos_faltantes || []).forEach((field) => missing.push(`${field} en el detalle del pedido`));
  }
  if (missing.length) {
    throw remitoError(422, `No se puede generar el Remito X. Falta: ${[...new Set(missing)].join(", ")}.`);
  }

  const lines = pricing.lineas.map((line, index) => ({
    code: String(details[index].id_producto),
    description: String(details[index].producto),
    boxes: line.cantidad_cajas,
    total: line.subtotal_esperado
  }));
  return {
    orderId: String(normalizedOrderId),
    remitoNumber: String(normalizedOrderId).padStart(5, "0"),
    date: deliveryDate,
    clientName,
    address,
    locality,
    cuit,
    lines,
    totalBoxes: lines.reduce((total, line) => total + Number(line.boxes), 0),
    total: pricing.subtotal_esperado
  };
}

function generateRemitoXPdf(templateBuffer, data) {
  assertTemplate(templateBuffer);
  const pages = chunk(data.lines, LINES_PER_PAGE);
  const pageCount = pages.length || 1;
  let nextObject = TEMPLATE_OBJECTS.size;
  const regularFont = nextObject++;
  const boldFont = nextObject++;
  const overlayObjects = Array.from({ length: pageCount }, () => nextObject++);
  const resourcesObject = nextObject++;
  const extraPageObjects = Array.from({ length: Math.max(0, pageCount - 1) }, () => nextObject++);
  const objects = new Map();

  objects.set(regularFont, pdfObject(regularFont,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
  objects.set(boldFont, pdfObject(boldFont,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));
  pages.forEach((lines, index) => {
    const stream = overlayForPage(data, lines, index, pageCount);
    objects.set(overlayObjects[index], pdfStreamObject(overlayObjects[index], stream));
  });

  const fonts = TEMPLATE_OBJECTS.fonts.map((id, index) => `/Font${index} ${id} 0 R`).join(" ");
  objects.set(resourcesObject, pdfObject(resourcesObject,
    `<< /Font << ${fonts} /RemitoRegular ${regularFont} 0 R /RemitoBold ${boldFont} 0 R >> `
    + "/Pattern << >> /XObject << >> /ExtGState << >> /ProcSet [/PDF /Text /ImageB /ImageC /ImageI] >>"));

  const pageIds = [TEMPLATE_OBJECTS.page, ...extraPageObjects];
  objects.set(TEMPLATE_OBJECTS.pages, pdfObject(TEMPLATE_OBJECTS.pages,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`));
  pageIds.forEach((pageId, index) => {
    objects.set(pageId, pdfObject(pageId,
      `<< /Type /Page /Parent ${TEMPLATE_OBJECTS.pages} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
      + `/Contents [${TEMPLATE_OBJECTS.contents} 0 R ${overlayObjects[index]} 0 R] /Resources ${resourcesObject} 0 R `
      + "/Group << /S /Transparency /CS /DeviceRGB >> >>"));
  });

  return appendIncrementalUpdate(templateBuffer, objects, nextObject);
}

function remitoXFileName(data) {
  const client = String(data.clientName || "cliente")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 70) || "cliente";
  return `Remito_X_Pedido_${String(data.orderId)}_${client}.pdf`;
}

function overlayForPage(data, lines, pageIndex, pageCount) {
  const commands = ["q", "0 g"];
  const [year, month, day] = data.date.split("-");
  drawLeft(commands, data.remitoNumber, 476.5, 788.2, 10, true, 112);
  drawCentered(commands, String(Number(day)), 408.1, 744.5, 46.1, 28, 10, true);
  drawCentered(commands, String(Number(month)), 455.3, 744.5, 42.0, 28, 10, true);
  drawCentered(commands, year, 498.9, 744.5, 42.2, 28, 10, true);
  drawLeft(commands, data.clientName, 78.2, 637.5, 10, true, 287);
  drawLeft(commands, data.address, 78.2, 616.4, 10, false, 287);
  drawLeft(commands, data.locality, 476.7, 616.4, 10, false, 112);
  if (data.cuit) drawCentered(commands, data.cuit, 368.2, 544.0, 222.8, 55, 9, false);

  lines.forEach((line, index) => {
    const baseline = 480.7 - (index * 21.76);
    drawCentered(commands, line.code, 4.2, baseline - 7, 70.4, 20, 9, true);
    drawProductDescription(commands, line.description, 77.2, baseline, 168.6);
    drawCentered(commands, formatQuantity(line.boxes), 248.2, baseline - 7, 64.6, 20, 9, true);
    drawRight(commands, formatCurrency(line.total), 499.2, baseline, 91.2, 9, true);
  });

  if (pageIndex === pageCount - 1) {
    drawCentered(commands, formatQuantity(data.totalBoxes), 248.2, 192.9, 64.6, 20, 9, true);
    drawRight(commands, formatCurrency(data.total), 499.2, 199.2, 91.2, 9, true);
  }
  if (pageCount > 1) {
    drawRight(commands, `Página ${pageIndex + 1}/${pageCount}`, 499.2, 181.0, 91.2, 6.5, false);
  }
  commands.push("Q");
  return Buffer.from(commands.join("\n"), "latin1");
}

function drawProductDescription(commands, value, x, baseline, width) {
  const text = cleanPdfText(value);
  const preferred = 9;
  if (textWidth(text, preferred, true) <= width) {
    drawCentered(commands, text, x, baseline - 7, width, 20, preferred, true);
    return;
  }
  const singleSize = fitFontSize(text, width, preferred, 6);
  if (singleSize >= 6) {
    drawCentered(commands, text, x, baseline - 7, width, 20, singleSize, true);
    return;
  }
  const wrapped = wrapTextExact(text, width, 6.2, true, 2);
  if (!wrapped) throw remitoError(422, `El producto "${text}" es demasiado largo para el modelo de Remito X.`);
  drawCentered(commands, wrapped[0], x, baseline + 2.0, width, 8, 6.2, true);
  drawCentered(commands, wrapped[1], x, baseline - 6.0, width, 8, 6.2, true);
}

function drawLeft(commands, value, x, y, preferredSize, bold, width) {
  const text = cleanPdfText(value);
  const size = fitFontSize(text, width, preferredSize, 5.5);
  if (size < 5.5) throw remitoError(422, `El texto "${text}" es demasiado largo para el modelo de Remito X.`);
  drawText(commands, text, x, y, size, bold);
}

function drawCentered(commands, value, x, y, width, height, preferredSize, bold) {
  const text = cleanPdfText(value);
  const size = fitFontSize(text, width - 4, preferredSize, 5.5);
  if (size < 5.5) throw remitoError(422, `El texto "${text}" es demasiado largo para el modelo de Remito X.`);
  const textX = x + Math.max(2, (width - textWidth(text, size, bold)) / 2);
  const textY = y + Math.max(1, (height - size) / 2) - 1;
  drawText(commands, text, textX, textY, size, bold);
}

function drawRight(commands, value, x, y, width, preferredSize, bold) {
  const text = cleanPdfText(value);
  const size = fitFontSize(text, width - 5, preferredSize, 5.5);
  if (size < 5.5) throw remitoError(422, `El texto "${text}" es demasiado largo para el modelo de Remito X.`);
  drawText(commands, text, x + width - textWidth(text, size, bold) - 3, y, size, bold);
}

function drawText(commands, text, x, y, size, bold) {
  commands.push(
    "BT",
    `/${bold ? "RemitoBold" : "RemitoRegular"} ${decimal(size)} Tf`,
    `1 0 0 1 ${decimal(x)} ${decimal(y)} Tm`,
    `(${pdfLiteral(text)}) Tj`,
    "ET"
  );
}

function appendIncrementalUpdate(templateBuffer, objects, size) {
  const templateText = templateBuffer.toString("latin1");
  const startMatch = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(templateText);
  if (!startMatch) throw remitoError(500, "La plantilla de Remito X no tiene una tabla PDF válida.");
  const prefix = templateText.endsWith("\n") ? Buffer.alloc(0) : Buffer.from("\n", "ascii");
  const ordered = [...objects.entries()].sort(([left], [right]) => left - right);
  const objectBuffers = [];
  const offsets = new Map();
  let offset = templateBuffer.length + prefix.length;
  ordered.forEach(([id, buffer]) => {
    offsets.set(id, offset);
    objectBuffers.push(buffer);
    offset += buffer.length;
  });
  const xrefOffset = offset;
  const xref = ["xref", "0 1", "0000000000 65535 f "];
  contiguousGroups(ordered.map(([id]) => id)).forEach((group) => {
    xref.push(`${group[0]} ${group.length}`);
    group.forEach((id) => xref.push(`${String(offsets.get(id)).padStart(10, "0")} 00000 n `));
  });
  xref.push(
    "trailer",
    `<< /Size ${size} /Root ${TEMPLATE_OBJECTS.root} 0 R /Info ${TEMPLATE_OBJECTS.info} 0 R /Prev ${startMatch[1]} >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    ""
  );
  return Buffer.concat([templateBuffer, prefix, ...objectBuffers, Buffer.from(xref.join("\n"), "ascii")]);
}

function pdfObject(id, body) {
  return Buffer.from(`${id} 0 obj\n${body}\nendobj\n`, "ascii");
}

function pdfStreamObject(id, stream) {
  return Buffer.concat([
    Buffer.from(`${id} 0 obj\n<< /Length ${stream.length} >>\nstream\n`, "ascii"),
    stream,
    Buffer.from("\nendstream\nendobj\n", "ascii")
  ]);
}

function assertTemplate(templateBuffer) {
  if (!Buffer.isBuffer(templateBuffer)) throw remitoError(500, "No se pudo leer la plantilla de Remito X.");
  const hash = crypto.createHash("sha256").update(templateBuffer).digest("hex");
  if (hash !== TEMPLATE_SHA256) throw remitoError(500, "La plantilla de Remito X no coincide con la versión validada.");
}

function formatCuit(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}` : "";
}

function formatQuantity(value) {
  return Number(value).toLocaleString("es-AR", { maximumFractionDigits: 2 });
}

function formatCurrency(value) {
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cleanPdfText(value) {
  const text = String(value ?? "")
    .normalize("NFC")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, " ")
    .replace(/[\r\n\t]+/g, " ");
  if ([...text].some((character) => character.codePointAt(0) > 255)) {
    throw remitoError(422, `El texto "${text}" contiene caracteres incompatibles con el modelo de Remito X.`);
  }
  return text;
}

function pdfLiteral(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function fitFontSize(text, width, preferred, minimum) {
  const unitWidth = textWidth(text, 1, false);
  if (!unitWidth) return preferred;
  const size = Math.min(preferred, width / unitWidth);
  return size >= minimum ? Math.floor(size * 10) / 10 : size;
}

function textWidth(text, size, bold = false) {
  const units = [...text].reduce((total, character) => {
    if (character === " ") return total + 0.278;
    if (/[ilI.,'!:;|]/.test(character)) return total + 0.278;
    if (/[MW@%&]/.test(character)) return total + 0.86;
    if (/[A-ZÁÉÍÓÚÜÑ]/.test(character)) return total + 0.667;
    if (/[0-9_]/.test(character)) return total + 0.556;
    return total + 0.52;
  }, 0);
  return units * size * (bold ? 1.03 : 1);
}

function wrapTextExact(text, width, size, bold, maxLines) {
  const lines = [];
  let remaining = text;
  while (remaining && lines.length < maxLines) {
    let end = 1;
    while (end <= remaining.length && textWidth(remaining.slice(0, end), size, bold) <= width) end += 1;
    if (end > remaining.length) {
      lines.push(remaining);
      remaining = "";
      break;
    }
    let split = end - 1;
    for (let index = split - 1; index > Math.floor(split * 0.55); index -= 1) {
      if (/[ _-]/.test(remaining[index])) {
        split = index + 1;
        break;
      }
    }
    lines.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  return !remaining && lines.length <= maxLines ? lines : null;
}

function contiguousGroups(ids) {
  return ids.reduce((groups, id) => {
    const current = groups.at(-1);
    if (!current || id !== current.at(-1) + 1) groups.push([id]);
    else current.push(id);
    return groups;
  }, []);
}

function chunk(values, size) {
  if (!values.length) return [[]];
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

function validIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function requiredText(value, label, missing) {
  const text = String(value || "").trim();
  if (!text) missing.push(label);
  return text;
}

function decimal(value) {
  return Number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function remitoError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  LINES_PER_PAGE,
  TEMPLATE_SHA256,
  buildRemitoXData,
  generateRemitoXPdf,
  normalizeReceiptType,
  remitoXFileName
};
