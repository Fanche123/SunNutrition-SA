const { backendNextNumericId } = require("../utils/runtime");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TAG_NAME = "Transferencia interna - Galicia";
const OWN_CUIT = "30717550419";

function migrateInternalTransferCatalog(cache) {
  const migrated = JSON.parse(JSON.stringify(cache));
  const tables = migrated.tables || {};
  const creditors = (tables.acreedores?.rows || []).filter(
    (row) => digits(row.cuit_cuil) === OWN_CUIT
  );
  if (creditors.length !== 1) throw new Error("La identidad propia no existe de forma inequivoca.");
  const creditor = creditors[0];
  const ownName = (tables.otros_acreedores?.rows || []).find(
    (row) => String(row.id_otro_acreedor) === String(creditor.origen_id_acreedor)
  )?.nombre_otro_acreedor;
  if (normalize(ownName) !== "propio") throw new Error("El CUIT propio no corresponde al acreedor canonico Propio.");

  const matchingTags = (tables.etiquetas?.rows || []).filter((row) => normalize(row.etiqueta) === normalize(TAG_NAME));
  if (matchingTags.length > 1) throw new Error("La etiqueta de transferencia interna esta duplicada.");
  let tag = matchingTags[0];
  let tagInserted = false;
  if (!tag) {
    const table = tables.etiquetas;
    tag = {
      _rowNumber: table.rows.length + 2,
      id_etiqueta: backendNextNumericId(table.rows, "id_etiqueta"),
      etiqueta: TAG_NAME,
      categoria_pnl: ""
    };
    table.rows.push(tag);
    table.rowCount = table.rows.length;
    tagInserted = true;
  }

  const relations = (tables.acreedores_etiquetas?.rows || []).filter((row) => (
    String(row.id_acreedor) === String(creditor.id_acreedor)
    && String(row.id_etiqueta) === String(tag.id_etiqueta)
  ));
  if (relations.length > 1) throw new Error("La relacion Propio/transferencia interna esta duplicada.");
  let relationInserted = false;
  if (!relations.length) {
    const table = tables.acreedores_etiquetas;
    table.rows.push({
      _rowNumber: table.rows.length + 2,
      id_acreedor_etiqueta: backendNextNumericId(table.rows, "id_acreedor_etiqueta"),
      id_acreedor: creditor.id_acreedor,
      id_etiqueta: tag.id_etiqueta
    });
    table.rowCount = table.rows.length;
    relationInserted = true;
  }
  return {
    cache: migrated,
    report: {
      tagInserted,
      relationInserted,
      idAcreedor: String(creditor.id_acreedor),
      idEtiqueta: String(tag.id_etiqueta)
    }
  };
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = { migrateInternalTransferCatalog, OWN_CUIT, TAG_NAME };

if (require.main === module) {
  const action = process.argv[2] || "dry-run";
  const cachePath = path.resolve(process.argv[3] || path.join(__dirname, "../../tmp/backend-data-cache.json"));
  const expectedHash = String(process.argv[4] || "").toLowerCase();
  const source = fs.readFileSync(cachePath);
  const sourceHash = sha256(source);
  if (expectedHash && sourceHash !== expectedHash) throw new Error("El hash del cache no coincide con el esperado.");
  const result = migrateInternalTransferCatalog(JSON.parse(source.toString("utf8")));
  const output = Buffer.from(`${JSON.stringify(result.cache, null, 2)}\n`, "utf8");
  const outputHash = sha256(output);
  if (action === "dry-run") {
    console.log(JSON.stringify({ action, sourceHash, outputHash, report: result.report }, null, 2));
  } else if (action === "apply") {
    if (!expectedHash) throw new Error("Apply requiere el hash SHA-256 esperado.");
    const backupPath = `${cachePath}.backup-20260729-internal-transfer-${sourceHash.slice(0, 12)}.json`;
    const tempPath = `${cachePath}.tmp-20260729-internal-transfer`;
    fs.writeFileSync(backupPath, source, { flag: "wx" });
    if (sha256(fs.readFileSync(backupPath)) !== sourceHash) throw new Error("El backup no pudo verificarse.");
    fs.writeFileSync(tempPath, output, { flag: "wx" });
    fs.renameSync(tempPath, cachePath);
    console.log(JSON.stringify({ action, sourceHash, outputHash, backupPath, report: result.report }, null, 2));
  } else {
    throw new Error("Accion invalida. Usa dry-run o apply.");
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
