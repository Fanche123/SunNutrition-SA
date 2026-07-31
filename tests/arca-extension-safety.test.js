const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const background = require("../tools/arca-extension/background.js");
const content = require("../tools/arca-extension/content-script.js");
const frontend = require("../assets/js/modules/arca-invoicing.js");
const fiscal = require("../tools/arca-extension/arca-fiscal-contract.js");

test.beforeEach(() => {
  background.setVaultControllerForTesting({
    status: async () => ({ ok: true, status: "stored" }),
    decrypt: async () => ({ ok: true, status: "available", secret: "synthetic-vault-secret" }),
    save: async () => ({ ok: true, status: "stored" }),
    forget: async () => ({ ok: true, status: "forgotten" })
  });
});

function memoryVaultStores() {
  let key = null;
  let record = null;
  return {
    keyStore: {
      async get() { return key; },
      async set(value) { key = structuredClone(value); },
      async remove() { key = null; }
    },
    recordStore: {
      async get() { return record ? structuredClone(record) : null; },
      async set(value) { record = structuredClone(value); },
      async remove() { record = null; }
    },
    snapshot() {
      return { key, record: record ? structuredClone(record) : null };
    }
  };
}

function safeMessage() {
  return {
    type: "PREPARE_SESSION",
    sessionId: "12345678-1234-1234-1234-123456789012",
    payload: {
      contractVersion: fiscal.CONTRACT.version,
      mode: "review_only",
      finalSubmissionAllowed: false,
      revision: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      automation: { ...fiscal.AUTOMATION },
      order: { id: "10" },
      customer: {
        cuit: "30123456789",
        fiscalCondition: "responsable_inscripto",
        fiscalConditionLabel: "IVA Responsable Inscripto",
        address: "Calle 1"
      },
      invoice: {
        pointOfSale: "00001",
        receiptType: "Factura_A",
        invoiceDate: "2026-07-30",
        issuerCondition: "responsable_inscripto",
        recipientCondition: "responsable_inscripto",
        totals: {
          netSubtotal: 1800,
          vat: 378,
          total: 2178
        }
      },
      lines: [{
        productName: "Barra",
        boxes: 2,
        unitsPerBox: 10,
        quantity: 20,
        unitValue: "7",
        unitText: "unidades",
        description: "2 Barra - Entrega: Calle 1",
        individualUnits: 20,
        unitPrice: 100,
        discountPercent: 10,
        vatRate: 21,
        gross: 2000,
        discountAmount: 200,
        netSubtotal: 1800,
        vat: 378,
        total: 2178
      }]
    }
  };
}

function sessionChrome(stored, { tabId = 73, runtimeId = "abcdefghijklmnopabcdefghijklmnop" } = {}) {
  return {
    runtime: { id: runtimeId, lastError: null },
    storage: {
      session: {
        get(key, callback) {
          callback({ [key]: stored[key] === undefined ? undefined : structuredClone(stored[key]) });
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback?.();
        }
      }
    },
    tabs: {
      create(_options, callback) { callback({ id: tabId }); },
      sendMessage(_tabId, _message, callback) { callback?.(); },
      remove(_tabId, callback) { callback?.(); }
    },
    alarms: {
      create() {},
      clear(_name, callback) { callback?.(); }
    }
  };
}

function authDomFixture(stage, options = {}) {
  const events = [];
  const writes = [];
  const reads = [];
  const messages = [];
  const listeners = [];
  const counters = { next: 0, enter: 0, passwordClick: 0 };
  const controls = {};
  let useReplacementForm = false;
  function control(properties) {
    let storedValue = properties.value || "";
    const field = {
      disabled: false,
      readOnly: false,
      ...properties,
      get value() {
        if (field.type === "password" || field.type === "hidden") reads.push(field.name);
        return storedValue;
      },
      set value(nextValue) {
        writes.push({ name: field.name, value: String(nextValue) });
        storedValue = String(nextValue);
      },
      setSyntheticValueWithoutEvents(nextValue) {
        storedValue = String(nextValue);
      },
      dispatchEvent(event) {
        events.push(`${field.name}:${event.type}`);
        if (options.revertCuit && field.name === "F1:username") storedValue = "";
        if (options.replaceFormAfterInput && field.name === "F1:username" && event.type === "input") {
          useReplacementForm = true;
        }
        if (event.type === "click" && field.name === "F1:btnSiguiente") counters.next += 1;
        if (event.type === "click" && field.name === "F1:btnIngresar") counters.enter += 1;
        return true;
      },
      focus() {
        events.push(`${field.name}:focus`);
        if (!options.rejectPasswordFocus || field.type !== "password") document.activeElement = field;
      },
      click() {
        events.push(`${field.name}:click`);
        if (field.name === "F1:password") counters.passwordClick += 1;
        if (field.name === "F1:btnIngresar") counters.enter += 1;
      },
      getAttribute(name) {
        return name === "aria-disabled" ? null : "";
      }
    };
    return field;
  }
  controls.username = control({
    id: "F1:username",
    name: "F1:username",
    type: stage === "cuit" ? "number" : "text",
    value: options.username ?? (stage === "cuit" ? "" : "20398041063")
  });
  if (stage === "cuit") {
    controls.submit = control({
      id: "F1:btnSiguiente",
      name: "F1:btnSiguiente",
      type: "submit",
      title: "Siguiente",
      value: "Siguiente"
    });
    (options.hiddenControls || []).forEach((hidden, index) => {
      controls[`hidden${index}`] = control({
        id: hidden.id,
        name: hidden.name,
        type: "hidden",
        value: "sanitized-state"
      });
    });
  } else {
    controls.password = control({
      id: "F1:password",
      name: "F1:password",
      type: "password",
      required: true,
      value: options.password || ""
    });
    controls.captcha = control({
      id: "F1:captcha",
      name: "F1:captcha",
      type: options.visibleCaptcha ? "text" : "hidden",
      value: ""
    });
    controls.viewState = control({
      id: "javax.faces.ViewState",
      name: "javax.faces.ViewState",
      type: "hidden",
      value: "sanitized-state"
    });
    controls.submit = control({
      id: "F1:btnIngresar",
      name: "F1:btnIngresar",
      type: "submit",
      title: "Ingresar",
      value: "Ingresar"
    });
  }
  if (options.genericChallenge) {
    controls.challenge = control({
      id: "",
      name: "",
      type: "div",
      className: options.genericChallenge
    });
  }
  const selectors = {
    'input#F1\\:username[name="F1:username"][type="number"]': stage === "cuit" ? [controls.username] : [],
    'input#F1\\:username[name="F1:username"][type="text"]': stage === "password" ? [controls.username] : [],
    'input#F1\\:password[name="F1:password"][type="password"]': stage === "password" ? [controls.password] : [],
    'input#F1\\:btnSiguiente[name="F1:btnSiguiente"][type="submit"][title="Siguiente"]': stage === "cuit" ? [controls.submit] : [],
    'input#F1\\:btnIngresar[name="F1:btnIngresar"][type="submit"][title="Ingresar"]': stage === "password" ? [controls.submit] : [],
    'input#F1\\:captcha[name="F1:captcha"][type="hidden"]': stage === "password" && !options.visibleCaptcha ? [controls.captcha] : []
  };
  const form = {
    id: "F1",
    name: "F1",
    method: options.method || "post",
    action: options.action || (stage === "cuit"
      ? "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
      : "https://auth.afip.gob.ar/contribuyente_/loginClave.xhtml"),
    getAttribute(name) {
      return name === "method" ? form.method : name === "action" ? form.action : "";
    },
    querySelectorAll(selector) {
      const values = selectors[selector] || [];
      return options.duplicateControl && values.length ? [...values, values[0]] : values;
    }
  };
  Object.values(controls).forEach((field) => {
    field.form = form;
  });
  const secondForm = {
    ...form,
    querySelectorAll: form.querySelectorAll.bind(form)
  };
  const banner = { dataset: {}, textContent: "" };
  const document = {
    activeElement: null,
    title: options.title || "Acceso con Clave Fiscal - ARCA",
    body: { innerText: options.pageText || "", textContent: options.pageText || "" },
    querySelectorAll(selector) {
      if (selector === 'form#F1[name="F1"]') {
        if (useReplacementForm) return [secondForm];
        if (options.duplicateForm) return [form, secondForm];
        if (options.duplicateFormReferences) return [form, form, form];
        return [form];
      }
      if (selector.startsWith("input, select, textarea, iframe")) {
        return Object.values(controls);
      }
      return [];
    },
    getElementById(id) {
      return id === "sunnutrition-arca-assistant" ? banner : null;
    },
    readyState: options.readyState || "complete",
    documentElement: { appendChild() {} },
    createElement: () => ({ dataset: {}, style: {}, setAttribute() {} }),
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
    }
  };
  if (options.controlFormMismatch) controls.submit.form = secondForm;
  return { banner, controls, counters, document, events, form, listeners, messages, reads, writes };
}

function withAuthDom(fixture, callback, href = "https://auth.afip.gob.ar/contribuyente_/login.xhtml") {
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalMouseEvent = global.MouseEvent;
  const originalChrome = global.chrome;
  global.document = fixture.document;
  global.location = new URL(href);
  global.MouseEvent = class MouseEvent {
    constructor(type) {
      this.type = type;
    }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        fixture.messages.push(message);
        if (callback) callback(message.type === "CONSUME_ENCRYPTED_CREDENTIAL"
          ? { ok: true, status: "consumed", secret: "synthetic-once-marker" }
          : { ok: true, stage: message.stage });
      }
    }
  };
  try {
    return callback();
  } finally {
    content.resetLoginStateForTesting();
    global.document = originalDocument;
    global.location = originalLocation;
    global.MouseEvent = originalMouseEvent;
    global.chrome = originalChrome;
  }
}

function operationDomFixture(payload, options = {}) {
  const events = [];
  const lineSets = [];
  const counters = {
    add: 0,
    continue: 0,
    delete: 0,
    addTribute: 0,
    back: 0,
    menu: 0
  };

  function option(value, text, selected = false) {
    return { value, textContent: text, selected, disabled: false };
  }

  function control(tagName, properties = {}) {
    const field = {
      tagName,
      id: "",
      name: "",
      type: tagName === "SELECT" ? "select-one" : "text",
      value: "",
      disabled: false,
      readOnly: false,
      options: [],
      selectedIndex: -1,
      ...properties,
      dispatchEvent(event) {
        events.push(`${field.id || field.name || field.value}:${event.type}`);
        if (options.revertFieldName === field.name && event.type === "change") field.value = "";
        return field.onDispatch ? field.onDispatch(event) : true;
      }
    };
    if (field.tagName === "SELECT" && field.selectedIndex >= 0) {
      field.options.forEach((candidate, index) => {
        candidate.selected = index === field.selectedIndex;
      });
      field.value = field.options[field.selectedIndex]?.value || "";
    }
    return field;
  }

  function addLine(index) {
    const suffix = String(index + 1);
    const expected = payload.lines[index];
    const recalculate = () => {
      const row = lineSets[index];
      if (!row || !row.quantity.value || !row.price.value || !row.discountPercent.value) return;
      row.discountAmount.value = String(expected.discountAmount);
      row.netSubtotal.value = String(
        options.corruptSubtotal ? expected.netSubtotal + 1 : expected.netSubtotal
      );
      row.vatAmount.value = String(expected.vat);
      row.total.value = String(expected.total);
    };
    const unitOptions = [
      option("7", "seleccionar...", true),
      option("1", "kilogramos"),
      option("7", "unidades")
    ];
    if (options.missingUnit) unitOptions.splice(2, 1);
    if (options.duplicateUnit) unitOptions.push(option("7", "unidades"));
    const vatOptions = [option("0", "seleccionar...", true), option("5", "21%")];
    if (options.wrongVat) vatOptions.splice(1, 1, option("6", "27%"));
    const row = {
      code: control("INPUT", { name: "detalleCodigoArticulo", onDispatch: recalculate }),
      lineNumber: control("INPUT", {
        name: "detalleNroLinea",
        type: "hidden",
        value: options.lineNumbers?.[index] ?? ""
      }),
      description: control("TEXTAREA", {
        id: options.mismatchedLineIndex === index ? `detalle_descripcion${index + 2}` : `detalle_descripcion${suffix}`,
        name: "detalleDescripcion",
        onDispatch: recalculate
      }),
      quantity: control("INPUT", {
        id: `detalle_cantidad${suffix}`,
        name: "detalleCantidad",
        onDispatch: recalculate
      }),
      unit: control("SELECT", {
        id: `detalle_medida${suffix}`,
        name: "detalleMedida",
        options: unitOptions,
        selectedIndex: 0,
        onDispatch: recalculate
      }),
      price: control("INPUT", {
        id: `detalle_precio${suffix}`,
        name: "detallePrecio",
        onDispatch: recalculate
      }),
      discountPercent: control("INPUT", {
        id: `detalle_porcentaje${suffix}`,
        name: "detallePorcentajeBonificacion",
        onDispatch: recalculate
      }),
      discountAmount: control("INPUT", {
        id: `detalle_importe_bonificacion${suffix}`,
        name: "detalleImporteBonificacion",
        readOnly: true
      }),
      netSubtotal: control("INPUT", {
        id: `detalle_subtotal1${suffix}`,
        name: "detalleSubtotal1",
        readOnly: true
      }),
      vatType: control("SELECT", {
        id: `detalle_tipo_iva${suffix}`,
        name: "detalleTipoIVA",
        options: vatOptions,
        selectedIndex: 0,
        onDispatch: recalculate
      }),
      vatAmount: control("INPUT", {
        id: `detalle_importe_iva${suffix}`,
        name: "detalleImporteIVA",
        readOnly: true
      }),
      total: control("INPUT", {
        id: `detalle_subtotal2${suffix}`,
        name: "detalleSubtotal2",
        readOnly: true
      }),
      deleteButton: control("INPUT", {
        name: "Eliminar",
        type: "button",
        value: "X",
        onDispatch: () => {
          counters.delete += 1;
          return true;
        }
      })
    };
    lineSets.push(row);
  }

  const initialCount = options.initialLineCount ?? 1;
  for (let index = 0; index < initialCount; index += 1) addLine(index);

  const quantityPrecision = control("SELECT", {
    id: "numdecimalescantidad",
    name: "numDecimalesCantidad",
    options: [option("2", "2 decimales", true), option("4", "4 decimales")],
    selectedIndex: 0
  });
  const pricePrecision = control("SELECT", {
    id: "numdecimalespreciounit",
    name: "numDecimalesPrecioUnit",
    options: [option("2", "2 decimales", true), option("4", "4 decimales")],
    selectedIndex: 0
  });
  const tributeSelect = control("SELECT", {
    id: "impuesto_6",
    options: [option("999", "Seleccionar...", true), option("1", "Impuestos Nacionales")],
    selectedIndex: options.activeTribute || options.selectedTribute ? 1 : 0
  });
  const tributeNames = [
    "impuestoCodigo",
    "impuestoDescripcion",
    "impuestoDetalle",
    "impuestoBaseImponible",
    "impuestoAlicuota",
    "impuestoMonto"
  ];
  const tributeFields = Object.fromEntries(tributeNames.map((name) => [
    name,
    Array.from({ length: 6 }, (_, index) => control("INPUT", {
      id: `${name}${index + 1}`,
    name,
      type: ["impuestoCodigo", "impuestoDescripcion"].includes(name) ? "hidden" : "text",
      value: name === "impuestoCodigo"
        ? (index === 5 ? "999" : String(index + 1))
        : name === "impuestoDescripcion"
          ? (index === 5 ? "Seleccionar..." : `Tributo fijo ${index + 1}`)
          : options.completedTribute && name === "impuestoDetalle" && index === 0
            ? "Percepción informada"
            : options.activeTribute && name === "impuestoMonto" && index === 0
              ? "1"
              : options.defaultTributeZeros
                && ["impuestoBaseImponible", "impuestoAlicuota", "impuestoMonto"].includes(name)
                && index === 5
                ? "0.00"
                : ""
    }))
  ]));
  const addButton = control("INPUT", {
    type: "button",
    value: "Agregar l\u00ednea descripci\u00f3n",
    onDispatch: () => {
      counters.add += 1;
      if (options.failAdd) return false;
      if (lineSets.length < payload.lines.length) addLine(lineSets.length);
      return true;
    }
  });
  const continueButtons = Array.from({ length: options.duplicateContinue ? 2 : 1 }, () => control("INPUT", {
    type: "button",
    value: "Continuar >",
    onDispatch: () => {
      counters.continue += 1;
      return true;
    }
  }));
  if (options.missingContinue) continueButtons.splice(0);
  const addTribute = control("INPUT", {
    name: "agregarImp",
    type: "button",
    value: "Agregar otro Tributo",
    onDispatch: () => {
      counters.addTribute += 1;
      return true;
    }
  });
  const back = control("INPUT", {
    type: "button",
    value: "< Volver",
    onDispatch: () => {
      counters.back += 1;
      return true;
    }
  });
  const selectorByLineKey = {
    'input[name="detalleCodigoArticulo"]': "code",
    'input[name="detalleNroLinea"][type="hidden"]': "lineNumber",
    'textarea[name="detalleDescripcion"]': "description",
    'input[name="detalleCantidad"]': "quantity",
    'select[name="detalleMedida"]': "unit",
    'input[name="detallePrecio"]': "price",
    'input[name="detallePorcentajeBonificacion"]': "discountPercent",
    'input[name="detalleImporteBonificacion"]': "discountAmount",
    'input[name="detalleSubtotal1"]': "netSubtotal",
    'select[name="detalleTipoIVA"]': "vatType",
    'input[name="detalleImporteIVA"]': "vatAmount",
    'input[name="detalleSubtotal2"]': "total"
  };
  const form = {
    method: options.method || "post",
    action: options.action || "https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do",
    getAttribute(name) {
      if (name === "method") return form.method;
      if (name === "action") return form.action;
      return "";
    },
    querySelectorAll(selector) {
      if (selectorByLineKey[selector]) {
        const key = selectorByLineKey[selector];
        const values = lineSets.map((row) => row[key]);
        if (options.missingCode && key === "code") return values.slice(1);
        if (options.missingLineNumber && key === "lineNumber") return values.slice(1);
        if (options.duplicateLineNumberControl && key === "lineNumber") return [...values, values[0]];
        return values;
      }
      if (selector === 'select#numdecimalescantidad[name="numDecimalesCantidad"]') {
        return [quantityPrecision];
      }
      if (selector === 'select#numdecimalespreciounit[name="numDecimalesPrecioUnit"]') {
        return [pricePrecision];
      }
      if (selector === 'input[type="button"]') {
        return [
          ...lineSets.map((row) => row.deleteButton),
          addButton,
          addTribute,
          back,
          ...continueButtons
        ];
      }
      const tributeName = selector.match(/^\[name="([^"]+)"\]$/)?.[1];
      if (tributeName && tributeFields[tributeName]) return tributeFields[tributeName];
      if (selector === "select") {
        return [
          ...lineSets.flatMap((row) => [row.unit, row.vatType]),
          tributeSelect,
          quantityPrecision,
          pricePrecision
        ];
      }
      return [];
    }
  };
  const banner = { dataset: {}, textContent: "" };
  const document = {
    title: options.title || "RCEL",
    getElementById(id) {
      return id === "sunnutrition-arca-assistant" ? banner : null;
    },
    querySelectorAll(selector) {
      if (selector === 'form[name="datosOperacionForm"]') {
        return options.duplicateForm ? [form, form] : [form];
      }
      return [];
    }
  };
  return { banner, counters, document, events, form, lineSets, tributeFields, tributeSelect };
}

function withOperationDom(fixture, callback, href = "https://fe.afip.gob.ar/rcel/jsp/genComDatosOperacion.do") {
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalMouseEvent = global.MouseEvent;
  global.document = fixture.document;
  global.location = new URL(href);
  global.MouseEvent = class MouseEvent {
    constructor(type) {
      this.type = type;
    }
  };
  try {
    return callback();
  } finally {
    global.document = originalDocument;
    global.location = originalLocation;
    global.MouseEvent = originalMouseEvent;
    content.resetOperationStateForTesting();
  }
}

test("manifest limita hosts y separa sesiones efímeras del vault local cifrado", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "tools/arca-extension/manifest.json"), "utf8"));

  assert.deepEqual(manifest.permissions.sort(), ["alarms", "clipboardWrite", "storage"]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "https://auth.afip.gob.ar/*",
    "https://fe.afip.gob.ar/*",
    "https://serviciosjava2.afip.gob.ar/*"
  ]);
  assert.deepEqual(
    [...manifest.content_scripts[0].matches].sort(),
    [...manifest.host_permissions].sort()
  );
  assert.deepEqual(manifest.externally_connectable.matches, ["http://127.0.0.1/*"]);
  assert.equal(manifest.content_scripts[0].all_frames, undefined);
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
  assert.equal(
    manifest.content_scripts[0].matches.some((match) => match === "https://fe.afip.gob.ar/*"),
    true
  );
  assert.equal(manifest.minimum_chrome_version, "102");
  assert.equal(manifest.version, "1.1.26");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
});

test("login CUIT completa solo el autorizado y pulsa Siguiente una vez", () => {
  const dom = authDomFixture("cuit");
  withAuthDom(dom, () => {
    content.setActiveSessionForTesting({ sessionId: "login-cuit", payload: {} });
    content.runLoginAutomationForTesting();
    content.runLoginAutomationForTesting();
    assert.equal(dom.controls.username.value, content.AUTHORIZED_LOGIN_CUIT);
    assert.equal(dom.counters.next, 1);
    assert.equal(dom.counters.enter, 0);
    assert.deepEqual(
      dom.events.filter((event) => event.startsWith("F1:username:")),
      ["F1:username:input", "F1:username:change"]
    );
    assert.deepEqual(dom.writes, [{ name: "F1:username", value: "20398041063" }]);
  });
});

test("fixture JSON real acepta hidden y referencias repetidas al mismo formulario F1", () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(root, "tests/fixtures/arca/login-cuit-real.json"),
    "utf8"
  ));
  assert.equal(fixture.url, "https://auth.afip.gob.ar/contribuyente_/login.xhtml");
  assert.deepEqual(
    [fixture.form.id, fixture.form.name, fixture.form.method, fixture.form.action],
    ["F1", "F1", "post", fixture.url]
  );
  const dom = authDomFixture("cuit", {
    duplicateFormReferences: true,
    hiddenControls: fixture.form.hiddenInputs
  });
  withAuthDom(dom, () => {
    content.setActiveSessionForTesting({ sessionId: "login-real-json", payload: {} });
    content.runLoginAutomationForTesting();
    assert.equal(dom.controls.username.value, content.AUTHORIZED_LOGIN_CUIT);
    assert.equal(dom.counters.next, 1);
    assert.deepEqual(dom.writes, [{ name: "F1:username", value: "20398041063" }]);
    assert.deepEqual(dom.reads, []);
    assert.equal(content.uniqueElementReferences([dom.form, dom.form, dom.form]).length, 1);
  }, fixture.url);
});

test("login F1 real duplicado, action distinta, submit duplicado o control de otro form no hacen clic", () => {
  const scenarios = [
    authDomFixture("cuit", { duplicateForm: true }),
    authDomFixture("cuit", { action: "https://auth.afip.gob.ar/otra.xhtml" }),
    authDomFixture("cuit", { duplicateControl: true }),
    authDomFixture("cuit", { controlFormMismatch: true })
  ];
  for (const dom of scenarios) {
    withAuthDom(dom, () => {
      content.setActiveSessionForTesting({ sessionId: "login-real-blocked", payload: {} });
      content.runLoginAutomationForTesting();
      assert.equal(dom.counters.next, 0);
      assert.deepEqual(dom.writes, []);
      assert.match(dom.banner.textContent, /login_(form_not_unique|form_action_mismatch|cuit_controls_mismatch|cuit_controls_form_mismatch)/);
    });
  }
});

test("login revalida el mismo F1 y submit después de escribir el CUIT", () => {
  const dom = authDomFixture("cuit", { replaceFormAfterInput: true });
  withAuthDom(dom, () => {
    content.setActiveSessionForTesting({ sessionId: "login-replaced-after-input", payload: {} });
    content.runLoginAutomationForTesting();
    assert.deepEqual(dom.writes, [{ name: "F1:username", value: "20398041063" }]);
    assert.equal(dom.counters.next, 0);
    assert.match(dom.banner.textContent, /formulario F1 o el botón Siguiente cambió/);
  });
});

test("login descifra just-in-time y pulsa Ingresar una sola vez sin leer password", () => {
  for (const password of ["", "fixture-no-real"]) {
    const dom = authDomFixture("password", { password });
    withAuthDom(dom, () => {
      content.setActiveSessionForTesting({ sessionId: `login-focus-${password.length}`, payload: {} });
      content.runLoginAutomationForTesting();
      content.runLoginAutomationForTesting();
      assert.equal(dom.document.activeElement, dom.controls.password);
      assert.equal(dom.counters.passwordClick, 1);
      assert.equal(dom.counters.enter, 1);
      assert.equal(dom.counters.next, 0);
      assert.deepEqual(dom.reads, []);
      assert.equal(dom.writes.length, 1);
      assert.deepEqual(
        dom.events.filter((event) => event.startsWith("F1:password:")),
        ["F1:password:focus", "F1:password:click", "F1:password:input", "F1:password:change"]
      );
    });
  }
});

test("login conserva una sola autorización ante doble inicialización y re-render", () => {
  const dom = authDomFixture("password");
  withAuthDom(dom, () => {
    const callbacks = [];
    global.chrome.runtime.sendMessage = (message, callback) => {
      if (message.type === "AUTHORIZE_LOGIN_ACTION") callbacks.push(callback);
      else if (message.type === "CONSUME_ENCRYPTED_CREDENTIAL") {
        callback({ ok: true, secret: "synthetic-rerender" });
      } else if (callback) callback({ ok: true });
    };
    content.setActiveSessionForTesting({ sessionId: "login-rerender", payload: {} });
    content.runLoginAutomationForTesting();
    content.runLoginAutomationForTesting();
    assert.equal(callbacks.length, 1);
    dom.controls.password.setSyntheticValueWithoutEvents("synthetic-stale-field");
    callbacks[0]({ ok: true, stage: "login_password" });
    assert.equal(dom.counters.passwordClick, 1);
    assert.equal(dom.counters.enter, 1);
    assert.deepEqual(dom.reads, []);
    assert.equal(dom.writes.length, 1);
  });
});

test("login bloquea CUIT revertido o discrepante", () => {
  const reverted = authDomFixture("cuit", { revertCuit: true });
  withAuthDom(reverted, () => {
    content.setActiveSessionForTesting({ sessionId: "login-reverted", payload: {} });
    content.runLoginAutomationForTesting();
    assert.equal(reverted.counters.next, 0);
    assert.match(reverted.banner.textContent, /revirti/);
  });
  const mismatch = authDomFixture("password", { username: "20999999999", password: "fixture" });
  withAuthDom(mismatch, () => {
    content.setActiveSessionForTesting({ sessionId: "login-mismatch", payload: {} });
    content.runLoginAutomationForTesting();
    assert.equal(mismatch.document.activeElement, null);
    assert.equal(mismatch.counters.passwordClick, 0);
    assert.equal(mismatch.counters.enter, 0);
    assert.deepEqual(mismatch.reads, []);
    assert.deepEqual(mismatch.writes, []);
    assert.match(mismatch.banner.textContent, /login_cuit_mismatch/);
  });
});

test("login acepta la URL canónica con query, fragmento o slash final sin relajar el DOM", () => {
  for (const href of [
    "https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=rcel",
    "https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=rcel#login",
    "https://auth.afip.gob.ar/contribuyente_/login.xhtml/"
  ]) {
    const dom = authDomFixture("cuit");
    withAuthDom(dom, () => {
      content.setActiveSessionForTesting({ sessionId: `login-canonical-${href}`, payload: {} });
      content.runLoginAutomationForTesting();
      content.runLoginAutomationForTesting();
      assert.equal(dom.controls.username.value, content.AUTHORIZED_LOGIN_CUIT);
      assert.equal(dom.counters.next, 1);
      assert.deepEqual(dom.writes, [{ name: "F1:username", value: "20398041063" }]);
    }, href);
  }
});

test("login evita doble autorización asíncrona y pulsa Siguiente una sola vez", () => {
  const dom = authDomFixture("cuit");
  withAuthDom(dom, () => {
    const callbacks = [];
    global.chrome.runtime.sendMessage = (message, callback) => {
      if (message.type === "AUTHORIZE_LOGIN_ACTION") callbacks.push(callback);
      else if (callback) callback({ ok: true });
    };
    content.setActiveSessionForTesting({ sessionId: "login-async-guard", payload: {} });
    content.runLoginAutomationForTesting();
    content.runLoginAutomationForTesting();
    assert.equal(callbacks.length, 1);
    assert.equal(dom.counters.next, 0);
    callbacks[0]({ ok: true, stage: "login_cuit" });
    assert.equal(dom.counters.next, 1);
    assert.doesNotMatch(dom.banner.textContent, /detuvo|utilizada|autorizada/);
  });
});

test("login rechaza host, protocolo, puerto, path, credenciales y dominios engañosos", () => {
  for (const href of [
    "http://auth.afip.gob.ar/contribuyente_/login.xhtml",
    "https://auth.afip.gob.ar:444/contribuyente_/login.xhtml",
    "https://auth.afip.gob.ar/otra/login.xhtml",
    "https://auth.afip.gob.ar/contribuyente_/login.xhtml//",
    "https://usuario@auth.afip.gob.ar/contribuyente_/login.xhtml",
    "https://usuario:clave@auth.afip.gob.ar/contribuyente_/login.xhtml",
    "https://evil.auth.afip.gob.ar/contribuyente_/login.xhtml",
    "https://auth.afip.gob.ar.evil.example/contribuyente_/login.xhtml"
  ]) {
    const dom = authDomFixture("cuit");
    withAuthDom(dom, () => {
      content.setActiveSessionForTesting({ sessionId: `login-invalid-${href}`, payload: {} });
      content.runLoginAutomationForTesting();
      assert.equal(dom.counters.next, 0);
      assert.deepEqual(dom.writes, []);
      assert.match(dom.banner.textContent, /login_url_mismatch/);
    }, href);
  }
});

test("login bloquea contrato distinto, duplicados y CAPTCHA visible", () => {
  for (const dom of [
    authDomFixture("cuit", { method: "get" }),
    authDomFixture("cuit", { action: "https://auth.afip.gob.ar/otra.xhtml" }),
    authDomFixture("cuit", { duplicateForm: true }),
    authDomFixture("cuit", { duplicateControl: true }),
    authDomFixture("password", { visibleCaptcha: true, password: "fixture" }),
    authDomFixture("password", { genericChallenge: "mfa-panel", password: "fixture" }),
    authDomFixture("password", { pageText: "Error de autenticación", password: "fixture" })
  ]) {
    withAuthDom(dom, () => {
      content.setActiveSessionForTesting({ sessionId: "login-blocked", payload: {} });
      content.runLoginAutomationForTesting();
      assert.deepEqual(dom.counters, { next: 0, enter: 0, passwordClick: 0 });
      assert.deepEqual(dom.writes, []);
    });
  }
  for (const action of [
    "https://auth.afip.gob.ar/contribuyente_/loginClave.xhtml?unexpected=1",
    "https://auth.afip.gob.ar/contribuyente_/loginClave.xhtml#unexpected",
    "https://usuario@auth.afip.gob.ar/contribuyente_/loginClave.xhtml"
  ]) {
    const invalidAction = authDomFixture("password", { action });
    withAuthDom(invalidAction, () => {
      content.setActiveSessionForTesting({ sessionId: `login-action-${action}`, payload: {} });
      content.runLoginAutomationForTesting();
      assert.equal(invalidAction.counters.passwordClick, 0);
      assert.equal(invalidAction.counters.enter, 0);
      assert.deepEqual(invalidAction.reads, []);
      assert.deepEqual(invalidAction.writes, []);
    });
  }
  const wrongTitle = authDomFixture("cuit", { title: "Acceso inesperado" });
  withAuthDom(wrongTitle, () => {
    content.setActiveSessionForTesting({ sessionId: "login-title", payload: {} });
    content.runLoginAutomationForTesting();
    assert.equal(wrongTitle.counters.next, 0);
  });
});

test("login reemplazado invalida la autorización pendiente de la sesión anterior", () => {
  const dom = authDomFixture("password");
  withAuthDom(dom, () => {
    const callbacks = [];
    global.chrome.runtime.sendMessage = (message, callback) => {
      if (message.type === "AUTHORIZE_LOGIN_ACTION") callbacks.push(callback);
      else if (callback) callback({ ok: true });
    };
    content.setActiveSessionForTesting({ sessionId: "login-session-a", payload: {} });
    content.runLoginAutomationForTesting();
    content.setActiveSessionForTesting({ sessionId: "login-session-b", payload: {} });
    callbacks[0]({ ok: true, stage: "login_password" });
    assert.equal(dom.counters.passwordClick, 0);
    assert.equal(dom.counters.enter, 0);
    assert.deepEqual(dom.reads, []);
  });
});

test("login cancela sin foco/clic si cambia navegación, contrato, CAPTCHA/MFA o sesión", () => {
  for (const change of ["navigation", "captcha", "mfa", "contract", "cancel"]) {
    const dom = authDomFixture("password");
    withAuthDom(dom, () => {
      const callbacks = [];
      global.chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === "AUTHORIZE_LOGIN_ACTION") callbacks.push(callback);
        else if (callback) callback({ ok: true });
      };
      content.setActiveSessionForTesting({ sessionId: `login-${change}`, payload: {} });
      content.runLoginAutomationForTesting();
      if (change === "navigation") global.location = new URL("https://auth.afip.gob.ar/otra.xhtml");
      if (change === "captcha") dom.controls.captcha.type = "text";
      if (change === "mfa") dom.controls.username.className = "mfa-panel";
      if (change === "contract") dom.form.method = "get";
      if (change === "cancel") content.expireActiveSessionForTesting("Cancelada.");
      callbacks[0]({ ok: true, stage: "login_password" });
      assert.equal(dom.counters.passwordClick, 0);
      assert.equal(dom.counters.enter, 0);
      assert.deepEqual(dom.reads, []);
    });
  }
});

test("login limpia el Ingresar pendiente ante cambio, CAPTCHA/MFA, cancelación o reemplazo", () => {
  for (const change of ["navigation", "captcha", "mfa", "contract", "cancel", "session"]) {
    const dom = authDomFixture("password");
    withAuthDom(dom, () => {
      let consumeCallback = null;
      global.chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === "AUTHORIZE_LOGIN_ACTION") {
          callback({ ok: true, stage: message.stage });
        } else if (message.type === "CONSUME_ENCRYPTED_CREDENTIAL") {
          consumeCallback = callback;
        } else if (callback) callback({ ok: true });
      };
      content.setActiveSessionForTesting({ sessionId: `login-wait-${change}`, payload: {} });
      content.runLoginAutomationForTesting();
      assert.equal(typeof consumeCallback, "function");
      assert.equal(dom.counters.passwordClick, 0);
      if (change === "navigation") global.location = new URL("https://auth.afip.gob.ar/otra.xhtml");
      if (change === "captcha") dom.controls.captcha.type = "text";
      if (change === "mfa") dom.controls.username.className = "mfa-panel";
      if (change === "contract") dom.form.method = "get";
      if (change === "cancel") content.expireActiveSessionForTesting("Cancelada.");
      if (change === "session") {
        content.setActiveSessionForTesting({ sessionId: "login-replacement", payload: {} });
      }
      consumeCallback({ ok: true, secret: "synthetic-pending" });
      assert.equal(dom.counters.enter, 0);
      assert.deepEqual(dom.reads, []);
      assert.deepEqual(dom.writes, []);
    });
  }
});

test("login no reintenta Ingresar si ARCA permanece o muestra rechazo", () => {
  const dom = authDomFixture("password");
  withAuthDom(dom, () => {
    content.setActiveSessionForTesting({ sessionId: "login-no-retry", payload: {} });
    content.runLoginAutomationForTesting();
    dom.document.body.innerText = "Clave o usuario incorrecto";
    content.runLoginAutomationForTesting();
    assert.equal(dom.counters.passwordClick, 1);
    assert.equal(dom.counters.enter, 1);
    assert.deepEqual(dom.reads, []);
    assert.equal(dom.writes.length, 1);
  });
});

test("login diagnostica foco rechazado y se detiene sin Ingresar", () => {
  const dom = authDomFixture("password", { rejectPasswordFocus: true });
  withAuthDom(dom, () => {
    content.setActiveSessionForTesting({ sessionId: "login-focus-rejected", payload: {} });
    content.runLoginAutomationForTesting();
    assert.equal(dom.counters.passwordClick, 1);
    assert.equal(dom.counters.enter, 0);
    assert.match(dom.banner.textContent, /rechazó el foco/);
    content.runLoginAutomationForTesting();
    assert.equal(dom.counters.passwordClick, 1);
    assert.deepEqual(dom.reads, []);
  });
});

test("login nunca lee password, captcha ni hidden y no ejecuta etapas fiscales", () => {
  const source = fs.readFileSync(path.join(root, "tools/arca-extension/content-script.js"), "utf8");
  const loginBody = source.match(/function runLoginAutomation\(\) \{([\s\S]*?)\n  \}\n\n  function emissionScreenContract/)?.[1] || "";
  assert.doesNotMatch(loginBody, /completeInitialFields|completeEmissionFields|completeRecipientFields|completeOperationFields/);
  assert.doesNotMatch(loginBody, /storage|console\.|sendMessage\([^)]*(password|captcha)/i);
  assert.doesNotMatch(loginBody, /password\s*\.\s*value|password\]\s*\.\s*value|hiddenCaptcha\.value/);
  assert.doesNotMatch(loginBody, /contract\.username\.value|verified\.username\.value/);
  assert.match(loginBody, /CONSUME_ENCRYPTED_CREDENTIAL/);
  assert.doesNotMatch(loginBody, /setTimeout|setInterval/);
  assert.match(loginBody, /activateInterimAction\(verified\.submit,\s*"login_password"\)/);
  assert.doesNotMatch(source, /function loginPasswordIsReady|LOGIN_PASSWORD_RETRY|LOGIN_PASSWORD_TIMEOUT/);
});

test("vault cifra con AES-GCM, clave no extraíble y reemplazo usa IV/ciphertext nuevos", async () => {
  const stores = memoryVaultStores();
  const vault = background.createVaultController({
    cryptoApi: global.crypto,
    keyStore: stores.keyStore,
    recordStore: stores.recordStore
  });
  const marker = ["synthetic", "vault", Date.now()].join("-");
  assert.deepEqual(await vault.save(marker), { ok: true, status: "stored" });
  const first = stores.snapshot();
  assert.equal(first.key.extractable, false);
  await assert.rejects(global.crypto.subtle.exportKey("raw", first.key));
  assert.doesNotMatch(JSON.stringify(first.record), new RegExp(marker));
  assert.doesNotMatch(JSON.stringify({ key: first.key }), new RegExp(marker));
  assert.equal((await vault.decrypt()).secret, marker);

  assert.deepEqual(await vault.save(marker), { ok: true, status: "stored" });
  const second = stores.snapshot();
  assert.notDeepEqual(second.record.iv, first.record.iv);
  assert.notDeepEqual(second.record.ciphertext, first.record.ciphertext);
  assert.equal((await vault.decrypt()).secret, marker);
});

test("vault persiste entre workers y exige versión, CUIT y CryptoKey válidos", async () => {
  const stores = memoryVaultStores();
  const firstWorker = background.createVaultController({
    cryptoApi: global.crypto,
    keyStore: stores.keyStore,
    recordStore: stores.recordStore
  });
  const marker = ["synthetic", "restart", Date.now()].join("-");
  await firstWorker.save(marker);
  const restartedWorker = background.createVaultController({
    cryptoApi: global.crypto,
    keyStore: stores.keyStore,
    recordStore: stores.recordStore
  });
  assert.equal((await restartedWorker.decrypt()).secret, marker);
  const wrongAadWorker = background.createVaultController({
    cryptoApi: global.crypto,
    keyStore: stores.keyStore,
    recordStore: stores.recordStore,
    aadValue: `${background.VAULT_AAD}|unexpected`
  });
  assert.equal((await wrongAadWorker.decrypt()).status, "invalid");
  assert.equal(stores.snapshot().record, null);
  assert.equal(stores.snapshot().key, null);

  await restartedWorker.save(marker);
  const corrupted = stores.snapshot().record;
  corrupted.cuit = "20398041064";
  await stores.recordStore.set(corrupted);
  assert.equal((await restartedWorker.decrypt()).status, "invalid");
  assert.equal(stores.snapshot().record, null);
  assert.equal(stores.snapshot().key, null);
});

test("corrupción, auth tag inválido, clave ausente y Olvidar limpian vault", async () => {
  for (const failure of ["ciphertext", "missing-key", "forget"]) {
    const stores = memoryVaultStores();
    const vault = background.createVaultController({
      cryptoApi: global.crypto,
      keyStore: stores.keyStore,
      recordStore: stores.recordStore
    });
    await vault.save(`synthetic-${failure}`);
    if (failure === "ciphertext") {
      const record = stores.snapshot().record;
      record.ciphertext[0] ^= 1;
      await stores.recordStore.set(record);
      assert.equal((await vault.decrypt()).status, "invalid");
    } else if (failure === "missing-key") {
      await stores.keyStore.remove();
      assert.equal((await vault.decrypt()).status, "invalid");
    } else {
      assert.equal((await vault.forget()).status, "forgotten");
    }
    assert.equal(stores.snapshot().record, null);
    assert.equal(stores.snapshot().key, null);
  }
});

test("autorización y consumo del login rechazan otros hosts ARCA", () => {
  const loginSender = {
    tab: { id: 10 },
    frameId: 0,
    url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
  };
  assert.equal(background.trustedLoginSender(loginSender), true);
  assert.equal(background.trustedLoginSender({
    ...loginSender,
    url: "https://fe.afip.gob.ar/rcel/"
  }), false);
  assert.equal(background.trustedLoginSender({
    ...loginSender,
    url: "https://serviciosjava2.afip.gob.ar/rcel/"
  }), false);
  assert.equal(background.trustedLoginSender({
    ...loginSender,
    url: "https://auth.afip.gob.ar/otra.xhtml"
  }), false);
});

test("flujo feliz aplica el setter al password una vez, emite eventos y pulsa Ingresar una vez", () => {
  const dom = authDomFixture("password");
  const marker = ["synthetic", "dom", Date.now()].join("-");
  withAuthDom(dom, () => {
    let consumeCount = 0;
    global.chrome.runtime.sendMessage = (message, callback) => {
      dom.messages.push(message);
      if (message.type === "CONSUME_ENCRYPTED_CREDENTIAL") {
        consumeCount += 1;
        callback({ ok: true, status: "consumed", secret: marker });
      } else if (message.type === "AUTHORIZE_LOGIN_ACTION") {
        callback({ ok: true, stage: message.stage });
      } else if (callback) callback({ ok: true });
    };
    content.setActiveSessionForTesting({ sessionId: "login-once", payload: {} });
    content.runLoginAutomationForTesting();
    content.runLoginAutomationForTesting();
    assert.equal(consumeCount, 1);
    assert.equal(dom.counters.passwordClick, 1);
    assert.equal(dom.counters.enter, 1);
    assert.deepEqual(
      dom.events.filter((event) => event.startsWith("F1:password:")),
      ["F1:password:focus", "F1:password:click", "F1:password:input", "F1:password:change"]
    );
    assert.equal(dom.writes.length, 1);
    assert.equal(dom.reads.includes("F1:password"), false);
  });
});

test("popup sólo delega guardado cifrado, nunca muestra el secreto y usa CSP MV3", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "tools/arca-extension/manifest.json"), "utf8"));
  const popupHtml = fs.readFileSync(path.join(root, "tools/arca-extension/popup.html"), "utf8");
  const popupScript = fs.readFileSync(path.join(root, "tools/arca-extension/popup.js"), "utf8");
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "clipboardWrite", "storage"]);
  assert.doesNotMatch(popupScript, /storage|localStorage|indexedDB|cookie|console\./i);
  assert.match(popupHtml, /type="password"/);
  assert.match(popupHtml, /Guardar cifrada/);
  assert.match(popupHtml, /Olvidar clave/);
  assert.match(popupHtml, /Copiar diagn.stico seguro/);
  assert.match(popupScript, /GET_SAFE_SESSION_TRACE/);
  assert.doesNotMatch(popupHtml, /<script[^>]*>[^<]+/i);
  assert.doesNotMatch(popupScript, /textContent\s*=\s*(secret|input\.value)/);
});

test("contrato exige revisión exclusiva y rechaza cualquier clave sensible", () => {
  assert.equal(background.validatePreparedMessage(safeMessage()), true);
  const withPassword = safeMessage();
  withPassword.payload.password = "nunca";
  assert.equal(background.validatePreparedMessage(withPassword), false);
  const withCookie = safeMessage();
  withCookie.payload.customer.cookie = "nunca";
  assert.equal(background.validatePreparedMessage(withCookie), false);
  const emissionEnabled = safeMessage();
  emissionEnabled.payload.finalSubmissionAllowed = true;
  assert.equal(background.validatePreparedMessage(emissionEnabled), false);
  const staleContract = safeMessage();
  staleContract.payload.contractVersion -= 1;
  assert.equal(background.validatePreparedMessage(staleContract), false);
  const wrongRepresentative = safeMessage();
  wrongRepresentative.payload.automation.representativeCuit = "30123456789";
  assert.equal(background.validatePreparedMessage(wrongRepresentative), false);
  const wrongVat = safeMessage();
  wrongVat.payload.lines[0].vatRate = 10.5;
  assert.equal(background.validatePreparedMessage(wrongVat), false);
  const wrongRecipient = safeMessage();
  wrongRecipient.payload.invoice.recipientCondition = "exento";
  assert.equal(background.validatePreparedMessage(wrongRecipient), false);
  const invalidDate = safeMessage();
  invalidDate.payload.invoice.invoiceDate = "2026-02-30";
  assert.equal(background.validatePreparedMessage(invalidDate), false);
  const invalidUnits = safeMessage();
  invalidUnits.payload.lines[0].quantity = -20;
  assert.equal(background.validatePreparedMessage(invalidUnits), false);
  const invalidDiscount = safeMessage();
  invalidDiscount.payload.lines[0].discountPercent = 101;
  assert.equal(background.validatePreparedMessage(invalidDiscount), false);
  const incoherentTotals = safeMessage();
  incoherentTotals.payload.invoice.totals.total = 2177;
  assert.equal(background.validatePreparedMessage(incoherentTotals), false);
  const nonFiniteAmount = safeMessage();
  nonFiniteAmount.payload.lines[0].unitPrice = Number.NaN;
  assert.equal(background.validatePreparedMessage(nonFiniteAmount), false);
});

test("mensajes externos sólo aceptan loopback explícito", () => {
  assert.equal(background.trustedExternalSender({ url: "http://127.0.0.1:3000/" }), true);
  assert.equal(background.trustedExternalSender({ url: "http://127.0.0.1:3300/" }), false);
  assert.equal(background.trustedExternalSender({ url: "http://localhost:3000/" }), false);
  assert.equal(background.trustedExternalSender({ url: "https://example.com/" }), false);
});

test("PING negocia la versión vigente antes de preparar una sesión", async () => {
  assert.equal(fiscal.CONTRACT.version, 5);
  const response = await background.externalMessage(
    { type: "PING" },
    { url: "http://127.0.0.1:3000/" }
  );
  assert.deepEqual(response, {
    ok: true,
    contractVersion: fiscal.CONTRACT.version,
    mode: "review_only"
  });
  assert.equal(frontend.extensionContractCompatibilityError(response), "");
  assert.match(frontend.extensionContractCompatibilityError({
    ...response,
    contractVersion: 3
  }), /Recargala desde chrome:\/\/extensions/);
  assert.equal(
    frontend.extensionContractCompatibilityError({ ok: true, mode: "review_only" }),
    "Contrato incompatible."
  );
});

test("PING contrato 5 distingue y limpia una preparación contrato 4 de un backend stale", async () => {
  const originalChrome = global.chrome;
  const stored = {};
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      session: {
        get(key, callback) {
          callback({ [key]: stored[key] ? structuredClone(stored[key]) : undefined });
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    tabs: {
      create(_options, callback) {
        callback({ id: 73 });
      },
      sendMessage(_tabId, _message, callback) {
        callback();
      }
    }
  };
  try {
    const staleSession = safeMessage();
    await background.writeSessionRecords({
      stale: {
        id: "stale",
        payload: staleSession.payload,
        orderId: "9",
        status: "waiting_login",
        stage: "login",
        reason: "",
        tabId: 41,
        updatedAt: new Date().toISOString(),
        expiresAt: Date.now() + 60_000
      }
    });
    const staleContract = safeMessage();
    staleContract.payload.contractVersion = 4;
    const response = await background.externalMessage(
      staleContract,
      { url: "http://127.0.0.1:3000/" }
    );
    assert.deepEqual(response, {
      ok: false,
      status: "rejected",
      reason: "contract_incompatible",
      contractVersion: 5
    });
    assert.deepEqual(stored[background.SESSION_STORAGE_KEY], {});
    assert.match(frontend.extensionPreparationError(response), /Reiniciá el servidor local/);
    assert.doesNotMatch(frontend.extensionPreparationError(response), /payload|cuit|revision/i);

    const fresh = safeMessage();
    fresh.sessionId = "22345678-1234-1234-1234-123456789012";
    const accepted = await background.externalMessage(
      fresh,
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.status, "waiting_login");
    assert.equal(stored[background.SESSION_STORAGE_KEY][fresh.sessionId].tabId, 73);
  } finally {
    global.chrome = originalChrome;
  }
});

test("preparación diferencia payload inválido, vencimiento, origen y asociación fallida", async () => {
  const missingPayload = { type: "PREPARE_SESSION", sessionId: safeMessage().sessionId };
  assert.equal(background.preparedMessageRejectionReason(missingPayload), "payload_invalid");

  const invalidPayload = safeMessage();
  invalidPayload.payload.automation.activityCode = "999999";
  assert.equal(background.preparedMessageRejectionReason(invalidPayload), "payload_invalid");
  assert.match(frontend.extensionPreparationError({ reason: "payload_invalid" }), /contrato fiscal vigente/);

  const expired = safeMessage();
  expired.payload.expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal(background.preparedMessageRejectionReason(expired), "session_expired");
  assert.match(frontend.extensionPreparationError({ reason: "session_expired" }), /venció/);

  const originRejected = await background.externalMessage(
    safeMessage(),
    { url: "http://localhost:3000/" }
  );
  assert.equal(originRejected.reason, "origin_rejected");
  assert.match(frontend.extensionPreparationError(originRejected), /127\.0\.0\.1:3000/);
  assert.match(frontend.extensionPreparationError({ reason: "association_failed" }), /asociarse/);
  assert.match(frontend.extensionPreparationError({ reason: "manual_action_required" }), /clave cifrada/);
  assert.equal(frontend.safePreparationRejectionReason("association_failed"), "association_failed");
  assert.equal(frontend.safePreparationRejectionReason("manual_action_required"), "manual_action_required");
  assert.equal(frontend.safePreparationRejectionReason("dato_interno"), "extension_unavailable");
});

test("preparación sin vault válido se detiene antes de abrir ARCA", async () => {
  background.setVaultControllerForTesting({
    status: async () => ({ ok: true, status: "empty" })
  });
  const response = await background.externalMessage(
    safeMessage(),
    { url: "http://127.0.0.1:3000/" }
  );
  assert.equal(response.ok, false);
  assert.equal(response.reason, "manual_action_required");
});

test("fallo al asociar pestaña se devuelve fail-closed y limpia el payload", async () => {
  const originalChrome = global.chrome;
  const stored = {};
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      session: {
        get(key, callback) {
          callback({ [key]: stored[key] ? structuredClone(stored[key]) : undefined });
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    tabs: {
      create(_options, callback) {
        callback(null);
      },
      sendMessage(_tabId, _message, callback) {
        callback();
      }
    }
  };
  try {
    const response = await background.externalMessage(
      safeMessage(),
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(response.ok, false);
    assert.equal(response.status, "interrupted");
    assert.equal(response.reason, "association_failed");
    assert.equal(stored[background.SESSION_STORAGE_KEY][safeMessage().sessionId], undefined);
    assert.deepEqual(stored[background.SESSION_TRACE_STORAGE_KEY], []);
  } finally {
    global.chrome = originalChrome;
  }
});

test("openArca conserva la preparación y no llama al backend con una extensión obsoleta", async () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalFetch = global.fetch;
  const status = { textContent: "", dataset: {} };
  const extensionId = { value: "a".repeat(32) };
  const openButton = { disabled: false };
  const sentMessages = [];
  let fetchCalls = 0;
  const prepared = {
    sessionId: safeMessage().sessionId,
    payload: safeMessage().payload,
    orderId: "10",
    prepareRequest: {
      orderId: "10",
      receiptType: "Factura_A",
      invoiceDate: "2026-07-30"
    }
  };
  global.document = {
    getElementById(id) {
      return {
        "arca-status": status,
        "arca-extension-id": extensionId,
        "arca-open": openButton
      }[id] || null;
    }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(_extensionId, message, callback) {
        sentMessages.push(message.type);
        callback({
          ok: true,
          contractVersion: fiscal.CONTRACT.version - 1,
          mode: "review_only"
        });
      }
    }
  };
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("El preflight no debe llamar al backend.");
  };
  frontend.__testing.state.prepared = prepared;
  frontend.__testing.state.sessionActive = false;
  try {
    await frontend.__testing.openArca();
    assert.deepEqual(sentMessages, ["PING"]);
    assert.equal(fetchCalls, 0);
    assert.equal(frontend.__testing.state.prepared, prepared);
    assert.equal(openButton.disabled, false);
    assert.match(status.textContent, /Recargala desde chrome:\/\/extensions/);
    assert.equal(status.dataset.status, "error");
  } finally {
    frontend.__testing.state.prepared = null;
    frontend.__testing.state.sessionActive = false;
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.fetch = originalFetch;
  }
});

test("openArca conserva la generación devuelta y la usa al cancelar una preparación tardía", async () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalRequestBackendApi = global.requestBackendApi;
  const status = { textContent: "", dataset: {} };
  const extensionId = { value: "a".repeat(32) };
  const sentMessages = [];
  let prepareCallback = null;
  const prepared = {
    sessionId: safeMessage().sessionId,
    payload: safeMessage().payload,
    orderId: "10",
    prepareRequest: {
      orderId: "10",
      receiptType: "Factura_A",
      invoiceDate: "2026-07-30"
    }
  };
  global.document = {
    getElementById(id) {
      return {
        "arca-status": status,
        "arca-extension-id": extensionId
      }[id] || null;
    }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(_extensionId, message, callback) {
        sentMessages.push(structuredClone(message));
        if (message.type === "PING") {
          callback({
            ok: true,
            contractVersion: fiscal.CONTRACT.version,
            mode: "review_only"
          });
        } else if (message.type === "PREPARE_SESSION") {
          prepareCallback = callback;
        } else {
          callback({ ok: true, status: "interrupted" });
        }
      }
    }
  };
  global.requestBackendApi = async (url) => {
    if (url === "/api/sales/arca/prepare") {
      return { sessionId: prepared.sessionId, payload: structuredClone(prepared.payload) };
    }
    if (url === "/api/sales/arca/audit") return { ok: true };
    throw new Error(`Ruta inesperada: ${url}`);
  };
  frontend.__testing.state.prepared = prepared;
  frontend.__testing.state.sessionActive = false;
  frontend.__testing.state.auditedTerminalStatus = "";
  try {
    const opening = frontend.__testing.openArca();
    for (let index = 0; index < 8 && !prepareCallback; index += 1) await Promise.resolve();
    assert.ok(prepareCallback);
    frontend.__testing.state.launchSequence += 1;
    prepareCallback({ ok: true, status: "waiting_login", generation: 27 });
    await opening;

    const cancellation = sentMessages.find((message) => message.type === "CANCEL_SESSION");
    assert.deepEqual(cancellation, {
      type: "CANCEL_SESSION",
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      generation: 27,
      closeTab: true
    });
    assert.equal(frontend.__testing.state.prepared.generation, 27);
  } finally {
    frontend.__testing.state.prepared = null;
    frontend.__testing.state.sessionActive = false;
    frontend.__testing.state.auditedTerminalStatus = "";
    global.chrome = originalChrome;
    global.document = originalDocument;
    if (originalRequestBackendApi === undefined) delete global.requestBackendApi;
    else global.requestBackendApi = originalRequestBackendApi;
  }
});

test("pagehide correlaciona la cancelación con la generación activa", () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalFetch = global.fetch;
  const extensionId = { value: "a".repeat(32) };
  const prepared = {
    sessionId: safeMessage().sessionId,
    payload: safeMessage().payload,
    orderId: "10",
    generation: 31
  };
  const sentMessages = [];
  global.document = {
    getElementById(id) {
      return id === "arca-extension-id" ? extensionId : null;
    }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(_extensionId, message, callback) {
        sentMessages.push(structuredClone(message));
        callback({ ok: true });
      }
    }
  };
  global.fetch = async () => ({ ok: true });
  frontend.__testing.state.prepared = prepared;
  frontend.__testing.state.sessionActive = true;
  try {
    frontend.__testing.cancelOnPageHide();
    assert.deepEqual(sentMessages, [{
      type: "CANCEL_SESSION",
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      generation: 31
    }]);
    assert.equal(frontend.__testing.state.sessionActive, false);
    assert.equal(frontend.__testing.state.prepared, null);
  } finally {
    frontend.__testing.state.prepared = null;
    frontend.__testing.state.sessionActive = false;
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.fetch = originalFetch;
  }
});

test("reducer único aplica la tabla completa, secuencia monotónica y bloqueo final", () => {
  const events = background.SESSION_EVENT;
  let reduced = background.reduceSession(null, {
    type: events.PREPARE,
    sessionId: safeMessage().sessionId,
    payload: safeMessage().payload,
    generation: 3,
    timestamp: "2026-07-31T12:00:00.000Z"
  });
  assert.equal(reduced.ok, true);
  assert.equal(reduced.session.sequence, 1);

  const apply = (event) => {
    const previousSequence = reduced.session.sequence;
    const next = background.reduceSession(reduced.session, event);
    assert.equal(next.ok, true, `${event.type}:${event.stage || ""}:${event.phase || ""}`);
    assert.equal(next.session.sequence, previousSequence + 1);
    reduced = next;
  };

  apply({ type: events.ASSOCIATE_TAB, tabId: 73 });
  apply({ type: events.CLAIM_LOGIN_CUIT });
  apply({ type: events.CLAIM_LOGIN_PASSWORD });
  apply({ type: events.CONSUME_CREDENTIAL });
  apply({ type: events.COMPLETE_LOGIN });
  apply({ type: events.CLAIM_REPRESENTATIVE });
  apply({ type: events.CLAIM_SERVICE });
  for (const stage of ["initial", "emission", "recipient", "lines"]) {
    apply({ type: events.STAGE_PROGRESS, stage, phase: "started" });
    apply({ type: events.STAGE_PROGRESS, stage, phase: "completed" });
  }

  const regression = background.reduceSession(reduced.session, {
    type: events.STAGE_PROGRESS,
    stage: "initial",
    phase: "started"
  });
  assert.equal(regression.ok, false);
  const unsafeReview = background.reduceSession(reduced.session, {
    type: events.REVIEW_REACHED,
    finalSafe: false
  });
  assert.equal(unsafeReview.ok, false);
  apply({ type: events.REVIEW_REACHED, finalSafe: true });
  assert.equal(reduced.session.status, "review_reached");
  assert.equal(reduced.session.stage, "review");
  assert.equal(reduced.session.payload, null);
  assert.equal(background.reduceSession(reduced.session, {
    type: events.PAGE_DIAGNOSTIC,
    reason: "selector_changed"
  }).ok, false);
  assert.ok(background.SESSION_TRANSITIONS[events.COMPLETE_LOGIN]);
});

test("sesión preparada sobrevive al reinicio del service worker y queda ligada a una sola pestaña", async () => {
  const originalChrome = global.chrome;
  const stored = {};
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      session: {
        get(key, callback) {
          const result = { [key]: stored[key] ? structuredClone(stored[key]) : undefined };
          callback(result);
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    tabs: {
      create(_options, callback) {
        callback({ id: 73 });
      },
      sendMessage(_tabId, _message, callback) {
        callback();
      },
      remove(_tabId, callback) {
        callback();
      }
    }
  };
  try {
    const prepared = await background.externalMessage(
      safeMessage(),
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(prepared.status, "waiting_login");
    assert.equal(prepared.stage, "login");

    const storageSnapshot = structuredClone(stored[background.SESSION_STORAGE_KEY]);
    assert.equal(storageSnapshot[safeMessage().sessionId].payload.order.id, "10");
    assert.equal(JSON.stringify(storageSnapshot).includes("password"), false);

    // La fuente de verdad es storage.session, no una variable global del worker.
    const restored = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      {
        tab: { id: 73 },
        frameId: 0,
        url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=rcel"
      }
    );
    assert.equal(restored.ok, true);
    assert.equal(restored.payload.order.id, "10");
    assert.equal(restored.revision, safeMessage().payload.revision);

    const restoredAfterOriginChange = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 0, url: "https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp" }
    );
    assert.equal(restoredAfterOriginChange.ok, true);
    assert.equal(restoredAfterOriginChange.stage, "login");
    assert.equal(restoredAfterOriginChange.sessionId, safeMessage().sessionId);
    assert.equal(restoredAfterOriginChange.revision, safeMessage().payload.revision);

    const wrongTab = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 74 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    const wrongFrame = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 2, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    const wrongHost = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 0, url: "https://example.com/rcel/" }
    );
    assert.equal(wrongTab.ok, false);
    assert.equal(wrongFrame.ok, false);
    assert.equal(wrongHost.ok, false);

    const authSender = {
      tab: { id: 73 },
      frameId: 0,
      url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
    };
    const correlated = (type, fields = {}) => ({
      type,
      sessionId: safeMessage().sessionId,
      revision: safeMessage().payload.revision,
      generation: prepared.generation,
      ...fields
    });
    const cuitClaim = await background.internalMessage(
      correlated("AUTHORIZE_LOGIN_ACTION", { stage: "login_cuit" }),
      authSender
    );
    const repeatedCuitClaim = await background.internalMessage(
      correlated("AUTHORIZE_LOGIN_ACTION", { stage: "login_cuit" }),
      authSender
    );
    const passwordClaim = await background.internalMessage(
      correlated("AUTHORIZE_LOGIN_ACTION", { stage: "login_password" }),
      authSender
    );
    const repeatedPasswordClaim = await background.internalMessage(
      correlated("AUTHORIZE_LOGIN_ACTION", { stage: "login_password" }),
      authSender
    );
    assert.equal(cuitClaim.ok, true);
    assert.equal(repeatedCuitClaim.ok, false);
    assert.equal(passwordClaim.ok, true);
    assert.equal(repeatedPasswordClaim.ok, false);
    const consumedCredential = await background.internalMessage(
      correlated("CONSUME_ENCRYPTED_CREDENTIAL"),
      authSender
    );
    const repeatedCredential = await background.internalMessage(
      correlated("CONSUME_ENCRYPTED_CREDENTIAL"),
      authSender
    );
    assert.equal(consumedCredential.ok, true);
    assert.equal(repeatedCredential.ok, false);
    const completedLogin = await background.internalMessage(
      correlated("COMPLETE_LOGIN_ACTION"),
      authSender
    );
    assert.equal(completedLogin.ok, true);
    assert.equal(
      JSON.stringify(stored[background.SESSION_STORAGE_KEY]).includes("fixture-no-real"),
      false
    );

    const wrongRevisionRepresentative = await background.internalMessage(
      {
        ...correlated("AUTHORIZE_INTERIM_ACTION", {
          stage: "representative",
          domContract: background.REPRESENTATIVE_DOM_CONTRACT
        }),
        revision: "b".repeat(64)
      },
      { tab: { id: 73 }, frameId: 0, url: "https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp" }
    );
    const wrongPathRepresentative = await background.internalMessage(
      correlated("AUTHORIZE_INTERIM_ACTION", {
        stage: "representative",
        domContract: background.REPRESENTATIVE_DOM_CONTRACT
      }),
      { tab: { id: 73 }, frameId: 0, url: "https://fe.afip.gob.ar/rcel/jsp/otra.jsp" }
    );
    assert.equal(wrongRevisionRepresentative.ok, false);
    assert.equal(wrongPathRepresentative.ok, false);

    const representative = await background.internalMessage(
      correlated("AUTHORIZE_INTERIM_ACTION", {
        stage: "representative",
        domContract: background.REPRESENTATIVE_DOM_CONTRACT
      }),
      { tab: { id: 73 }, frameId: 0, url: "https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp" }
    );
    assert.equal(representative.ok, true);
    assert.equal(representative.status, "waiting_representative");
    assert.equal(representative.stage, "representative");
    const lateAuthDocumentUpdate = await background.internalMessage(
      correlated("REPORT_PAGE_DIAGNOSTIC", { stage: "login", reason: "selector_changed" }),
      authSender
    );
    assert.equal(lateAuthDocumentUpdate.ok, true);
    assert.equal(stored[background.SESSION_STORAGE_KEY][safeMessage().sessionId].stage, "representative");
    const repeatedRepresentative = await background.internalMessage(
      correlated("AUTHORIZE_INTERIM_ACTION", {
        stage: "representative",
        domContract: background.REPRESENTATIVE_DOM_CONTRACT
      }),
      { tab: { id: 73 }, frameId: 0, url: "https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp" }
    );
    assert.equal(repeatedRepresentative.ok, false);
    assert.equal(repeatedRepresentative.stage, "representative");

    const visibleStatus = await background.externalMessage(
      { type: "GET_SESSION_STATUS", sessionId: safeMessage().sessionId },
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(visibleStatus.status, "waiting_representative");
    assert.equal(visibleStatus.orderId, "10");

    const authorizedService = await background.internalMessage(
      correlated("AUTHORIZE_INTERIM_ACTION", { stage: "service" }),
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(authorizedService.ok, true);
    assert.equal(authorizedService.stage, "service");
    const repeatedService = await background.internalMessage(
      correlated("AUTHORIZE_INTERIM_ACTION", { stage: "service" }),
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(repeatedService.ok, false);
    assert.equal(repeatedService.stage, "service");

    stored[background.SESSION_STORAGE_KEY][safeMessage().sessionId].expiresAt = Date.now() - 1;
    const expiredLoginClaim = await background.internalMessage(
      correlated("AUTHORIZE_LOGIN_ACTION", { stage: "login_password" }),
      authSender
    );
    assert.equal(expiredLoginClaim.ok, false);
    assert.equal(expiredLoginClaim.reason, "session_expired");
    assert.equal(stored[background.SESSION_STORAGE_KEY][safeMessage().sessionId].payload, null);
    assert.equal(stored[background.SESSION_STORAGE_KEY][safeMessage().sessionId].reason, "timeout");

    const replacement = safeMessage();
    replacement.sessionId = "22345678-1234-1234-1234-123456789012";
    replacement.payload.order.id = "11";
    const replacementStatus = await background.externalMessage(
      replacement,
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(replacementStatus.orderId, "11");
    const oldStatus = await background.externalMessage(
      { type: "GET_SESSION_STATUS", sessionId: safeMessage().sessionId },
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(oldStatus.ok, false);
    const replacementSession = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(replacementSession.payload.order.id, "11");
    const staleCancellation = await background.externalMessage(
      {
        type: "CANCEL_SESSION",
        sessionId: replacement.sessionId,
        revision: "b".repeat(64)
      },
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(staleCancellation.ok, false);
    const replacementCorrelated = (type, fields = {}) => ({
      type,
      sessionId: replacement.sessionId,
      revision: replacement.payload.revision,
      generation: replacementStatus.generation,
      ...fields
    });

    const terminal = await background.internalMessage(
      replacementCorrelated("REJECT_SESSION_SECURITY", {
        stage: "login", reason: "payload_invalid"
      }),
      { tab: { id: 73 }, frameId: 0, url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml" }
    );
    assert.equal(terminal.status, "interrupted");
    const terminalRecovery = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.deepEqual(terminalRecovery, {
      ok: false,
      status: "interrupted",
      reason: "payload_invalid"
    });
    const lateUpdate = await background.internalMessage(
      replacementCorrelated("REPORT_STAGE_PROGRESS", {
        phase: "completed", stage: "lines"
      }),
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(lateUpdate.ok, false);
    assert.equal(stored[background.SESSION_STORAGE_KEY][replacement.sessionId].payload, null);
  } finally {
    global.chrome = originalChrome;
  }
});

test("snapshot real post-login ignora selector_changed tardío y conserva payload y revisión", async () => {
  const originalChrome = global.chrome;
  const prepared = safeMessage();
  const stored = {
    [background.SESSION_STORAGE_KEY]: {
      [prepared.sessionId]: {
        id: prepared.sessionId,
        payload: prepared.payload,
        orderId: prepared.payload.order.id,
        status: "waiting_representative",
        stage: "login",
        reason: "",
        tabId: 73,
        updatedAt: new Date().toISOString(),
        expiresAt: Date.parse(prepared.payload.expiresAt),
        generation: 9,
        sequence: 40,
        loginCuitSubmitted: true,
        loginPasswordSubmitted: true,
        loginCredentialConsumed: true,
        loginCompleted: true
      }
    }
  };
  global.chrome = sessionChrome(stored);
  try {
    const legacyTerminal = await background.internalMessage({
      type: "UPDATE_SESSION",
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      generation: 9,
      status: "interrupted",
      stage: "",
      reason: "selector_changed"
    }, {
      tab: { id: 73 },
      frameId: 0,
      url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
    });
    assert.equal(legacyTerminal.ok, false);

    const diagnostic = await background.internalMessage({
      type: "REPORT_PAGE_DIAGNOSTIC",
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      generation: 9,
      stage: "",
      reason: "selector_changed"
    }, {
      tab: { id: 73 },
      frameId: 0,
      url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
    });
    assert.equal(diagnostic.ok, true);
    const snapshot = stored[background.SESSION_STORAGE_KEY][prepared.sessionId];
    assert.equal(snapshot.status, "waiting_representative");
    assert.equal(snapshot.stage, "login");
    assert.equal(snapshot.loginCompleted, true);
    assert.equal(snapshot.payload.revision, prepared.payload.revision);
    assert.equal(snapshot.sequence, 41);

    const recovered = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 0, url: "https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp" }
    );
    assert.equal(recovered.ok, true);
    assert.equal(recovered.status, "waiting_representative");
    assert.equal(recovered.stage, "login");
    assert.equal(recovered.revision, prepared.payload.revision);
  } finally {
    global.chrome = originalChrome;
  }
});

test("generación anterior no puede terminalizar una preparación reemplazada con igual correlación", async () => {
  const originalChrome = global.chrome;
  const stored = {};
  global.chrome = sessionChrome(stored);
  try {
    const message = safeMessage();
    const first = await background.externalMessage(message, { url: "http://127.0.0.1:3000/" });
    const second = await background.externalMessage(message, { url: "http://127.0.0.1:3000/" });
    assert.ok(second.generation > first.generation);

    const staleTerminal = await background.internalMessage({
      type: "REJECT_SESSION_SECURITY",
      sessionId: message.sessionId,
      revision: message.payload.revision,
      generation: first.generation,
      stage: "login",
      reason: "payload_invalid"
    }, {
      tab: { id: 73 },
      frameId: 0,
      url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
    });
    assert.equal(staleTerminal.ok, false);
    const active = stored[background.SESSION_STORAGE_KEY][message.sessionId];
    assert.equal(active.generation, second.generation);
    assert.equal(active.status, "waiting_login");
    assert.ok(active.payload);
  } finally {
    global.chrome = originalChrome;
  }
});

test("CANCEL_SESSION externo exige la generación vigente aunque sesión y revisión coincidan", async () => {
  const originalChrome = global.chrome;
  const stored = {};
  global.chrome = sessionChrome(stored);
  try {
    const message = safeMessage();
    const first = await background.externalMessage(message, { url: "http://127.0.0.1:3000/" });
    const second = await background.externalMessage(message, { url: "http://127.0.0.1:3000/" });
    assert.ok(second.generation > first.generation);

    const staleCancellation = await background.externalMessage({
      type: "CANCEL_SESSION",
      sessionId: message.sessionId,
      revision: message.payload.revision,
      generation: first.generation
    }, { url: "http://127.0.0.1:3000/" });
    assert.equal(staleCancellation.ok, false);
    assert.equal(stored[background.SESSION_STORAGE_KEY][message.sessionId].generation, second.generation);
    assert.ok(stored[background.SESSION_STORAGE_KEY][message.sessionId].payload);

    const missingGeneration = await background.externalMessage({
      type: "CANCEL_SESSION",
      sessionId: message.sessionId,
      revision: message.payload.revision
    }, { url: "http://127.0.0.1:3000/" });
    assert.equal(missingGeneration.ok, false);
    assert.ok(stored[background.SESSION_STORAGE_KEY][message.sessionId].payload);

    const currentCancellation = await background.externalMessage({
      type: "CANCEL_SESSION",
      sessionId: message.sessionId,
      revision: message.payload.revision,
      generation: second.generation
    }, { url: "http://127.0.0.1:3000/" });
    assert.equal(currentCancellation.status, "interrupted");
    assert.equal(stored[background.SESSION_STORAGE_KEY][message.sessionId], undefined);
    assert.deepEqual(stored[background.SESSION_TRACE_STORAGE_KEY], []);
  } finally {
    global.chrome = originalChrome;
  }
});

test("TTL elimina el payload de storage.session y devuelve una interrupción cerrada", async () => {
  const originalChrome = global.chrome;
  const stored = {};
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      session: {
        get(key, callback) {
          callback({ [key]: stored[key] ? structuredClone(stored[key]) : undefined });
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    tabs: {
      sendMessage(_tabId, _message, callback) {
        callback();
      }
    }
  };
  try {
    const sessionId = safeMessage().sessionId;
    await background.writeSessionRecords({
      [sessionId]: {
        id: sessionId,
        orderId: "10",
        payload: safeMessage().payload,
        status: "waiting_login",
        stage: "login",
        reason: "",
        tabId: 73,
        updatedAt: new Date().toISOString(),
        expiresAt: Date.now() - 1
      }
    });
    const response = await background.externalMessage(
      { type: "GET_SESSION_STATUS", sessionId },
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(response.status, "interrupted");
    assert.equal(response.reason, "timeout");
    assert.equal(stored[background.SESSION_STORAGE_KEY][sessionId].payload, null);
  } finally {
    global.chrome = originalChrome;
  }
});

test("alarma MV3 elimina el payload aun sin polling ni navegación", async () => {
  const originalChrome = global.chrome;
  const modulePath = require.resolve("../tools/arca-extension/background.js");
  const stored = {};
  let alarmListener = null;
  let createdAlarm = null;
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      session: {
        get(key, callback) {
          callback({ [key]: stored[key] ? structuredClone(stored[key]) : undefined });
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    alarms: {
      create(name, options) {
        createdAlarm = { name, options };
      },
      clear(_name, callback) {
        callback();
      },
      onAlarm: {
        addListener(listener) {
          alarmListener = listener;
        }
      }
    },
    tabs: {
      sendMessage(_tabId, _message, callback) {
        callback();
      }
    }
  };
  delete require.cache[modulePath];
  try {
    const alarmBackground = require(modulePath);
    const session = {
      id: safeMessage().sessionId,
      orderId: "10",
      payload: safeMessage().payload,
      status: "waiting_login",
      stage: "login",
      reason: "",
      tabId: 73,
      updatedAt: new Date().toISOString(),
      expiresAt: Date.now() - 1
    };
    await alarmBackground.writeSessionRecords({ [session.id]: session });
    alarmBackground.createExpiryAlarm(session);
    assert.equal(createdAlarm.name, alarmBackground.expiryAlarmName(session.id));
    alarmListener({ name: createdAlarm.name });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stored[alarmBackground.SESSION_STORAGE_KEY][session.id].payload, null);
    assert.equal(stored[alarmBackground.SESSION_STORAGE_KEY][session.id].status, "interrupted");
  } finally {
    delete require.cache[modulePath];
    global.chrome = originalChrome;
  }
});

test("invariante de no submit: sólo existe el click único permitido sobre password", () => {
  const source = fs.readFileSync(path.join(root, "tools/arca-extension/content-script.js"), "utf8");
  const passwordClicks = source.match(/verified\.password\.click\s*\(\)/g) || [];
  const sourceWithoutPasswordClick = source.replace(/verified\.password\.click\s*\(\)/g, "");

  assert.equal(passwordClicks.length, 1);
  assert.doesNotMatch(sourceWithoutPasswordClick, /\.click\s*\(/);
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /requestSubmit\s*\(/);
  assert.match(source, /dispatchEvent\(new MouseEvent\("click"/);
  assert.match(content.FINAL_ACTION_PATTERN.source, /confirmar/i);
  assert.equal(content.FINAL_ACTION_PATTERN.test("Obtener CAE"), true);
  assert.equal(content.FINAL_ACTION_PATTERN.test("Presentar"), true);
  assert.equal(content.interimActionAllowed({ value: "Continuar" }, "emission"), true);
  assert.equal(content.interimActionAllowed({ value: "Continuar >" }, "initial"), true);
  assert.equal(content.interimActionAllowed({ value: "Ingresar" }, "login_password"), true);
  assert.equal(content.interimActionAllowed({ value: "Confirmar" }, "review"), false);
  assert.equal(content.interimActionAllowed({ value: "Generar comprobantes" }, "service"), true);
  assert.equal(content.interimActionAllowed({ value: "Generar" }, "service"), false);
});

test("eventos sintéticos finales se bloquean en captura", () => {
  const originalDocument = global.document;
  const listeners = {};
  global.document = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
  try {
    content.blockSyntheticFinalActions();
    let prevented = false;
    let stopped = false;
    const control = { value: "Confirmar" };
    listeners.click({
      isTrusted: false,
      target: { closest: () => control },
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; }
    });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
  } finally {
    global.document = originalDocument;
  }
});

test("frontend valida ID y sugiere comprobante sólo desde condiciones explícitas", () => {
  assert.equal(frontend.validExtensionId("a".repeat(32)), true);
  assert.equal(frontend.validExtensionId("z".repeat(32)), false);
  assert.equal(frontend.suggestReceiptType("responsable_inscripto", "responsable_inscripto"), "Factura_A");
  assert.equal(frontend.suggestReceiptType("responsable_inscripto", "exento"), "Factura_B");
  assert.equal(frontend.suggestReceiptType("responsable_inscripto", "monotributista"), "");
  assert.equal(frontend.suggestReceiptType("monotributista", "responsable_inscripto"), "");
  assert.equal(frontend.suggestReceiptType("", "consumidor_final"), "");
});

test("la lista presenta entrega prevista y marca hoy o mañana según calendario argentino", () => {
  const nearMidnightUtc = new Date("2026-07-31T02:30:00.000Z");
  const previousEscapeHtml = global.escapeHtml;
  const previousFormatDate = global.formatDate;
  global.escapeHtml = (value) => String(value);
  global.formatDate = (value) => {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  };

  try {
    assert.equal(frontend.argentinaCalendarIso(nearMidnightUtc), "2026-07-30");
    assert.equal(frontend.expectedDeliveryTiming("2026-07-30", nearMidnightUtc), "today");
    assert.equal(frontend.expectedDeliveryTiming("2026-07-31", nearMidnightUtc), "tomorrow");
    assert.equal(frontend.expectedDeliveryTiming("2026-08-01", nearMidnightUtc), "");
    assert.equal(frontend.expectedDeliveryTiming("2026-07-29", nearMidnightUtc), "");
    assert.match(frontend.expectedDeliveryMarkup("2026-07-30", "today"), /30\/07\/2026[\s\S]*Entrega hoy/);
    assert.match(frontend.expectedDeliveryMarkup("2026-07-31", "tomorrow"), /31\/07\/2026[\s\S]*Entrega mañana/);
    assert.equal(frontend.expectedDeliveryMarkup(""), "Sin fecha prevista");
    assert.equal(frontend.expectedDeliveryMarkup("2026-02-30"), "Sin fecha prevista");
  } finally {
    global.escapeHtml = previousEscapeHtml;
    global.formatDate = previousFormatDate;
  }
});

test("fixture de extensión mapea campos permitidos y aborta pantallas inesperadas", () => {
  const payload = safeMessage().payload;
  payload.invoice.receiptType = "Factura_A";
  payload.customer.fiscalCondition = "responsable_inscripto";
  payload.customer.address = "Domicilio de prueba";
  payload.lines[0].description = "2 Barra - Entrega: Domicilio de prueba";

  assert.deepEqual(content.buildFieldPlan("initial", payload), [
    {
      labels: ["Punto de Ventas a utilizar", "Punto de Venta", "Punto de venta"],
      value: "00001",
      matchBy: "numeric_identifier"
    },
    {
      label: "Tipo de Comprobante",
      value: "Factura_A",
      optionText: "Factura A",
      matchBy: "visible_text"
    }
  ]);
  assert.deepEqual(content.buildFieldPlan("recipient", payload).map((field) => field.label), [
    "CUIT",
    "Condición frente al IVA",
    undefined
  ]);
  assert.deepEqual(content.buildFieldPlan("emission", payload).map((field) => field.value), [
    "2026-07-30",
    "Productos",
    "Elaboración de alimentos o bases de cereales"
  ]);
  assert.equal(content.classifyPage("La sesión ha expirado", false, "serviciosjava2.afip.gob.ar"), "session_expired");
  assert.equal(content.classifyPage("No se puede acceder al sitio. ERR_CONNECTION_RESET", false, "serviciosjava2.afip.gob.ar"), "network_error");
  assert.equal(content.classifyPage("Revisión de datos del comprobante", true, "serviciosjava2.afip.gob.ar"), "review");
  assert.equal(content.classifyPage("Seleccione la empresa representada", false, "fe.afip.gob.ar"), "representative_selection");
  assert.equal(content.classifyPage("Comprobantes en línea - Generar comprobantes", false, "serviciosjava2.afip.gob.ar"), "service_menu");
  assert.equal(content.classifyPage("Pantalla final. Generar comprobantes", true, "serviciosjava2.afip.gob.ar"), "unrecognized");
  assert.equal(content.classifyPage("Mis Comprobantes - consultar comprobantes", false, "serviciosjava2.afip.gob.ar"), "unrecognized");
  assert.equal(content.classifyPage("Punto de Venta y Tipo de Comprobante", false, "serviciosjava2.afip.gob.ar"), "initial");
  assert.equal(content.classifyPage("Paso 1 - Datos de emisión", false, "serviciosjava2.afip.gob.ar"), "emission");
  assert.equal(content.classifyPage("Pantalla nueva", false, "serviciosjava2.afip.gob.ar"), "unrecognized");
  assert.equal(content.classifyPage("Seleccione la empresa representada", false, "example.com"), "outside_service");
  assert.equal(content.payloadCoherenceIsValid(payload), true);
  payload.customer.fiscalCondition = "exento";
  assert.equal(content.payloadCoherenceIsValid(payload), false);
});

test("punto de venta se resuelve sólo por identificador único de cinco dígitos", () => {
  const select = {
    tagName: "SELECT",
    options: [
      { value: "1", textContent: "00001 — Arenales 2955, piso 7" },
      { value: "2", textContent: "000002 — Otro domicilio" }
    ]
  };
  assert.equal(content.exactOption(select, "00001", "", "numeric_identifier")?.value, "1");
  select.options[0] = { value: "1", textContent: "000002 — Otro domicilio" };
  assert.equal(content.exactOption(select, "00001", "", "numeric_identifier"), null);
  select.options[0] = { value: "1", textContent: "00001 — Arenales 2955, piso 7" };
  select.options.push({ value: "00001", textContent: "Punto alternativo" });
  assert.equal(content.exactOption(select, "00001", "", "numeric_identifier"), null);
});

test("pantalla inicial real selecciona punto 00001 y únicamente Factura A o B", () => {
  const originalDocument = global.document;
  const originalMouseEvent = global.MouseEvent;
  const dispatched = [];
  const clicked = [];
  const fixture = fs.readFileSync(
    path.join(root, "tests/fixtures/arca/initial-fields-legacy.html"),
    "utf8"
  );
  assert.match(fixture, /Puntos de Ventas y Tipos de Comprobantes habilitados para impresión/);
  assert.match(fixture, /Punto de Ventas a utilizar/);
  assert.match(fixture, /Tipo de Comprobante/);
  const point = {
    tagName: "SELECT",
    id: "puntodeventa",
    name: "puntodeventa",
    value: "",
    options: [
      { value: "", textContent: "seleccionar..." },
      {
        value: "1",
        textContent: "00001-Arenales 2955 Piso:7 Dpto:D - Ciudad de Buenos Aires"
      }
    ],
    dispatchEvent: (event) => dispatched.push(`point:${event.type}`)
  };
  const receiptOptions = [
    { value: "1", textContent: "Factura A" },
    { value: "2", textContent: "Nota de Débito A" },
    { value: "3", textContent: "Nota de Crédito A" },
    { value: "6", textContent: "Factura B" },
    { value: "7", textContent: "Nota de Débito B" },
    { value: "201", textContent: "Factura de Crédito Electrónica MiPyMEs (FCE) A" }
  ];
  const receipt = {
    tagName: "SELECT",
    id: "tipocomprobante",
    name: "tipocomprobante",
    value: "",
    options: [{ value: "", textContent: "seleccionar..." }],
    dispatchEvent: (event) => dispatched.push(`receipt:${event.type}`)
  };
  const row = (label, select) => ({
    querySelectorAll: (selector) => selector === "th, td"
      ? [{ textContent: label }, { textContent: "" }]
      : selector === "select" ? [select] : [],
    querySelector: (selector) => selector === "select" ? select : null
  });
  const rows = [row("Punto de Ventas a utilizar", point), row("Tipo de Comprobante", receipt)];
  const back = { value: "< Volver", dispatchEvent: () => clicked.push("back") };
  const next = {
    value: "Continuar >",
    disabled: false,
    getAttribute: () => null,
    dispatchEvent: (event) => {
      clicked.push(`next:${event.type}`);
      return true;
    }
  };
  const banner = { dataset: {}, textContent: "" };
  global.document = {
    body: { innerText: fixture },
    documentElement: { appendChild: () => {} },
    querySelectorAll: (selector) => selector === "tr"
      ? rows
      : selector === "button, input[type='submit'], input[type='button'], a"
        ? [back, next]
        : [],
    getElementById: (id) => id === "sunnutrition-arca-assistant" ? banner : null
  };
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  try {
    const payload = safeMessage().payload;
    payload.invoice.receiptType = "Factura_A";
    assert.deepEqual(content.completeInitialFields(payload), {
      ok: false,
      pending: true,
      reason: "receipt_options_pending"
    });
    assert.deepEqual([point.value, receipt.value], ["1", ""]);
    receipt.options = [{ value: "", textContent: "seleccionar..." }, ...receiptOptions];
    assert.deepEqual(content.completeInitialFields(payload), { ok: true, pending: false });
    assert.deepEqual([point.value, receipt.value], ["1", "1"]);
    assert.equal(content.findUniqueAction("Continuar")?.value, "Continuar >");
    content.setCurrentStageForTesting("initial");
    content.continueFromStage("Datos iniciales completos.", "initial");
    assert.deepEqual(clicked, ["next:click"]);
    payload.invoice.receiptType = "Factura_B";
    assert.deepEqual(content.completeInitialFields(payload), { ok: true, pending: false });
    assert.deepEqual([point.value, receipt.value], ["1", "6"]);
    assert.deepEqual(dispatched, [
      "point:input", "point:change",
      "receipt:input", "receipt:change",
      "receipt:input", "receipt:change"
    ]);

    receipt.value = "";
    receipt.options = [
      { value: "", textContent: "seleccionar..." },
      { value: "Factura A", textContent: "Nota de Débito A" }
    ];
    payload.invoice.receiptType = "Factura_A";
    assert.deepEqual(content.completeInitialFields(payload), {
      ok: false,
      pending: false,
      reason: "receipt_type_not_unique"
    });
    assert.equal(receipt.value, "");

    point.options = [{ value: "2", textContent: "00002" }];
    assert.deepEqual(content.completeInitialFields(payload), {
      ok: false,
      pending: false,
      reason: "point_of_sale_not_unique"
    });

    point.options = [{ value: "1", textContent: "00001" }];
    rows.push(row("Punto de Ventas a utilizar", { ...point }));
    assert.equal(content.initialScreenFields(), null);

    rows.pop();
    const conflictingPoint = { ...point };
    const pointLabel = {
      textContent: "Punto de Ventas a utilizar",
      getAttribute: () => "label-point",
      querySelector: () => null
    };
    global.document.getElementById = (id) => id === "label-point" ? conflictingPoint : null;
    global.document.querySelectorAll = (selector) => selector === "label"
      ? [pointLabel]
      : selector === "tr" ? rows : [];
    assert.equal(content.initialScreenFields(), null);
  } finally {
    global.document = originalDocument;
    global.MouseEvent = originalMouseEvent;
  }
});

test("código de producto exige conjuntamente código 4 y etiqueta esperada", () => {
  const select = {
    tagName: "SELECT",
    options: [{ value: "4", textContent: "Producto o servicio" }]
  };
  assert.equal(content.exactOption(select, "4", "Producto o servicio", "code_and_label")?.value, "4");
  select.options[0] = { value: "9", textContent: "Producto o servicio" };
  assert.equal(content.exactOption(select, "4", "Producto o servicio", "code_and_label"), null);
  select.options[0] = { value: "4", textContent: "Otro concepto" };
  assert.equal(content.exactOption(select, "4", "Producto o servicio", "code_and_label"), null);
});

function representativeDomFixture({
  personalValue = "  DE MAYO BENJAMIN  ",
  companyValue = "\nSUNNUTRITION S.A.\n"
} = {}) {
  const control = (value, target = "") => ({
    value,
    target,
    disabled: false,
    getAttribute: () => null,
    dispatchEvent: () => true
  });
  const personal = control(personalValue, "personal");
  const company = control(companyValue, "company");
  const controls = [personal, company];
  const hidden = { id: "idcontribuyente", name: "idContribuyente", type: "hidden" };
  const attributes = {
    action: "https://fe.afip.gob.ar/rcel/jsp/setearContribuyente.do",
    id: "",
    method: "get"
  };
  const form = {
    id: "",
    method: "get",
    action: attributes.action,
    getAttribute: (name) => attributes[name] ?? null,
    querySelectorAll(selector) {
      if (selector === 'input#idcontribuyente[name="idContribuyente"][type="hidden"]') return [hidden];
      if (selector === 'input[type="button"].btn_empresa') return controls;
      return [];
    }
  };
  const promptParts = [
    { textContent: "Seleccione la", children: [] },
    { textContent: "Empresa a representar:", children: [] }
  ];
  const prompt = {
    textContent: "\n  Seleccione la \n Empresa a representar:  \n",
    children: promptParts
  };
  const exit = control("Salir", "exit");
  const document = {
    title: "RCEL",
    querySelectorAll(selector) {
      if (selector === "body *") return [exit, prompt, ...promptParts, form, hidden, ...controls];
      if (selector === 'form[name="seleccionaEmpresaForm"]') return [form];
      return [];
    }
  };
  return { attributes, company, controls, document, exit, form, hidden, personal, prompt };
}

function representativeStartupFixture() {
  const fixture = representativeDomFixture();
  const listeners = [];
  let banner = null;
  fixture.document.body = {
    innerText: "Seleccione la Empresa a representar:",
    textContent: "Seleccione la Empresa a representar:"
  };
  const originalQuerySelectorAll = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector) => {
    if (selector === "button, input[type='submit'], input[type='button'], a") {
      return [fixture.exit, ...fixture.controls];
    }
    return originalQuerySelectorAll(selector);
  };
  fixture.document.getElementById = (id) => id === "sunnutrition-arca-assistant" ? banner : null;
  fixture.document.createElement = () => ({
    dataset: {},
    style: {},
    setAttribute() {}
  });
  fixture.document.documentElement = {
    appendChild(element) {
      banner = element;
    }
  };
  fixture.document.addEventListener = (type, listener, options) => {
    listeners.push({ type, listener, options });
  };
  return { ...fixture, get banner() { return banner; }, listeners };
}

test("inicialización nueva completa CUIT, recupera la sesión navegada y selecciona SUNNUTRITION una vez", () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalMouseEvent = global.MouseEvent;
  const originalMutationObserver = global.MutationObserver;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const realLogin = JSON.parse(fs.readFileSync(
    path.join(root, "tests/fixtures/arca/login-cuit-real.json"),
    "utf8"
  ));
  const auth = authDomFixture("cuit", {
    duplicateFormReferences: true,
    hiddenControls: realLogin.form.hiddenInputs,
    readyState: "loading"
  });
  const representative = representativeStartupFixture();
  const prepared = safeMessage();
  const messages = [];
  let companyClicks = 0;
  representative.company.dispatchEvent = (event) => {
    if (event.type === "click") companyClicks += 1;
    return true;
  };
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  global.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
  };
  global.setTimeout = () => 1;
  global.clearTimeout = () => {};
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === "GET_ACTIVE_SESSION") {
          callback({
            ok: true,
            sessionId: prepared.sessionId,
            revision: prepared.payload.revision,
            payload: prepared.payload,
            status: "waiting_login",
            stage: "login"
          });
        } else if (message.type === "AUTHORIZE_LOGIN_ACTION") {
          callback({ ok: true, status: "waiting_login", stage: "login_cuit" });
        } else if (message.type === "AUTHORIZE_INTERIM_ACTION") {
          callback({ ok: true, status: "waiting_representative", stage: "representative" });
        } else callback({ ok: true });
      }
    }
  };
  try {
    content.resetLoginStateForTesting();
    global.document = auth.document;
    global.location = new URL(realLogin.url);
    content.startForTesting();
    assert.equal(auth.counters.next, 0);
    assert.match(auth.banner.textContent, /Usando la clave efímera preparada/);
    auth.document.readyState = "interactive";
    auth.listeners.find((listener) => listener.type === "DOMContentLoaded")?.listener();
    assert.deepEqual(auth.writes, [{ name: "F1:username", value: "20398041063" }]);
    assert.equal(auth.counters.next, 1);

    content.resetLoginStateForTesting();
    global.document = representative.document;
    global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
    content.startForTesting();
    content.runRecognizedStageForTesting();
    assert.equal(companyClicks, 1);
    assert.equal(messages.filter((message) => message.type === "GET_ACTIVE_SESSION").length, 2);
    assert.equal(messages.filter((message) => message.type === "AUTHORIZE_LOGIN_ACTION").length, 1);
    assert.equal(messages.filter((message) => message.type === "AUTHORIZE_INTERIM_ACTION").length, 1);
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.location = originalLocation;
    global.MouseEvent = originalMouseEvent;
    global.MutationObserver = originalMutationObserver;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("E2E con background real mantiene activa la sesión desde CUIT hasta SUNNUTRITION", async () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalMouseEvent = global.MouseEvent;
  const originalMutationObserver = global.MutationObserver;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const stored = {};
  const preparedMessage = safeMessage();
  const realLogin = JSON.parse(fs.readFileSync(
    path.join(root, "tests/fixtures/arca/login-cuit-real.json"),
    "utf8"
  ));
  const authCuit = authDomFixture("cuit", {
    duplicateFormReferences: true,
    hiddenControls: realLogin.form.hiddenInputs
  });
  const authPassword = authDomFixture("password");
  const representative = representativeStartupFixture();
  const activeSessionResponses = [];
  let companyClicks = 0;
  let runtimeQueue = Promise.resolve();

  representative.company.dispatchEvent = (event) => {
    if (event.type === "click") companyClicks += 1;
    return true;
  };
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  global.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
  };
  global.setTimeout = () => 1;
  global.clearTimeout = () => {};
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        const sender = {
          tab: { id: 73 },
          frameId: 0,
          url: String(global.location?.href || "")
        };
        const operation = runtimeQueue.then(() => background.internalMessage(message, sender));
        runtimeQueue = operation.catch(() => {});
        operation.then((response) => {
          if (message.type === "GET_ACTIVE_SESSION") activeSessionResponses.push(response);
          callback?.(response);
        });
      }
    },
    storage: {
      session: {
        get(key, callback) {
          callback({ [key]: stored[key] ? structuredClone(stored[key]) : undefined });
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    tabs: {
      create(_options, callback) { callback({ id: 73 }); },
      sendMessage(_tabId, _message, callback) { callback?.(); },
      remove(_tabId, callback) { callback?.(); }
    },
    alarms: {
      create() {},
      clear(_name, callback) { callback?.(); }
    }
  };
  async function drainRuntimeQueue() {
    for (let index = 0; index < 12; index += 1) {
      const observed = runtimeQueue;
      await observed;
      await Promise.resolve();
      if (observed === runtimeQueue) return;
    }
    throw new Error("runtime_queue_did_not_settle");
  }
  async function publicStatus() {
    return background.externalMessage(
      { type: "GET_SESSION_STATUS", sessionId: preparedMessage.sessionId },
      { url: "http://127.0.0.1:3000/" }
    );
  }
  try {
    const prepared = await background.externalMessage(
      preparedMessage,
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(prepared.status, "waiting_login");

    content.resetLoginStateForTesting();
    global.document = authCuit.document;
    global.location = new URL(realLogin.url);
    content.startForTesting();
    await drainRuntimeQueue();
    assert.equal(authCuit.counters.next, 1);
    assert.deepEqual(authCuit.writes, [{ name: "F1:username", value: "20398041063" }]);
    assert.equal((await publicStatus()).status, "waiting_login");

    content.resetLoginStateForTesting();
    global.document = authPassword.document;
    global.location = new URL(realLogin.url);
    content.startForTesting();
    await drainRuntimeQueue();
    assert.equal(authPassword.counters.enter, 1);
    const afterLogin = await publicStatus();
    assert.equal(afterLogin.status, "waiting_representative");
    assert.equal(afterLogin.stage, "login");
    assert.ok(stored[background.SESSION_STORAGE_KEY][preparedMessage.sessionId].payload);
    assert.equal(stored[background.SESSION_STORAGE_KEY][preparedMessage.sessionId].loginCompleted, true);
    const lateLoginInterruption = await background.internalMessage(
      {
        type: "REPORT_PAGE_DIAGNOSTIC",
        sessionId: preparedMessage.sessionId,
        revision: preparedMessage.payload.revision,
        generation: prepared.generation,
        stage: "login",
        reason: "unexpected_response"
      },
      { tab: { id: 73 }, frameId: 0, url: realLogin.url }
    );
    assert.equal(lateLoginInterruption.status, "waiting_representative");
    assert.ok(stored[background.SESSION_STORAGE_KEY][preparedMessage.sessionId].payload);

    content.resetLoginStateForTesting();
    global.document = representative.document;
    global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
    content.startForTesting();
    await drainRuntimeQueue();
    content.runRecognizedStageForTesting();
    await drainRuntimeQueue();
    assert.equal(companyClicks, 1);
    const afterRepresentative = await publicStatus();
    assert.equal(afterRepresentative.status, "waiting_representative");
    assert.equal(afterRepresentative.stage, "representative");
    assert.equal(activeSessionResponses.length, 3);
    assert.equal(activeSessionResponses.every((response) => response.ok && response.status !== "interrupted"), true);
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.location = originalLocation;
    global.MouseEvent = originalMouseEvent;
    global.MutationObserver = originalMutationObserver;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("diagnóstico tardío queda serializado, no sobrescribe loginCompleted ni bloquea SUNNUTRITION", async () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalMouseEvent = global.MouseEvent;
  const originalMutationObserver = global.MutationObserver;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const prepared = safeMessage();
  const records = {
    [prepared.sessionId]: {
      id: prepared.sessionId,
      payload: prepared.payload,
      orderId: prepared.payload.order.id,
      status: "waiting_representative",
      stage: "login",
      reason: "",
      tabId: 73,
      updatedAt: new Date().toISOString(),
      expiresAt: Date.parse(prepared.payload.expiresAt),
      generation: 7,
      sequence: 20,
      loginCuitSubmitted: true,
      loginPasswordSubmitted: true,
      loginCredentialConsumed: true,
      loginCompleted: false
    }
  };
  const stored = { [background.SESSION_STORAGE_KEY]: structuredClone(records) };
  let getCalls = 0;
  let releaseTerminalReread = null;
  let holdSecondGet = true;
  let runtimeQueue = Promise.resolve();
  let companyClicks = 0;
  const authSender = {
    tab: { id: 73 },
    frameId: 0,
    url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
  };
  const correlated = (type, fields = {}) => ({
    type,
    sessionId: prepared.sessionId,
    revision: prepared.payload.revision,
    generation: 7,
    ...fields
  });
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      session: {
        get(key, callback) {
          getCalls += 1;
          if (holdSecondGet && getCalls === 2) {
            releaseTerminalReread = () => callback({
              [key]: structuredClone(stored[key])
            });
            return;
          }
          callback({ [key]: structuredClone(stored[key]) });
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    tabs: {
      sendMessage(_tabId, _message, callback) { callback?.(); }
    },
    alarms: {
      clear(_name, callback) { callback?.(); }
    }
  };
  const lateTerminalMessage = correlated("REPORT_PAGE_DIAGNOSTIC", {
    stage: "login",
    reason: "selector_changed"
  });
  try {
    const staleTerminalUpdate = background.internalMessage(lateTerminalMessage, authSender);
    for (let index = 0; index < 6 && !releaseTerminalReread; index += 1) await Promise.resolve();
    assert.ok(releaseTerminalReread);

    let completeSettled = false;
    const completePromise = background.internalMessage(
      correlated("COMPLETE_LOGIN_ACTION"),
      authSender
    );
    completePromise.finally(() => { completeSettled = true; });
    await Promise.resolve();
    assert.equal(completeSettled, false);

    releaseTerminalReread();
    const staleResult = await staleTerminalUpdate;
    const completed = await completePromise;
    assert.equal(completed.status, "waiting_representative");
    assert.equal(stored[background.SESSION_STORAGE_KEY][prepared.sessionId].loginCompleted, true);
    assert.equal(staleResult.status, "waiting_representative");
    assert.equal(stored[background.SESSION_STORAGE_KEY][prepared.sessionId].status, "waiting_representative");
    assert.equal(stored[background.SESSION_STORAGE_KEY][prepared.sessionId].stage, "login");
    assert.ok(stored[background.SESSION_STORAGE_KEY][prepared.sessionId].payload);

    holdSecondGet = false;
    const inverseResult = await background.internalMessage(lateTerminalMessage, authSender);
    assert.equal(inverseResult.status, "waiting_representative");
    assert.ok(stored[background.SESSION_STORAGE_KEY][prepared.sessionId].payload);

    const recovered = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 0, url: "https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp" }
    );
    assert.equal(recovered.ok, true);
    assert.equal(recovered.status, "waiting_representative");

    const representative = representativeStartupFixture();
    representative.company.dispatchEvent = (event) => {
      if (event.type === "click") companyClicks += 1;
      return true;
    };
    global.document = representative.document;
    global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
    global.MouseEvent = class MouseEvent {
      constructor(type) { this.type = type; }
    };
    global.MutationObserver = class MutationObserver {
      observe() {}
      disconnect() {}
    };
    global.setTimeout = () => 1;
    global.clearTimeout = () => {};
    global.chrome.runtime.sendMessage = (message, callback) => {
      const operation = runtimeQueue.then(() => background.internalMessage(message, {
        tab: { id: 73 },
        frameId: 0,
        url: String(global.location.href)
      }));
      runtimeQueue = operation.catch(() => {});
      operation.then((response) => callback?.(response));
    };
    content.resetLoginStateForTesting();
    content.startForTesting();
    for (let index = 0; index < 8; index += 1) {
      const observed = runtimeQueue;
      await observed;
      await Promise.resolve();
      if (observed === runtimeQueue) break;
    }
    content.runRecognizedStageForTesting();
    for (let index = 0; index < 8; index += 1) {
      const observed = runtimeQueue;
      await observed;
      await Promise.resolve();
      if (observed === runtimeQueue) break;
    }
    assert.equal(companyClicks, 1);
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.location = originalLocation;
    global.MouseEvent = originalMouseEvent;
    global.MutationObserver = originalMutationObserver;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("pagehide y unload posteriores al login sólo reportan diagnóstico y nunca terminalizan", async () => {
  const originalChrome = global.chrome;
  const prepared = safeMessage();
  const stored = {
    [background.SESSION_STORAGE_KEY]: {
      [prepared.sessionId]: {
        id: prepared.sessionId,
        payload: prepared.payload,
        orderId: prepared.payload.order.id,
        status: "waiting_representative",
        stage: "login",
        reason: "",
        tabId: 73,
        updatedAt: new Date().toISOString(),
        expiresAt: Date.parse(prepared.payload.expiresAt),
        generation: 4,
        sequence: 10,
        loginCuitSubmitted: true,
        loginPasswordSubmitted: true,
        loginCredentialConsumed: true,
        loginCompleted: true
      }
    }
  };
  const chrome = sessionChrome(stored);
  const messages = [];
  const pending = [];
  chrome.runtime.sendMessage = (message, callback) => {
    messages.push(message);
    const operation = background.internalMessage(message, {
      tab: { id: 73 },
      frameId: 0,
      url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
    }).then((response) => callback?.(response));
    pending.push(operation);
  };
  global.chrome = chrome;
  try {
    content.setActiveSessionForTesting({
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      generation: 4,
      payload: prepared.payload
    });
    content.setCurrentStageForTesting("login_password");
    content.reportDocumentTransitionForTesting("pagehide");
    content.reportDocumentTransitionForTesting("unload");
    await Promise.all(pending);
    assert.deepEqual(messages.map((message) => message.type), [
      "REPORT_DOCUMENT_TRANSITION",
      "REPORT_DOCUMENT_TRANSITION"
    ]);
    assert.equal(messages.some((message) => message.type === "UPDATE_SESSION"), false);
    const active = stored[background.SESSION_STORAGE_KEY][prepared.sessionId];
    assert.equal(active.status, "waiting_representative");
    assert.equal(active.stage, "login");
    assert.ok(active.payload);
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
  }
});

test("traza circular sanitizada conserva sólo metadatos booleanos y el popup puede copiarla", async () => {
  const originalChrome = global.chrome;
  const prepared = safeMessage();
  prepared.payload.order.id = "ORDER_TRACE_SECRET";
  prepared.payload.customer.address = "ADDRESS_TRACE_SECRET";
  prepared.payload.invoice.totals.total = 987654.32;
  const stored = {
    [background.SESSION_STORAGE_KEY]: {
      [prepared.sessionId]: {
        id: prepared.sessionId,
        payload: prepared.payload,
        orderId: prepared.payload.order.id,
        status: "waiting_login",
        stage: "login",
        reason: "",
        tabId: 73,
        updatedAt: new Date().toISOString(),
        expiresAt: Date.parse(prepared.payload.expiresAt),
        generation: 15,
        sequence: 1,
        loginCuitSubmitted: false,
        loginPasswordSubmitted: false,
        loginCredentialConsumed: false,
        loginCompleted: false
      }
    }
  };
  const chrome = sessionChrome(stored);
  global.chrome = chrome;
  try {
    for (let index = 0; index < background.SESSION_TRACE_LIMIT + 5; index += 1) {
      const response = await background.internalMessage({
        type: "REPORT_PAGE_DIAGNOSTIC",
        sessionId: prepared.sessionId,
        revision: prepared.payload.revision,
        generation: 15,
        stage: "login",
        reason: "selector_changed"
      }, {
        tab: { id: 73 },
        frameId: 0,
        url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
      });
      assert.equal(response.ok, true);
    }
    const sensitivePathMarker = "ORDER_PATH_SECRET";
    const sensitivePathResponse = await background.internalMessage({
      type: "REPORT_PAGE_DIAGNOSTIC",
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      generation: 15,
      stage: "login",
      reason: "selector_changed"
    }, {
      tab: { id: 73 },
      frameId: 0,
      url: `https://auth.afip.gob.ar/contribuyente_/cliente/20398041063/pedido/${sensitivePathMarker}`
    });
    assert.equal(sensitivePathResponse.ok, true);
    const copied = await background.internalMessage(
      { type: "GET_SAFE_SESSION_TRACE" },
      { url: `chrome-extension://${chrome.runtime.id}/popup.html` }
    );
    assert.equal(copied.ok, true);
    assert.equal(copied.trace.length, background.SESSION_TRACE_LIMIT);
    assert.equal(copied.trace.every((entry) => (
      Object.values(entry.flags).every((flag) => typeof flag === "boolean")
    )), true);
    for (let index = 1; index < copied.trace.length; index += 1) {
      assert.ok(copied.trace[index].sequence > copied.trace[index - 1].sequence);
    }
    const serialized = JSON.stringify(copied.trace);
    for (const forbidden of [
      prepared.sessionId,
      prepared.payload.revision,
      prepared.payload.customer.cuit,
      "ORDER_TRACE_SECRET",
      "ORDER_PATH_SECRET",
      "ADDRESS_TRACE_SECRET",
      "987654"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.equal(copied.trace.at(-1).senderPath, "/other");
    assert.equal(copied.trace.every((entry) => ["/login", "/other"].includes(entry.senderPath)), true);
    assert.doesNotMatch(serialized, /ciphertext|CryptoKey|"password"\s*:|"clave"\s*:|"payload"\s*:|"orderId"\s*:/i);

    stored[background.SESSION_TRACE_STORAGE_KEY] = [{
      sequence: 99,
      timestamp: "2026-07-31T12:00:00.000Z",
      eventType: "PAGE_DIAGNOSTIC",
      senderHost: "auth.afip.gob.ar",
      senderPath: "/contribuyente_/cliente/20398041063/pedido/ORDER_PATH_SECRET",
      stateBefore: "waiting_login",
      stateAfter: "waiting_login",
      stageBefore: "login",
      stageAfter: "login",
      reason: "selector_changed",
      flags: { payloadPresent: true, injectedSecretFlag: true },
      result: "recorded",
      payload: prepared.payload,
      injectedSecret: "LEGACY_TRACE_SECRET"
    }];
    const sanitizedLegacy = await background.internalMessage(
      { type: "GET_SAFE_SESSION_TRACE" },
      { url: `chrome-extension://${chrome.runtime.id}/popup.html` }
    );
    const sanitizedSerialized = JSON.stringify(sanitizedLegacy.trace);
    assert.equal(sanitizedLegacy.trace[0].senderPath, "/other");
    assert.deepEqual(Object.keys(sanitizedLegacy.trace[0].flags).sort(), [
      "correlationMatched",
      "generationMatched",
      "loginCompleted",
      "loginCredentialConsumed",
      "loginCuitSubmitted",
      "loginPasswordSubmitted",
      "payloadPresent",
      "revisionPresent",
      "tabMatched"
    ]);
    for (const forbidden of ["20398041063", "ORDER_PATH_SECRET", "LEGACY_TRACE_SECRET", "injectedSecretFlag"]) {
      assert.equal(sanitizedSerialized.includes(forbidden), false);
    }
  } finally {
    global.chrome = originalChrome;
  }
});

test("documento nuevo auth -> fe recupera sesión, monta un banner y hace un clic exclusivo", () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalMouseEvent = global.MouseEvent;
  const originalMutationObserver = global.MutationObserver;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const dom = representativeStartupFixture();
  const prepared = safeMessage();
  const messages = [];
  const clicks = { company: 0, personal: 0, exit: 0 };
  dom.company.dispatchEvent = (event) => {
    if (event.type === "click") clicks.company += 1;
    return true;
  };
  dom.personal.dispatchEvent = (event) => {
    if (event.type === "click") clicks.personal += 1;
    return true;
  };
  dom.exit.dispatchEvent = (event) => {
    if (event.type === "click") clicks.exit += 1;
    return true;
  };
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.document = dom.document;
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  global.MutationObserver = class MutationObserver {
    observe() {}
  };
  global.setTimeout = () => 1;
  global.clearTimeout = () => {};
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === "GET_ACTIVE_SESSION") {
          callback({
            ok: true,
            sessionId: prepared.sessionId,
            revision: prepared.payload.revision,
            payload: prepared.payload,
            status: "waiting_login",
            stage: "login"
          });
        } else if (message.type === "AUTHORIZE_INTERIM_ACTION") {
          callback({ ok: true, status: "waiting_representative", stage: "representative" });
        } else callback({ ok: true });
      }
    }
  };
  try {
    content.resetLoginStateForTesting();
    content.startForTesting();
    content.startForTesting();
    assert.equal(dom.document.getElementById("sunnutrition-arca-assistant"), dom.banner);
    assert.match(dom.banner.textContent, /init_recovering/);
    content.runRecognizedStageForTesting();
    content.runRecognizedStageForTesting();
    assert.deepEqual(clicks, { company: 1, personal: 0, exit: 0 });
    assert.equal(messages.filter((message) => message.type === "GET_ACTIVE_SESSION").length, 1);
    assert.equal(messages.filter((message) => message.type === "AUTHORIZE_INTERIM_ACTION").length, 1);
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.location = originalLocation;
    global.MouseEvent = originalMouseEvent;
    global.MutationObserver = originalMutationObserver;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("document_start espera body y DOMContentLoaded antes de clasificar o autorizar", () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalMouseEvent = global.MouseEvent;
  const originalMutationObserver = global.MutationObserver;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const dom = representativeStartupFixture();
  const prepared = safeMessage();
  const timers = [];
  const messages = [];
  let companyClicks = 0;
  dom.document.readyState = "loading";
  dom.document.body = null;
  dom.company.dispatchEvent = (event) => {
    if (event.type === "click") companyClicks += 1;
    return true;
  };
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.document = dom.document;
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  global.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
  };
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === "GET_ACTIVE_SESSION") {
          callback({
            ok: true,
            sessionId: prepared.sessionId,
            revision: prepared.payload.revision,
            payload: prepared.payload,
            status: "waiting_login",
            stage: "login"
          });
        } else if (message.type === "AUTHORIZE_INTERIM_ACTION") {
          callback({ ok: true, status: "waiting_representative", stage: "representative" });
        } else callback({ ok: true });
      }
    }
  };
  try {
    content.resetLoginStateForTesting();
    content.startForTesting();
    assert.equal(timers.some((timer) => timer.delay === 250), false);
    assert.equal(messages.some((message) => message.type === "AUTHORIZE_INTERIM_ACTION"), false);
    assert.equal(messages.some((message) => message.status === "interrupted"), false);

    dom.document.body = {
      innerText: "Seleccione la Empresa a representar:",
      textContent: "Seleccione la Empresa a representar:"
    };
    dom.document.readyState = "interactive";
    dom.listeners.find((listener) => listener.type === "DOMContentLoaded")?.listener();
    const inspectionTimer = timers.find((timer) => timer.delay === 250 && !timer.cleared);
    assert.ok(inspectionTimer);
    inspectionTimer.callback();
    assert.equal(companyClicks, 1);
    assert.equal(messages.filter((message) => message.type === "AUTHORIZE_INTERIM_ACTION").length, 1);
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.location = originalLocation;
    global.MouseEvent = originalMouseEvent;
    global.MutationObserver = originalMutationObserver;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("excepción al observar deja el arranque terminal y bloquea timers y autorizaciones", () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalMutationObserver = global.MutationObserver;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const dom = representativeStartupFixture();
  const prepared = safeMessage();
  const timers = [];
  const messages = [];
  let companyClicks = 0;
  dom.document.readyState = "complete";
  dom.company.dispatchEvent = () => {
    companyClicks += 1;
    return true;
  };
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.document = dom.document;
  global.MutationObserver = class MutationObserver {
    observe() { throw new Error("sanitized observer failure"); }
    disconnect() {}
  };
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        callback({
          ok: true,
          sessionId: prepared.sessionId,
          revision: prepared.payload.revision,
          payload: prepared.payload,
          status: "waiting_login",
          stage: "login"
        });
      }
    }
  };
  try {
    content.resetLoginStateForTesting();
    content.startForTesting();
    for (const timer of timers.filter((entry) => entry.delay === 250)) timer.callback();
    content.runRecognizedStageForTesting();
    assert.match(dom.banner.textContent, /init_exception/);
    assert.equal(messages.some((message) => message.type === "AUTHORIZE_INTERIM_ACTION"), false);
    assert.equal(companyClicks, 0);
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.location = originalLocation;
    global.MutationObserver = originalMutationObserver;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("arranque diagnostica error runtime, respuesta ausente, sesión ausente o terminal sin clic", () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalLocation = global.location;
  const dom = representativeStartupFixture();
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.document = dom.document;
  const cases = [
    {
      expected: "init_runtime_error",
      sendMessage(_message, callback) {
        global.chrome.runtime.lastError = { message: "sanitized runtime failure" };
        callback(undefined);
      }
    },
    {
      expected: "init_response_missing",
      sendMessage(_message, callback) { callback(undefined); }
    },
    {
      expected: "session_absent",
      sendMessage(_message, callback) {
        callback({ ok: false, status: "not_found", reason: "session_absent" });
      }
    },
    {
      expected: "session_terminal",
      sendMessage(_message, callback) {
        callback({ ok: false, status: "review_reached", reason: "session_terminal" });
      }
    },
    {
      expected: "init_exception",
      sendMessage() { throw new Error("sanitized startup exception"); }
    }
  ];
  try {
    for (const scenario of cases) {
      content.resetLoginStateForTesting();
      global.chrome = { runtime: { lastError: null, sendMessage: scenario.sendMessage } };
      content.requestActiveSessionForTesting(content.MAX_SESSION_LOOKUP_ATTEMPTS);
      assert.match(dom.banner.textContent, new RegExp(scenario.expected));
      assert.match(dom.banner.textContent, /Cero acciones ejecutadas/);
    }
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.location = originalLocation;
  }
});

test("autorización rechazada muestra diagnóstico y no acciona ninguna empresa", () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalLocation = global.location;
  const dom = representativeStartupFixture();
  const prepared = safeMessage();
  let companyClicks = 0;
  dom.company.dispatchEvent = () => {
    companyClicks += 1;
    return true;
  };
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.document = dom.document;
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(_message, callback) {
        callback({ ok: false, status: "rejected", stage: "login" });
      }
    }
  };
  try {
    content.resetLoginStateForTesting();
    content.setActiveSessionForTesting({
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      payload: prepared.payload
    });
    content.setCurrentStageForTesting("representative");
    const contract = content.representativeScreenContract(prepared.payload.automation);
    content.authorizeInterimAction(contract.companyControl, "representative");
    assert.equal(companyClicks, 0);
    assert.match(dom.banner.textContent, /authorization_rejected/);
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.location = originalLocation;
  }
});

test("empresa representada valida el formulario real y normaliza prompt y botones", () => {
  const originalDocument = global.document;
  const originalLocation = global.location;
  const dom = representativeDomFixture();
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.document = dom.document;
  try {
    const automation = safeMessage().payload.automation;
    assert.equal(content.findRepresentativeControl(automation), dom.company);
    assert.equal(content.representativeScreenContract(automation).ok, true);
    dom.company.value = "SUNNUTRITION S.A.S.";
    assert.equal(content.representativeScreenContract(automation).reason, "representative_company_missing");
    dom.company.value = " SUNNUTRITION S.A. ";
    dom.controls.push({ ...dom.company, value: "SUNNUTRITION S.A." });
    assert.equal(content.representativeScreenContract(automation).reason, "representative_button_count_mismatch");
    dom.controls.pop();
    dom.personal.value = "OTRA PERSONA";
    assert.equal(content.representativeScreenContract(automation).reason, "representative_personal_missing");
    dom.personal.value = "DE MAYO BENJAMIN";
    dom.company.disabled = true;
    assert.equal(content.representativeScreenContract(automation).reason, "representative_company_disabled");
    dom.company.disabled = false;
    dom.personal.disabled = true;
    assert.equal(content.representativeScreenContract(automation).reason, "representative_personal_disabled");
    dom.personal.disabled = false;
    dom.attributes.method = "post";
    dom.form.method = "post";
    assert.equal(content.representativeScreenContract(automation).reason, "representative_form_method_mismatch");
    dom.attributes.method = "get";
    dom.form.method = "get";
    dom.attributes.action = "https://fe.afip.gob.ar/rcel/jsp/otra.do";
    dom.form.action = dom.attributes.action;
    assert.equal(content.representativeScreenContract(automation).reason, "representative_form_action_mismatch");
    dom.attributes.action = "https://fe.afip.gob.ar/rcel/jsp/setearContribuyente.do";
    dom.form.action = dom.attributes.action;
    global.document.title = "ARCA";
    assert.equal(content.representativeScreenContract(automation).reason, "representative_title_mismatch");
    global.document.title = "RCEL";
    global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp?unexpected=1");
    assert.equal(content.representativeScreenContract(automation).reason, "representative_url_mismatch");
    global.location = new URL("https://otro.afip.gob.ar/rcel/jsp/index_bis.jsp");
    assert.equal(content.representativeScreenContract(automation).reason, "representative_url_mismatch");
    global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
    dom.prompt.textContent = "Seleccione una Empresa a representar:";
    assert.equal(content.representativeScreenContract(automation).reason, "representative_prompt_mismatch");
  } finally {
    global.document = originalDocument;
    global.location = originalLocation;
  }
});

test("representación duplicada hace cero clics y emite sólo un diagnóstico sanitizado", () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalLocation = global.location;
  const prepared = safeMessage();
  const dom = representativeStartupFixture();
  const messages = [];
  const clicks = { company: 0, personal: 0 };
  dom.company.dispatchEvent = () => { clicks.company += 1; return true; };
  dom.personal.dispatchEvent = () => { clicks.personal += 1; return true; };
  dom.controls.push({ ...dom.company });
  global.document = dom.document;
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        callback?.({ ok: true, status: "waiting_representative", stage: "login" });
      }
    }
  };
  try {
    content.resetLoginStateForTesting();
    content.setActiveSessionForTesting({
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      generation: 8,
      payload: prepared.payload
    });
    content.runRecognizedStageForTesting();
    assert.deepEqual(clicks, { company: 0, personal: 0 });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "REPORT_PAGE_DIAGNOSTIC");
    assert.equal(messages[0].reason, "selector_changed");
    assert.doesNotMatch(dom.banner.textContent, /30123456789|2178|Barra/);
  } finally {
    content.resetLoginStateForTesting();
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.location = originalLocation;
  }
});

test("fixture de representación hace un clic sólo en SUNNUTRITION y cero en DE MAYO", () => {
  const fixture = fs.readFileSync(
    path.join(root, "tests/fixtures/arca/representative-selection-legacy.html"),
    "utf8"
  );
  assert.match(fixture, /<title>RCEL<\/title>/);
  assert.match(fixture, /name="seleccionaEmpresaForm" method="get" action="https:\/\/fe\.afip\.gob\.ar\/rcel\/jsp\/setearContribuyente\.do"/);
  assert.match(fixture, /id="idcontribuyente" name="idContribuyente" type="hidden"/);
  assert.match(fixture, /class="btn_empresa [^"]+" type="button" value="  DE MAYO BENJAMIN  "/);
  assert.match(fixture, /class="btn_empresa [^"]+" type="button" value="&#10;SUNNUTRITION S\.A\.&#10;"/);
  assert.match(fixture, />Salir</);

  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalChrome = global.chrome;
  const originalMouseEvent = global.MouseEvent;
  const clicks = { personal: 0, company: 0 };
  const dom = representativeDomFixture();
  for (const control of [dom.personal, dom.company, dom.exit]) {
    control.dispatchEvent = (event) => {
      if (event.type === "click") clicks[control.target] += 1;
      return true;
    };
  }
  const banner = { dataset: {}, textContent: "" };
  clicks.exit = 0;
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  dom.document.getElementById = () => banner;
  global.document = dom.document;
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        callback({ ok: true, stage: message.stage });
      }
    }
  };
  try {
    const prepared = safeMessage();
    content.setActiveSessionForTesting({
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      payload: prepared.payload
    });
    content.setCurrentStageForTesting("representative");
    const contract = content.representativeScreenContract(prepared.payload.automation);
    assert.equal(contract.ok, true);
    content.authorizeInterimAction(contract.companyControl, "representative");
    assert.deepEqual(clicks, { personal: 0, company: 1, exit: 0 });
  } finally {
    content.resetLoginStateForTesting();
    global.document = originalDocument;
    global.location = originalLocation;
    global.chrome = originalChrome;
    global.MouseEvent = originalMouseEvent;
  }
});

test("cancelación tardía no contamina redirecciones y exige sessionId/revision exactos", () => {
  const prepared = safeMessage();
  const originalDocument = global.document;
  global.document = {
    getElementById: () => ({ dataset: {}, textContent: "" })
  };
  content.resetLoginStateForTesting();
  assert.equal(content.handleCancellationMessage({
    type: "CANCEL_ACTIVE_SESSION",
    sessionId: "stale",
    revision: "b".repeat(64)
  }), false);
  content.setActiveSessionForTesting({
    sessionId: prepared.sessionId,
    revision: prepared.payload.revision,
    payload: prepared.payload
  });
  assert.equal(content.handleCancellationMessage({
    type: "CANCEL_ACTIVE_SESSION",
    sessionId: prepared.sessionId,
    revision: "b".repeat(64)
  }), false);
  assert.equal(content.handleCancellationMessage({
    type: "CANCEL_ACTIVE_SESSION",
    sessionId: "22345678-1234-1234-1234-123456789012",
    revision: prepared.payload.revision
  }), false);
  assert.equal(content.handleCancellationMessage({
    type: "CANCEL_ACTIVE_SESSION",
    sessionId: prepared.sessionId,
    revision: prepared.payload.revision
  }), true);
  global.document = originalDocument;
});

test("autorización tardía con sessionId o revision reemplazados no hace clic", () => {
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalChrome = global.chrome;
  const originalMouseEvent = global.MouseEvent;
  const dom = representativeDomFixture();
  let companyClicks = 0;
  let authorizationCallback = null;
  dom.company.dispatchEvent = (event) => {
    if (event.type === "click") companyClicks += 1;
    return true;
  };
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.document = dom.document;
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === "AUTHORIZE_INTERIM_ACTION") authorizationCallback = callback;
      }
    }
  };
  try {
    const prepared = safeMessage();
    content.resetLoginStateForTesting();
    content.setActiveSessionForTesting({
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      payload: prepared.payload
    });
    content.setCurrentStageForTesting("representative");
    const contract = content.representativeScreenContract(prepared.payload.automation);
    content.authorizeInterimAction(contract.companyControl, "representative");
    content.setActiveSessionForTesting({
      sessionId: "32345678-1234-1234-1234-123456789012",
      revision: "c".repeat(64),
      payload: { ...prepared.payload, revision: "c".repeat(64) }
    });
    authorizationCallback({ ok: true, stage: "representative" });
    assert.equal(companyClicks, 0);
  } finally {
    content.resetLoginStateForTesting();
    global.document = originalDocument;
    global.location = originalLocation;
    global.chrome = originalChrome;
    global.MouseEvent = originalMouseEvent;
  }
});

test("representación mantiene una sola autorización pendiente y un solo clic", () => {
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalChrome = global.chrome;
  const originalMouseEvent = global.MouseEvent;
  const dom = representativeDomFixture();
  const banner = { dataset: {}, textContent: "" };
  let authorizationRequests = 0;
  let authorizationCallback = null;
  let companyClicks = 0;
  dom.company.dispatchEvent = (event) => {
    if (event.type === "click") companyClicks += 1;
    return true;
  };
  dom.document.getElementById = () => banner;
  global.document = dom.document;
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === "AUTHORIZE_INTERIM_ACTION") {
          authorizationRequests += 1;
          authorizationCallback = callback;
        }
      }
    }
  };
  try {
    const prepared = safeMessage();
    content.resetLoginStateForTesting();
    content.setActiveSessionForTesting({
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      payload: prepared.payload
    });
    content.setCurrentStageForTesting("representative");
    const contract = content.representativeScreenContract(prepared.payload.automation);
    content.authorizeInterimAction(contract.companyControl, "representative");
    content.authorizeInterimAction(contract.companyControl, "representative");
    assert.equal(authorizationRequests, 1);
    authorizationCallback({ ok: true, stage: "representative" });
    assert.equal(companyClicks, 1);
    assert.equal(banner.dataset.state, "complete");
  } finally {
    content.resetLoginStateForTesting();
    global.document = originalDocument;
    global.location = originalLocation;
    global.chrome = originalChrome;
    global.MouseEvent = originalMouseEvent;
  }
});

test("representación ignora autorización pendiente después de estado terminal", () => {
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalChrome = global.chrome;
  const originalMouseEvent = global.MouseEvent;
  const dom = representativeDomFixture();
  const banner = { dataset: {}, textContent: "" };
  let authorizationCallback = null;
  let companyClicks = 0;
  dom.company.dispatchEvent = (event) => {
    if (event.type === "click") companyClicks += 1;
    return true;
  };
  dom.document.getElementById = () => banner;
  global.document = dom.document;
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === "AUTHORIZE_INTERIM_ACTION") authorizationCallback = callback;
        else if (callback) callback({ ok: true });
      }
    }
  };
  try {
    const prepared = safeMessage();
    content.resetLoginStateForTesting();
    content.setActiveSessionForTesting({
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      payload: prepared.payload
    });
    content.setCurrentStageForTesting("representative");
    const contract = content.representativeScreenContract(prepared.payload.automation);
    content.authorizeInterimAction(contract.companyControl, "representative");
    content.authorizeInterimAction({ value: "OTRA EMPRESA" }, "representative");
    authorizationCallback({ ok: true, stage: "representative" });
    assert.equal(companyClicks, 0);
    assert.equal(banner.dataset.state, "error");
    assert.match(banner.textContent, /detuvo de forma segura/);
  } finally {
    content.resetLoginStateForTesting();
    global.document = originalDocument;
    global.location = originalLocation;
    global.chrome = originalChrome;
    global.MouseEvent = originalMouseEvent;
  }
});

test("representación reverifica el mismo control tras autorización asíncrona", () => {
  const originalDocument = global.document;
  const originalLocation = global.location;
  const originalChrome = global.chrome;
  const originalMouseEvent = global.MouseEvent;
  const clicks = { personal: 0, company: 0 };
  const dom = representativeDomFixture();
  for (const control of [dom.personal, dom.company]) {
    control.dispatchEvent = (event) => {
      if (event.type === "click") clicks[control.target] += 1;
      return true;
    };
  }
  const banner = { dataset: {}, textContent: "" };
  let authorizationCallback = null;
  global.location = new URL("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");
  dom.document.getElementById = () => banner;
  global.document = dom.document;
  global.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === "AUTHORIZE_INTERIM_ACTION") authorizationCallback = callback;
        else if (callback) callback({ ok: true });
      }
    }
  };
  try {
    const prepared = safeMessage();
    content.setActiveSessionForTesting({
      sessionId: prepared.sessionId,
      revision: prepared.payload.revision,
      payload: prepared.payload
    });
    content.setCurrentStageForTesting("representative");
    const contract = content.representativeScreenContract(prepared.payload.automation);
    content.authorizeInterimAction(
      contract.companyControl,
      "representative",
      "Abriendo.",
      (authorizedControl) => {
        const current = content.representativeScreenContract(prepared.payload.automation);
        return current.ok && current.companyControl === authorizedControl
          ? current.companyControl
          : null;
      },
      () => content.representativeFailureMessage("representative_company_missing", true)
    );
    dom.personal.value = "SUNNUTRITION S.A.";
    dom.company.value = "DE MAYO BENJAMIN";
    authorizationCallback({ ok: true, stage: "representative" });
    assert.deepEqual(clicks, { personal: 0, company: 0 });
    assert.match(banner.textContent, /Falta el botón exacto SUNNUTRITION S\.A\./);
    assert.match(banner.textContent, /detuvo de forma segura/);
  } finally {
    content.resetLoginStateForTesting();
    global.document = originalDocument;
    global.location = originalLocation;
    global.chrome = originalChrome;
    global.MouseEvent = originalMouseEvent;
  }
});

test("cada etapa intermedia se reclama una sola vez", () => {
  const guard = content.createStageGuard();
  assert.equal(guard.claim("initial"), true);
  assert.equal(guard.claim("initial"), false);
  assert.equal(guard.claim("emission"), true);
});

test("los dos botones Agregar y las acciones ajenas a productos se bloquean en captura", () => {
  const originalDocument = global.document;
  const listeners = {};
  global.document = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
  try {
    content.blockSyntheticFinalActions();
    for (const control of [
      { value: "Agregar línea descripción" },
      { name: "agregarImp", value: "Agregar otro Tributo" },
      { name: "Eliminar", value: "X" },
      { value: "< Volver" },
      { value: "Menú Principal" }
    ]) {
      let prevented = false;
      let stopped = false;
      listeners.click({
        isTrusted: false,
        target: { closest: () => control },
        preventDefault: () => { prevented = true; },
        stopImmediatePropagation: () => { stopped = true; }
      });
      assert.equal(content.isForbiddenOperationAction(control), true);
      assert.equal(prevented, true);
      assert.equal(stopped, true);
    }
  } finally {
    global.document = originalDocument;
  }
});

test("Datos de emisión usa el DOM real sanitizado, aplica payload exacto y continúa una sola vez", () => {
  const originalDocument = global.document;
  const originalEvent = global.Event;
  const originalMouseEvent = global.MouseEvent;
  const originalLocation = global.location;
  const fixture = fs.readFileSync(
    path.join(root, "tests/fixtures/arca/emission-fields-legacy.html"),
    "utf8"
  );
  assert.match(fixture, /form name="datosEmisorForm" method="post" action="\/rcel\/jsp\/genComDatosReceptor\.do"/);
  assert.match(fixture, /id="fc" name="fechaEmisionComprobante"/);
  assert.match(fixture, /id="idconcepto" name="idConcepto"/);
  assert.match(fixture, /id="monedaextranjera" name="monedaExtranjera" type="checkbox"/);
  assert.match(fixture, /id="actiAsociadaId" name="actiAsociadaId"/);
  assert.match(fixture, /id="refComEmisor" name="refComEmisor"/);
  assert.match(fixture, /id="cancelacionMonedaExtranjera"/);
  assert.match(fixture, /id="moneda" name="moneda"/);
  assert.match(fixture, /id="tipocambio" name="tipoCambio"/);

  const createDom = () => {
    const events = [];
    const clicks = [];
    const field = (tagName, extra = {}) => ({
      tagName,
      id: extra.id || "",
      name: extra.name || "",
      type: extra.type || "",
      value: extra.value || "",
      checked: Boolean(extra.checked),
      indeterminate: Boolean(extra.indeterminate),
      disabled: Boolean(extra.disabled),
      readOnly: Boolean(extra.readOnly),
      options: extra.options || [],
      dispatchEvent(event) {
        events.push(`${this.id}:${event.type}`);
        extra.onDispatch?.(this, event);
        return true;
      }
    });
    const date = field("INPUT", {
      id: "fc",
      name: "fechaEmisionComprobante",
      type: "text"
    });
    const concept = field("SELECT", {
      id: "idconcepto",
      name: "idConcepto",
      options: [
        { value: "", textContent: "seleccionar..." },
        { value: "1", textContent: "Productos" },
        { value: "2", textContent: "Servicios" },
        { value: "3", textContent: "Productos y Servicios" }
      ]
    });
    const currency = field("INPUT", {
      id: "monedaextranjera",
      name: "monedaExtranjera",
      type: "checkbox"
    });
    const activity = field("SELECT", {
      id: "actiAsociadaId",
      name: "actiAsociadaId",
      options: [
        { value: "", textContent: "seleccionar..." },
        { value: "106131", textContent: "106131 - ELABORACIÓN DE ALIMENTOS A BASE..." }
      ]
    });
    const reference = field("INPUT", {
      id: "refComEmisor",
      name: "refComEmisor",
      type: "text",
      value: "debe limpiarse"
    });
    const untouchedCurrencyControls = {
      cancellation: field("INPUT", {
        id: "cancelacionMonedaExtranjera",
        type: "checkbox"
      }),
      currency: field("SELECT", {
        id: "moneda",
        name: "moneda",
        value: "",
        options: [{ value: "", textContent: "seleccionar..." }]
      }),
      exchangeRate: field("INPUT", {
        id: "tipocambio",
        name: "tipoCambio",
        type: "text",
        value: ""
      })
    };
    const selectors = {
      'input#fc[name="fechaEmisionComprobante"]': [date],
      'select#idconcepto[name="idConcepto"]': [concept],
      'input#monedaextranjera[name="monedaExtranjera"][type="checkbox"]': [currency],
      'select#actiAsociadaId[name="actiAsociadaId"]': [activity],
      'input#refComEmisor[name="refComEmisor"]': [reference]
    };
    const button = (value, outside = false) => ({
      value,
      outside,
      disabled: false,
      getAttribute: () => null,
      dispatchEvent(event) {
        clicks.push(`${value}:${event.type}`);
        return true;
      }
    });
    const plus = button("+");
    const minus = button("-");
    const back = button("< Volver");
    const next = button("Continuar >");
    const menu = button("Menú Principal", true);
    const form = {
      name: "datosEmisorForm",
      method: "post",
      action: "https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do",
      getAttribute(name) {
        if (name === "method") return this.method;
        if (name === "action") return this.action;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "input[type='button']") return [plus, minus, back, next];
        return selectors[selector] || [];
      }
    };
    const forms = [form];
    const banner = { dataset: {}, textContent: "" };
    const document = {
      title: "RCEL",
      body: { innerText: fixture },
      documentElement: { appendChild: () => {} },
      querySelectorAll(selector) {
        if (selector === 'form[name="datosEmisorForm"]') return forms;
        return [];
      },
      getElementById: (id) => id === "sunnutrition-arca-assistant" ? banner : null
    };
    return {
      activity,
      banner,
      buttons: { back, menu, minus, next, plus },
      clicks,
      concept,
      currency,
      date,
      document,
      events,
      form,
      forms,
      reference,
      selectors,
      untouchedCurrencyControls
    };
  };
  const installDom = (dom) => {
    global.document = dom.document;
    global.location = {
      href: "https://fe.afip.gob.ar/rcel/jsp/genComDatosEmisor.do"
    };
  };
  global.Event = class Event { constructor(type) { this.type = type; } };
  global.MouseEvent = class MouseEvent { constructor(type) { this.type = type; } };
  try {
    const payload = safeMessage().payload;
    payload.invoice.invoiceDate = "2026-08-04";

    let dom = createDom();
    installDom(dom);
    assert.deepEqual(content.completeEmissionFields(payload), { ok: true, pending: false });
    assert.equal(dom.date.value, "04/08/2026");
    assert.equal(dom.concept.value, "1");
    assert.equal(dom.currency.checked, false);
    assert.equal(dom.activity.value, "106131");
    assert.equal(dom.reference.value, "");
    assert.deepEqual(dom.events, ["idconcepto:change", "actiAsociadaId:change"]);
    assert.deepEqual(
      Object.values(dom.untouchedCurrencyControls).map((control) => ({
        checked: control.checked,
        value: control.value
      })),
      [
        { checked: false, value: "" },
        { checked: false, value: "" },
        { checked: false, value: "" }
      ]
    );

    global.location.href = "https://fe.afip.gob.ar/rcel/jsp/otraPantalla.do";
    assert.equal(content.completeEmissionFields(payload).reason, "emission_path_mismatch");

    for (const href of [
      "https://fe.afip.gob.ar:444/rcel/jsp/genComDatosEmisor.do",
      "https://fe.afip.gob.ar/rcel/jsp/genComDatosEmisor.do?inesperado=1",
      "https://fe.afip.gob.ar/rcel/jsp/genComDatosEmisor.do#inesperado"
    ]) {
      dom = createDom();
      installDom(dom);
      global.location.href = href;
      assert.equal(content.completeEmissionFields(payload).reason, "emission_path_mismatch");
      assert.deepEqual(dom.clicks, []);
    }

    dom = createDom();
    installDom(dom);
    dom.forms.length = 0;
    assert.equal(content.completeEmissionFields(payload).reason, "datosEmisorForm_not_unique");

    dom = createDom();
    installDom(dom);
    dom.form.action = "https://fe.afip.gob.ar/rcel/jsp/actionInesperada.do";
    assert.equal(content.completeEmissionFields(payload).reason, "datosEmisorForm_action_mismatch");

    for (const action of [
      "https://fe.afip.gob.ar:444/rcel/jsp/genComDatosReceptor.do",
      "https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do?inesperado=1",
      "https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do#inesperado"
    ]) {
      dom = createDom();
      installDom(dom);
      dom.form.action = action;
      assert.equal(content.completeEmissionFields(payload).reason, "datosEmisorForm_action_mismatch");
      assert.deepEqual(dom.clicks, []);
    }

    dom = createDom();
    installDom(dom);
    dom.selectors['input#fc[name="fechaEmisionComprobante"]'] = [];
    assert.equal(content.completeEmissionFields(payload).reason, "fc_not_unique");

    dom = createDom();
    installDom(dom);
    dom.concept.options = [{ value: "", textContent: "seleccionar..." }, { value: "2", textContent: "Servicios" }];
    assert.equal(content.completeEmissionFields(payload).reason, "idconcepto_productos_not_unique");

    dom = createDom();
    installDom(dom);
    dom.concept.options.push({ value: "99", textContent: "Productos" });
    assert.equal(content.completeEmissionFields(payload).reason, "idconcepto_productos_not_unique");

    dom = createDom();
    installDom(dom);
    dom.concept.disabled = true;
    assert.equal(content.completeEmissionFields(payload).reason, "idconcepto_disabled");
    assert.deepEqual(dom.clicks, []);

    dom = createDom();
    installDom(dom);
    dom.concept.options[1].disabled = true;
    assert.equal(content.completeEmissionFields(payload).reason, "idconcepto_productos_disabled");
    assert.deepEqual(dom.clicks, []);

    dom = createDom();
    installDom(dom);
    dom.activity.options = [{ value: "", textContent: "seleccionar..." }];
    assert.equal(content.completeEmissionFields(payload).reason, "actiAsociadaId_106131_not_unique");

    dom = createDom();
    installDom(dom);
    dom.activity.options.push({ value: "106131", textContent: "106131 - DUPLICADA" });
    assert.equal(content.completeEmissionFields(payload).reason, "actiAsociadaId_106131_not_unique");

    dom = createDom();
    installDom(dom);
    dom.activity.disabled = true;
    assert.equal(content.completeEmissionFields(payload).reason, "actiAsociadaId_disabled");
    assert.deepEqual(dom.clicks, []);

    dom = createDom();
    installDom(dom);
    dom.activity.options[1].disabled = true;
    assert.equal(content.completeEmissionFields(payload).reason, "actiAsociadaId_106131_disabled");
    assert.deepEqual(dom.clicks, []);

    dom = createDom();
    installDom(dom);
    dom.currency.checked = true;
    assert.equal(content.completeEmissionFields(payload).reason, "monedaextranjera_not_unchecked");

    dom = createDom();
    installDom(dom);
    dom.currency.indeterminate = true;
    assert.equal(content.completeEmissionFields(payload).reason, "monedaextranjera_not_unchecked");

    dom = createDom();
    installDom(dom);
    let lockedReference = "no se puede vaciar";
    Object.defineProperty(dom.reference, "value", {
      configurable: true,
      get: () => lockedReference,
      set: (value) => {
        if (value !== "") lockedReference = value;
      }
    });
    assert.equal(content.completeEmissionFields(payload).reason, "refComEmisor_value_rejected");

    dom = createDom();
    installDom(dom);
    const conceptDispatch = dom.concept.dispatchEvent;
    dom.concept.dispatchEvent = function dispatchAndRevert(event) {
      conceptDispatch.call(this, event);
      if (event.type === "change") this.value = "2";
      return true;
    };
    assert.equal(content.completeEmissionFields(payload).reason, "idconcepto_value_rejected");

    dom = createDom();
    installDom(dom);
    const activityDispatch = dom.activity.dispatchEvent;
    dom.activity.dispatchEvent = function dispatchAndRevert(event) {
      activityDispatch.call(this, event);
      if (event.type === "change") this.value = "";
      return true;
    };
    assert.equal(content.completeEmissionFields(payload).reason, "actiAsociadaId_value_rejected");

    dom = createDom();
    installDom(dom);
    assert.deepEqual(content.completeEmissionFields(payload), { ok: true, pending: false });
    dom.form.querySelectorAll = (selector) => (
      selector === "input[type='button']" ? [] : dom.selectors[selector] || []
    );
    content.setCurrentStageForTesting("emission");
    content.continueFromEmissionStage(payload, "Datos de emisión completos.");
    assert.deepEqual(dom.clicks, []);
    assert.match(dom.banner.textContent, /datosEmisorForm.*Continuar >/);

    dom = createDom();
    installDom(dom);
    assert.deepEqual(content.completeEmissionFields(payload), { ok: true, pending: false });
    const duplicateContinue = {
      ...dom.buttons.next,
      dispatchEvent(event) {
        dom.clicks.push(`duplicado:${event.type}`);
        return true;
      }
    };
    dom.form.querySelectorAll = (selector) => (
      selector === "input[type='button']"
        ? [dom.buttons.plus, dom.buttons.minus, dom.buttons.back, dom.buttons.next, duplicateContinue]
        : dom.selectors[selector] || []
    );
    content.continueFromEmissionStage(payload, "Datos de emisión completos.");
    assert.deepEqual(dom.clicks, []);

    dom = createDom();
    installDom(dom);
    assert.deepEqual(content.completeEmissionFields(payload), { ok: true, pending: false });
    dom.concept.disabled = true;
    content.continueFromEmissionStage(payload, "Datos de emisión completos.");
    assert.deepEqual(dom.clicks, []);
    assert.match(dom.banner.textContent, /idconcepto_disabled/);

    dom = createDom();
    installDom(dom);
    assert.deepEqual(content.completeEmissionFields(payload), { ok: true, pending: false });
    dom.activity.options[1].disabled = true;
    content.continueFromEmissionStage(payload, "Datos de emisión completos.");
    assert.deepEqual(dom.clicks, []);
    assert.match(dom.banner.textContent, /actiAsociadaId_106131_disabled/);

    dom = createDom();
    installDom(dom);
    assert.deepEqual(content.completeEmissionFields(payload), { ok: true, pending: false });
    content.setCurrentStageForTesting("emission");
    content.continueFromEmissionStage(payload, "Datos de emisión completos.");
    content.continueFromEmissionStage(payload, "Datos de emisión completos.");
    assert.deepEqual(dom.clicks, ["Continuar >:click"]);
    assert.equal(dom.clicks.some((click) => /^[+\-<]|Menú Principal/.test(click)), false);
    assert.equal(content.FINAL_ACTION_PATTERN.test("Obtener CAE"), true);
  } finally {
    global.document = originalDocument;
    global.Event = originalEvent;
    global.MouseEvent = originalMouseEvent;
    global.location = originalLocation;
  }
});

test("Datos del receptor usa el DOM real sanitizado, espera ARCA y continúa una sola vez", () => {
  const originalDocument = global.document;
  const originalEvent = global.Event;
  const originalMouseEvent = global.MouseEvent;
  const originalLocation = global.location;
  const fixture = fs.readFileSync(
    path.join(root, "tests/fixtures/arca/recipient-fields-legacy.html"),
    "utf8"
  );
  assert.match(fixture, /form id="formulario" name="datosReceptorForm" method="post"/);
  assert.match(fixture, /id="idivareceptor" name="idIVAReceptor"/);
  assert.match(fixture, /id="idtipodocreceptor" name="idTipoDocReceptor" type="hidden"/);
  assert.match(fixture, /id="nrodocreceptor" name="nroDocReceptor"/);
  assert.match(fixture, /id="razonsocialreceptor" name="razonSocialReceptor"/);
  assert.match(fixture, /id="domicilioreceptor" name="domicilioReceptor"/);
  assert.match(fixture, /id="formadepago5" name="formaDePago" type="checkbox"/);
  assert.match(fixture, /id="selectCompradoresMultiples" name="selectCompradoresMultiples"/);
  assert.match(fixture, /id="cmp_asoc_tipo" name="cmpAsociadoTipo"/);
  assert.match(fixture, /id="datoadicionaltipo" name="datoAdicionalTipo"/);
  assert.doesNotMatch(fixture, /\b30-?\d{8}-?\d\b|raz[oó]n social de prueba|cookie|token/i);

  const createDom = ({ autoComplete = true } = {}) => {
    const events = [];
    const clicks = [];
    const field = (tagName, extra = {}) => {
      const control = {
        tagName,
        id: extra.id || "",
        name: extra.name || "",
        type: extra.type || "",
        value: extra.value || "",
        checked: Boolean(extra.checked),
        indeterminate: Boolean(extra.indeterminate),
        disabled: Boolean(extra.disabled),
        readOnly: Boolean(extra.readOnly),
        options: extra.options || [],
        dispatchEvent(event) {
          events.push(`${this.id || this.name}:${event.type}`);
          extra.onDispatch?.(this, event);
          return true;
        }
      };
      return control;
    };
    const condition = field("SELECT", {
      id: "idivareceptor",
      name: "idIVAReceptor",
      options: [
        { value: "", textContent: "seleccionar..." },
        { value: "1", textContent: "IVA Responsable Inscripto" },
        { value: "6", textContent: "Responsable Monotributo" }
      ]
    });
    const documentType = field("INPUT", {
      id: "idtipodocreceptor",
      name: "idTipoDocReceptor",
      type: "hidden",
      value: "80"
    });
    const legalName = field("INPUT", {
      id: "razonsocialreceptor",
      name: "razonSocialReceptor",
      type: "text",
      readOnly: true
    });
    const address = field("SELECT", {
      id: "domicilioreceptor",
      name: "domicilioReceptor",
      options: []
    });
    const cuit = field("INPUT", {
      id: "nrodocreceptor",
      name: "nroDocReceptor",
      type: "text",
      onDispatch: (_control, event) => {
        if (autoComplete && event.type === "blur") {
          legalName.value = "AUTOCOMPLETADO POR ARCA";
          address.options = [{ value: "domicilio-arca", textContent: "AUTOCOMPLETADO POR ARCA" }];
          address.value = "domicilio-arca";
        }
      }
    });
    const email = field("INPUT", {
      id: "email",
      name: "emailReceptor",
      type: "text",
      value: "correo-existente@example.invalid"
    });
    const payments = {};
    for (let index = 1; index <= 8; index += 1) {
      payments[index] = field("INPUT", {
        id: `formadepago${index}`,
        name: index === 2 || index === 3 ? "formaDePagoTarjeta" : "formaDePago",
        type: "checkbox",
        checked: index === 1
      });
    }
    const buyers = field("SELECT", {
      id: "selectCompradoresMultiples",
      name: "selectCompradoresMultiples",
      value: "S",
      options: [
        { value: "N", textContent: "No" },
        { value: "S", textContent: "Sí" }
      ]
    });
    const associatedType = field("SELECT", {
      id: "cmp_asoc_tipo",
      name: "cmpAsociadoTipo",
      value: "91",
      options: [{ value: "91", textContent: "Remito R" }]
    });
    const associated = {
      point: field("INPUT", { name: "cmpAsociadoPtoVta", type: "text" }),
      number: field("INPUT", { name: "cmpAsociadoNro", type: "text" }),
      issuer: field("INPUT", { name: "cmpAsociadoCuitEmisor", type: "text" }),
      date: field("INPUT", { name: "cmpAsociadoFechaEmision", type: "text" })
    };
    const additionalType = field("SELECT", {
      id: "datoadicionaltipo",
      name: "datoAdicionalTipo",
      value: "0",
      options: [
        { value: "0", textContent: "Seleccionar..." },
        { value: "2", textContent: "Empresas Promovidas" }
      ]
    });
    const selectors = {
      'select#idivareceptor[name="idIVAReceptor"]': [condition],
      'input#idtipodocreceptor[name="idTipoDocReceptor"][type="hidden"]': [documentType],
      'input#nrodocreceptor[name="nroDocReceptor"]': [cuit],
      'input#razonsocialreceptor[name="razonSocialReceptor"]': [legalName],
      'select#domicilioreceptor[name="domicilioReceptor"]': [address],
      'input#email[name="emailReceptor"]': [email],
      'select#selectCompradoresMultiples[name="selectCompradoresMultiples"]': [buyers],
      'select#cmp_asoc_tipo[name="cmpAsociadoTipo"]': [associatedType],
      'select#datoadicionaltipo[name="datoAdicionalTipo"]': [additionalType],
      'input#formadepago5[name="formaDePago"][type="checkbox"]': [payments[5]],
      'input[name="cmpAsociadoPtoVta"]': [associated.point],
      'input[name="cmpAsociadoNro"]': [associated.number],
      'input[name="cmpAsociadoCuitEmisor"]': [associated.issuer],
      'input[name="cmpAsociadoFechaEmision"]': [associated.date]
    };
    for (const id of [1, 2, 3, 4, 6, 7, 8]) {
      selectors[`input#formadepago${id}[type="checkbox"]`] = [payments[id]];
    }
    const button = (value, outside = false) => ({
      value,
      outside,
      disabled: false,
      getAttribute: () => null,
      dispatchEvent(event) {
        clicks.push(`${value}:${event.type}`);
        return true;
      }
    });
    const buttons = {
      add: button("Agregar"),
      plus: button("+"),
      minus: button("-"),
      back: button("< Volver"),
      next: button("Continuar >"),
      menu: button("Menú Principal", true)
    };
    const form = {
      id: "formulario",
      name: "datosReceptorForm",
      method: "post",
      action: "https://fe.afip.gob.ar/rcel/jsp/genComDatosOperacion.do",
      getAttribute(name) {
        if (name === "method") return this.method;
        if (name === "action") return this.action;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "input[type='button']") {
          return [buttons.add, buttons.plus, buttons.minus, buttons.back, buttons.next];
        }
        if (selector === 'input[id^="formadepago"][type="checkbox"]') {
          return Object.values(payments);
        }
        return selectors[selector] || [];
      }
    };
    const forms = [form];
    const banner = { dataset: {}, textContent: "" };
    const document = {
      title: "RCEL",
      body: { innerText: fixture },
      documentElement: { appendChild: () => {} },
      querySelectorAll(selector) {
        if (selector === 'form#formulario[name="datosReceptorForm"]') return forms;
        return [];
      },
      getElementById: (id) => id === "sunnutrition-arca-assistant" ? banner : null
    };
    return {
      additionalType,
      address,
      associated,
      associatedType,
      banner,
      buttons,
      buyers,
      clicks,
      condition,
      cuit,
      document,
      documentType,
      email,
      events,
      form,
      forms,
      legalName,
      payments,
      selectors
    };
  };
  const installDom = (dom) => {
    global.document = dom.document;
    global.location = {
      href: "https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do"
    };
  };
  global.Event = class Event {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = options.bubbles;
    }
  };
  global.MouseEvent = class MouseEvent { constructor(type) { this.type = type; } };

  try {
    const payload = safeMessage().payload;
    payload.customer.cuit = "30-12345678-9";
    payload.customer.fiscalCondition = "responsable_inscripto";
    payload.invoice.receiptType = "Factura_A";
    payload.invoice.recipientCondition = "responsable_inscripto";

    let dom = createDom();
    installDom(dom);
    const untouched = {
      documentType: dom.documentType.value,
      legalNameBeforeLookup: dom.legalName.value,
      addressOptionsBeforeLookup: dom.address.options.length,
      email: dom.email.value,
      associatedType: dom.associatedType.value
    };
    assert.deepEqual(content.completeRecipientFields(payload), { ok: true, pending: false });
    assert.equal(dom.condition.value, "1");
    assert.equal(dom.cuit.value, "30123456789");
    assert.equal(dom.legalName.value, "AUTOCOMPLETADO POR ARCA");
    assert.equal(dom.address.value, "domicilio-arca");
    assert.equal(dom.email.value, untouched.email);
    assert.equal(dom.documentType.value, untouched.documentType);
    assert.equal(dom.associatedType.value, untouched.associatedType);
    assert.equal(untouched.legalNameBeforeLookup, "");
    assert.equal(untouched.addressOptionsBeforeLookup, 0);
    assert.equal(dom.payments[5].checked, true);
    assert.equal([1, 2, 3, 4, 6, 7, 8].some((id) => dom.payments[id].checked), false);
    assert.equal(dom.buyers.value, "N");
    assert.equal(Object.values(dom.associated).some((field) => field.value), false);
    assert.equal(dom.additionalType.value, "0");
    assert.deepEqual(dom.clicks, []);
    assert.deepEqual(
      dom.events.filter((event) => event.startsWith("nrodocreceptor:")),
      ["nrodocreceptor:input", "nrodocreceptor:change", "nrodocreceptor:blur"]
    );
    assert.equal(
      dom.events.some((event) => /^(razonsocialreceptor|domicilioreceptor|email):/.test(event)),
      false
    );

    global.location.href = "https://fe.afip.gob.ar/rcel/jsp/otraPantalla.do";
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_path_mismatch");

    dom = createDom();
    installDom(dom);
    dom.forms.length = 0;
    assert.equal(content.completeRecipientFields(payload).reason, "datosReceptorForm_not_unique");

    dom = createDom();
    installDom(dom);
    dom.form.action = "https://fe.afip.gob.ar/rcel/jsp/otraAccion.do";
    assert.equal(content.completeRecipientFields(payload).reason, "datosReceptorForm_action_mismatch");

    dom = createDom();
    installDom(dom);
    dom.condition.disabled = true;
    assert.equal(content.completeRecipientFields(payload).reason, "idivareceptor_disabled");

    dom = createDom();
    installDom(dom);
    dom.condition.options = [{ value: "", textContent: "seleccionar..." }];
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_condition_not_unique");

    dom = createDom();
    installDom(dom);
    dom.condition.options.push({ value: "1", textContent: "IVA Responsable Inscripto" });
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_condition_not_unique");

    dom = createDom();
    installDom(dom);
    payload.customer.cuit = "CUIT 30-12345678-9";
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_cuit_invalid");
    payload.customer.cuit = "30123456789";

    dom = createDom({ autoComplete: false });
    installDom(dom);
    assert.deepEqual(content.completeRecipientFields(payload), {
      ok: false,
      pending: true,
      reason: "recipient_legal_name_empty"
    });
    assert.equal(dom.legalName.value, "");
    assert.equal(dom.address.options.length, 0);
    assert.equal(dom.email.value, "correo-existente@example.invalid");

    dom = createDom({ autoComplete: false });
    installDom(dom);
    dom.legalName.value = "AUTOCOMPLETADO POR ARCA";
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_address_empty");

    dom = createDom({ autoComplete: false });
    installDom(dom);
    dom.legalName.value = "AUTOCOMPLETADO POR ARCA";
    dom.address.options = [
      { value: "uno", textContent: "DOMICILIO UNO" },
      { value: "dos", textContent: "DOMICILIO DOS" }
    ];
    dom.address.value = "uno";
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_address_ambiguous");

    dom = createDom();
    installDom(dom);
    dom.selectors['input#formadepago5[name="formaDePago"][type="checkbox"]'] = [];
    assert.equal(content.completeRecipientFields(payload).reason, "formadepago5_not_unique");

    dom = createDom();
    installDom(dom);
    dom.address.disabled = true;
    assert.equal(content.completeRecipientFields(payload).reason, "domicilioreceptor_disabled");

    dom = createDom();
    installDom(dom);
    dom.payments[5].disabled = true;
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_cheque_not_checked");

    dom = createDom();
    installDom(dom);
    dom.payments[1].disabled = true;
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_other_payment_checked");

    dom = createDom();
    installDom(dom);
    dom.buyers.disabled = true;
    assert.equal(content.completeRecipientFields(payload).reason, "selectCompradoresMultiples_disabled");

    dom = createDom();
    installDom(dom);
    dom.buyers.value = "N";
    dom.buyers.disabled = true;
    assert.equal(content.completeRecipientFields(payload).reason, "selectCompradoresMultiples_disabled");

    dom = createDom();
    installDom(dom);
    dom.payments[9] = {
      id: "formadepago9",
      name: "formaDePago",
      type: "checkbox",
      checked: false
    };
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_payment_controls_unexpected");
    assert.deepEqual(dom.clicks, []);
    dom.payments[9].checked = true;
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_payment_controls_unexpected");
    assert.deepEqual(dom.clicks, []);

    dom = createDom();
    installDom(dom);
    dom.payments[2].name = "formaDePago";
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_payment_controls_unexpected");
    assert.deepEqual(dom.clicks, []);

    dom = createDom();
    installDom(dom);
    dom.associated.point.value = "00001";
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_associated_fields_not_empty");

    dom = createDom();
    installDom(dom);
    dom.additionalType.value = "2";
    assert.equal(content.completeRecipientFields(payload).reason, "recipient_additional_type_active");

    dom = createDom();
    installDom(dom);
    payload.invoice.receiptType = "Factura_B";
    payload.invoice.recipientCondition = "exento";
    payload.customer.fiscalCondition = "exento";
    dom.condition.options.push({ value: "4", textContent: "IVA Sujeto Exento" });
    assert.deepEqual(content.completeRecipientFields(payload), { ok: true, pending: false });
    assert.equal(dom.condition.value, "4");
    payload.invoice.receiptType = "Factura_A";
    payload.invoice.recipientCondition = "responsable_inscripto";
    payload.customer.fiscalCondition = "responsable_inscripto";

    dom = createDom();
    installDom(dom);
    assert.deepEqual(content.completeRecipientFields(payload), { ok: true, pending: false });
    dom.form.querySelectorAll = (selector) => (
      selector === "input[type='button']" ? [] : dom.selectors[selector] || []
    );
    content.setCurrentStageForTesting("recipient");
    content.continueFromRecipientStage(payload, "Datos del receptor completos.");
    assert.deepEqual(dom.clicks, []);

    dom = createDom();
    installDom(dom);
    assert.deepEqual(content.completeRecipientFields(payload), { ok: true, pending: false });
    const duplicateContinue = {
      ...dom.buttons.next,
      dispatchEvent(event) {
        dom.clicks.push(`duplicado:${event.type}`);
        return true;
      }
    };
    dom.form.querySelectorAll = (selector) => (
      selector === "input[type='button']"
        ? [
          dom.buttons.add,
          dom.buttons.plus,
          dom.buttons.minus,
          dom.buttons.back,
          dom.buttons.next,
          duplicateContinue
        ]
        : dom.selectors[selector] || []
    );
    content.continueFromRecipientStage(payload, "Datos del receptor completos.");
    assert.deepEqual(dom.clicks, []);

    dom = createDom();
    installDom(dom);
    assert.deepEqual(content.completeRecipientFields(payload), { ok: true, pending: false });
    content.setCurrentStageForTesting("recipient");
    content.continueFromRecipientStage(payload, "Datos del receptor completos.");
    content.continueFromRecipientStage(payload, "Datos del receptor completos.");
    assert.deepEqual(dom.clicks, ["Continuar >:click"]);
    assert.equal(
      dom.clicks.some((click) => /^(Agregar|\+|-|< Volver|Menú Principal):/.test(click)),
      false
    );
  } finally {
    global.document = originalDocument;
    global.Event = originalEvent;
    global.MouseEvent = originalMouseEvent;
    global.location = originalLocation;
  }
});

test("Factura B exige IVA Sujeto Exento exacto y no adivina una opción ausente", () => {
  const select = {
    tagName: "SELECT",
    options: [
      { value: "", textContent: "seleccionar..." },
      { value: "1", textContent: "IVA Responsable Inscripto" }
    ]
  };
  const payload = safeMessage().payload;
  payload.invoice.receiptType = "Factura_B";
  payload.invoice.recipientCondition = "exento";
  payload.customer.fiscalCondition = "exento";
  assert.equal(content.recipientValuesMatch({
    conditionField: select
  }, payload), "recipient_condition_not_unique");

  select.options.push({ value: "4", textContent: "IVA Sujeto Exento" });
  select.value = "4";
  const contract = {
    conditionField: select,
    cuitField: { value: "30123456789" },
    legalNameField: { value: "AUTOCOMPLETADO POR ARCA" },
    addressField: {
      value: "domicilio-arca",
      options: [{ value: "domicilio-arca", textContent: "AUTOCOMPLETADO POR ARCA" }]
    },
    chequeField: { checked: true, disabled: false, indeterminate: false },
    otherPaymentFields: Array.from({ length: 7 }, () => ({ checked: false, indeterminate: false })),
    multipleBuyersField: { value: "N" },
    associatedFields: Array.from({ length: 4 }, () => ({ value: "" })),
    additionalTypeField: { value: "0" }
  };
  assert.equal(content.recipientValuesMatch(contract, payload), "");
  select.options.push({ value: "99", textContent: "IVA Sujeto Exento" });
  assert.equal(content.recipientValuesMatch(contract, payload), "recipient_condition_not_unique");
  select.options.pop();
  select.options.push({ value: "4", textContent: "Otra condición" });
  assert.equal(content.recipientValuesMatch(contract, payload), "recipient_condition_not_unique");
});

test("la espera del receptor usa un deadline real de cinco segundos y un único timer", () => {
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let now = 1000;
  let nextHandle = 1;
  const activeTimers = new Map();
  const cleared = [];
  Date.now = () => now;
  global.setTimeout = (callback, delay) => {
    const handle = nextHandle;
    nextHandle += 1;
    activeTimers.set(handle, { callback, delay });
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (activeTimers.delete(handle)) cleared.push(handle);
  };
  try {
    content.resetRecipientLookupWait();
    assert.equal(content.RECIPIENT_LOOKUP_TIMEOUT_MS, 5000);
    assert.equal(content.scheduleRecipientLookupRetry(() => {}), true);
    assert.equal(activeTimers.size, 1);
    assert.equal([...activeTimers.values()][0].delay, 250);

    now = 1100;
    assert.equal(content.scheduleRecipientLookupRetry(() => {}), true);
    assert.equal(activeTimers.size, 1);
    assert.deepEqual(cleared, [1]);

    now = 5999;
    assert.equal(content.scheduleRecipientLookupRetry(() => {}), true);
    assert.equal(activeTimers.size, 1);
    assert.equal([...activeTimers.values()][0].delay, 1);

    now = 6000;
    assert.equal(content.scheduleRecipientLookupRetry(() => {}), false);
    assert.equal(activeTimers.size, 0);
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    content.resetRecipientLookupWait();
  }
});

test("fixture DOM completa campos exactos, eventos y líneas sin clicks ni submits", () => {
  const originalDocument = global.document;
  const dispatched = [];
  const field = (tagName = "INPUT", options = []) => ({
    tagName,
    id: "",
    name: "",
    value: "",
    options,
    dispatchEvent: (event) => dispatched.push(event.type)
  });
  const point = field();
  point.id = "point";
  const receipt = field("SELECT", [{ value: "A", textContent: "Factura A" }]);
  receipt.id = "receipt";
  const labels = [
    { textContent: "Punto de Venta", getAttribute: () => "point", querySelector: () => null },
    { textContent: "Tipo de Comprobante", getAttribute: () => "receipt", querySelector: () => null }
  ];
  const controls = { point, receipt };
  global.document = {
    querySelectorAll: (selector) => selector === "label" ? labels : [],
    getElementById: (id) => controls[id] || null
  };
  try {
    const payload = safeMessage().payload;
    payload.invoice.receiptType = "Factura_A";
    assert.equal(content.completeExactFields(content.buildFieldPlan("initial", payload)), true);
    assert.equal(point.value, "00001");
    assert.equal(receipt.value, "A");
    assert.deepEqual(dispatched, ["input", "change", "input", "change"]);

    const cuit = field();
    cuit.id = "cuit";
    const condition = field("SELECT", [{
      value: "RI",
      textContent: "IVA Responsable Inscripto"
    }]);
    condition.id = "condition";
    const saleCondition = field("SELECT", [{ value: "CH", textContent: "Cheque" }]);
    saleCondition.id = "sale-condition";
    Object.assign(controls, { cuit, condition, "sale-condition": saleCondition });
    labels.splice(0, labels.length,
      { textContent: "CUIT", getAttribute: () => "cuit", querySelector: () => null },
      { textContent: "Condición frente al IVA", getAttribute: () => "condition", querySelector: () => null },
      { textContent: "Condición de venta", getAttribute: () => "sale-condition", querySelector: () => null }
    );
    payload.customer.fiscalCondition = "responsable_inscripto";
    assert.equal(content.completeExactFields(content.buildFieldPlan("recipient", payload)), true);
    assert.deepEqual(
      [cuit.value, condition.value, saleCondition.value],
      ["30123456789", "RI", "CH"]
    );

    global.document.querySelectorAll = () => [];
    assert.equal(content.completeExactFields(content.buildFieldPlan("initial", payload)), false);
  } finally {
    global.document = originalDocument;
  }
});

test("la nueva solapa carga el módulo y los datos sólo al abrirla", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "assets/js/app.js"), "utf8");

  assert.match(html, /data-view="arca-invoicing"/);
  assert.doesNotMatch(html, /<script[^>]+src="assets\/js\/modules\/arca-invoicing\.js/);
  assert.match(app, /loadDeferredScript\(\s*"assets\/js\/modules\/arca-invoicing\.js/);
  assert.match(app, /runViewLoad\(view/);
});

test("la preparación se invalida y el ciclo de vida cancela contexto, revalida y usa fecha local", () => {
  const source = fs.readFileSync(path.join(root, "assets/js/modules/arca-invoicing.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "assets/js/app.js"), "utf8");

  assert.match(source, /arca-products-body"\)\?\.addEventListener\("change", clearPreparedState\)/);
  assert.match(source, /MAX_POLL_FAILURES = 3/);
  assert.match(source, /POLL_TIMEOUT_MS = 5 \* 60 \* 1000/);
  assert.match(source, /discardPreparedContext\("timeout"/);
  assert.match(source, /preparedBeforeRevalidation\.prepareRequest/);
  assert.match(source, /type: "CANCEL_SESSION"/);
  assert.match(source, /state\.launchSequence !== launchSequence/);
  assert.match(
    source,
    /cancelExtensionSession\(extensionId, preparedForExtension\.sessionId, \{[\s\S]*?revision: preparedForExtension\.payload\.revision,[\s\S]*?generation: preparedForExtension\.generation/
  );
  assert.match(source, /preparedForExtension\.generation = responseGeneration/);
  assert.match(source, /generation: prepared\.generation/);
  assert.match(source, /orderId, status, reason/);
  assert.match(source, /pagehide/);
  assert.match(app, /window\.cancelArcaInvoicing\?\.\("manual_abort"\)/);
  assert.equal(frontend.invoiceDateFromOrder({ fecha_entrega_prevista: "2026-07-30" }), "2026-07-30");
  assert.equal(frontend.invoiceDateFromOrder({ fecha_entrega_prevista: "2026-02-30" }), "");
  const dateInput = { value: "2026-07-01" };
  frontend.setInvoiceDateFromOrder({ fecha_entrega_prevista: "2026-07-31" }, dateInput);
  assert.equal(dateInput.value, "2026-07-31");
  frontend.setInvoiceDateFromOrder({ fecha_entrega_prevista: "" }, dateInput);
  assert.equal(dateInput.value, "");
  assert.deepEqual(frontend.buildPrepareRequest("1023", "Factura_B", "2026-07-30"), {
    orderId: "1023",
    receiptType: "Factura_B",
    invoiceDate: "2026-07-30"
  });
  assert.match(frontend.fiscalSummaryForReceipt("Factura_B"), /IVA Sujeto Exento/);
  assert.deepEqual(fiscal.validateProductInvoiceDate("2026-07-25", "2026-07-30"), { ok: true, reason: "" });
  assert.deepEqual(fiscal.validateProductInvoiceDate("2026-08-03", "2026-07-30"), {
    ok: false,
    reason: "future_month"
  });
  assert.match(frontend.extensionStatusLabel("waiting_login"), /clave cifrada/);
  assert.match(frontend.extensionStatusLabel("waiting_representative"), /SunNutrition/);
  assert.match(frontend.extensionStatusLabel("service_recognized"), /Comprobantes en línea/);
  assert.match(frontend.extensionStatusLabel("completing_stage", "recipient"), /datos del receptor/);
});

test("una preparación tardía se cancela y cierra sólo la pestaña creada por esa carrera", () => {
  const removed = [];
  const originalChrome = global.chrome;
  global.chrome = {
    runtime: { lastError: null },
    tabs: {
      sendMessage: (_tabId, _message, callback) => callback(),
      remove: (tabId, callback) => {
        removed.push(tabId);
        callback();
      }
    }
  };
  try {
    const session = {
      id: "late-session",
      status: "waiting_login",
      stage: "login",
      reason: "",
      payload: safeMessage().payload,
      tabId: 73,
      updatedAt: new Date().toISOString()
    };
    background.cancelSession(session, "manual_abort", { closeTab: true });
    assert.deepEqual(removed, [73]);
    assert.equal(session.status, "interrupted");
    assert.equal(session.payload, null);
  } finally {
    global.chrome = originalChrome;
  }
});

test("la extensión elimina el payload al cancelar y aplica TTL autónomo", () => {
  let forgotten = 0;
  background.setVaultControllerForTesting({
    forget: async () => { forgotten += 1; },
    status: async () => ({ ok: true, status: "stored" })
  });
  const session = {
    id: "session",
    orderId: "10",
    payload: safeMessage().payload,
    status: "waiting_login",
    stage: "login",
    reason: "",
    tabId: null,
    updatedAt: new Date().toISOString()
  };
  background.cancelSession(session, "timeout");
  assert.equal(session.payload, null);
  assert.equal(session.status, "interrupted");
  assert.equal(session.reason, "timeout");
  assert.equal(background.SESSION_TTL_MS, 5 * 60 * 1000);
  assert.equal(forgotten, 0);
});

test("el código persiste sólo ciphertext local, no expone secretos y reintenta sólo asociación", () => {
  const backgroundSource = fs.readFileSync(path.join(root, "tools/arca-extension/background.js"), "utf8");
  const contentSource = fs.readFileSync(path.join(root, "tools/arca-extension/content-script.js"), "utf8");

  assert.match(backgroundSource, /chrome\?\.storage\?\.session/);
  assert.match(backgroundSource, /chrome\.storage\.local/);
  assert.doesNotMatch(backgroundSource, /storage\.sync/);
  assert.match(backgroundSource, /AES-GCM/);
  assert.match(backgroundSource, /indexedDB/);
  assert.doesNotMatch(backgroundSource, /console\.(log|info|warn|error)/);
  assert.equal(content.MAX_SESSION_LOOKUP_ATTEMPTS, 12);
  assert.equal((contentSource.match(/verified\.password\.click\s*\(\)/g) || []).length, 1);
  assert.doesNotMatch(
    contentSource.replace(/verified\.password\.click\s*\(\)/g, ""),
    /\.click\s*\(|\.submit\s*\(|requestSubmit\s*\(/
  );
});

test("la UI contiene estados, bloqueos y textos de control manual", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const view = html.match(/id="view-arca-invoicing"([\s\S]*?)id="view-sales-invoice-entry"/)?.[1] || "";

  assert.match(view, /<th scope="col">Entrega prevista<\/th>/);
  assert.match(view, /<th scope="col">Entrega<\/th>/);
  assert.doesNotMatch(view, /Entregado sin factura/);
  assert.match(view, /Datos incompletos/);
  assert.doesNotMatch(view, /Ya facturados/);
  assert.match(view, /extensión usa la clave cifrada guardada; MFA y CAPTCHA siempre son manuales/);
  assert.match(view, /Confirmar, Emitir, Generar,\s+Obtener CAE, Firmar o Presentar/);
  assert.doesNotMatch(view, /id="arca-(issuer-condition|recipient-condition|point-of-sale)"/);
  assert.doesNotMatch(view, /data-arca-vat|id="arca-summary-condition"/);
  assert.doesNotMatch(view, /Factura C/);
  assert.match(view, /id="arca-receipt-type"/);
  assert.match(view, /id="arca-invoice-date" type="date"/);
});

test("Datos de la operacion usa el fixture sanitizado y completa el ejemplo exacto una sola vez", () => {
  const fixtureHtml = fs.readFileSync(
    path.join(root, "tests/fixtures/arca/operation-fields-legacy.html"),
    "utf8"
  );
  assert.match(fixtureHtml, /form name="datosOperacionForm" method="post" action="\/rcel\/jsp\/genComResumenDatos\.do"/);
  assert.match(fixtureHtml, /value="7" selected>seleccionar\.\.\.<\/option>[\s\S]*value="7">unidades/);
  assert.equal(fixtureHtml.includes('value="Agregar línea descripción"'), true);
  assert.match(fixtureHtml, /value="Continuar &gt;"/);
  assert.doesNotMatch(fixtureHtml, /cuit|cookie|token|password|mfa|captcha/i);

  const payload = safeMessage().payload;
  payload.customer.address = "Miralla_235, Liniers";
  const calculation = require("../shared/order-pricing").calculateLine({
    boxes: 40,
    unitsPerBox: 140,
    unitPrice: 1.5,
    discountPercent: 10,
    vatRate: 21,
    receiptType: "Factura_A"
  });
  payload.lines = [{
    id: "1",
    productId: "67",
    productName: "Barra Pop 140Ud",
    boxes: 40,
    unitsPerBox: 140,
    quantity: 5600,
    unitValue: "7",
    unitText: "unidades",
    description: "40 Barra Pop 140Ud - Entrega: Miralla 235, Liniers",
    ...calculation
  }];
  const dom = operationDomFixture(payload);
  withOperationDom(dom, () => {
    const result = content.completeOperationFields(payload);
    assert.deepEqual(result, { ok: true, pending: false, reason: "", message: "" });
    assert.equal(dom.lineSets[0].code.value, "4");
    assert.equal(dom.lineSets[0].description.value, payload.lines[0].description);
    assert.equal(dom.lineSets[0].quantity.value, "5600");
    assert.equal(dom.lineSets[0].unit.value, "7");
    assert.equal(dom.lineSets[0].unit.selectedIndex, 2);
    assert.equal(dom.lineSets[0].unit.options[0].value, "7");
    assert.equal(dom.lineSets[0].unit.options[0].selected, false);
    assert.equal(dom.lineSets[0].unit.options[2].textContent, "unidades");
    assert.equal(dom.lineSets[0].price.value, "1.5");
    assert.equal(dom.lineSets[0].discountPercent.value, "10");
    assert.equal(
      dom.lineSets[0].vatType.options[dom.lineSets[0].vatType.selectedIndex].value,
      "5"
    );
    assert.equal(dom.lineSets[0].netSubtotal.value, String(payload.lines[0].netSubtotal));
    assert.equal(content.operationValuesMatch(content.operationScreenContract(), payload), "");

    content.setCurrentStageForTesting("lines");
    content.continueFromOperationStage(payload, "Datos de la operacion completos.");
    content.continueFromOperationStage(payload, "Datos de la operacion completos.");
    assert.equal(dom.counters.continue, 1);
    assert.deepEqual(
      [dom.counters.delete, dom.counters.addTribute, dom.counters.back, dom.counters.menu],
      [0, 0, 0, 0]
    );
  });
});

test("una preparación reemplazada detiene Datos de la operación sin ejecutar botones", () => {
  const payload = safeMessage().payload;
  const dom = operationDomFixture(payload);
  withOperationDom(dom, () => {
    content.setActiveSessionForTesting({
      sessionId: "reemplazada",
      payload: { ...payload, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    });
    content.expireActiveSessionForTesting("El ERP canceló o reemplazó esta preparación.");
    content.runRecognizedStageForTesting();
    assert.deepEqual(
      [
        dom.counters.add,
        dom.counters.addTribute,
        dom.counters.delete,
        dom.counters.back,
        dom.counters.menu,
        dom.counters.continue
      ],
      [0, 0, 0, 0, 0, 0]
    );
    assert.match(dom.banner.textContent, /canceló o reemplazó esta preparación/);
  });
});

test("la fila predeterminada de tributos vacía o en cero queda intacta", () => {
  const payload = safeMessage().payload;
  const dom = operationDomFixture(payload, { defaultTributeZeros: true });
  const before = Object.fromEntries(Object.entries(dom.tributeFields).map(([name, fields]) => [
    name,
    fields.map((field) => field.value)
  ]));
  withOperationDom(dom, () => {
    const result = content.completeOperationFields(payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      Object.fromEntries(Object.entries(dom.tributeFields).map(([name, fields]) => [
        name,
        fields.map((field) => field.value)
      ])),
      before
    );
    assert.deepEqual(
      [dom.counters.add, dom.counters.addTribute, dom.counters.delete],
      [0, 0, 0]
    );
  });
});

test("un tributo realmente seleccionado detiene el llenado", () => {
  const payload = safeMessage().payload;
  const dom = operationDomFixture(payload, { selectedTribute: true });
  withOperationDom(dom, () => {
    const result = content.completeOperationFields(payload);
    assert.equal(result.reason, "operation_tribute_active");
    assert.deepEqual(
      [dom.counters.add, dom.counters.addTribute, dom.counters.delete, dom.counters.continue],
      [0, 0, 0, 0]
    );
  });
});

test("un campo editable de tributo completado detiene el llenado", () => {
  const payload = safeMessage().payload;
  const dom = operationDomFixture(payload, { completedTribute: true });
  withOperationDom(dom, () => {
    const result = content.completeOperationFields(payload);
    assert.equal(result.reason, "operation_tribute_active");
    assert.deepEqual(
      [dom.counters.add, dom.counters.addTribute, dom.counters.delete, dom.counters.continue],
      [0, 0, 0, 0]
    );
  });
});

test("Datos de la operacion completa unidades y kg sólo en filas superiores preexistentes", () => {
  const payload = safeMessage().payload;
  const pricing = require("../shared/order-pricing");
  const unitsCalculation = pricing.calculateLine({
    boxes: 2,
    unitsPerBox: 10,
    unitPrice: 100,
    discountPercent: 10,
    vatRate: 21,
    receiptType: "Factura_A"
  });
  const kgCalculation = pricing.calculateMeasuredLine({
    quantity: 128.5,
    unitPrice: 843,
    discountPercent: 0,
    vatRate: 21,
    receiptType: "Factura_A"
  });
  payload.lines = [
    {
      productName: "Barra Pop 10Ud",
      boxes: 2,
      unitsPerBox: 10,
      quantity: 20,
      unitValue: "7",
      unitText: "unidades",
      description: "2 Barra Pop 10Ud - Entrega: Calle 1",
      ...unitsCalculation
    },
    {
      productName: "Materia Prima Pochoclo Dulce",
      boxes: 128.5,
      unitsPerBox: null,
      quantity: 128.5,
      unitValue: "1",
      unitText: "kilogramos",
      description: "128.5 Materia Prima Pochoclo Dulce - Entrega: Calle 1",
      ...kgCalculation
    },
    {
      productName: "Barra My Pop 10Ud",
      boxes: 1,
      unitsPerBox: 10,
      quantity: 10,
      unitValue: "7",
      unitText: "unidades",
      description: "1 Barra My Pop 10Ud - Entrega: Calle 1",
      ...pricing.calculateLine({
        boxes: 1,
        unitsPerBox: 10,
        unitPrice: 50,
        discountPercent: 0,
        vatRate: 21,
        receiptType: "Factura_A"
      })
    }
  ];
  const dom = operationDomFixture(payload, { initialLineCount: 3 });
  withOperationDom(dom, () => {
    const result = content.completeOperationFields(payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(dom.counters.add, 0);
    assert.equal(dom.counters.addTribute, 0);
    assert.equal(dom.lineSets.length, 3);
    assert.equal(dom.lineSets[1].quantity.value, "128.5");
    assert.equal(dom.lineSets[1].unit.options[dom.lineSets[1].unit.selectedIndex].value, "1");
    assert.equal(dom.lineSets[1].unit.options[dom.lineSets[1].unit.selectedIndex].textContent, "kilogramos");
    assert.equal(dom.counters.delete, 0);
  });
});

test("Datos de la operacion acepta la numeracion legacy vacia y rechaza mapeos ambiguos", () => {
  const payload = safeMessage().payload;
  payload.lines = [structuredClone(payload.lines[0]), structuredClone(payload.lines[0])];
  const cases = [
    ["legacy real vacío", { initialLineCount: 2, lineNumbers: ["", ""] }, true, ""],
    ["secuencia explícita", { initialLineCount: 2, lineNumbers: ["1", "2"] }, true, ""],
    ["número ausente", { initialLineCount: 2, missingLineNumber: true }, false, "operation_line_controls_mismatch"],
    ["no numérico", { initialLineCount: 2, lineNumbers: ["1", "dos"] }, false, "operation_line_number_invalid"],
    ["duplicado", { initialLineCount: 2, lineNumbers: ["1", "1"] }, false, "operation_line_number_invalid"],
    ["fuera de secuencia", { initialLineCount: 2, lineNumbers: ["1", "3"] }, false, "operation_line_number_invalid"],
    ["control duplicado", { initialLineCount: 2, duplicateLineNumberControl: true }, false, "operation_line_controls_mismatch"],
    ["modos mezclados", { initialLineCount: 2, lineNumbers: ["", "2"] }, false, "operation_line_number_invalid"],
    ["id e índice discrepantes", { initialLineCount: 2, mismatchedLineIndex: 1 }, false, "operation_line_ids_mismatch"]
  ];
  for (const [label, options, expectedOk, expectedReason] of cases) {
    const dom = operationDomFixture(payload, options);
    withOperationDom(dom, () => {
      const contract = content.operationScreenContract();
      assert.equal(contract.ok, expectedOk, label);
      assert.equal(contract.reason || "", expectedReason, label);
    });
  }
});

test("Datos de la operacion falla cerrado ante contrato, valores o controles ambiguos", () => {
  const payload = safeMessage().payload;
  const cases = [
    ["path", {}, "https://fe.afip.gob.ar/rcel/jsp/otra.do", "operation_path_mismatch"],
    ["titulo", { title: "Otra pantalla" }, undefined, "operation_title_mismatch"],
    ["form duplicado", { duplicateForm: true }, undefined, "datosOperacionForm_not_unique"],
    ["metodo", { method: "get" }, undefined, "datosOperacionForm_method_mismatch"],
    ["action", { action: "/rcel/jsp/otra.do" }, undefined, "datosOperacionForm_action_mismatch"],
    ["codigo ausente", { missingCode: true }, undefined, "operation_line_controls_mismatch"],
    ["unidad ausente", { missingUnit: true }, undefined, "operation_unit_not_unique"],
    ["unidad duplicada", { duplicateUnit: true }, undefined, "operation_unit_not_unique"],
    ["evento revierte", { revertFieldName: "detallePrecio" }, undefined, "operation_value_rejected"],
    ["subtotal incoherente", { corruptSubtotal: true }, undefined, "operation_subtotal_mismatch"],
    ["IVA distinto", { wrongVat: true }, undefined, "operation_vat_not_unique"],
    ["tributo activo", { activeTribute: true }, undefined, "operation_tribute_active"],
    ["continuar ausente", { missingContinue: true }, undefined, "operation_continue_not_unique"],
    ["continuar duplicado", { duplicateContinue: true }, undefined, "operation_continue_not_unique"]
  ];
  for (const [label, options, href, expectedReason] of cases) {
    const dom = operationDomFixture(payload, options);
    withOperationDom(dom, () => {
      const result = content.completeOperationFields(payload);
      assert.equal(result.ok, false, label);
      assert.equal(result.reason, expectedReason, label);
      assert.deepEqual(
        [dom.counters.delete, dom.counters.addTribute, dom.counters.back, dom.counters.menu],
        [0, 0, 0, 0],
        label
      );
    }, href);
  }

  const missingRowsPayload = structuredClone(payload);
  missingRowsPayload.lines.push(structuredClone(payload.lines[0]));
  const missingRows = operationDomFixture(missingRowsPayload, { initialLineCount: 1 });
  withOperationDom(missingRows, () => {
    const result = content.completeOperationFields(missingRowsPayload);
    assert.equal(result.reason, "operation_product_lines_missing");
    assert.equal(result.pending, false);
    assert.equal(missingRows.counters.add, 0);
    assert.equal(missingRows.counters.addTribute, 0);
    assert.equal(missingRows.counters.delete, 0);
  });

  const extra = operationDomFixture(payload, { initialLineCount: 2 });
  withOperationDom(extra, () => {
    const result = content.completeOperationFields(payload);
    assert.equal(result.reason, "operation_extra_lines");
    assert.equal(extra.counters.delete, 0);
  });
});
