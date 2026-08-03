const readline = require("readline");
const { SECURITY_USERS_FILE } = require("../backend/config/paths");
const { createSecurityStore } = require("../backend/repositories/security-store.repository");
const { createAuditService } = require("../backend/services/audit.service");
const { createAuthService, ROLES } = require("../backend/services/auth.service");

async function main(argv = process.argv.slice(2)) {
  const command = String(argv[0] || "").trim().toLowerCase();
  const options = parseOptions(argv.slice(1));
  const store = createSecurityStore({ usersFile: SECURITY_USERS_FILE });
  const auth = createAuthService({
    store,
    readJsonBody: async () => ({}),
    sendJson: () => {},
    auditSecurityEvent: () => {}
  });

  if (command === "list") {
    const users = auth.listUsers();
    if (!users.length) console.log("No hay usuarios configurados.");
    else users.forEach((user) => console.log(`${user.username}\t${user.displayName}\t${user.role}\t${user.active ? "activo" : "inactivo"}`));
    return;
  }

  if (command !== "create") throw new Error(usage());
  if (auth.listUsers().length) {
    throw new Error("El alta por terminal se limita al propietario inicial. Creá usuarios adicionales desde la vista Usuarios del ERP.");
  }
  const username = requiredOption(options, "username");
  const displayName = requiredOption(options, "display-name");
  const role = requiredOption(options, "role");
  if (![ROLES.OWNER, ROLES.EMPLOYEE_ADMIN].includes(role)) {
    throw new Error("--role debe ser owner o employee_admin.");
  }
  if (role !== ROLES.OWNER) throw new Error("El alta inicial debe usar --role owner.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("La contraseña solo se acepta desde el prompt interactivo local; no se admite por argumento, variable de entorno ni entrada redirigida.");
  }
  const password = await readSecret("Contraseña inicial (mínimo 12 caracteres): ");
  const confirmation = await readSecret("Repetir contraseña: ");
  if (password !== confirmation) throw new Error("Las contraseñas no coinciden.");
  const result = auth.createUser({ username, displayName, role, password });
  createAuditService({
    auditFile: require("../backend/config/paths").SECURITY_AUDIT_FILE,
    loadCache: () => ({ tables: {} }),
    loadRegistry: () => ({ tables: [] })
  }).appendSecurityEvent({
    action: "bootstrap_owner_create",
    outcome: "success",
    actor: { username: "local_terminal", displayName: "Terminal local", role: "system" },
    entity: "users",
    recordId: result.user.id,
    route: "tools/manage-users.js"
  });
  console.log(`Usuario creado: ${result.user.username} (${result.user.role}).`);
  if (result.backup) console.log(`Backup verificado previo: ${result.backup.file} (${result.backup.sha256}).`);
}

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(process.stdin);
    const input = process.stdin;
    let value = "";
    const wasRaw = Boolean(input.isRaw);
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();

    function finish(error) {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }

    function onKeypress(character, key = {}) {
      if (key.ctrl && key.name === "c") return finish(new Error("Operación cancelada."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        if (value) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (key.ctrl || key.meta || !character) return;
      value += character;
      process.stdout.write("*");
    }
    input.on("keypress", onKeypress);
  });
}

function parseOptions(args) {
  const allowed = new Set(["username", "display-name", "role"]);
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`Argumento inesperado: ${argument}`);
    const key = argument.slice(2);
    if (!allowed.has(key)) throw new Error(`El argumento --${key} no esta admitido. La contrasena se solicita solo en el prompt local oculto.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Falta el valor de --${key}.`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function requiredOption(options, name) {
  const value = String(options[name] || "").trim();
  if (!value) throw new Error(`Falta --${name}.\n${usage()}`);
  return value;
}

function usage() {
  return "Uso: npm.cmd run users:create -- --username <usuario> --display-name \"Nombre\" --role <owner|employee_admin>";
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, parseOptions, readSecret };
