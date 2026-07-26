function readJsonBody(request) {
  const maxBodySize = 15 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBodySize) {
        reject(new Error("Body demasiado grande."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("JSON invalido.")); }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(request, response, accessConfig) {
  const origin = String(request.headers.origin || "").trim();
  if (origin && accessConfig.cors.allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = { readJsonBody, sendJson, setCorsHeaders };
