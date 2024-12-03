import chalk from "chalk";

import { log } from "./log";
import { init, workloop } from "./worker";
import { config } from "./config";
import { sleep } from "./utils";

const main = async (): Promise<void> => {
  log.info(`Starting ${chalk.blue("mongo-k8s-sidecar")} @ 0.9.0`);
  await init();

  while (true) {
    await workloop();
    await sleep(config.mongo.loopSleepSeconds * 1000);
  }
};
main().catch((err) => log.error(err));
