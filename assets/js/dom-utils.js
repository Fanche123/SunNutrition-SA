/*
  Utilidades chicas de interfaz compartidas por varias pantallas.
  Mantenerlas fuera de app.js evita repetir patrones y acelera cambios simples.
*/

function setupFileDropZone({ dropZone, input, acceptFile, onAccepted, onRejected, respectDisabled = false }) {
  if (!dropZone || !input) return;

  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!respectDisabled || !input.disabled) dropZone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("is-dragging");
    });
  });

  dropZone.addEventListener("drop", (event) => {
    if (respectDisabled && input.disabled) return;
    const file = [...(event.dataTransfer?.files || [])].find((candidate) => !acceptFile || acceptFile(candidate));
    if (!file) {
      onRejected?.();
      return;
    }

    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    onAccepted?.(file);
  });
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes >= 1048576) {
    return `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 }).format(bytes / 1048576)} MB`;
  }
  return `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(bytes / 1024)} KB`;
}
