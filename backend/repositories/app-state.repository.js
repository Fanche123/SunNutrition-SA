const fs = require("fs");
const path = require("path");

function readAppState(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeAppState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state), "utf8");
  fs.renameSync(tempFile, filePath);
}

module.exports = { readAppState, writeAppState };
