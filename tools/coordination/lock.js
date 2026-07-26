'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { ensureDirectory } = require('./atomic-fs');
const { CoordinationError } = require('./errors');

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readLock(lockPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function removeIfStale(lockPath, staleMs) {
  const lock = await readLock(lockPath);
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  const recordedAt = Date.parse(lock?.createdAt || '');
  const age = Date.now() - (Number.isFinite(recordedAt) ? recordedAt : stat.mtimeMs);
  if (age <= staleMs || processIsAlive(Number(lock?.pid))) return false;
  await fs.unlink(lockPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return true;
}

async function acquireLock(lockPath, options = {}) {
  const staleMs = options.staleMs ?? 5 * 60_000;
  await ensureDirectory(path.dirname(lockPath));
  const nonce = crypto.randomBytes(16).toString('hex');
  const value = {
    pid: process.pid,
    nonce,
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        nonce,
        async release() {
          const current = await readLock(lockPath);
          if (current?.nonce === nonce) {
            await fs.unlink(lockPath).catch((error) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && await removeIfStale(lockPath, staleMs)) continue;
      throw new CoordinationError(
        `Ya existe una instancia activa para ${path.basename(lockPath)}.`,
        { code: 'LOCK_HELD' },
      );
    }
  }
  throw new CoordinationError('No se pudo adquirir el lock.', { code: 'LOCK_HELD' });
}

async function waitForLock(lockPath, options = {}) {
  const waitMs = options.waitMs ?? 5_000;
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      return await acquireLock(lockPath, options);
    } catch (error) {
      if (error.code !== 'LOCK_HELD' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

module.exports = {
  acquireLock,
  waitForLock,
};
