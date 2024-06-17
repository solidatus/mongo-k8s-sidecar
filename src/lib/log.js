function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function warn(message) {
  const timestamp = new Date().toISOString();
  console.warn(`[${timestamp}] ${message}`);
}

function error(message, error) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${message}`, error);
}

module.exports = {
  log: log,
  warn: warn,
  error: error,
};
