const {
  divide,
  fromCents,
  multiplyCents,
  normalize,
  sumCents
} = require("../../shared/money");

function createIncomeCalculationService({
  backendGroupRowsById,
  backendId,
  backendInventoryQuantity,
  backendRowsById
}) {
  function backendLastInventorySummary(tables, startIso, endIso, inventoryById, detailsByInventory, productByItemId, itemsById) {
    const rows = (tables.inventarios?.rows || [])
      .map((inventory) => ({ inventory, date: backendIsoDate(inventory.fecha) }))
      .filter((row) => row.date && (!startIso || row.date >= startIso) && (!endIso || row.date <= endIso))
      .sort((left, right) => {
        if (left.date !== right.date) return right.date.localeCompare(left.date);
        return backendTurnRank(right.inventory.turno) - backendTurnRank(left.inventory.turno);
      });
  
    if (!rows.length) return null;
    const latest = rows[0].inventory;
    let units = 0;
    let calculatedValueCents = 0;
    let valuedDetailCount = 0;
    const valueDetails = [];
    (detailsByInventory.get(backendId(latest.id_inventario)) || []).forEach((detail) => {
      const item = itemsById.get(backendId(detail.id_item));
      const product = productByItemId.get(backendId(detail.id_item));
      const originType = backendNormalizeText(item?.origen_tipo);
      const quantity = backendInventoryQuantity(detail.cantidad);
      const unitCost = backendNumber(detail.costo_unitario_usado);
      if (unitCost > 0) {
        calculatedValueCents += multiplyCents(unitCost, quantity);
        valuedDetailCount += 1;
      }
  
      if (originType === "producto" || product) {
        units += quantity * backendNumber(product?.cantidad_individual || 1);
      }
  
      if (originType === "insumo") {
        valueDetails.push({
          id_item: detail.id_item,
          id_insumo: backendId(item?.id_origen),
          quantity,
          unitCost,
          value: fromCents(multiplyCents(unitCost, quantity))
        });
      }
    });
  
    const storedValue = normalize(backendNumber(latest.valor_total));
  
    return {
      date: backendIsoDate(latest.fecha),
      turn: latest.turno || "",
      units,
      value: valuedDetailCount ? fromCents(calculatedValueCents) : storedValue,
      storedValue,
      valueDetails
    };
  }
  
  function backendLatestSupplyCostMap(tables, dateIso) {
    const purchasesById = backendRowsById(tables.compras?.rows, "id_compra");
    const expensesById = backendRowsById(tables.egresos?.rows, "id_egreso");
    const receptionsByPurchase = backendGroupRowsById(tables.recepciones?.rows, "id_compra");
    const receptionDetailsByReception = backendGroupRowsById(tables.detalle_recepciones?.rows, "id_recepcion");
    const suppliesById = backendRowsById(tables.insumos?.rows, "id_insumo");
    const supplierItemsById = backendRowsById(tables.insumos_proveedores?.rows, "id_insumos_proveedores");
    const candidatesBySupply = new Map();
  
    (tables.detalle_compras?.rows || []).forEach((detail) => {
      const purchase = purchasesById.get(backendId(detail.id_compra));
      if (!purchase) return;
  
      const receptionRows = receptionsByPurchase.get(backendId(detail.id_compra)) || [];
      const receptionDate = receptionRows
        .map((row) => backendIsoDate(row.fecha_recepcion))
        .filter(Boolean)
        .sort()
        .at(-1);
      const purchaseDate = receptionDate || backendIsoDate(purchase.fecha_pedido) || backendIsoDate(purchase.fecha_entrega_prevista);
      if (!purchaseDate) return;
  
      const supplierItem = supplierItemsById.get(backendId(detail.id_insumos_proveedores));
      if (!supplierItem) return;
  
      const supplyId = backendId(supplierItem.id_insumo);
      if (!supplyId) return;
  
      const supplyRecipeUnitsPerCountUnit = backendRecipeQuantity(suppliesById.get(supplyId)?.cantidad_receta) || 1;
      const supplierRecipeUnitsPerProviderUnit = backendNumber(supplierItem.cantidad_proveedor) || 1;
      const unitCost = backendReceptionRecipeUnitCost({
        detail,
        expenseRows: expensesById,
        receptionRows,
        receptionDetailsByReception,
        supplyId,
        supplierRecipeUnitsPerProviderUnit,
        supplierItem
      });
      if (!unitCost) return;
  
      if (!candidatesBySupply.has(supplyId)) candidatesBySupply.set(supplyId, []);
      candidatesBySupply.get(supplyId).push({
        date: purchaseDate,
        unitCost,
        supplierItemId: supplierItem.id_insumos_proveedores,
        supplyRecipeUnitsPerCountUnit,
        supplierRecipeUnitsPerProviderUnit
      });
    });
  
    const selectedBySupply = new Map();
    candidatesBySupply.forEach((candidates, supplyId) => {
      const sorted = candidates.slice().sort((left, right) => left.date.localeCompare(right.date));
      const previous = dateIso ? sorted.filter((candidate) => candidate.date <= dateIso).at(-1) : sorted.at(-1);
      selectedBySupply.set(supplyId, previous || sorted[0]);
    });
  
    return selectedBySupply;
  }
  
  function backendReceptionRecipeUnitCost({
    detail,
    expenseRows,
    receptionRows,
    receptionDetailsByReception,
    supplyId,
    supplierRecipeUnitsPerProviderUnit,
    supplierItem
  }) {
    for (const reception of receptionRows) {
      const expense = expenseRows.get(backendId(reception.id_egreso));
      const expenseSubtotal = backendNumber(expense?.subtotal);
      if (!expenseSubtotal) continue;
  
      const receivedQuantity = (receptionDetailsByReception.get(backendId(reception.id_recepcion)) || [])
        .filter((row) => backendId(row.id_insumo) === supplyId)
        .reduce((total, row) => total + backendNumber(row.cantidad_recibida), 0);
      const providerUnits = receivedQuantity || backendNumber(detail.cantidad);
      const recipeUnits = providerUnits * supplierRecipeUnitsPerProviderUnit;
      if (recipeUnits > 0) return divide(expenseSubtotal, recipeUnits);
    }
  
    const supplierUnitQuantity = backendNumber(supplierItem.cantidad_proveedor) || 1;
    const supplierUnitPrice = backendNumber(supplierItem.precio);
    return supplierUnitPrice ? divide(supplierUnitPrice, supplierUnitQuantity) : 0;
  }
  
  function backendIsoDate(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const local = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (local) {
      const day = local[1].padStart(2, "0");
      const month = local[2].padStart(2, "0");
      const year = local[3].length === 2 ? `20${local[3]}` : local[3];
      return `${year}-${month}-${day}`;
    }
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    return "";
  }
  
  function backendNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const text = String(value ?? "").trim();
    if (!text) return 0;
    const compact = text
      .replace(/\$/g, "")
      .replace(/\s/g, "")
      .replace(/[^\d,.-]/g, "");
    const normalized = normalizeBackendNumberText(compact);
    const number = Number(normalized);
    return Number.isFinite(number) ? number : 0;
  }
  
  function backendRecipeQuantity(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const text = String(value ?? "").trim();
    if (!text) return 0;
    const normalized = text.replace(/\s/g, "").replace(",", ".");
    const number = Number(normalized);
    return Number.isFinite(number) ? number : 0;
  }
  
  function backendRate(value) {
    const number = backendNumber(value);
    return number > 1 ? number / 100 : number;
  }
  
  function backendIsGrossRevenueTaxInvoice(invoiceType) {
    const normalized = backendNormalizeText(invoiceType);
    return normalized === "factura a" || normalized === "factura b";
  }
  
  function normalizeBackendNumberText(text) {
    if (!text) return "";
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
  
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) {
        return text.replace(/\./g, "").replace(",", ".");
      }
      return text.replace(/,/g, "");
    }
  
    if (lastComma >= 0) {
      const decimals = text.length - lastComma - 1;
      if (decimals > 0 && decimals <= 2) return text.replace(/\./g, "").replace(",", ".");
      return text.replace(/,/g, "");
    }
  
    if (lastDot >= 0) {
      const decimals = text.length - lastDot - 1;
      const dotCount = (text.match(/\./g) || []).length;
      if (dotCount > 1 || decimals === 3) return text.replace(/\./g, "");
    }
  
    return text;
  }
  
  function backendNormalizeText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/\s+/g, " ");
  }
  
  function backendIsSchoolClient(client) {
    const type = backendNormalizeText(client?.tipo);
    const name = backendNormalizeText(client?.nombre_cliente);
    return type.includes("escuela") || name.includes("escuela");
  }
  
  function backendObjectSum(object) {
    return fromCents(sumCents(Object.values(object).map((value) => Number(value) || 0)));
  }
  
  function backendMonthStartIso(year, month) {
    return `${year}-${String(month + 1).padStart(2, "0")}-01`;
  }
  
  function backendMonthEndIso(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  }
  
  function backendCurrentDateIso() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
  
  function backendOffsetIsoDate(isoDate, days) {
    const date = new Date(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return "";
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  
  function backendComparisonPeriod(year, month, mode) {
    if (mode === "previousMonth") {
      return month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
    }
    if (mode === "previousYear") return { year: year - 1, month };
    return null;
  }
  
  function backendTurnRank(turn) {
    const text = backendNormalizeText(turn);
    if (text.includes("madrugada")) return 1;
    if (text.includes("manana") || text.includes("mañana")) return 2;
    if (text.includes("tarde")) return 3;
    return 0;
  }

  return { backendComparisonPeriod, backendCurrentDateIso, backendIsGrossRevenueTaxInvoice, backendIsoDate, backendIsSchoolClient, backendLastInventorySummary, backendLatestSupplyCostMap, backendMonthEndIso, backendMonthStartIso, backendNormalizeText, backendNumber, backendObjectSum, backendOffsetIsoDate, backendRate, backendReceptionRecipeUnitCost, backendRecipeQuantity, backendTurnRank, normalizeBackendNumberText };
}

module.exports = { createIncomeCalculationService };
