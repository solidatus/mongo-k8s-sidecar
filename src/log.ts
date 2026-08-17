/* eslint-disable no-console */
const getDate = (): string => new Date().toISOString();

// Read straight from the environment rather than through config.js, which imports this module.
const debugEnabled = process.env.LOG_DEBUG === "true";

const log = {
  debug: (msg: string, ...optionalParams: unknown[]) => {
    if (debugEnabled) {
      console.log(`[${getDate()}] DEBUG: ${msg}`, ...optionalParams);
    }
  },
  error: (msg: string, ...optionalParams: unknown[]) =>
    console.error(`[${getDate()}] ERROR: ${msg}`, ...optionalParams),
  info: (msg: string, ...optionalParams: unknown[]) => console.log(`[${getDate()}] INFO: ${msg}`, ...optionalParams),
  warn: (msg: string, ...optionalParams: unknown[]) => console.warn(`[${getDate()}] WARN: ${msg}`, ...optionalParams),
};

export { log };
