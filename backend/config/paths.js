const os = require("os");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const APP_STATE_FILE = path.join(ROOT_DIR, "tmp", "app-state.json");
const BACKEND_CACHE_FILE = path.join(ROOT_DIR, "tmp", "backend-data-cache.json");
const BACKEND_SQL_SCRIPT = path.join(ROOT_DIR, "tools", "backend-sqlite-query.py");
const PYTHON_EXECUTABLE = process.env.PYTHON_EXECUTABLE
  || path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");

module.exports = {
  APP_STATE_FILE,
  BACKEND_CACHE_FILE,
  BACKEND_SQL_SCRIPT,
  PYTHON_EXECUTABLE,
  ROOT_DIR
};
