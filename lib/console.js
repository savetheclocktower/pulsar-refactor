const TAG = '[refactor]';

let isEnabled = false;

atom.config.observe(
  'pulsar-refactor.enableDebugLogging',
  (value) => isEnabled = value
);

function log(...args) {
  if (!isEnabled) return;
  return console.log(TAG, ...args);
}

function warn(...args) {
  if (!isEnabled) return;
  return console.warn(TAG, ...args);
}

function debug(...args) {
  if (!isEnabled) return;
  return console.debug(TAG, ...args);
}

function error(...args) {
  // Errors should get logged no matter what.
  return console.error(TAG, ...args);
}

module.exports = { log, warn, debug, error };
