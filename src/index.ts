import chalk from "chalk";

import packageJson from "../package.json";
import { config } from "./config";
import { log } from "./log";
import { sleep } from "./utils";
import { init, workloop } from "./worker";

const main = async (): Promise<void> => {
  log.info(`Starting ${chalk.blue("mongo-k8s-sidecar")} @ ${packageJson.version}`);
  await init();

  while (true) {
    await workloop();
    await sleep(config.mongo.loopSleepSeconds * 1000);
  }
};
main().catch((err) => log.error(err));
