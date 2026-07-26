'use strict';

const fs = require('node:fs/promises');

const { atomicWriteJson, pathExists, readJsonLimited } = require('./atomic-fs');
const { getCoordinationPaths } = require('./constants');
const { CoordinationError } = require('./errors');

const MAX_HEARTBEAT_BYTES = 32 * 1024;

function validateHeartbeat(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.instanceId !== 'string' ||
    !Number.isInteger(value.pid) ||
    Number.isNaN(Date.parse(value.lastSeenAt)) ||
    !['running', 'stopping', 'stopped'].includes(value.status)
  ) {
    throw new CoordinationError('El heartbeat del watcher es inválido.', {
      code: 'INVALID_WATCHER_HEARTBEAT',
    });
  }
  return value;
}

async function readHeartbeat(repoRoot, options = {}) {
  const paths = getCoordinationPaths(repoRoot);
  if (!await pathExists(paths.heartbeat)) return null;
  const heartbeat = validateHeartbeat(
    await readJsonLimited(paths.heartbeat, MAX_HEARTBEAT_BYTES),
  );
  const now = options.now ? options.now() : Date.now();
  const staleMs = options.staleMs ?? 30_000;
  return {
    ...heartbeat,
    ageMs: Math.max(0, now - Date.parse(heartbeat.lastSeenAt)),
    active:
      heartbeat.status === 'running' &&
      now - Date.parse(heartbeat.lastSeenAt) <= staleMs,
  };
}

class WatcherHeartbeat {
  constructor(options) {
    this.repoRoot = options.repoRoot;
    this.paths = getCoordinationPaths(options.repoRoot);
    this.intervalMs = options.intervalMs ?? 5_000;
    this.atomicWriteJson = options.atomicWriteJson || atomicWriteJson;
    this.now = options.now || (() => new Date());
    this.instanceId = options.instanceId;
    this.startedAt = null;
    this.timer = null;
  }

  async write(status) {
    const current = this.now().toISOString();
    if (!this.startedAt) this.startedAt = current;
    await this.atomicWriteJson(this.paths.heartbeat, {
      version: 1,
      instanceId: this.instanceId,
      pid: process.pid,
      status,
      startedAt: this.startedAt,
      lastSeenAt: current,
    }, {
      root: this.paths.root,
      overwrite: true,
    });
  }

  async start() {
    await this.write('running');
    this.timer = setInterval(() => {
      this.write('running').catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async beat() {
    await this.write('running');
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.write('stopped').catch(() => {});
  }
}

module.exports = {
  WatcherHeartbeat,
  readHeartbeat,
  validateHeartbeat,
};
