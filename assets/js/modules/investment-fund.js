let investmentFundState = {
  balance: 0,
  movements: [],
  bankMovements: [],
  tags: []
};

async function loadInvestmentFund() {
  const status = document.getElementById("investment-fund-status");
  try {
    if (status) {
      status.textContent = "Cargando movimientos del fondo...";
      status.dataset.status = "";
    }
    const response = await fetch(`${API_BASE_URL}/api/treasury/investment-fund`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo cargar el fondo.");
    investmentFundState = payload;
    renderInvestmentFund();
  } catch (error) {
    if (status) {
      status.textContent = error.message;
      status.dataset.status = "warn";
    }
    renderInvestmentFundRows([]);
  }
}

function renderInvestmentFund() {
  const balance = document.getElementById("investment-fund-balance");
  if (balance) balance.textContent = formatMoney(investmentFundState.balance || 0);
  renderInvestmentFundBankOptions();
  renderInvestmentFundTagOptions();
  renderInvestmentFundRows(investmentFundState.movements || []);
  const status = document.getElementById("investment-fund-status");
  if (status) {
    status.textContent = (investmentFundState.movements || []).length
      ? `${investmentFundState.movements.length} movimiento(s) registrado(s).`
      : "Todavia no hay movimientos en el fondo.";
    status.dataset.status = "ok";
  }
}

function renderInvestmentFundRows(rows) {
  const body = document.getElementById("investment-fund-history-body");
  if (!body) return;
  body.innerHTML = rows.length
    ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(formatDate(row.fecha))}</td>
        <td><span class="investment-fund-type is-${escapeHtml(row.tipo)}">${escapeHtml(investmentFundTypeLabel(row.tipo))}</span></td>
        <td class="num">${escapeHtml(formatMoney(row.importe || 0))}</td>
        <td>${escapeHtml(investmentFundReference(row))}</td>
        <td class="num"><strong>${escapeHtml(formatMoney(row.saldo_resultante || 0))}</strong></td>
        <td>${escapeHtml(row.observacion || "-")}</td>
      </tr>
    `).join("")
    : '<tr><td class="empty" colspan="6">Todavia no hay movimientos registrados.</td></tr>';
}

function renderInvestmentFundReconciliationCandidates(candidates) {
  const body = document.getElementById("bank-fund-stage-body");
  const count = document.getElementById("bank-fund-stage-count");
  if (count) count.textContent = String(candidates.length);
  if (!body) return;
  body.innerHTML = candidates.length
    ? candidates.map((candidate) => `
      <tr data-fund-candidate-id="${escapeHtml(String(candidate.id || ""))}">
        <td>${escapeHtml(formatDate(candidate.movement?.fecha))}</td>
        <td>${escapeHtml(candidate.movement?.banco || "-")}</td>
        <td>${escapeHtml(candidate.movement?.detalle || "-")}</td>
        <td><span class="investment-fund-type is-${escapeHtml(candidate.type || "review")}">${escapeHtml(investmentFundTypeLabel(candidate.type) || "Sin definir")}</span></td>
        <td class="num">${escapeHtml(formatMoney(candidate.movement?.importe || 0))}</td>
        <td>
          <span class="bank-fund-confidence is-${escapeHtml(candidate.confidence)}">${candidate.confidence === "reliable" ? "Confiable" : "Revisar"}</span>
          <small class="bank-fund-reason">${escapeHtml(candidate.reason || "")}</small>
        </td>
        <td>${candidate.confidence === "reliable"
          ? `<button type="button" class="bank-fund-register" data-register-fund-candidate="${escapeHtml(String(candidate.id || ""))}">Registrar en fondo</button>`
          : '<span class="bank-fund-review-only">Sin registro automático</span>'}</td>
      </tr>
    `).join("")
    : '<tr><td class="empty" colspan="7">No hay movimientos de fondo para agregar.</td></tr>';
}

async function registerInvestmentFundCandidate(candidateId, button) {
  const candidates = bankReconciliationReport?.investmentFundCandidates || [];
  const candidate = candidates.find((row) => String(row.id) === String(candidateId));
  const status = document.getElementById("bank-fund-stage-status");
  if (!candidate?.payload || candidate.confidence !== "reliable") {
    if (status) {
      status.textContent = "El movimiento requiere revisión y no puede registrarse automáticamente.";
      status.dataset.status = "warn";
    }
    return;
  }
  const originalText = button?.textContent || "Registrar en fondo";
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "Registrando...";
    }
    if (status) {
      status.textContent = "Registrando y asociando el movimiento...";
      status.dataset.status = "";
    }
    const response = await fetch(`${API_BASE_URL}/api/treasury/investment-fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate.payload)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "No se pudo registrar el movimiento del fondo.");
    await loadInvestmentFund();
    await refreshBankReconciliationFromBackend();
    if (status) {
      status.textContent = result.idempotent
        ? "El movimiento ya estaba registrado y asociado."
        : "Movimiento registrado y asociado al fondo.";
      status.dataset.status = "ok";
    }
  } catch (error) {
    if (status) {
      status.textContent = error.message;
      status.dataset.status = "warn";
    }
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function renderInvestmentFundBankOptions() {
  const select = document.getElementById("investment-fund-bank-movement");
  if (!select) return;
  const current = select.value;
  const type = document.getElementById("investment-fund-type")?.value || "deposito";
  const rows = (investmentFundState.bankMovements || []).filter((row) => (
    type === "deposito" ? Number(row.debito || 0) > 0 : Number(row.credito || 0) > 0
  ));
  select.innerHTML = '<option value="">Sin asociacion bancaria</option>' + rows.map((row) => {
    const amount = type === "deposito" ? row.debito : row.credito;
    return `<option value="${escapeHtml(String(row.id_movimiento_bancario))}">${escapeHtml(`${formatDate(row.fecha)} · ${row.banco} · ${row.detalle || "Sin detalle"} · ${formatMoney(amount)}`)}</option>`;
  }).join("");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderInvestmentFundTagOptions() {
  const select = document.getElementById("investment-fund-tag");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Elegir etiqueta</option>' + (investmentFundState.tags || []).map((row) => (
    `<option value="${escapeHtml(String(row.id_etiqueta))}">${escapeHtml(row.etiqueta)}</option>`
  )).join("");
  const preferred = (investmentFundState.tags || []).find((row) => investmentFundNormalizeText(row.etiqueta) === "rendimiento fondo");
  select.value = current || String(preferred?.id_etiqueta || "");
}

function updateInvestmentFundFields() {
  const type = document.getElementById("investment-fund-type")?.value || "deposito";
  const isYield = type === "rendimiento";
  const periodField = document.getElementById("investment-fund-period-field");
  const tagField = document.getElementById("investment-fund-tag-field");
  const bankField = document.getElementById("investment-fund-bank-field");
  if (periodField) periodField.hidden = !isYield;
  if (tagField) tagField.hidden = !isYield;
  if (bankField) bankField.hidden = isYield;
  renderInvestmentFundBankOptions();
}

function applySelectedInvestmentFundBankMovement() {
  const id = document.getElementById("investment-fund-bank-movement")?.value || "";
  if (!id) return;
  const type = document.getElementById("investment-fund-type")?.value || "deposito";
  const row = (investmentFundState.bankMovements || []).find((candidate) => String(candidate.id_movimiento_bancario) === id);
  if (!row) return;
  const date = document.getElementById("investment-fund-date");
  const amount = document.getElementById("investment-fund-amount");
  if (date) date.value = row.fecha;
  if (amount) amount.value = ErpMoney.formatInput(type === "deposito" ? row.debito : row.credito);
}

async function submitInvestmentFund(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById("investment-fund-form-status");
  const amount = ErpMoney.parseInput(document.getElementById("investment-fund-amount")?.value, {
    allowEmpty: false,
    allowNegative: false
  });
  if (!amount.ok || amount.empty || amount.cents <= 0) {
    status.textContent = "Ingresa un importe positivo con hasta dos decimales.";
    status.dataset.status = "warn";
    return;
  }
  const type = document.getElementById("investment-fund-type")?.value || "";
  const payload = {
    fecha: document.getElementById("investment-fund-date")?.value || "",
    tipo: type,
    importe: amount.amount,
    periodo_rendimiento: type === "rendimiento"
      ? document.getElementById("investment-fund-period")?.value || ""
      : "",
    id_movimiento_bancario: type === "rendimiento"
      ? ""
      : document.getElementById("investment-fund-bank-movement")?.value || "",
    id_etiqueta: type === "rendimiento"
      ? document.getElementById("investment-fund-tag")?.value || ""
      : "",
    referencia: document.getElementById("investment-fund-reference")?.value || "",
    observacion: document.getElementById("investment-fund-observation")?.value || "",
    clave_idempotencia: investmentFundOperationKey()
  };
  try {
    button.disabled = true;
    status.textContent = "Guardando movimiento...";
    status.dataset.status = "";
    const response = await fetch(`${API_BASE_URL}/api/treasury/investment-fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "No se pudo guardar el movimiento.");
    form.reset();
    form.dataset.operationKey = "";
    setInvestmentFundDefaults();
    status.textContent = result.idempotent ? "El movimiento ya estaba registrado." : "Movimiento guardado.";
    status.dataset.status = "ok";
    await loadInvestmentFund();
    if (typeof refreshBankReconciliationFromBackend === "function") await refreshBankReconciliationFromBackend();
  } catch (error) {
    status.textContent = error.message;
    status.dataset.status = "warn";
  } finally {
    button.disabled = false;
  }
}

function investmentFundOperationKey() {
  const form = document.getElementById("investment-fund-form");
  if (!form.dataset.operationKey) {
    form.dataset.operationKey = globalThis.crypto?.randomUUID?.()
      || `fondo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return form.dataset.operationKey;
}

function setInvestmentFundDefaults() {
  const today = new Date();
  const iso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
  const date = document.getElementById("investment-fund-date");
  const period = document.getElementById("investment-fund-period");
  if (date && !date.value) date.value = iso;
  if (period && !period.value) period.value = iso.slice(0, 7);
  updateInvestmentFundFields();
}

function investmentFundTypeLabel(type) {
  return { deposito: "Deposito", rescate: "Rescate", rendimiento: "Rendimiento" }[type] || type;
}

function investmentFundReference(row) {
  const parts = [];
  if (row.periodo_rendimiento) parts.push(row.periodo_rendimiento);
  if (row.id_movimiento_bancario) parts.push(`Banco #${row.id_movimiento_bancario}`);
  if (row.referencia) parts.push(row.referencia);
  return parts.join(" · ") || "-";
}

function investmentFundNormalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("investment-fund-form");
  if (!form) return;
  form.addEventListener("submit", submitInvestmentFund);
  document.getElementById("investment-fund-type")?.addEventListener("change", updateInvestmentFundFields);
  document.getElementById("investment-fund-bank-movement")?.addEventListener("change", applySelectedInvestmentFundBankMovement);
  document.getElementById("bank-fund-stage-body")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-register-fund-candidate]");
    if (!button) return;
    registerInvestmentFundCandidate(button.dataset.registerFundCandidate, button);
  });
  setInvestmentFundDefaults();
});
