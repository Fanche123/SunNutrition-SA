const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STORE_VERSION = 1;

function createSecurityStore({ usersFile, fsModule = fs, now = () => new Date() }) {
  if (!usersFile) throw new Error("usersFile es obligatorio.");

  function readUsers() {
    if (!fsModule.existsSync(usersFile)) return emptyStore();
    const parsed = JSON.parse(fsModule.readFileSync(usersFile, "utf8"));
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.users)) {
      throw new Error("El archivo de usuarios tiene un formato no compatible.");
    }
    return parsed;
  }

  function writeUsers(nextStore) {
    const normalized = {
      version: STORE_VERSION,
      updatedAt: now().toISOString(),
      users: Array.isArray(nextStore?.users) ? nextStore.users : []
    };
    const directory = path.dirname(usersFile);
    fsModule.mkdirSync(directory, { recursive: true });
    const backup = createVerifiedBackup();
    const temporary = `${usersFile}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fsModule.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      fsModule.renameSync(temporary, usersFile);
      try { fsModule.chmodSync(usersFile, 0o600); } catch {}
      return { store: normalized, backup };
    } catch (error) {
      try { fsModule.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }

  function createVerifiedBackup() {
    if (!fsModule.existsSync(usersFile)) return null;
    const source = fsModule.readFileSync(usersFile);
    const sha256 = digest(source);
    const backupDir = path.join(path.dirname(usersFile), "backups");
    fsModule.mkdirSync(backupDir, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(backupDir, `users-${stamp}.json`);
    fsModule.writeFileSync(backupFile, source, { mode: 0o600 });
    const verified = digest(fsModule.readFileSync(backupFile));
    if (verified !== sha256) {
      fsModule.rmSync(backupFile, { force: true });
      throw new Error("No se pudo verificar el backup de usuarios.");
    }
    return { file: backupFile, sha256 };
  }

  return { readUsers, writeUsers };
}

function emptyStore() {
  return { version: STORE_VERSION, updatedAt: "", users: [] };
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = { STORE_VERSION, createSecurityStore };
