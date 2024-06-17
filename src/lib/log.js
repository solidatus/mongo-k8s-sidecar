function log(message, ...optionalParams) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, ...optionalParams);
}

function warn(message, ...optionalParams) {
  const timestamp = new Date().toISOString();
  console.warn(`[${timestamp}] ${message}`, ...optionalParams);
}

function error(message, ...optionalParams) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${message}`, ...optionalParams);
}

module.exports = {
  log: log,
  warn: warn,
  error: error,
};
