const {
  divideCents,
  fromCents,
  parseInput: parseMoneyInput
} = require("../../shared/money");

// Factura B de Ventas expresa el IVA dentro del total salvo evidencia fiscal explícita en contrario.
const SALES_FACTURA_B_DEFAULT_IVA = Object.freeze({
  percent: 21,
  grossDivisor: "1.21"
});

function createAttachmentsService({
  childProcess,
  fetchImpl = globalThis.fetch,
  fs,
  invoiceProviderHealthTimeoutMs = 5_000,
  invoiceReadTimeoutMs = 45_000,
  path,
  pythonExecutable,
  readJsonBody,
  rootDir,
  sendJson
}) {
  async function handleReceptionAttachmentSave(request, response) {
    try {
      const body = await readJsonBody(request);
      const receptionId = String(body.receptionId || "").trim();
      const fileName = sanitizeFileName(String(body.fileName || ""));
      const base64 = String(body.dataBase64 || "").trim();
      if (!receptionId || !fileName || !base64) {
        sendJson(response, 400, { ok: false, error: "Faltan datos del archivo de recepcion." });
        return;
      }
  
      const buffer = Buffer.from(base64, "base64");
      if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
        sendJson(response, 400, { ok: false, error: "El archivo de recepcion esta vacio o supera 20 MB." });
        return;
      }
  
      const attachmentDir = path.join(rootDir, "backend", "attachments", "recepciones");
      fs.mkdirSync(attachmentDir, { recursive: true });
      const storedName = `${sanitizeFileName(receptionId)}-${Date.now()}-${fileName}`;
      const storedPath = path.join(attachmentDir, storedName);
      fs.writeFileSync(storedPath, buffer);
      sendJson(response, 200, {
        ok: true,
        path: path.relative(rootDir, storedPath).replace(/\\/g, "/"),
        fileName
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
  }
  
  async function handleReceptionInvoiceRead(request, response) {
    return handleInvoiceRead(request, response, { normalizeSalesFacturaB: false });
  }

  async function handleSalesInvoiceRead(request, response) {
    return handleInvoiceRead(request, response, {
      normalizeSalesFacturaB: true,
      normalizeSalesRemitoX: true
    });
  }

  async function handleInvoiceRead(request, response, options) {
    try {
      const body = await readJsonBody(request);
      const fileDataUrl = String(body.fileDataUrl || body.imageDataUrl || "");
      const fileName = sanitizeFileName(body.fileName || "factura_remito");
      const mimeType = String(body.mimeType || dataUrlMimeType(fileDataUrl) || "").trim();
      const isImage = fileDataUrl.startsWith("data:image/");
      const isPdf = fileDataUrl.startsWith("data:application/pdf");
      if (!isImage && !isPdf) {
        sendInvoiceReadError(response, 400, "INVALID_FILE");
        return;
      }

      const fileBuffer = dataUrlBuffer(fileDataUrl);
      if (!fileBuffer.length || fileBuffer.length > 20 * 1024 * 1024 || (isPdf && !isPdfBuffer(fileBuffer))) {
        sendInvoiceReadError(response, 400, "INVALID_FILE");
        return;
      }
  
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        sendInvoiceReadError(response, 503, "SERVICE_NOT_CONFIGURED");
        return;
      }
  
      const extractedInvoice = isPdf
        ? await extractReceptionInvoiceFromPdf(apiKey, fileDataUrl, fileName, mimeType)
        : await extractReceptionInvoiceFromImage(apiKey, fileDataUrl);
      const pdfText = isPdf
        && options.normalizeSalesRemitoX
        && extractedInvoice?.tipo_factura === "Remito_X"
        ? tryExtractPdfText(fileDataUrl, fileName)
        : "";
      const { invoice, missingFields, reviewWarnings } = normalizeReceptionInvoice(
        extractedInvoice,
        { ...options, pdfText }
      );
      if (!Object.values(invoice).some((value) => (
        (typeof value === "string" && value !== "")
        || (typeof value === "number" && value > 0)
      ))) {
        throw invoiceReadError("UNREADABLE_RESPONSE");
      }
      sendJson(response, 200, { ok: true, invoice, missingFields, reviewWarnings });
    } catch (error) {
      const code = classifyInvoiceReadError(error);
      const status = code === "SERVICE_TIMEOUT"
        ? 504
        : code === "INVALID_FILE"
          ? 400
          : code === "SERVICE_NOT_CONFIGURED"
            ? 503
            : 502;
      sendInvoiceReadError(response, status, code, error?.invoiceReadDetails);
    }
  }

  async function handleInvoiceProviderHealth(_request, response) {
    try {
      const providerResponse = await fetchInvoiceProvider("https://api.openai.com/v1/models", {
        method: "HEAD"
      }, invoiceProviderHealthTimeoutMs);
      sendJson(response, 200, {
        ok: true,
        provider: "openai",
        connectivity: "reachable",
        providerStatus: providerResponse.status
      });
    } catch (error) {
      sendJson(response, 503, {
        ok: false,
        provider: "openai",
        connectivity: "unreachable",
        transportCode: String(error?.cause?.code || error?.code || "unknown").toLowerCase()
      });
    }
  }

  function sendInvoiceReadError(response, status, code, details) {
    const messages = {
      INVALID_FILE: "El archivo no es un PDF o imagen valido, esta vacio o supera 20 MB.",
      SERVICE_NOT_CONFIGURED: "El servicio de lectura automatica no esta configurado. Completa los datos manualmente o consulta al administrador.",
      PROVIDER_AUTHENTICATION: "La credencial del servicio de lectura no es valida o no tiene permiso. Consulta al administrador.",
      PROVIDER_QUOTA: "El servicio de lectura alcanzo su limite de uso. Intenta mas tarde o consulta al administrador.",
      PROVIDER_MODEL: "El modelo configurado no esta disponible para leer este archivo. Consulta al administrador.",
      PROVIDER_REQUEST: "El servicio rechazo la solicitud de lectura. Consulta al administrador o completa los datos manualmente.",
      SERVICE_TIMEOUT: "El servicio de lectura automatica demoro demasiado. Intenta nuevamente en unos minutos o completa los datos manualmente.",
      SERVICE_UNAVAILABLE: "El servicio de lectura automatica no esta disponible temporalmente. Intenta nuevamente en unos minutos o completa los datos manualmente.",
      UNREADABLE_RESPONSE: "El servicio respondio, pero no devolvio datos de factura legibles. Revisa el archivo o completa los datos manualmente."
    };
    const payload = {
      ok: false,
      code,
      error: messages[code] || messages.SERVICE_UNAVAILABLE
    };
    if (details) payload.details = details;
    sendJson(response, status, payload);
  }

  function invoiceReadError(code, cause, details) {
    const error = new Error(code);
    error.invoiceReadCode = code;
    if (cause) error.cause = cause;
    if (details) error.invoiceReadDetails = details;
    return error;
  }

  function classifyInvoiceReadError(error) {
    if (error?.invoiceReadCode) return error.invoiceReadCode;
    if (error?.name === "AbortError" || error?.cause?.code === "ABORT_ERR") return "SERVICE_TIMEOUT";
    if (error instanceof SyntaxError) return "UNREADABLE_RESPONSE";
    return "SERVICE_UNAVAILABLE";
  }

  function providerInvoiceReadError(response, payload) {
    const status = Number(response?.status) || 0;
    const type = String(payload?.error?.type || "").toLowerCase();
    const code = String(payload?.error?.code || "").toLowerCase();
    const param = String(payload?.error?.param || "").toLowerCase();
    const details = {
      stage: "provider_response",
      providerStatus: status,
      providerType: safeProviderMetadata(type),
      providerCode: safeProviderMetadata(code),
      providerParam: safeProviderMetadata(param)
    };
    if (status === 401 || status === 403 || type.includes("authentication") || code.includes("api_key")) {
      return invoiceReadError("PROVIDER_AUTHENTICATION", null, details);
    }
    if (status === 429 || type.includes("rate_limit") || code.includes("quota")) {
      return invoiceReadError("PROVIDER_QUOTA", null, details);
    }
    if (param === "model" || code.includes("model") || type.includes("model")) {
      return invoiceReadError("PROVIDER_MODEL", null, details);
    }
    if (status === 400 || status === 422) return invoiceReadError("PROVIDER_REQUEST", null, details);
    return invoiceReadError("SERVICE_UNAVAILABLE", null, details);
  }

  function safeProviderMetadata(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 80);
  }

  function dataUrlBuffer(dataUrl) {
    const separatorIndex = String(dataUrl).indexOf(",");
    if (separatorIndex < 0 || !/;base64$/i.test(String(dataUrl).slice(0, separatorIndex))) return Buffer.alloc(0);
    try {
      return Buffer.from(String(dataUrl).slice(separatorIndex + 1), "base64");
    } catch {
      return Buffer.alloc(0);
    }
  }

  function isPdfBuffer(buffer) {
    return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  }
  
  async function handlePayrollScaleRead(request, response) {
    try {
      const body = await readJsonBody(request);
      const fileDataUrl = String(body.fileDataUrl || "");
      const fileName = sanitizeFileName(body.fileName || "escala_salarial.pdf");
      const requestedPeriod = normalizePayrollPeriod(body.periodKey);
      if (!fileDataUrl.startsWith("data:application/pdf")) {
        sendJson(response, 400, { ok: false, error: "Adjunta un PDF valido de escala salarial." });
        return;
      }
  
      const text = extractPdfTextWithPython(fileDataUrl, fileName);
      const scale = parsePayrollScaleText(text, requestedPeriod);
      sendJson(response, 200, { ok: true, scale });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
  }
  
  function extractPdfTextWithPython(fileDataUrl, fileName) {
    const base64 = String(fileDataUrl).split(",")[1] || "";
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
      throw new Error("El PDF esta vacio o supera 20 MB.");
    }
  
    const tempDir = path.join(rootDir, "tmp", "uploads");
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${Date.now()}-${fileName}`);
    try {
      fs.writeFileSync(tempPath, buffer);
      const executable = fs.existsSync(pythonExecutable) ? pythonExecutable : "python";
      const script = [
        "import sys, pdfplumber",
        "sys.stdout.reconfigure(encoding='utf-8')",
        "path = sys.argv[1]",
        "parts = []",
        "with pdfplumber.open(path) as pdf:",
        "    for page in pdf.pages:",
        "        parts.append(page.extract_text() or '')",
        "print('\\n'.join(parts))"
      ].join("\n");
      const result = childProcess.spawnSync(executable, ["-c", script, tempPath], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      });
      if (result.status !== 0) {
        throw new Error((result.stderr || "No se pudo extraer texto del PDF.").trim());
      }
      return result.stdout || "";
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }

  function tryExtractPdfText(fileDataUrl, fileName) {
    try {
      return extractPdfTextWithPython(fileDataUrl, fileName);
    } catch {
      return "";
    }
  }
  
  function parsePayrollScaleText(text, requestedPeriod = "") {
    const categories = {};
    const detectedPeriods = detectPayrollPeriods(text);
    const periods = detectedPeriods.length ? detectedPeriods : requestedPeriod ? [requestedPeriod] : [];
    String(text || "").split(/\r?\n/).forEach((line) => {
      const cleanLine = line.replace(/\s+/g, " ").trim();
      if (!cleanLine || !/\$/.test(cleanLine)) return;
      const values = [...cleanLine.matchAll(/\$\s*([0-9.,\s]+)/g)]
        .map((match) => parsePayrollMoney(match[1]));
      if (!values.length) return;
      const name = cleanLine.split("$")[0].trim();
      if (!name || /PLANILLA|REMUNERATIVO|ADICIONALES|SUMA/i.test(name)) return;
      const normalized = normalizePayrollScaleKey(name);
      const isMonthly = values[0] > 100000;
      const valuesByPeriod = {};
      periods.forEach((periodKey, index) => {
        const valueIndex = Math.min(index * 2, Math.max(values.length - 2, 0));
        valuesByPeriod[periodKey] = {
          remunerative: values[valueIndex] || 0,
          nonRemunerative: values[valueIndex + 1] || 0
        };
      });
      categories[normalized] = {
        label: name,
        type: isMonthly ? "monthly" : "hourly",
        periods: valuesByPeriod
      };
    });
    return { categories, periods, periodSource: detectedPeriods.length ? "document" : requestedPeriod ? "selected" : "unknown" };
  }

  function detectPayrollPeriods(text) {
    const monthNumbers = {
      enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
      julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10",
      noviembre: "11", diciembre: "12"
    };
    const found = new Set();
    const normalizedText = String(text || "").toLowerCase()
      .replace(/[áéíóú]/g, (letter) => "aeiou"["áéíóú".indexOf(letter)]);
    normalizedText.replace(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(?:a|al|y|-)\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(?:de\s+)?(20\d{2})\b/g,
      (_, firstMonth, lastMonth, year) => {
        const first = Number(monthNumbers[firstMonth]);
        const last = Number(monthNumbers[lastMonth]);
        if (first <= last) {
          for (let month = first; month <= last; month += 1) {
            found.add(`${year}-${String(month).padStart(2, "0")}`);
          }
        }
        return _;
      });
    normalizedText
      .replace(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(?:de\s+)?(20\d{2})\b/g,
        (_, month, year) => {
          found.add(`${year}-${monthNumbers[month]}`);
          return _;
        });
    for (const match of String(text || "").matchAll(/\b(20\d{2})[-/](0[1-9]|1[0-2])\b/g)) {
      found.add(`${match[1]}-${match[2]}`);
    }
    return [...found].sort();
  }

  function normalizePayrollPeriod(value) {
    const match = String(value || "").trim().match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
    return match ? `${match[1]}-${match[2]}` : "";
  }
  
  function parsePayrollMoney(value) {
    const parsed = parseMoneyInput(value, { allowNegative: true });
    return parsed.ok && !parsed.empty ? parsed.amount : NaN;
  }
  
  function normalizePayrollScaleKey(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  
  function dataUrlMimeType(dataUrl) {
    const match = String(dataUrl || "").match(/^data:([^;,]+)[;,]/);
    return match ? match[1] : "";
  }
  
  function receptionInvoiceExtractionPrompt() {
    return `Lee esta factura o remito argentino y devolve SOLO JSON valido.
  Campos esperados:
  {
    "tipo_factura": "Factura_A|Factura_B|Factura_C|Remito_X",
    "nro_factura": "texto",
    "fecha_factura": "YYYY-MM-DD",
    "subtotal": numero,
    "iva": numero,
    "iva_alicuota": numero,
    "exento": numero,
    "no_gravado": numero,
    "tratamiento_iva": "texto",
    "per_ret_iva": numero,
    "per_ret_iibb": numero,
    "imp_internos": numero,
    "total": numero
  }
  Si un texto no aparece, usa string vacio. Si un importe no aparece, usa null.
  En Remito X, el encabezado puede mostrar N° 00001 - 01018: el primer bloque es el punto fijo de emision.
  Para nro_factura devuelve solo el correlativo ubicado a la derecha del guion (01018 en el ejemplo), nunca 00001.
  Conserva 0 solo cuando el comprobante muestre explicitamente ese importe. No inventes datos.`;
  }
  
  async function extractReceptionInvoiceFromImage(apiKey, imageDataUrl) {
    const response = await fetchInvoiceProvider("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: receptionInvoiceExtractionPrompt()
              },
              {
                type: "image_url",
                image_url: { url: imageDataUrl, detail: "high" }
              }
            ]
          }
        ]
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw providerInvoiceReadError(response, payload);
    const content = payload.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  }
  
  async function extractReceptionInvoiceFromPdf(apiKey, pdfDataUrl, fileName, mimeType) {
    const response = await fetchInvoiceProvider("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
        temperature: 0,
        text: { format: { type: "json_object" } },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: receptionInvoiceExtractionPrompt() },
              {
                type: "input_file",
                filename: fileName || `factura.${mimeType.includes("pdf") ? "pdf" : "bin"}`,
                file_data: pdfDataUrl
              }
            ]
          }
        ]
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw providerInvoiceReadError(response, payload);
    return JSON.parse(extractResponseText(payload) || "{}");
  }

  async function fetchInvoiceProvider(url, options = {}, timeoutMs = invoiceReadTimeoutMs) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternalSignal();
    else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const { signal: _externalSignal, ...fetchOptions } = options;
    try {
      return await fetchImpl(url, { ...fetchOptions, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw invoiceReadError("SERVICE_TIMEOUT", error);
      throw invoiceReadError("SERVICE_UNAVAILABLE", error, {
        stage: "provider_transport",
        transportCode: safeProviderMetadata(error?.cause?.code)
      });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    }
  }

  function normalizeReceptionInvoice(value, options = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invoiceReadError("UNREADABLE_RESPONSE");
    }
    const allowedTypes = new Set(["Factura_A", "Factura_B", "Factura_C", "Remito_X"]);
    const text = (input, maxLength = 120) => typeof input === "string" ? input.trim().slice(0, maxLength) : "";
    const isoDate = (input) => {
      const candidate = text(input, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return "";
      const date = new Date(`${candidate}T00:00:00Z`);
      const year = Number(candidate.slice(0, 4));
      return Number.isNaN(date.getTime())
        || date.toISOString().slice(0, 10) !== candidate
        || year < 2000
        ? ""
        : candidate;
    };
    const money = (input) => {
      const parsed = parseMoneyInput(input);
      return parsed.ok && !parsed.empty && parsed.amount >= 0 ? parsed.amount : null;
    };
    const invoice = {
      tipo_factura: allowedTypes.has(value.tipo_factura) ? value.tipo_factura : "",
      nro_factura: text(value.nro_factura),
      fecha_factura: isoDate(value.fecha_factura),
      subtotal: money(value.subtotal),
      iva: money(value.iva),
      per_ret_iva: money(value.per_ret_iva),
      per_ret_iibb: money(value.per_ret_iibb),
      imp_internos: money(value.imp_internos),
      total: money(value.total)
    };
    const reviewWarnings = [];
    if (options.normalizeSalesFacturaB) {
      normalizeSalesFacturaB(invoice, value, reviewWarnings);
    }
    if (options.normalizeSalesRemitoX) {
      normalizeSalesRemitoX(invoice, options.pdfText);
    }
    const missingFields = Object.entries(invoice)
      .filter(([, fieldValue]) => fieldValue === "" || fieldValue === null)
      .map(([field]) => field);
    return { invoice, missingFields, reviewWarnings };
  }

  function normalizeSalesRemitoX(invoice, pdfText = "") {
    if (invoice.tipo_factura !== "Remito_X") return;
    const correlative = remitoXNumberFromText(pdfText)
      || remitoXNumberFromText(invoice.nro_factura);
    if (correlative) invoice.nro_factura = correlative;
    invoice.iva = 0;
    invoice.per_ret_iva = 0;
    invoice.per_ret_iibb = 0;
    invoice.imp_internos = 0;
  }

  function normalizeSalesFacturaB(invoice, source, reviewWarnings) {
    if (invoice.tipo_factura !== "Factura_B" || !(invoice.total > 0)) return;

    const hasAdditionalTaxes = ["per_ret_iva", "per_ret_iibb", "imp_internos"]
      .some((field) => invoice[field] > 0);
    const explicitRateText = String(source.iva_alicuota ?? "").trim().replace(",", ".");
    const explicitRate = Number(explicitRateText);
    const hasDifferentExplicitRate = explicitRateText !== ""
      && Number.isFinite(explicitRate)
      && explicitRate !== SALES_FACTURA_B_DEFAULT_IVA.percent;
    const positiveFiscalAmount = (value) => {
      const parsed = parseMoneyInput(value);
      return parsed.ok && !parsed.empty && parsed.cents > 0;
    };
    const taxTreatment = String(source.tratamiento_iva || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    const hasSpecialTaxTreatment = positiveFiscalAmount(source.exento)
      || positiveFiscalAmount(source.no_gravado)
      || /\bexent[oa]\b|\bno\s+gravado\b/.test(taxTreatment);
    if (hasAdditionalTaxes || hasDifferentExplicitRate || hasSpecialTaxTreatment) {
      reviewWarnings.push(
        "Factura B con alícuota, exención o impuestos adicionales: revisá manualmente subtotal e IVA."
      );
      return;
    }

    const totalCents = parseMoneyInput(invoice.total).cents;
    const subtotalCents = invoice.subtotal === null ? null : parseMoneyInput(invoice.subtotal).cents;
    const ivaCents = invoice.iva === null ? null : parseMoneyInput(invoice.iva).cents;
    if (
      subtotalCents !== null
      && ivaCents !== null
      && subtotalCents + ivaCents === totalCents
    ) {
      return;
    }

    const derivedSubtotalCents = divideCents(invoice.total, SALES_FACTURA_B_DEFAULT_IVA.grossDivisor);
    const derivedIvaCents = totalCents - derivedSubtotalCents;
    if (subtotalCents === totalCents && ivaCents === derivedIvaCents) {
      invoice.subtotal = fromCents(totalCents - ivaCents);
      invoice.iva = fromCents(ivaCents);
      return;
    }

    invoice.subtotal = fromCents(derivedSubtotalCents);
    invoice.iva = fromCents(derivedIvaCents);
  }
  
  function extractResponseText(payload) {
    if (payload.output_text) return payload.output_text;
    const chunks = [];
    (payload.output || []).forEach((outputItem) => {
      (outputItem.content || []).forEach((contentItem) => {
        if (contentItem.text) chunks.push(contentItem.text);
      });
    });
    return chunks.join("\n").trim();
  }
  
  function sanitizeFileName(value) {
    return String(value || "archivo")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "archivo";
  }

  return {
    handleInvoiceProviderHealth,
    handlePayrollScaleRead,
    handleReceptionAttachmentSave,
    handleReceptionInvoiceRead,
    handleSalesInvoiceRead
  };
}

function remitoXNumberFromText(value) {
  const text = String(value || "");
  const match = text.match(/(?:N\s*[°ºo]?\s*)?([0-9]{4,8})\s*-\s*([0-9]{4,12})/i);
  return match?.[2] || "";
}

module.exports = { createAttachmentsService, remitoXNumberFromText };
