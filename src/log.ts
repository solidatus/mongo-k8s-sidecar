import chalk from "chalk";

const getDate = (): string => new Date().toISOString();

const log = {
  error: (msg: string, ...optionalParams: unknown[]) =>
    console.error(`[${getDate()}] ${chalk.red("ERROR")}: ${msg}`, ...optionalParams),
  info: (msg: string, ...optionalParams: unknown[]) =>
    console.log(`[${getDate()}] ${chalk.green("INFO")}: ${msg}`, ...optionalParams),
  warn: (msg: string, ...optionalParams: unknown[]) =>
    console.warn(`[${getDate()}] ${chalk.yellow("WARN")}: ${msg}`, ...optionalParams),
};

export { log };
