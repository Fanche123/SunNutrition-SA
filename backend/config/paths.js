const os = require("os");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const APP_STATE_FILE = path.join(ROOT_DIR, "tmp", "app-state.json");
const BACKEND_CACHE_FILE = path.join(ROOT_DIR, "tmp", "backend-data-cache.json");
const SECURITY_DIR = path.join(ROOT_DIR, "tmp", "security");
const SECURITY_USERS_FILE = path.join(SECURITY_DIR, "users.json");
const SECURITY_AUDIT_FILE = path.join(SECURITY_DIR, "activity-audit.jsonl");
const SECURITY_AUDIT_RECOVERY_FILE = path.join(SECURITY_DIR, "activity-audit-recovery.jsonl");
const OPERATIONAL_CUTOVER_STATE_FILE = path.join(ROOT_DIR, "tmp", "operational-cutover-state.json");
const OPERATIONAL_CUTOVER_AUDIT_FILE = path.join(ROOT_DIR, "tmp", "operational-cutover-events.jsonl");
const BACKEND_SQL_SCRIPT = path.join(ROOT_DIR, "tools", "backend-sqlite-query.py");
const PYTHON_EXECUTABLE = process.env.PYTHON_EXECUTABLE
  || path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");

module.exports = {
  APP_STATE_FILE,
  BACKEND_CACHE_FILE,
  BACKEND_SQL_SCRIPT,
  OPERATIONAL_CUTOVER_AUDIT_FILE,
  OPERATIONAL_CUTOVER_STATE_FILE,
  PYTHON_EXECUTABLE,
  ROOT_DIR,
  SECURITY_AUDIT_FILE,
  SECURITY_AUDIT_RECOVERY_FILE,
  SECURITY_DIR,
  SECURITY_USERS_FILE
};
