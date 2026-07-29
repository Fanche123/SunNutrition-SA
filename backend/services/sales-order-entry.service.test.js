const assert = require("node:assert/strict");
const test = require("node:test");
const { createSalesOrderEntryService } = require("./sales-order-entry.service");
const {
  createCatalogCombobox,
  findDefaultOrderProduct,
  filterCatalogOptions,
  orderDetailFromDraftValues
} = require("../../assets/js/modules/sales-orders");

global.backendId = (value) => value === null || value === undefined || value === "" ? "" : String(value);
global.displayNameLabel = (value) => String(value || "").replaceAll("_", " ");
global.escapeHtml = (value) => String(value || "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

class FakeControl {
  constructor(value = "") {
    this.value = value;
    this.hidden = true;
    this.attributes = new Map();
    this.listeners = new Map();
    this.validityMessage = "";
    this.options = [];
    this.dataset = {};
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, properties = {}) {
    const event = {
      target: this,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...properties
    };
    this.listeners.get(type)?.(event);
    return event;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  setCustomValidity(message) {
    this.validityMessage = message;
  }

  set innerHTML(value) {
    this.html = value;
    this.options = [...value.matchAll(/data-catalog-index="(\d+)"/g)].map((match) => ({
      dataset: { catalogIndex: match[1] },
      classList: { toggle() {} }
    }));
  }

  get innerHTML() {
    return this.html || "";
  }

  querySelectorAll() {
    return this.options;
  }
}

function createComboboxFixture(rows, config = {}) {
  const input = new FakeControl(config.inputValue || "");
  const valueInput = new FakeControl(config.selectedId || "");
  const listbox = new FakeControl();
  const combobox = createCatalogCombobox({
    name: config.name || "Cliente",
    input,
    valueInput,
    listbox,
    rows,
    idKey: config.idKey || "id_cliente",
    labelKey: config.labelKey || "nombre_cliente",
    inputId: config.inputId || "order-client"
  });
  return { combobox, input, valueInput, listbox };
}

function createFixture(options = {}) {
  const source = {
    generatedAt: "",
    tables: {
      clientes: { rows: [{ id_cliente: 1 }], rowCount: 1 },
      productos: { rows: [{ id_producto: 10 }, { id_producto: 11 }], rowCount: 2 },
      pedidos: { rows: [], rowCount: 0 },
      detalle_pedidos: { rows: [], rowCount: 0 }
    }
  };
  let saved = null;
  let saveCount = 0;
  const responses = [];
  const service = createSalesOrderEntryService({
    backendId: (value) => value === null || value === undefined || value === "" ? "" : String(value),
    backendNextNumericId: (rows, key) => rows.reduce((max, row) => Math.max(max, Number(row[key]) || 0), 0) + 1,
    backendNumber: (value) => Number(value) || 0,
    ensureBackendTable: (tables, name) => {
      tables[name] ||= { rows: [], rowCount: 0 };
    },
    isIsoDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")),
    loadCache: () => source,
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => {
      if (options.failSave) throw new Error("fallo de persistencia");
      saveCount += 1;
      saved = cache;
    },
    sendJson: (_response, status, payload) => {
      responses.push({ status, payload });
      return payload;
    },
    failureInjector: options.failureInjector
  });
  return { service, source, responses, saved: () => saved, saveCount: () => saveCount };
}

function validBody(details = [{
  idProducto: 10,
  cantidadCajas: 2,
  impuesto: "A",
  precioUd: 150,
  bonificacion: 0
}]) {
  return {
    order: {
      idCliente: 1,
      fechaPedido: "2026-07-23",
      fechaEntrega: "2026-07-24",
      fechaOriginal: "2026-07-24"
    },
    details
  };
}

async function submit(fixture, body) {
  await fixture.service.handleSalesOrderFullEntry({ body }, {});
  return fixture.responses.at(-1);
}

test("guarda encabezado y un detalle con una sola persistencia", async () => {
  const fixture = createFixture();
  const result = await submit(fixture, validBody());
  assert.equal(result.status, 200);
  assert.equal(fixture.saved().tables.pedidos.rows.length, 1);
  assert.equal(fixture.saved().tables.detalle_pedidos.rows.length, 1);
  assert.equal(fixture.saved().tables.detalle_pedidos.rows[0].id_pedido, result.payload.orderId);
  assert.equal(fixture.saveCount(), 1);
  assert.deepEqual(
    Object.keys(fixture.saved().tables.pedidos.rows[0]).filter((key) => !key.startsWith("_")),
    ["id_pedido", "fecha_pedido", "id_cliente", "fecha_entrega", "fecha_original"]
  );
  assert.deepEqual(
    Object.keys(fixture.saved().tables.detalle_pedidos.rows[0]).filter((key) => !key.startsWith("_")),
    ["id_detalle_pedido", "id_pedido", "id_producto", "cantidad_cajas", "impuesto", "precio_ud", "bonificacion"]
  );
});

test("genera IDs backend para varios detalles", async () => {
  const fixture = createFixture();
  const result = await submit(fixture, validBody([
    { idProducto: 10, cantidadCajas: 2, impuesto: "A", precioUd: 150, bonificacion: 0 },
    { idProducto: 11, cantidadCajas: 1, impuesto: "B", precioUd: 90, bonificacion: 5 }
  ]));
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.detailIds, [1, 2]);
  assert.equal(fixture.saved().tables.detalle_pedidos.rows.length, 2);
});

test("guarda el detalle agregado cuando el borrador conserva producto pero tiene cantidad limpia", async () => {
  const addedDetails = [
    { idProducto: 10, cantidadCajas: 40, impuesto: "A", precioUd: 150, bonificacion: 5 }
  ];
  const emptyDraft = orderDetailFromDraftValues({
    idProducto: 10,
    cantidadCajas: "",
    impuesto: "A",
    precioUd: 0,
    bonificacion: 0
  });
  const details = emptyDraft ? [...addedDetails, emptyDraft] : [...addedDetails];

  assert.equal(emptyDraft, null);
  assert.deepEqual(details, addedDetails);

  const fixture = createFixture();
  const result = await submit(fixture, validBody(details));
  assert.equal(result.status, 200);
  assert.deepEqual(
    fixture.saved().tables.detalle_pedidos.rows.map((detail) => ({
      id_producto: detail.id_producto,
      cantidad_cajas: detail.cantidad_cajas,
      impuesto: detail.impuesto,
      precio_ud: detail.precio_ud,
      bonificacion: detail.bonificacion
    })),
    [{ id_producto: "10", cantidad_cajas: 40, impuesto: "A", precio_ud: 150, bonificacion: 5 }]
  );
});

test("el borrador limpio no altera cantidades independientes de múltiples detalles", async () => {
  const details = [
    { idProducto: 10, cantidadCajas: 40, impuesto: "A", precioUd: 150, bonificacion: 0 },
    { idProducto: 11, cantidadCajas: 3, impuesto: "B", precioUd: 90, bonificacion: 5 }
  ];
  const emptyDraft = orderDetailFromDraftValues({ idProducto: 11, cantidadCajas: "" });
  const fixture = createFixture();
  const result = await submit(fixture, validBody(emptyDraft ? [...details, emptyDraft] : details));

  assert.equal(result.status, 200);
  assert.deepEqual(
    fixture.saved().tables.detalle_pedidos.rows.map((detail) => [detail.id_producto, detail.cantidad_cajas]),
    [["10", 40], ["11", 3]]
  );
});

for (const [name, mutate] of [
  ["cliente inexistente", (body) => { body.order.idCliente = 999; }],
  ["producto inexistente", (body) => { body.details[0].idProducto = 999; }],
  ["cantidad cero", (body) => { body.details[0].cantidadCajas = 0; }],
  ["cantidad negativa", (body) => { body.details[0].cantidadCajas = -1; }],
  ["cantidad no numérica", (body) => { body.details[0].cantidadCajas = "invalida"; }],
  ["payload sin detalles", (body) => { body.details = []; }]
]) {
  test(`responde 400 para ${name} sin persistir`, async () => {
    const fixture = createFixture();
    const body = validBody();
    mutate(body);
    const result = await submit(fixture, body);
    assert.equal(result.status, 400);
    assert.equal(fixture.saved(), null);
    assert.equal(fixture.source.tables.pedidos.rows.length, 0);
    assert.equal(fixture.source.tables.detalle_pedidos.rows.length, 0);
  });
}

test("un fallo antes del guardado no deja filas aisladas", async () => {
  const fixture = createFixture({
    failureInjector: (stage) => {
      if (stage === "after-order") throw new Error("fallo antes del detalle");
    }
  });
  const result = await submit(fixture, validBody());
  assert.equal(result.status, 400);
  assert.equal(fixture.source.tables.pedidos.rows.length, 0);
  assert.equal(fixture.source.tables.detalle_pedidos.rows.length, 0);
});

test("un fallo durante la persistencia no modifica la instancia original", async () => {
  const fixture = createFixture({ failSave: true });
  const result = await submit(fixture, validBody());
  assert.equal(result.status, 400);
  assert.equal(fixture.source.tables.pedidos.rows.length, 0);
  assert.equal(fixture.source.tables.detalle_pedidos.rows.length, 0);
});

test("reintentar después de un fallo guarda una sola unidad coherente", async () => {
  let fail = true;
  const fixture = createFixture({
    failureInjector: (stage) => {
      if (stage === "before-save" && fail) {
        fail = false;
        throw new Error("fallo transitorio");
      }
    }
  });
  assert.equal((await submit(fixture, validBody())).status, 400);
  assert.equal((await submit(fixture, validBody())).status, 200);
  assert.equal(fixture.saved().tables.pedidos.rows.length, 1);
  assert.equal(fixture.saved().tables.detalle_pedidos.rows.length, 1);
});

test("combobox filtra clientes y productos sin distinguir mayúsculas ni tildes", () => {
  const clients = [
    { id_cliente: 1, nombre_cliente: "Álamo_Sur" },
    { id_cliente: 2, nombre_cliente: "Distribuidora_Alamo" },
    { id_cliente: 3, nombre_cliente: "Norte" }
  ];
  assert.deepEqual(
    filterCatalogOptions(clients, "nombre_cliente", "ALAMO").map((option) => option.row.id_cliente),
    [1, 2]
  );

  const products = [
    { id_producto: 10, nombre_producto: "Barra_Pop_140Ud" },
    { id_producto: 11, nombre_producto: "Caja_Barra_Pop" },
    { id_producto: 12, nombre_producto: "Alfajor" }
  ];
  assert.deepEqual(
    filterCatalogOptions(products, "nombre_producto", "barra pop").map((option) => option.row.id_producto),
    [10, 11]
  );
});

test("combobox selecciona por teclado el ID canónico aunque haya etiquetas duplicadas", () => {
  const rows = [
    { id_cliente: 7, nombre_cliente: "Cliente_Duplicado" },
    { id_cliente: 9, nombre_cliente: "Cliente_Duplicado" }
  ];
  const { combobox, input, valueInput } = createComboboxFixture(rows);
  input.dispatch("focus");
  input.dispatch("keydown", { key: "ArrowDown" });
  const enter = input.dispatch("keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(combobox.validSelectedId(), "9");
  assert.equal(valueInput.value, "9");
  assert.equal(input.value, "Cliente Duplicado");
});

test("combobox selecciona con mouse y expone semántica accesible", () => {
  const rows = [
    { id_producto: 67, nombre_producto: "Barra_Pop_140Ud" },
    { id_producto: 71, nombre_producto: "Barra_My_Pop_140Ud" }
  ];
  const { combobox, input, valueInput, listbox } = createComboboxFixture(rows, {
    name: "Producto",
    idKey: "id_producto",
    labelKey: "nombre_producto",
    inputId: "order-product"
  });
  input.dispatch("click");
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.match(input.getAttribute("aria-activedescendant"), /^order-product-option-/);
  listbox.dispatch("click", { target: { closest: () => listbox.options[0] } });
  assert.equal(combobox.validSelectedId(), "71");
  assert.equal(valueInput.value, "71");
  assert.equal(input.getAttribute("aria-expanded"), "false");
});

test("texto libre invalida la selección previa y Tab no elige accidentalmente", () => {
  const rows = [{ id_cliente: 4, nombre_cliente: "Café_Central" }];
  const { combobox, input, valueInput } = createComboboxFixture(rows);
  assert.equal(combobox.selectById(4), true);
  input.value = "Café inventado";
  input.dispatch("input");
  assert.equal(combobox.validSelectedId(), "");
  assert.equal(valueInput.value, "");
  assert.match(input.validityMessage, /válido del listado/);
  input.dispatch("keydown", { key: "Tab" });
  assert.equal(combobox.validSelectedId(), "");
});

test("predeterminado usa el producto canónico exacto y omite ausentes o deshabilitados", () => {
  const available = [
    { id_producto: 67, nombre_producto: "Barra_Pop_140Ud" },
    { id_producto: 68, nombre_producto: "Barra_Pop_140Ud", activo: false }
  ];
  assert.equal(findDefaultOrderProduct(available).id_producto, 67);
  assert.equal(findDefaultOrderProduct([{ id_producto: 68, nombre_producto: "Barra_Pop_140Ud", activo: false }]), undefined);
  assert.equal(findDefaultOrderProduct([{ id_producto: 69, nombre_producto: "Barra_Pop_150Ud" }]), undefined);
});

test("recargar catálogo conserva una selección válida y no la reemplaza por el predeterminado", () => {
  const rows = [
    { id_producto: 67, nombre_producto: "Barra_Pop_140Ud" },
    { id_producto: 71, nombre_producto: "Barra_My_Pop_140Ud" }
  ];
  const { combobox, input, valueInput } = createComboboxFixture(rows, {
    name: "Producto",
    idKey: "id_producto",
    labelKey: "nombre_producto",
    inputId: "order-product"
  });
  assert.equal(combobox.selectById(71), true);
  combobox.refresh([...rows].reverse());
  assert.equal(combobox.validSelectedId(), "71");
  assert.equal(valueInput.value, "71");
  assert.equal(input.value, "Barra My Pop 140Ud");
});
