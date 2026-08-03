const crypto = require("crypto");

const ROLES = Object.freeze({
  OWNER: "owner",
  EMPLOYEE_ADMIN: "employee_admin"
});
const ALLOWED_ROLES = new Set(Object.values(ROLES));
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function createAuthService({
  store,
  readJsonBody,
  sendJson,
  auditSecurityEvent = () => {},
  cryptoModule = crypto,
  now = () => new Date(),
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  cookieName = "erp_session"
}) {
  if (!store) throw new Error("El repositorio de seguridad es obligatorio.");
  const sessions = new Map();
  const loginFailures = new Map();

  function usersExist() {
    return store.readUsers().users.some((user) => user.active !== false);
  }

  function listUsers() {
    return store.readUsers().users.map(publicUser);
  }

  function createUser(input, actor = null) {
    const username = normalizeUsername(input?.username);
    const displayName = cleanDisplayName(input?.displayName || input?.username);
    const role = String(input?.role || "").trim();
    const password = String(input?.password || "");
    validateNewUser({ username, displayName, role, password });

    const current = store.readUsers();
    if (current.users.some((user) => normalizeUsername(user.username) === username)) {
      throw authError("USER_EXISTS", "Ya existe un usuario con ese nombre.", 409);
    }
    if (!current.users.length && role !== ROLES.OWNER) {
      throw authError("OWNER_REQUIRED_FIRST", "El primer usuario debe ser propietario.", 400);
    }

    const passwordRecord = hashPassword(password, cryptoModule);
    const createdAt = now().toISOString();
    const user = {
      id: cryptoModule.randomUUID(),
      username,
      displayName,
      role,
      active: true,
      password: passwordRecord,
      createdAt,
      createdBy: actor?.user?.id || null
    };
    const result = store.writeUsers({ ...current, users: [...current.users, user] });
    return { user: publicUser(user), backup: result.backup };
  }

  function authenticateRequest(request) {
    removeExpiredSessions();
    const token = parseCookies(request.headers?.cookie || "")[cookieName];
    if (!token) return null;
    const session = sessions.get(tokenDigest(token, cryptoModule));
    if (!session || session.expiresAt <= now().getTime()) return null;
    const user = store.readUsers().users.find((entry) => entry.id === session.userId && entry.active !== false);
    if (!user) return null;
    return {
      allowed: true,
      mode: "session",
      user: publicUser(user),
      roles: [user.role],
      sessionId: session.id,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  async function handleLogin(request, response) {
    setNoStore(response);
    const address = String(request.socket?.remoteAddress || "local");
    if (isRateLimited(address)) {
      return sendJson(response, 429, {
        ok: false,
        code: "LOGIN_RATE_LIMITED",
        error: "Demasiados intentos. Esperá unos minutos antes de volver a intentar."
      });
    }

    const body = await readJsonBody(request);
    const username = normalizeUsername(body?.username);
    const password = String(body?.password || "");
    const user = store.readUsers().users.find((entry) => normalizeUsername(entry.username) === username);
    if (!user || user.active === false || !verifyPassword(password, user.password, cryptoModule)) {
      recordLoginFailure(address);
      auditSecurityEvent({
        action: "login_failed",
        outcome: "failure",
        actor: { username: username || "unknown", role: "anonymous" },
        entity: "session",
        route: "/api/auth/login"
      });
      return sendJson(response, 401, {
        ok: false,
        code: "INVALID_CREDENTIALS",
        error: "Usuario o contraseña incorrectos."
      });
    }

    loginFailures.delete(address);
    const rawToken = cryptoModule.randomBytes(32).toString("base64url");
    const issuedAt = now().getTime();
    const session = {
      id: cryptoModule.randomUUID(),
      userId: user.id,
      issuedAt,
      expiresAt: issuedAt + sessionTtlMs
    };
    sessions.set(tokenDigest(rawToken, cryptoModule), session);
    response.setHeader("Set-Cookie", sessionCookie(cookieName, rawToken, sessionTtlMs, isSecureRequest(request)));
    auditSecurityEvent({
      action: "login",
      outcome: "success",
      actor: publicUser(user),
      entity: "session",
      recordId: session.id,
      route: "/api/auth/login"
    });
    return sendJson(response, 200, { ok: true, user: publicUser(user), expiresAt: new Date(session.expiresAt).toISOString() });
  }

  function handleSession(request, response) {
    setNoStore(response);
    const identity = authenticateRequest(request);
    if (!identity) {
      return sendJson(response, 401, {
        ok: false,
        code: "AUTHENTICATION_REQUIRED",
        error: "Iniciá sesión para continuar.",
        bootstrapRequired: !usersExist()
      });
    }
    return sendJson(response, 200, { ok: true, user: identity.user, expiresAt: identity.expiresAt });
  }

  function handleLogout(request, response) {
    setNoStore(response);
    const identity = authenticateRequest(request);
    const token = parseCookies(request.headers?.cookie || "")[cookieName];
    if (token) sessions.delete(tokenDigest(token, cryptoModule));
    response.setHeader("Set-Cookie", expiredCookie(cookieName, isSecureRequest(request)));
    if (identity) {
      auditSecurityEvent({
        action: "logout",
        outcome: "success",
        actor: identity.user,
        entity: "session",
        recordId: identity.sessionId,
        route: "/api/auth/logout"
      });
    }
    return sendJson(response, 200, { ok: true });
  }

  function handleUsersList(_request, response) {
    setNoStore(response);
    return sendJson(response, 200, { ok: true, users: listUsers() });
  }

  async function handleUserCreate(request, response) {
    try {
      const body = await readJsonBody(request);
      const result = createUser(body, request.accessIdentity);
      request.auditSummary = {
        action: "create",
        entity: "users",
        recordId: result.user.id,
        fields: ["username", "displayName", "role", "active"]
      };
      return sendJson(response, 201, { ok: true, user: result.user });
    } catch (error) {
      return sendJson(response, error.status || 400, {
        ok: false,
        code: error.code || "USER_CREATE_FAILED",
        error: error.message
      });
    }
  }

  function removeExpiredSessions() {
    const timestamp = now().getTime();
    for (const [key, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(key);
    }
  }

  function isRateLimited(address) {
    const item = loginFailures.get(address);
    if (!item) return false;
    if (now().getTime() - item.startedAt > 5 * 60 * 1000) {
      loginFailures.delete(address);
      return false;
    }
    return item.count >= 5;
  }

  function recordLoginFailure(address) {
    const timestamp = now().getTime();
    const current = loginFailures.get(address);
    if (!current || timestamp - current.startedAt > 5 * 60 * 1000) {
      loginFailures.set(address, { count: 1, startedAt: timestamp });
      return;
    }
    current.count += 1;
  }

  return {
    authenticateRequest,
    createUser,
    handleLogin,
    handleLogout,
    handleSession,
    handleUserCreate,
    handleUsersList,
    listUsers,
    roles: ROLES,
    usersExist
  };
}

function hashPassword(password, cryptoModule = crypto) {
  const salt = cryptoModule.randomBytes(16);
  const derived = cryptoModule.scryptSync(String(password), salt, 64, SCRYPT_OPTIONS);
  return {
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    hash: derived.toString("base64"),
    parameters: { N: SCRYPT_OPTIONS.N, r: SCRYPT_OPTIONS.r, p: SCRYPT_OPTIONS.p, keyLength: 64 }
  };
}

function verifyPassword(password, record, cryptoModule = crypto) {
  try {
    if (record?.algorithm !== "scrypt") return false;
    const parameters = record.parameters || {};
    const expected = Buffer.from(record.hash, "base64");
    const actual = cryptoModule.scryptSync(String(password), Buffer.from(record.salt, "base64"), expected.length, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: SCRYPT_OPTIONS.maxmem
    });
    return expected.length === actual.length && cryptoModule.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validateNewUser({ username, displayName, role, password }) {
  if (!/^[a-z0-9._-]{3,48}$/.test(username)) {
    throw authError("USERNAME_INVALID", "El usuario debe tener entre 3 y 48 caracteres: letras, números, punto, guion o guion bajo.");
  }
  if (displayName.length < 2 || displayName.length > 80) {
    throw authError("DISPLAY_NAME_INVALID", "El nombre visible debe tener entre 2 y 80 caracteres.");
  }
  if (!ALLOWED_ROLES.has(role)) throw authError("ROLE_INVALID", "Rol de usuario inválido.");
  if (password.length < 12 || password.length > 256) {
    throw authError("PASSWORD_INVALID", "La contraseña debe tener entre 12 y 256 caracteres.");
  }
}

function publicUser(user) {
  return {
    id: String(user.id),
    username: String(user.username),
    displayName: String(user.displayName),
    role: String(user.role),
    active: user.active !== false,
    createdAt: String(user.createdAt || "")
  };
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanDisplayName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function parseCookies(header) {
  return String(header || "").split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = ""; }
    return cookies;
  }, {});
}

function sessionCookie(name, token, ttlMs, secure) {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? "; Secure" : ""}`;
}

function expiredCookie(name, secure) {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function isSecureRequest(request) {
  return Boolean(request.socket?.encrypted);
}

function tokenDigest(token, cryptoModule = crypto) {
  return cryptoModule.createHash("sha256").update(String(token)).digest("hex");
}

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store");
}

function authError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

module.exports = {
  ALLOWED_ROLES,
  DEFAULT_SESSION_TTL_MS,
  ROLES,
  createAuthService,
  hashPassword,
  parseCookies,
  publicUser,
  verifyPassword
};
