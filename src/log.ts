const getDate = (): string => new Date().toISOString();

const log = {
  error: (msg: string, ...optionalParams: unknown[]) =>
    console.error(`[${getDate()}] ERROR: ${msg}`, ...optionalParams),
  info: (msg: string, ...optionalParams: unknown[]) => console.log(`[${getDate()}] INFO: ${msg}`, ...optionalParams),
  warn: (msg: string, ...optionalParams: unknown[]) => console.warn(`[${getDate()}] WARN: ${msg}`, ...optionalParams),
};

export { log };
