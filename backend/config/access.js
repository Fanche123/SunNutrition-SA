const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function createAccessConfig(env = process.env) {
  const mode = String(env.ERP_DEPLOYMENT_MODE || "local").trim().toLowerCase();
  const port = parseInteger(env.PORT, 3000, 1, 65535);
  const host = String(env.ERP_HOST || "127.0.0.1").trim();
  const authenticationReady = true;

  if (!["local", "lan"].includes(mode)) {
    throw new Error(`Modo de despliegue invalido: ${mode}. Use "local".`);
  }
  if (mode === "lan" || !LOCAL_HOSTS.has(host)) {
    throw new Error(
      "El acceso de red requiere autenticacion y autorizacion antes de habilitar el modo LAN o una interfaz no local."
    );
  }

  const defaultOrigins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`
  ];
  const configuredOrigins = splitOrigins(env.ERP_ALLOWED_ORIGINS);
  const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : defaultOrigins);
  if ([...allowedOrigins].some((origin) => origin === "*")) {
    throw new Error("ERP_ALLOWED_ORIGINS no admite el comodin '*'.");
  }
  if ([...allowedOrigins].some((origin) => !isLocalOrigin(origin, port))) {
    throw new Error("El modo local solo admite origenes localhost o 127.0.0.1 con el puerto configurado.");
  }

  return Object.freeze({
    mode,
    host,
    port,
    authenticationReady,
    cors: Object.freeze({
      enabled: true,
      allowedOrigins
    })
  });
}

function isLocalOrigin(origin, port) {
  try {
    const parsed = new URL(origin);
    const expectedPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return parsed.protocol === "http:"
      && ["127.0.0.1", "localhost"].includes(parsed.hostname)
      && expectedPort === String(port);
  } catch {
    return false;
  }
}

function splitOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, minimum), maximum);
}

module.exports = { createAccessConfig, LOCAL_HOSTS };
