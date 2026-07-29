/*
  Reglas base para reconocer movimientos bancarios recurrentes.
  Se mantienen separadas del servidor para poder ajustar conciliacion sin tocar endpoints.
*/

const DEFAULT_BANK_DETAIL_RULES = [
  { detail: "I V A", expenseType: "Iva", creditor: "Estado" },
  { detail: "COM MPAY TRF ABIERTA INTER", expenseType: "Gastos Bancarios", creditor: "ICBC" },
  { detail: "IMP S/DEB CT", expenseType: "Impuesto Deb", creditor: "Estado" },
  { detail: "IMP S/CRED CT", expenseType: "Impuesto Cred", creditor: "Estado" },
  { detail: "R/RECAUDACION IB SIRCREB CONV.", expenseType: "Ingresos Brutos", creditor: "Estado" },
  { detail: "DESC DOC - IMP.SELLOS", expenseType: "Impuesto Sello", creditor: "Estado" },
  { detail: "DESC DOC - IVA ADIC.", expenseType: "Iva", creditor: "Estado" },
  { detail: "DESC DOC - IVA", expenseType: "Iva", creditor: "Estado" },
  { detail: "IVA RG 2408", expenseType: "Iva", creditor: "Estado" },
  { detail: "COM MANT CT", expenseType: "Gastos Bancarios", creditor: "ICBC" },
  { detail: "COM B@C TRF.ABIERTA INTER", expenseType: "Gastos Bancarios", creditor: "ICBC" },
  { detail: "Intereses descuento Cheque", expenseType: "Intereses", creditor: "ICBC" },
  { detail: "Imp. Deb. Ley 25413", expenseType: "Impuesto Deb", creditor: "Estado" },
  { detail: "Impuesto De Sellos", expenseType: "Impuesto Sello", creditor: "Estado" },
  { detail: "Imp. Ing. Brutos", expenseType: "Ingresos Brutos", creditor: "Estado" },
  { detail: "Percep. Iva", expenseType: "Iva", creditor: "Estado" },
  { detail: "Iva", expenseType: "Iva", creditor: "Estado" },
  { detail: "Dev.imp.deb.ley 25413", expenseType: "Impuesto Deb", creditor: "Estado" },
  { detail: "Ajuste Percepcion Iva", expenseType: "Iva", creditor: "Estado" },
  { detail: "Reintegro Iva", expenseType: "Iva", creditor: "Estado" },
  { detail: "Imp. Cre. Ley 25413", expenseType: "Impuesto Cred", creditor: "Estado" },
  { detail: "CPA. PEDIDOS YA - PROPINA", expenseType: "Varios", creditor: "ICBC" },
  { detail: "CPA. PEDIDOSYA", expenseType: "Varios", creditor: "ICBC" },
  { detail: "COM AT PAGO CH", expenseType: "Gastos Bancarios", creditor: "ICBC" },
  { detail: "COM RECH DDIR", expenseType: "Gastos Bancarios", creditor: "ICBC" },
  { detail: "ING BRUTOS PERCEP.BS.AS.", expenseType: "Ingresos Brutos", creditor: "Estado" },
  { detail: "DEB RESCATE FC", expenseType: "Gastos Bancarios", creditor: "ICBC" },
  { detail: "CRED M.E.P. NG", expenseType: "Transferencia_Interna", creditor: "ICBC" },
  { detail: "Imp. Deb. Ley 25413 Gral.", expenseType: "Impuesto Deb", creditor: "Estado" },
  { detail: "Ing. Brutos S/ Cred", expenseType: "Ingresos Brutos", creditor: "Estado" },
  { detail: "ING BRUTOS PERCEP. BUENOS AIRE", expenseType: "Ingresos Brutos", creditor: "Estado" },
  { detail: "SELLADO", expenseType: "Impuesto Sello", creditor: "Estado" },
  { detail: "IVA REDUCIDA", expenseType: "Iva", creditor: "Estado" }
];

const INTERNAL_TRANSFER_RULES = [
  {
    bank: "ICBC",
    ownCuits: ["30717550419"],
    detailPattern: /^transf connbkg(?:\b|$)/,
    creditorName: "Propio",
    tagName: "Transferencia interna - Galicia"
  }
];

module.exports = {
  DEFAULT_BANK_DETAIL_RULES,
  INTERNAL_TRANSFER_RULES
};
