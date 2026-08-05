const { isOwnerOnlyApi } = require("../../shared/access-policy");

const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/session",
  "/api/health",
  "/api/health/ocr",
  "/api/runtime/shutdown"
]);
const EMPLOYEE_GENERIC_TABLE_MUTATIONS = new Set([
  "cheques_entregados",
  "cheques_recibidos",
  "comisiones",
  "egresos",
  "entregas",
  "sueldos"
]);

function createAccessControl({
  accessConfig,
  sendJson,
  setCorsHeaders,
  authenticateRequest,
  beginAuditRequest = async () => {},
  operationalCutover = null,
  authorizeIdentity = allowLocalIdentity
}) {
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

    setCorsHeaders(request, response, accessConfig);
    const pathname = requestPath(request);
    if (pathname === "/api/auth/login" && isStateChanging(request.method) && !hasTrustedMutationOrigin(request, accessConfig)) {
      sendJson(response, 403, {
        ok: false,
        code: "MUTATION_ORIGIN_REQUIRED",
        error: "No se pudo verificar el origen del inicio de sesión."
      });
      return false;
    }
    if (request.method === "OPTIONS" || isPublicRequest(pathname)) {
      request.accessIdentity = null;
      return true;
    }

    const identity = authenticateRequest
      ? await authenticateRequest(request)
      : await authorizeIdentity(request, accessConfig);
    if (!identity?.allowed) {
      response.setHeader("Cache-Control", "no-store");
      sendJson(response, 401, {
        ok: false,
        code: "AUTHENTICATION_REQUIRED",
        error: "La solicitud requiere autenticacion."
      });
      return false;
    }

    if (requiresOwner(pathname, request.method) && identity.user?.role !== "owner") {
      sendJson(response, 403, {
        ok: false,
        code: "OWNER_REQUIRED",
        error: "Esta herramienta está reservada al propietario."
      });
      return false;
    }
    if (isStateChanging(request.method) && !hasTrustedMutationOrigin(request, accessConfig)) {
      sendJson(response, 403, {
        ok: false,
        code: "MUTATION_ORIGIN_REQUIRED",
        error: "No se pudo verificar el origen de la operación."
      });
      return false;
    }

    const operationalBlock = operationalCutover?.mutationBlock(request.method, pathname);
    if (operationalBlock) {
      response.setHeader("Cache-Control", "no-store");
      sendJson(response, operationalBlock.status, {
        ok: false,
        code: operationalBlock.code,
        error: operationalBlock.error,
        operational: operationalBlock.operational
      });
      return false;
    }

    request.accessIdentity = identity;
    await beginAuditRequest(request, response, identity);
    return true;
  };
}

function allowLocalIdentity() {
  // Compatibilidad para pruebas unitarias que no componen el servicio real de sesiones.
  return { allowed: true, mode: "local", user: null, roles: [] };
}

function isPublicRequest(pathname) {
  return !pathname.startsWith("/api/") || PUBLIC_API_PATHS.has(pathname);
}

function requiresOwner(pathname, method) {
  if (isOwnerOnlyApi(pathname)) return true;
  if (pathname.startsWith("/api/backend/tables/") && isStateChanging(method)) {
    const tableName = decodePathSegment(pathname.slice("/api/backend/tables/".length));
    return !EMPLOYEE_GENERIC_TABLE_MUTATIONS.has(tableName);
  }
  return false;
}

function decodePathSegment(value) {
  try { return decodeURIComponent(String(value || "")).trim(); }
  catch { return ""; }
}

function hasTrustedMutationOrigin(request, accessConfig) {
  const origin = String(request.headers?.origin || "").trim();
  if (origin) return accessConfig.cors.allowedOrigins.has(origin);
  return String(request.headers?.["sec-fetch-site"] || "").toLowerCase() === "same-origin";
}

function isStateChanging(method) {
  return ["POST", "PATCH", "DELETE"].includes(String(method || "GET").toUpperCase());
}

function requestPath(request) {
  return new URL(request.url || "/", `http://${request.headers?.host || "127.0.0.1"}`).pathname;
}

module.exports = {
  EMPLOYEE_GENERIC_TABLE_MUTATIONS,
  PUBLIC_API_PATHS,
  createAccessControl,
  hasTrustedMutationOrigin,
  requiresOwner
};
