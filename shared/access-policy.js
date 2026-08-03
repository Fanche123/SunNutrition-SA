(function exposeAccessPolicy(root, factory) {
  const policy = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = policy;
  if (root) root.erpAccessPolicy = policy;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAccessPolicy() {
  const ANALYSIS_VIEWS = Object.freeze(["results", "cashflow", "production"]);
  const OWNER_ONLY_VIEWS = Object.freeze(["activity-log", "user-management"]);

  function isViewAllowed(role, view) {
    if (role === "owner") return true;
    if (role !== "employee_admin") return false;
    return !ANALYSIS_VIEWS.includes(String(view || ""))
      && !OWNER_ONLY_VIEWS.includes(String(view || ""));
  }

  function isOwnerOnlyApi(pathname) {
    const path = String(pathname || "");
    return path.startsWith("/api/auth/users")
      || path.startsWith("/api/audit/")
      || path.startsWith("/api/reports/");
  }

  return { ANALYSIS_VIEWS, OWNER_ONLY_VIEWS, isOwnerOnlyApi, isViewAllowed };
});
