(function initializePopup() {
  "use strict";

  const form = document.getElementById("secret-form");
  const input = document.getElementById("secret");
  const forget = document.getElementById("forget");
  const copyTrace = document.getElementById("copy-trace");
  const status = document.getElementById("status");
  const traceStatus = document.getElementById("trace-status");
  const labels = {
    stored: "Clave cifrada guardada",
    forgotten: "Sin clave guardada",
    empty: "Sin clave guardada",
    invalid: "Vault inválido; guardá la clave nuevamente"
  };

  function show(result) {
    status.textContent = labels[result?.status] || labels.invalid;
  }

  function send(message) {
    chrome.runtime.sendMessage(message, (response) => {
      input.value = "";
      show(chrome.runtime.lastError ? null : response);
    });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let secret = input.value;
    input.value = "";
    send({ type: "SAVE_ENCRYPTED_CREDENTIAL", secret });
    secret = null;
  });

  forget.addEventListener("click", () => {
    input.value = "";
    send({ type: "FORGET_ENCRYPTED_CREDENTIAL" });
  });

  copyTrace.addEventListener("click", () => {
    traceStatus.textContent = "Preparando diagnóstico seguro...";
    chrome.runtime.sendMessage({ type: "GET_SAFE_SESSION_TRACE" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok || !Array.isArray(response.trace)) {
        traceStatus.textContent = "No se pudo obtener el diagnóstico seguro";
        return;
      }
      if (!response.trace.length) {
        traceStatus.textContent = "No hay una traza activa para copiar";
        return;
      }
      navigator.clipboard.writeText(JSON.stringify(response.trace, null, 2))
        .then(() => {
          traceStatus.textContent = "Diagnóstico seguro copiado";
        })
        .catch(() => {
          traceStatus.textContent = "No se pudo copiar el diagnóstico seguro";
        });
    });
  });

  send({ type: "GET_ENCRYPTED_CREDENTIAL_STATUS" });
})();
