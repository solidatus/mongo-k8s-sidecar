import chalk from "chalk";

type OptionalParam = string | number | boolean | object;

type Log = {
  info: (msg: string, ...optionalParams: OptionalParam[]) => void;
  warn: (msg: string, ...optionalParams: OptionalParam[]) => void;
  error: (msg: string, ...optionalParams: OptionalParam[]) => void;
};

const getDate = (): string => new Date().toISOString();

const log: Log = {
  info: (msg: string, ...optionalParams: OptionalParam[]) =>
    console.log(`[${getDate()}] ${chalk.green("INFO")}: ${msg}`, ...optionalParams),
  warn: (msg: string, ...optionalParams: OptionalParam[]) =>
    console.warn(`[${getDate()}] ${chalk.yellow("WARN")}: ${msg}`, ...optionalParams),
  error: (msg: string, ...optionalParams: OptionalParam[]) =>
    console.trace(`[${getDate()}] ${chalk.red("ERROR")}: ${msg}`, ...optionalParams),
};

export { log };
