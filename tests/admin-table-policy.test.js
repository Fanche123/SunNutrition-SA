const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ADMIN_TABLE_POLICY, adminTableCapability } = require("../backend/config/admin-table-policy");

function main() {
  const registry = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "backend", "table-registry.json"), "utf8")
  );

  registry.tables.forEach(({ name }) => {
    const policy = ADMIN_TABLE_POLICY[name];
    assert(policy, `${name} debe tener una politica administrativa explicita`);
    assert.deepStrictEqual(
      [policy.read, policy.insert, policy.update, policy.delete],
      [true, true, true, true],
      `${name} debe permitir CRUD administrativo completo`
    );
    assert.strictEqual(policy.category, "administrative");
    assert.strictEqual(policy.reason, "Edicion directa habilitada en el Editor de datos.");
    assert.deepStrictEqual(adminTableCapability(name), {
      read: true,
      insert: true,
      update: true,
      delete: true,
      category: "administrative",
      reason: "Edicion directa habilitada en el Editor de datos."
    });
  });

  assert.deepStrictEqual(ADMIN_TABLE_POLICY.etiquetas.validation.required, ["etiqueta"]);
  assert.deepStrictEqual(ADMIN_TABLE_POLICY.clientes.validation.required, ["nombre_cliente"]);
  assert.deepStrictEqual(ADMIN_TABLE_POLICY.clientes.validation.references, [
    { column: "id_canal", table: "canales", target: "id_canal", optional: true }
  ]);
  assert.deepStrictEqual(ADMIN_TABLE_POLICY.empleados.validation.required, ["nombre_empleado"]);
  assert.deepStrictEqual(ADMIN_TABLE_POLICY.empleados.validation.isoDates, ["fecha_alta", "fecha_baja"]);

  assert.deepStrictEqual(adminTableCapability("tabla_no_registrada"), {
    read: false,
    insert: false,
    update: false,
    delete: false,
    category: "denied",
    reason: "Tabla no habilitada para Administracion."
  });

  console.log(`admin-table-policy: ${registry.tables.length} tablas editables`);
}

main();
