'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { CoordinationError } = require('./errors');

function assertPathInside(root, candidate, label = 'ruta') {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CoordinationError(`${label} fuera del repositorio permitido.`, {
      code: 'PATH_OUTSIDE_ALLOWED_ROOT',
    });
  }
  return resolvedCandidate;
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function temporaryPathFor(target) {
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  return path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.tmp`);
}

async function writeBufferAndSync(filePath, buffer) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function renameWithTransientRetry(source, destination, options = {}) {
  const attempts = options.attempts ?? 14;
  const initialDelayMs = options.initialDelayMs ?? 10;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const transient = ['EACCES', 'EBUSY', 'EPERM'].includes(error.code);
      if (!transient || attempt >= attempts) throw error;
      const delay = Math.min(1_000, initialDelayMs * (2 ** attempt));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function atomicWriteFile(target, content, options = {}) {
  const root = options.root || path.dirname(target);
  const resolvedTarget = assertPathInside(root, target, 'Destino');
  await ensureDirectory(path.dirname(resolvedTarget));

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const temporary = temporaryPathFor(resolvedTarget);
  await writeBufferAndSync(temporary, buffer);

  try {
    if (typeof options.validate === 'function') {
      await options.validate(buffer);
    }
    if (options.overwrite === false) {
      await fs.link(temporary, resolvedTarget);
      await fs.unlink(temporary);
    } else {
      await renameWithTransientRetry(temporary, resolvedTarget);
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    if (error.code === 'EEXIST') {
      throw new CoordinationError(`El destino ya existe: ${path.basename(resolvedTarget)}`, {
        code: 'DESTINATION_EXISTS',
      });
    }
    throw error;
  }

  return resolvedTarget;
}

async function atomicWriteJson(target, value, options = {}) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  return atomicWriteFile(target, serialized, {
    ...options,
    validate: async (buffer) => {
      const parsed = JSON.parse(buffer.toString('utf8'));
      if (typeof options.validateJson === 'function') {
        await options.validateJson(parsed);
      }
    },
  });
}

async function atomicMove(source, destination, options = {}) {
  const root = options.root || path.dirname(source);
  const resolvedSource = assertPathInside(root, source, 'Origen');
  const resolvedDestination = assertPathInside(root, destination, 'Destino');
  await ensureDirectory(path.dirname(resolvedDestination));
  if (await pathExists(resolvedDestination)) {
    throw new CoordinationError(
      `No se sobrescribió el archivo existente: ${path.basename(resolvedDestination)}`,
      { code: 'DESTINATION_EXISTS' },
    );
  }
  await renameWithTransientRetry(resolvedSource, resolvedDestination);
  return resolvedDestination;
}

async function readFileLimited(filePath, maxBytes) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new CoordinationError(`No es un archivo regular: ${filePath}`, {
      code: 'NOT_A_REGULAR_FILE',
    });
  }
  if (stat.size > maxBytes) {
    throw new CoordinationError(
      `El archivo ${path.basename(filePath)} excede el máximo de ${maxBytes} bytes.`,
      { code: 'FILE_TOO_LARGE' },
    );
  }
  return fs.readFile(filePath);
}

async function readJsonLimited(filePath, maxBytes) {
  const buffer = await readFileLimited(filePath, maxBytes);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new CoordinationError(
      `El archivo ${path.basename(filePath)} no contiene JSON válido.`,
      { code: 'INVALID_JSON' },
    );
  }
}

async function sha256File(filePath, maxBytes) {
  const buffer = await readFileLimited(filePath, maxBytes);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256Value(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

module.exports = {
  assertPathInside,
  atomicMove,
  atomicWriteFile,
  atomicWriteJson,
  ensureDirectory,
  pathExists,
  readFileLimited,
  readJsonLimited,
  renameWithTransientRetry,
  sha256File,
  sha256Value,
};
