function createAccessControl({ accessConfig, sendJson, setCorsHeaders, authorizeIdentity = allowLocalIdentity }) {
  return async function applyRequestAccess(request, response) {
    const origin = String(request.headers.origin || "").trim();
    if (origin && !accessConfig.cors.allowedOrigins.has(origin)) {
      sendJson(response, 403, {
        ok: false,
        code: "ORIGIN_FORBIDDEN",
        error: "El origen de la solicitud no esta autorizado."
      });
      return false;
    }

    const identity = await authorizeIdentity(request, accessConfig);
    if (!identity?.allowed) {
      sendJson(response, 401, {
        ok: false,
        code: "AUTHENTICATION_REQUIRED",
        error: "La solicitud requiere autenticacion."
      });
      return false;
    }

    setCorsHeaders(request, response, accessConfig);
    request.accessIdentity = identity;
    return true;
  };
}

function allowLocalIdentity() {
  // Punto unico de integracion para autenticacion, sesion, usuario, roles y autorizacion futura.
  return { allowed: true, mode: "local", user: null, roles: [] };
}

module.exports = { createAccessControl };
