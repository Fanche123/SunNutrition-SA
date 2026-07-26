const { parseInput: parseMoneyInput } = require("../../shared/money");

function createAttachmentsService({ childProcess, fs, path, pythonExecutable, readJsonBody, rootDir, sendJson }) {
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
    try {
      const body = await readJsonBody(request);
      const fileDataUrl = String(body.fileDataUrl || body.imageDataUrl || "");
      const fileName = sanitizeFileName(body.fileName || "factura_remito");
      const mimeType = String(body.mimeType || dataUrlMimeType(fileDataUrl) || "").trim();
      const isImage = fileDataUrl.startsWith("data:image/");
      const isPdf = fileDataUrl.startsWith("data:application/pdf");
      if (!isImage && !isPdf) {
        sendJson(response, 400, { ok: false, error: "Falta una imagen o PDF valido de factura o remito." });
        return;
      }
  
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        sendJson(response, 400, { ok: false, error: "Falta configurar OPENAI_API_KEY para leer facturas." });
        return;
      }
  
      const invoice = isPdf
        ? await extractReceptionInvoiceFromPdf(apiKey, fileDataUrl, fileName, mimeType)
        : await extractReceptionInvoiceFromImage(apiKey, fileDataUrl);
      sendJson(response, 200, { ok: true, invoice });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
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
    fs.rmSync(tempPath, { force: true });
    if (result.status !== 0) {
      throw new Error((result.stderr || "No se pudo extraer texto del PDF.").trim());
    }
    return result.stdout || "";
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
    "per_ret_iva": numero,
    "per_ret_iibb": numero,
    "imp_internos": numero,
    "total": numero
  }
  Si un dato no aparece, usa string vacio o 0. No inventes importes.`;
  }
  
  async function extractReceptionInvoiceFromImage(apiKey, imageDataUrl) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
    if (!response.ok) throw new Error(payload.error?.message || "No se pudo leer la factura.");
    const content = payload.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  }
  
  async function extractReceptionInvoiceFromPdf(apiKey, pdfDataUrl, fileName, mimeType) {
    const response = await fetch("https://api.openai.com/v1/responses", {
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
    if (!response.ok) throw new Error(payload.error?.message || "No se pudo leer el PDF de la factura.");
    return JSON.parse(extractResponseText(payload) || "{}");
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

  return { handlePayrollScaleRead, handleReceptionAttachmentSave, handleReceptionInvoiceRead };
}

module.exports = { createAttachmentsService };
