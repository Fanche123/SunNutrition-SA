const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("el comparador global se limita al reporte que consume período y comparación", () => {
  const appSource = fs.readFileSync(path.join(root, "assets/js/app.js"), "utf8");

  assert.match(appSource, /periodPicker\.hidden = !viewUsesGlobalPeriodComparison\(view\)/);
  assert.match(appSource, /function viewUsesGlobalPeriodComparison\(view\) \{\s*return view === "results";\s*\}/);
});

test("Ventas usa el selector canónico y conserva el input accesible", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const salesView = html.match(/<section class="view" id="view-sales-invoice-entry">([\s\S]*?)<section class="view" id="view-sales-entry">/)?.[1] || "";

  assert.match(salesView, /class="photo-drop-zone"[^>]*for="sales-invoice-file"/);
  assert.match(salesView, /id="sales-invoice-file" accept="\.pdf,image\/\*"/);
  assert.match(salesView, /id="sales-invoice-file-name" title=""/);
  assert.match(salesView, /id="sales-invoice-file-clear" aria-label="Quitar factura"/);
  assert.doesNotMatch(salesView, /Choose File|No file chosen/);
});

test("Ventas permite seleccionar Remito X y no lo resetea al aplicar una propuesta vacia", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const selectHtml = html.match(/<select id="sales-invoice-type"[^>]*>([\s\S]*?)<\/select>/)?.[1] || "";
  const optionValues = [...selectHtml.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
  const invoiceTypeSelect = {
    currentValue: "",
    get value() {
      return this.currentValue;
    },
    set value(nextValue) {
      this.currentValue = optionValues.includes(nextValue) ? nextValue : "";
    }
  };
  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      return id === "sales-invoice-type" ? invoiceTypeSelect : null;
    }
  };

  try {
    const { applySalesInvoiceProposal } = require("../assets/js/modules/sales-invoice-entry.js");
    invoiceTypeSelect.value = "Remito_X";
    assert.equal(invoiceTypeSelect.value, "Remito_X");

    applySalesInvoiceProposal({});
    assert.equal(invoiceTypeSelect.value, "Remito_X");
  } finally {
    global.document = previousDocument;
  }
});

test("Ventas completa subtotal neto, IVA incluido y total de la propuesta normalizada", () => {
  const values = {};
  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      if (id === "sales-invoice-comparison") return null;
      return {
        get value() {
          return values[id] || "";
        },
        set value(nextValue) {
          values[id] = nextValue;
        }
      };
    }
  };

  try {
    const { applySalesInvoiceProposal } = require("../assets/js/modules/sales-invoice-entry.js");
    applySalesInvoiceProposal({
      tipo_factura: "Factura_B",
      subtotal: 2268000,
      iva: 476280,
      total: 2744280
    });
    assert.equal(values["sales-invoice-type"], "Factura_B");
    assert.equal(values["sales-invoice-subtotal"], 2268000);
    assert.equal(values["sales-invoice-iva"], 476280);
    assert.equal(values["sales-invoice-total"], 2744280);
  } finally {
    global.document = previousDocument;
  }
});

test("Ventas interpreta el Plazo cobro canónico y suma días civiles para cualquier comprobante", () => {
  const {
    salesInvoiceAgreedDate,
    salesInvoiceAgreedDateState,
    salesInvoiceCollectionTermDays
  } = require("../assets/js/modules/sales-invoice-entry.js");

  assert.equal(salesInvoiceCollectionTermDays("0_Dias"), 0);
  assert.equal(salesInvoiceCollectionTermDays("30_Dias"), 30);
  assert.equal(salesInvoiceCollectionTermDays("45_Dias"), 45);
  assert.equal(salesInvoiceCollectionTermDays(" 30 días "), 30);
  assert.equal(salesInvoiceCollectionTermDays(30), 30);
  assert.equal(salesInvoiceAgreedDate("2026-07-21", "0_Dias"), "2026-07-21");
  assert.equal(salesInvoiceAgreedDate("2026-07-21", "30_Dias"), "2026-08-20");
  assert.equal(salesInvoiceAgreedDate("2026-07-22", "30_Dias"), "2026-08-21");
  assert.equal(salesInvoiceAgreedDate("2026-11-30", "45_Dias"), "2027-01-14");
  assert.equal(salesInvoiceAgreedDate("2026-08-30", "30_Dias"), "2026-09-29");
  assert.equal(salesInvoiceAgreedDate("2026-08-30", "0"), "2026-08-30");
  assert.equal(salesInvoiceAgreedDate("2026-02-29", 10), "");
  assert.equal(salesInvoiceAgreedDate("2026-08-30", "sin plazo"), "");
  assert.equal(salesInvoiceCollectionTermDays("30 días hábiles"), null);
  assert.deepEqual(salesInvoiceAgreedDateState("2026-07-21", { plazo_cobro: "30_Dias" }), {
    value: "2026-08-20",
    issue: ""
  });
  assert.deepEqual(salesInvoiceAgreedDateState("2026-07-21", { plazo_cobro: "45_Dias" }), {
    value: "2026-09-04",
    issue: ""
  });
  assert.equal(salesInvoiceAgreedDateState("", { plazo_cobro: "30_Dias" }).issue, "missing_invoice_date");
  assert.equal(salesInvoiceAgreedDateState("2026-07-21", { plazo_cobro: "ambiguo" }).issue, "invalid_collection_term");
});

test("Fecha acordada se recalcula al leer, editar fecha o cambiar de pedido sin fórmula exclusiva de Remito X", () => {
  const source = fs.readFileSync(path.join(root, "assets/js/modules/sales-invoice-entry.js"), "utf8");

  assert.match(source, /sales-invoice-date"\)\?\.addEventListener\("input", updateSalesInvoiceAgreedDate\)/);
  assert.match(source, /sales-invoice-date"\)\?\.addEventListener\("change", updateSalesInvoiceAgreedDate\)/);
  assert.match(source, /const agreedDateState = salesInvoiceAgreedDateState\(invoice\.fecha_factura, selectedOrder\)/);
  assert.match(source, /if \(!sale\) updateSalesInvoiceAgreedDate\(\)/);
  assert.doesNotMatch(source, /const isRemitoX = invoice\.tipo_factura === "Remito_X"/);
});

test("el popup propone Fecha acordada para Factura A, Factura B y Remito X sin bloquear su edición", () => {
  const values = {};
  const dueDateInput = {
    disabled: false,
    get value() { return values["sales-invoice-due-date"] || ""; },
    set value(nextValue) { values["sales-invoice-due-date"] = nextValue; }
  };
  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      if (id === "sales-invoice-comparison") return null;
      if (id === "sales-invoice-due-date") return dueDateInput;
      return {
        get value() { return values[id] || ""; },
        set value(nextValue) { values[id] = nextValue; }
      };
    }
  };

  try {
    const { applySalesInvoiceProposal } = require("../assets/js/modules/sales-invoice-entry.js");
    const order = { id_pedido: "1009", plazo_cobro: "30_Dias" };
    for (const tipo_factura of ["Factura_A", "Factura_B", "Remito_X"]) {
      const proposal = applySalesInvoiceProposal({ tipo_factura, fecha_factura: "2026-07-21" }, order);
      assert.equal(proposal.agreedDate, "2026-08-20");
      assert.equal(dueDateInput.value, "2026-08-20");
    }
    assert.equal(dueDateInput.disabled, false);
    dueDateInput.value = "2026-08-25";
    assert.equal(dueDateInput.value, "2026-08-25");
  } finally {
    global.document = previousDocument;
  }
});

test("el estado del archivo habilita lectura, expone el nombre y vuelve a vacío al quitarlo", () => {
  global.formatFileSize = (size) => `${size} bytes`;
  const { isSalesInvoiceReadableAttachment, salesInvoiceFileUiState } = require("../assets/js/modules/sales-invoice-entry.js");
  const file = { name: "factura-muy-larga.pdf", size: 2048, type: "application/pdf" };

  assert.equal(isSalesInvoiceReadableAttachment(file), true);
  assert.equal(isSalesInvoiceReadableAttachment({ name: "datos.csv", type: "text/csv" }), false);
  assert.deepEqual(salesInvoiceFileUiState(file), {
    hasFile: true,
    fileName: file.name,
    fileSize: "2048 bytes",
    canRead: true,
    canChange: true
  });
  assert.equal(salesInvoiceFileUiState(file, true).canRead, false);
  assert.equal(salesInvoiceFileUiState(file, true).canChange, false);
  assert.deepEqual(salesInvoiceFileUiState(null), {
    hasFile: false,
    fileName: "Sin archivo",
    fileSize: "-",
    canRead: false,
    canChange: true
  });
  delete global.formatFileSize;
});

test("descarta una lectura OCR si el archivo o token ya no es el vigente", () => {
  const { salesInvoiceReadIsCurrent } = require("../assets/js/modules/sales-invoice-entry.js");
  const original = { name: "original.pdf" };
  const replacement = { name: "otro.pdf" };

  assert.equal(salesInvoiceReadIsCurrent(original, { files: [original] }, 7, 7, true), true);
  assert.equal(salesInvoiceReadIsCurrent(original, { files: [replacement] }, 7, 7, true), false);
  assert.equal(salesInvoiceReadIsCurrent(original, { files: [original] }, 7, 8, true), false);
  assert.equal(salesInvoiceReadIsCurrent(original, { files: [original] }, 7, 7, false), false);

  const source = fs.readFileSync(path.join(root, "assets/js/modules/sales-invoice-entry.js"), "utf8");
  assert.match(source, /salesInvoiceFileReading\s*=\s*true;/);
  assert.match(source, /input\?\.files\?\.\[0\]\s*===\s*file/);
  assert.match(source, /respectDisabled:\s*true/);
  assert.match(source, /if \(clearButton\) clearButton\.disabled = !ui\.canChange/);
  assert.match(source, /if \(input\) input\.disabled = !ui\.canChange/);
  assert.equal(original === replacement, false);
});

test("Ventas usa su ruta de lectura y diferencia errores reales sin guardar", () => {
  const {
    SALES_INVOICE_READ_ENDPOINT,
    salesInvoiceReadErrorMessage
  } = require("../assets/js/modules/sales-invoice-entry.js");

  assert.equal(SALES_INVOICE_READ_ENDPOINT, "/api/sales/invoice/read");
  assert.match(
    salesInvoiceReadErrorMessage({ code: "INVALID_FILE", message: "Archivo inválido." }),
    /Elegí otro PDF o imagen/
  );
  assert.match(
    salesInvoiceReadErrorMessage({ code: "SERVICE_NOT_CONFIGURED", message: "Falta configurar." }),
    /no está configurada/
  );
  assert.match(
    salesInvoiceReadErrorMessage({ code: "UNREADABLE_RESPONSE", message: "Sin datos." }),
    /no contiene datos/
  );
  assert.match(
    salesInvoiceReadErrorMessage({ code: "PROVIDER_REQUEST", message: "Solicitud rechazada." }),
    /proveedor rechazó/
  );
  assert.match(
    salesInvoiceReadErrorMessage({ code: "SERVICE_UNAVAILABLE", message: "Sin conexión." }),
    /conectar con el proveedor/
  );
  assert.match(
    salesInvoiceReadErrorMessage({ status: 502, message: "Respuesta inválida." }),
    /HTTP 502/
  );
  assert.doesNotMatch(
    salesInvoiceReadErrorMessage(new Error("fetch failed")),
    /temporalmente no disponible/
  );
});

test("Factura A compara el subtotal al centavo y conserva el signo", () => {
  const { salesInvoiceComparison } = require("../assets/js/modules/sales-invoice-entry.js");
  const money = { toCents: (value) => Math.round(Number(value) * 100) };
  const order = {
    comparacion_factura: {
      estado: "calculable",
      subtotal_esperado: 100,
      lineas: []
    }
  };

  assert.equal(salesInvoiceComparison(order, "100.00", "Factura_A", money).state, "match");
  assert.equal(salesInvoiceComparison(order, "99.50", "Factura_A", money).differenceCents, -50);
});

test("Factura B #451 compara el subtotal neto y nunca usa el total bruto", () => {
  const { salesInvoiceComparison } = require("../assets/js/modules/sales-invoice-entry.js");
  const money = { toCents: (value) => Math.round(Number(value) * 100) };
  const order = {
    comparacion_factura: {
      estado: "calculable",
      subtotal_esperado: 529200,
      lineas: []
    }
  };

  const result = salesInvoiceComparison(order, "529200.00", "Factura_B", money, "640332.00");
  assert.equal(result.state, "match");
  assert.equal(result.differenceCents, 0);
  assert.equal(result.differencePercent, 0);
  assert.equal(result.invoiceCents, 52920000);
});

test("Remito X compara el subtotal visible con la misma regla", () => {
  const { salesInvoiceComparison } = require("../assets/js/modules/sales-invoice-entry.js");
  const source = fs.readFileSync(path.join(root, "assets/js/modules/sales-invoice-entry.js"), "utf8");
  const money = { toCents: (value) => Math.round(Number(value) * 100) };
  const order = {
    comparacion_factura: {
      estado: "calculable",
      subtotal_esperado: 2469852,
      lineas: []
    }
  };

  const result = salesInvoiceComparison(order, "2469852.00", "Remito_X", money, "2469852.00");
  assert.equal(result.state, "match");
  assert.equal(result.differenceCents, 0);
  assert.equal(result.differencePercent, 0);
  assert.doesNotMatch(source, /not_applicable|El remito no tiene subtotal fiscal comparable/);
});

test("los faltantes del pedido quedan explícitos para cualquier comprobante", () => {
  const { salesInvoiceComparison } = require("../assets/js/modules/sales-invoice-entry.js");
  const money = { toCents: (value) => Math.round(Number(value) * 100) };

  assert.deepEqual(
    salesInvoiceComparison({
      comparacion_factura: {
        estado: "datos_insuficientes",
        campos_faltantes: ["unidades por caja"]
      }
    }, "", "Factura_A", money).missing,
    ["unidades por caja"]
  );
});

test("subtotal vacío o inválido queda insuficiente sin fallback al total", () => {
  const { salesInvoiceComparison } = require("../assets/js/modules/sales-invoice-entry.js");
  const money = {
    toCents: (value) => {
      if (!/^\d+(?:\.\d+)?$/.test(String(value))) throw new Error("invalid");
      return Math.round(Number(value) * 100);
    }
  };
  const order = {
    comparacion_factura: {
      estado: "calculable",
      subtotal_esperado: 100,
      lineas: []
    }
  };

  for (const subtotal of ["", "importe inválido"]) {
    const result = salesInvoiceComparison(order, subtotal, "Factura_B", money, "121.00");
    assert.equal(result.state, "insufficient");
    assert.deepEqual(result.missing, ["subtotal del comprobante"]);
    assert.equal(result.invoiceCents, undefined);
  }
});

test("conserva esperado y desglose cuando falta subtotal de factura", () => {
  const { salesInvoiceComparison } = require("../assets/js/modules/sales-invoice-entry.js");
  const money = { toCents: (value) => Math.round(Number(value) * 100) };
  const lines = [{ id_producto: 1 }, { id_producto: 2 }];
  const result = salesInvoiceComparison({
    comparacion_factura: {
      estado: "calculable",
      subtotal_esperado: 123.45,
      lineas: lines
    }
  }, "", "Factura_A", money);

  assert.equal(result.state, "insufficient");
  assert.equal(result.expectedCents, 12345);
  assert.deepEqual(result.lines, lines);
});

test("usa el contrato monetario frontend canónico sin inyectar un reemplazo", () => {
  global.ErpMoney = require("../shared/money.js");
  const { salesInvoiceComparison } = require("../assets/js/modules/sales-invoice-entry.js");
  const result = salesInvoiceComparison({
    comparacion_factura: {
      estado: "calculable",
      subtotal_esperado: "10.00",
      lineas: []
    }
  }, "10.00", "Factura_A");

  assert.equal(result.state, "match");
  delete global.ErpMoney;
});
