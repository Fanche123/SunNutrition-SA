function backendId(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (Number.isFinite(number) && String(value).trim() !== "") return String(Math.trunc(number));
  return String(value).trim();
}

function backendRowsById(rows = [], idColumn) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const id = backendId(row[idColumn]);
    if (id && !map.has(id)) map.set(id, row);
  });
  return map;
}

function backendGroupRowsById(rows = [], idColumn) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const id = backendId(row[idColumn]);
    if (!id) return;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  });
  return map;
}

module.exports = { backendGroupRowsById, backendId, backendRowsById };
