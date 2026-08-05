(function initializeAccessModule(root) {
  "use strict";

  const nativeFetch = root.fetch.bind(root);
  const authentication = { user: null, ready: initialize() };
  root.erpAuthentication = authentication;

  async function initialize() {
    await domReady();
    bindAuthenticationEvents();
    await loadOperationalState();
    try {
      const response = await nativeFetch("/api/auth/session", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        showLogin(Boolean(payload.bootstrapRequired));
        return null;
      }
      authentication.user = payload.user;
      revealApplication(payload.user);
      installSessionExpiryGuard();
      bindOwnerTools(payload.user);
      return payload.user;
    } catch {
      showLogin(false, "No se pudo verificar la sesión local.");
      return null;
    }
  }

  function bindAuthenticationEvents() {
    document.getElementById("auth-login-form")?.addEventListener("submit", handleLogin);
    document.getElementById("session-logout")?.addEventListener("click", handleLogout);
  }

  async function handleLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.getElementById("auth-status");
    const submit = form.querySelector("button[type='submit']");
    submit.disabled = true;
    status.textContent = "Verificando credenciales...";
    try {
      const response = await nativeFetch("/api/auth/login", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: document.getElementById("auth-username").value,
          password: document.getElementById("auth-password").value
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo iniciar sesión.");
      document.getElementById("auth-password").value = "";
      root.location.reload();
    } catch (error) {
      document.getElementById("auth-password").value = "";
      status.textContent = error.message;
      submit.disabled = false;
      document.getElementById("auth-password").focus();
    }
  }

  async function handleLogout() {
    const button = document.getElementById("session-logout");
    button.disabled = true;
    try {
      await nativeFetch("/api/auth/logout", { method: "POST", cache: "no-store" });
    } finally {
      root.location.reload();
    }
  }

  function revealApplication(user) {
    document.body.classList.remove("auth-pending");
    document.getElementById("auth-screen").hidden = true;
    document.getElementById("app-shell").hidden = false;
    document.getElementById("session-user-name").textContent = user.displayName || user.username;
    document.getElementById("session-user-role").textContent = roleLabel(user.role);
    const canUseOwnerTools = root.erpAccessPolicy?.isViewAllowed(user.role, "activity-log") === true;
    const canUseAnalysis = root.erpAccessPolicy?.isViewAllowed(user.role, "results") === true;
    document.querySelectorAll("[data-owner-only]").forEach((element) => { element.hidden = !canUseOwnerTools; });
    document.querySelectorAll("[data-analysis-only]").forEach((element) => { element.hidden = !canUseAnalysis; });
    document.querySelectorAll(".nav-group").forEach((group) => {
      const items = [...group.querySelectorAll(".nav-group-items .nav-item")];
      if (items.length && items.every((item) => item.hidden)) group.hidden = true;
    });
  }

  async function loadOperationalState() {
    const banner = document.getElementById("operational-source-banner");
    if (!banner) return;
    try {
      const response = await nativeFetch("/api/health", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error("No se pudo verificar el estado operativo.");
      const operational = payload.operational || {};
      if (!operational.localReadOnly) {
        banner.hidden = true;
        document.body.classList.remove("local-read-only-active");
        return;
      }
      const siteLabel = operational.siteUrl ? ` en ${operational.siteUrl}` : "";
      banner.textContent = operational.canonicalSource === "sites"
        ? `LOCAL RESPALDO / SOLO LECTURA · Sites es la fuente canónica operativa${siteLabel}.`
        : "CORTE EN CURSO · Local está congelado y no acepta operaciones. Sites todavía no es escritor.";
      banner.dataset.mode = operational.canonicalSource === "sites" ? "sites-canonical" : "frozen";
      banner.hidden = false;
      document.body.classList.add("local-read-only-active");
      const updateHeight = () => document.documentElement.style.setProperty("--operational-banner-height", `${banner.offsetHeight}px`);
      updateHeight();
      root.addEventListener("resize", updateHeight, { passive: true });
    } catch {
      banner.textContent = "ESTADO OPERATIVO NO VERIFICADO · Las operaciones deben considerarse bloqueadas hasta validar el backend.";
      banner.dataset.mode = "guard-error";
      banner.hidden = false;
      document.body.classList.add("local-read-only-active");
    }
  }

  function showLogin(bootstrapRequired, message = "") {
    document.body.classList.add("auth-pending");
    document.getElementById("app-shell").hidden = true;
    document.getElementById("auth-screen").hidden = false;
    document.getElementById("auth-bootstrap-note").hidden = !bootstrapRequired;
    document.getElementById("auth-status").textContent = message;
    document.getElementById("auth-username").focus();
  }

  function bindOwnerTools(user) {
    if (user.role !== "owner") return;
    document.getElementById("activity-filters")?.addEventListener("submit", (event) => {
      event.preventDefault();
      loadActivity();
    });
    document.getElementById("activity-refresh")?.addEventListener("click", loadActivity);
    document.getElementById("user-create-form")?.addEventListener("submit", createUser);
    document.querySelectorAll('[data-view="activity-log"]').forEach((button) => button.addEventListener("click", loadActivity));
    document.querySelectorAll('[data-view="user-management"]').forEach((button) => button.addEventListener("click", loadUsers));
  }

  async function loadActivity() {
    const status = document.getElementById("activity-status");
    const body = document.getElementById("activity-body");
    status.textContent = "Cargando actividad...";
    const params = new URLSearchParams({ limit: "500" });
    [
      ["from", "activity-from"],
      ["to", "activity-to"],
      ["user", "activity-user"],
      ["entity", "activity-entity"],
      ["action", "activity-action"]
    ].forEach(([key, id]) => {
      const value = document.getElementById(id)?.value.trim();
      if (value) params.set(key, value);
    });
    try {
      const payload = await requestJson(`/api/audit/events?${params}`);
      body.replaceChildren();
      if (!payload.events.length) body.append(emptyRow(7, "No hay eventos para los filtros elegidos."));
      else payload.events.forEach((event) => body.append(activityRow(event)));
      const integrityLabel = payload.integrity
        ? " · integridad verificada"
        : payload.pendingRecovery
          ? ` · atención: ${payload.pendingRecovery} evento(s) pendiente(s) de recuperación`
          : " · atención: cadena de integridad inválida";
      status.textContent = `${payload.total} evento${payload.total === 1 ? "" : "s"}${integrityLabel}.`;
      status.classList.toggle("is-error", !payload.integrity);
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("is-error");
    }
  }

  function activityRow(event) {
    const row = document.createElement("tr");
    const summary = (event.changes || []).map((change) => {
      const counts = [`${change.added || 0} altas`, `${change.updated || 0} ediciones`, `${change.deleted || 0} bajas`];
      const fields = change.fields?.length ? ` · campos: ${change.fields.join(", ")}` : "";
      return `${change.entity}: ${counts.join(", ")}${fields}`;
    }).join(" | ") || (event.fields?.length ? `Campos: ${event.fields.join(", ")}` : "Operación sin cambios tabulares");
    [
      formatDateTime(event.occurredAtUtc),
      `${event.actor?.displayName || event.actor?.username || "—"} · ${roleLabel(event.actor?.role)}`,
      event.action || "—",
      `${event.module || "—"} / ${event.entity || "—"}`,
      event.recordId || "—",
      `${event.method || ""} ${event.route || ""}`.trim(),
      summary
    ].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    });
    return row;
  }

  async function loadUsers() {
    const body = document.getElementById("user-list-body");
    try {
      const payload = await requestJson("/api/auth/users");
      body.replaceChildren();
      if (!payload.users.length) body.append(emptyRow(4, "No hay usuarios configurados."));
      else payload.users.forEach((user) => {
        const row = document.createElement("tr");
        [user.username, user.displayName, roleLabel(user.role), user.active ? "Activo" : "Inactivo"].forEach((value) => {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        });
        body.append(row);
      });
    } catch (error) {
      body.replaceChildren(emptyRow(4, error.message));
    }
  }

  async function createUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.getElementById("user-create-status");
    const password = document.getElementById("user-create-password");
    const confirmation = document.getElementById("user-create-password-confirm");
    if (password.value !== confirmation.value) {
      status.textContent = "Las contraseñas no coinciden.";
      status.classList.add("is-error");
      confirmation.focus();
      return;
    }
    const submit = form.querySelector("button[type='submit']");
    submit.disabled = true;
    status.textContent = "Creando identidad...";
    status.classList.remove("is-error");
    try {
      await requestJson("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: document.getElementById("user-create-username").value,
          displayName: document.getElementById("user-create-display-name").value,
          role: document.getElementById("user-create-role").value,
          password: password.value
        })
      });
      form.reset();
      password.value = "";
      confirmation.value = "";
      status.textContent = "Usuario creado.";
      await loadUsers();
    } catch (error) {
      password.value = "";
      confirmation.value = "";
      status.textContent = error.message;
      status.classList.add("is-error");
    } finally {
      submit.disabled = false;
    }
  }

  async function requestJson(url, options = {}) {
    const response = await nativeFetch(url, { cache: "no-store", ...options });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function installSessionExpiryGuard() {
    root.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const target = String(args[0]?.url || args[0] || "");
      if (response.status === 401 && !target.includes("/api/auth/")) root.location.reload();
      return response;
    };
  }

  function emptyRow(columns, message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "empty";
    cell.colSpan = columns;
    cell.textContent = message;
    row.append(cell);
    return row;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("es-AR", {
      dateStyle: "short", timeStyle: "medium", timeZone: "America/Argentina/Buenos_Aires"
    }).format(date);
  }

  function roleLabel(role) {
    if (role === "owner") return "Propietario";
    if (role === "employee_admin") return "Empleado administrativo";
    if (role === "anonymous") return "No autenticado";
    return String(role || "—");
  }

  function domReady() {
    if (document.readyState !== "loading") return Promise.resolve();
    return new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }
})(globalThis);
