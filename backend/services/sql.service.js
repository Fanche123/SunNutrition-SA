const childProcess = require("child_process");
const fs = require("fs");

function createSqlService({ cacheFile, limits, pythonExecutable, rootDir, scriptFile }) {
  function execute(sql) {
    if (!fs.existsSync(scriptFile)) {
      return Promise.reject(sqlError("SQL_EXECUTION_ERROR", "Falta el ejecutor SQL del backend."));
    }
    const executable = fs.existsSync(pythonExecutable) ? pythonExecutable : "python";
    return new Promise((resolve, reject) => {
      const child = childProcess.spawn(executable, [scriptFile], {
        cwd: rootDir,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let outputExceeded = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(sqlError("SQL_TIMEOUT", "La consulta supero el tiempo maximo permitido."));
      }, limits.processTimeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") <= limits.maxOutputBytes) return;
        outputExceeded = true;
        child.kill();
      });
      child.stderr.on("data", (chunk) => {
        if (Buffer.byteLength(stderr, "utf8") < 4096) stderr += chunk;
      });
      child.on("error", (error) => finishReject("SQL_EXECUTION_ERROR", safeExecutionMessage(error)));
      child.on("close", (status) => {
        if (settled) return;
        if (outputExceeded) return finishReject("SQL_EXECUTION_ERROR", "La consulta supero el limite de salida.");
        let output;
        try {
          output = JSON.parse(stdout || "{}");
        } catch {
          return finishReject("SQL_EXECUTION_ERROR", "No se pudo ejecutar la consulta SQL.");
        }
        if (status !== 0 || !output.ok) {
          return finishReject(
            output.code || "SQL_EXECUTION_ERROR",
            output.error || "No se pudo ejecutar la consulta SQL."
          );
        }
        settled = true;
        clearTimeout(timer);
        resolve(output);
      });

      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({
        sql,
        cacheFile,
        maxRows: limits.maxRows,
        maxTimeMs: limits.sqliteTimeBudgetMs,
        maxProgressCallbacks: limits.sqliteCallbackBudget,
        progressOperations: limits.sqliteProgressOperations
      }));

      function finishReject(code, message) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(sqlError(code, message));
      }
    });
  }

  return async function runBackendSqlQuery(rawSql) {
    const sql = String(rawSql || "").trim();
    validateSql(sql);
    return execute(sql);
  };
}

function validateSql(sql) {
  if (!sql) throw sqlError("SQL_INVALID", "Escribi una consulta SQL.");
  if (!/^(select|with)\s+/i.test(sql)) {
    throw sqlError("SQL_FORBIDDEN", "Por seguridad solo se permiten consultas SELECT o WITH.");
  }
  if (/\b(insert|update|delete|drop|alter|create|truncate|replace|attach|detach|pragma|vacuum|reindex)\b/i.test(sql)) {
    throw sqlError("SQL_FORBIDDEN", "La consola SQL es solo de lectura.");
  }
}

function safeExecutionMessage(error) {
  if (error?.code === "ENOENT") return "No se encontro el ejecutor Python configurado.";
  return "No se pudo iniciar el ejecutor SQL.";
}

function sqlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { createSqlService };
