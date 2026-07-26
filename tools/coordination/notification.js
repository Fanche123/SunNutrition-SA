'use strict';

const { sanitizeNotificationText } = require('./security');

function notifyPending(pending, options = {}) {
  const logger = options.logger || console;
  const domain = sanitizeNotificationText(pending.domain, 40);
  const taskId = sanitizeNotificationText(pending.taskId, 128);
  const summary = sanitizeNotificationText(pending.summary, 140);
  const message = pending.protocolVersion === '2.0'
    ? `[coordinación] Revisión lista para ${domain} | ${taskId}` +
      `${pending.revision ? ` r${pending.revision}` : ''} | ${summary} | ` +
      'El mismo turno puede presentarla con coordinación await/present.'
    : `[coordinación] Pendiente para ${domain} | ${taskId} | ${summary} | ` +
      `Abrí el chat ${domain} y escribí "Revisar pendiente".`;
  if (options.enabled && options.stream?.write) {
    try {
      options.stream.write('\u0007');
    } catch {
      // El aviso es opcional y nunca debe alterar la cola.
    }
  }
  try {
    logger.info(message);
  } catch {
    // El log local también es best effort.
  }
  return message;
}

module.exports = {
  notifyPending,
};
