import chalk from "chalk";

type OptionalParam = boolean | number | object | string;

const getDate = (): string => new Date().toISOString();

const log = {
  error: (msg: string, ...optionalParams: OptionalParam[]) =>
    console.trace(`[${getDate()}] ${chalk.red("ERROR")}: ${msg}`, ...optionalParams),
  info: (msg: string, ...optionalParams: OptionalParam[]) =>
    console.log(`[${getDate()}] ${chalk.green("INFO")}: ${msg}`, ...optionalParams),
  warn: (msg: string, ...optionalParams: OptionalParam[]) =>
    console.warn(`[${getDate()}] ${chalk.yellow("WARN")}: ${msg}`, ...optionalParams),
};

export { log };
