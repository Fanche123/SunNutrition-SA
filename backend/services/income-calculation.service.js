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
  function backendLastInventoryRow(tables, startIso, endIso) {
    const rows = (tables.inventarios?.rows || [])
      .map((inventory) => ({ inventory, date: backendIsoDate(inventory.fecha) }))
      .filter((row) => row.date && (!startIso || row.date >= startIso) && (!endIso || row.date <= endIso))
      .sort((left, right) => {
        if (left.date !== right.date) return right.date.localeCompare(left.date);
        return backendTurnRank(right.inventory.turno) - backendTurnRank(left.inventory.turno);
      });
    return rows[0]?.inventory || null;
  }

  function backendLastInventorySummary(tables, startIso, endIso, inventoryById, detailsByInventory, productByItemId, itemsById) {
    const latest = backendLastInventoryRow(tables, startIso, endIso);
    if (!latest) return null;
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
  
  function backendLatestSupplyCostMap(tables, dateIso, cutoffTurn = "") {
    const purchasesById = backendRowsById(tables.compras?.rows, "id_compra");
    const expensesById = backendRowsById(tables.egresos?.rows, "id_egreso");
    const receptionsByPurchase = backendGroupRowsById(tables.recepciones?.rows, "id_compra");
    const receptionDetailsByReception = backendGroupRowsById(tables.detalle_recepciones?.rows, "id_recepcion");
    const suppliesById = backendRowsById(tables.insumos?.rows, "id_insumo");
    const supplierItemsById = backendRowsById(tables.insumos_proveedores?.rows, "id_insumos_proveedores");
    const countItemsBySupplyId = new Map((tables.items?.rows || [])
      .filter((row) => backendNormalizeText(row.origen_tipo) === "insumo")
      .map((row) => [backendId(row.id_origen), row])
      .filter(([id]) => id));
    const candidatesBySupply = new Map();
    const cutoffTurnRank = backendTurnRank(cutoffTurn);
    const eligibleReceptions = (tables.recepciones?.rows || []).filter((reception) => {
      if (!dateIso) return true;
      const receptionDate = backendIsoDate(reception.fecha_recepcion);
      if (!receptionDate || receptionDate > dateIso) return false;
      if (receptionDate < dateIso || !cutoffTurnRank) return true;
      // Recepciones no persiste hora. El contrato de Inventario las incorpora
      // una sola vez desde Manana; Madrugada del mismo dia queda antes del corte.
      return cutoffTurnRank >= backendTurnRank("Manana");
    });
    const expenseUses = new Map();
    (tables.recepciones?.rows || []).forEach((reception) => {
      const expenseId = backendId(reception.id_egreso);
      if (!expenseId) return;
      (receptionDetailsByReception.get(backendId(reception.id_recepcion)) || []).forEach((receptionDetail) => {
        const supplyId = backendId(receptionDetail.id_insumo);
        if (!supplyId) return;
        if (!expenseUses.has(expenseId)) expenseUses.set(expenseId, new Set());
        expenseUses.get(expenseId).add(`${backendId(reception.id_compra)}:${supplyId}`);
      });
    });
    const ambiguousExpenseIds = new Set([...expenseUses]
      .filter(([, uses]) => uses.size > 1)
      .map(([expenseId]) => expenseId));
  
    (tables.detalle_compras?.rows || []).forEach((detail) => {
      const purchase = purchasesById.get(backendId(detail.id_compra));
      if (!purchase) return;
  
      const receptionRows = (receptionsByPurchase.get(backendId(detail.id_compra)) || [])
        .filter((reception) => eligibleReceptions.includes(reception));
      const receptionDate = receptionRows
        .map((row) => backendIsoDate(row.fecha_recepcion))
        .filter(Boolean)
        .sort()
        .at(-1);
      const purchaseDate = receptionDate || backendIsoDate(purchase.fecha_pedido) || backendIsoDate(purchase.fecha_entrega_prevista);
      if (!purchaseDate) return;
  
      const supplierItem = supplierItemsById.get(backendId(detail.id_insumos_proveedores)) || {};
      const supplyId = backendId(detail.id_insumo) || backendId(supplierItem.id_insumo);
      if (!supplyId) return;

      const supply = suppliesById.get(supplyId) || {};
      const countItem = countItemsBySupplyId.get(supplyId) || {};
      const configuredCountFactor = positiveRecipeQuantity(supply.cantidad_receta);
      const matchingBaseUnits = backendNormalizeText(countItem.ud_conteo)
        && backendNormalizeText(countItem.ud_conteo) === backendNormalizeText(supply.ud_receta);
      const supplyRecipeUnitsPerCountUnit = configuredCountFactor || (matchingBaseUnits ? 1 : 0);
      const supplierSnapshotRecipeUnitsPerProviderUnit = positiveBackendNumber(detail.cantidad_proveedor);
      const supplierRecipeUnitsPerProviderUnit = supplierSnapshotRecipeUnitsPerProviderUnit
        || backendNumber(supplierItem.cantidad_proveedor);
      const costSnapshot = backendReceptionCostSnapshot({
        detail,
        ambiguousExpenseIds,
        expenseRows: expensesById,
        receptionRows,
        receptionDetailsByReception,
        supplyId,
        supplyRecipeUnitsPerCountUnit,
        supplierSnapshotRecipeUnitsPerProviderUnit,
        supplierRecipeUnitsPerProviderUnit,
        supplierItem
      });

      if (!candidatesBySupply.has(supplyId)) candidatesBySupply.set(supplyId, []);
      candidatesBySupply.get(supplyId).push({
        date: purchaseDate,
        ...costSnapshot,
        supplierItemId: supplierItem.id_insumos_proveedores,
        supplyRecipeUnitsPerCountUnit,
        supplierRecipeUnitsPerProviderUnit
      });
    });
  
    const selectedBySupply = new Map();
    candidatesBySupply.forEach((candidates, supplyId) => {
      const sorted = candidates.slice().sort((left, right) => left.date.localeCompare(right.date));
      const eligible = dateIso ? sorted.filter((candidate) => candidate.date <= dateIso) : sorted;
      const valid = eligible.filter((candidate) => candidate.countUnitCost > 0 || candidate.unitCost > 0);
      const selected = valid.at(-1) || eligible.at(-1);
      if (selected) selectedBySupply.set(supplyId, selected);
    });
  
    return selectedBySupply;
  }
  
  function backendReceptionRecipeUnitCost({
    detail,
    ambiguousExpenseIds = new Set(),
    expenseRows,
    receptionRows,
    receptionDetailsByReception,
    supplyId,
    supplyRecipeUnitsPerCountUnit = 1,
    supplierSnapshotRecipeUnitsPerProviderUnit = 0,
    supplierRecipeUnitsPerProviderUnit,
    supplierItem
  }) {
    return backendReceptionCostSnapshot({
      detail,
      ambiguousExpenseIds,
      expenseRows,
      receptionRows,
      receptionDetailsByReception,
      supplyId,
      supplyRecipeUnitsPerCountUnit,
      supplierSnapshotRecipeUnitsPerProviderUnit,
      supplierRecipeUnitsPerProviderUnit,
      supplierItem
    }).unitCost;
  }

  function backendReceptionCostSnapshot({
    detail,
    ambiguousExpenseIds = new Set(),
    expenseRows,
    receptionRows,
    receptionDetailsByReception,
    supplyId,
    supplyRecipeUnitsPerCountUnit,
    supplierSnapshotRecipeUnitsPerProviderUnit,
    supplierRecipeUnitsPerProviderUnit,
    supplierItem
  }) {
    let receivedCountUnits = 0;
    let expenseSubtotal = 0;
    let hasAmbiguousExpense = false;
    const countedExpenseIds = new Set();

    receptionRows.forEach((reception) => {
      const receptionSupplyRows = (receptionDetailsByReception.get(backendId(reception.id_recepcion)) || [])
        .filter((row) => backendId(row.id_insumo) === supplyId);
      if (!receptionSupplyRows.length) return;
      const receptionCountUnits = receptionSupplyRows
        .reduce((total, row) => total + positiveBackendNumber(row.cantidad_recibida), 0);
      receivedCountUnits += receptionCountUnits;
      const expenseId = backendId(reception.id_egreso);
      if (!expenseId || countedExpenseIds.has(expenseId)) return;
      if (ambiguousExpenseIds.has(expenseId)) {
        hasAmbiguousExpense = true;
        return;
      }
      const subtotal = positiveBackendNumber(expenseRows.get(expenseId)?.subtotal);
      if (!(subtotal > 0)) return;
      countedExpenseIds.add(expenseId);
      expenseSubtotal += subtotal;
    });

    if (hasAmbiguousExpense) {
      return {
        unitCost: 0,
        countUnitCost: 0,
        valuationSource: "ambiguous_shared_expense",
        diagnostic: "El subtotal pertenece a mas de una compra o insumo y no existe un reparto historico demostrable."
      };
    }

    const providerUnits = positiveBackendNumber(detail.cantidad);
    const providerRecipeFactor = positiveBackendNumber(supplierRecipeUnitsPerProviderUnit);
    const recipeFactor = positiveRecipeQuantity(supplyRecipeUnitsPerCountUnit);
    if (expenseSubtotal > 0 && receivedCountUnits > 0) {
      const historicalProviderRecipeFactor = positiveBackendNumber(supplierSnapshotRecipeUnitsPerProviderUnit)
        || providerRecipeFactor;
      const expectedCountUnits = providerUnits > 0 && historicalProviderRecipeFactor > 0 && recipeFactor > 0
        ? (providerUnits * historicalProviderRecipeFactor) / recipeFactor
        : 0;
      const matchesProviderUnits = approximatelyEqual(receivedCountUnits, providerUnits);
      const matchesCountUnits = approximatelyEqual(receivedCountUnits, expectedCountUnits);
      const receptionLooksLikeProviderUnits = matchesProviderUnits || (
        !matchesCountUnits
        && relativeDistance(receivedCountUnits, providerUnits) < relativeDistance(receivedCountUnits, expectedCountUnits)
      );

      if (receptionLooksLikeProviderUnits && !matchesCountUnits && providerRecipeFactor > 0 && recipeFactor > 0) {
        const countUnitCost = divide(
          expenseSubtotal,
          (receivedCountUnits * providerRecipeFactor) / recipeFactor
        );
        return {
          unitCost: divide(countUnitCost, recipeFactor),
          countUnitCost,
          valuationSource: "historical_reception_provider_unit",
          diagnostic: "La recepcion historica coincide con la cantidad del proveedor; se normalizo con la presentacion de la linea."
        };
      }

      const countUnitCost = divide(expenseSubtotal, receivedCountUnits);
      return {
        unitCost: recipeFactor ? divide(countUnitCost, recipeFactor) : 0,
        countUnitCost,
        valuationSource: "historical_reception_count_unit",
        diagnostic: recipeFactor
          ? ""
          : "Costo por unidad de conteo disponible; falta un factor historico valido hacia la unidad de receta."
      };
    }

    if (expenseSubtotal > 0 && providerUnits > 0 && providerRecipeFactor > 0) {
      const countUnitCost = recipeFactor
        ? divide(expenseSubtotal, (providerUnits * providerRecipeFactor) / recipeFactor)
        : 0;
      return {
        unitCost: divide(expenseSubtotal, providerUnits * providerRecipeFactor),
        countUnitCost,
        valuationSource: "historical_provider_quantity_fallback",
        diagnostic: recipeFactor
          ? "No habia cantidad de conteo historica; se uso la presentacion persistida de la linea."
          : "No habia cantidad de conteo historica ni factor valido hacia la unidad de conteo."
      };
    }

    const historicalSupplierQuantity = positiveBackendNumber(detail.cantidad_proveedor);
    const historicalSupplierPrice = positiveBackendNumber(detail.precio);
    const supplierUnitQuantity = historicalSupplierQuantity
      || positiveBackendNumber(supplierItem.cantidad_proveedor);
    const supplierUnitPrice = historicalSupplierPrice
      || positiveBackendNumber(supplierItem.precio);
    if (supplierUnitPrice > 0 && supplierUnitQuantity > 0) {
      const countUnitCost = recipeFactor
        ? divide(supplierUnitPrice, supplierUnitQuantity / recipeFactor)
        : 0;
      return {
        unitCost: divide(supplierUnitPrice, supplierUnitQuantity),
        countUnitCost,
        valuationSource: historicalSupplierPrice && historicalSupplierQuantity
          ? "historical_purchase_line_fallback"
          : "current_supplier_fallback",
        diagnostic: recipeFactor
          ? "Sin costo de recepcion; se uso el precio de proveedor disponible como fallback."
          : "Sin costo de recepcion ni factor valido hacia la unidad de conteo."
      };
    }

    return {
      unitCost: 0,
      countUnitCost: 0,
      valuationSource: "unavailable",
      diagnostic: "No se pudo normalizar el costo: faltan cantidades historicas positivas o factores validos."
    };
  }

  function positiveBackendNumber(value) {
    const number = backendNumber(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function positiveRecipeQuantity(value) {
    const number = backendRecipeQuantity(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function approximatelyEqual(left, right) {
    if (!(left > 0) || !(right > 0)) return false;
    return Math.abs(left - right) <= Math.max(0.000001, Math.abs(right) * 0.000001);
  }

  function relativeDistance(left, right) {
    if (!(left > 0) || !(right > 0)) return Number.POSITIVE_INFINITY;
    return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right));
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

  return { backendComparisonPeriod, backendCurrentDateIso, backendIsGrossRevenueTaxInvoice, backendIsoDate, backendIsSchoolClient, backendLastInventoryRow, backendLastInventorySummary, backendLatestSupplyCostMap, backendMonthEndIso, backendMonthStartIso, backendNormalizeText, backendNumber, backendObjectSum, backendOffsetIsoDate, backendRate, backendReceptionCostSnapshot, backendReceptionRecipeUnitCost, backendRecipeQuantity, backendTurnRank, normalizeBackendNumberText };
}

module.exports = { createIncomeCalculationService };
