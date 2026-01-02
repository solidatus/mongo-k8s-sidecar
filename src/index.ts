import packageJson from "../package.json" with { type: "json" };
import { config } from "./config.js";
import { log } from "./log.js";
import { sleep } from "./utils.js";
import { init, workloop } from "./worker.js";

const main = async (): Promise<void> => {
  log.info(`Starting mongo-k8s-sidecar @ ${packageJson.version}`);
  await init();

  while (true) {
    await workloop();
    await sleep(config.mongo.loopSleepSeconds * 1000);
  }
};
main().catch((err) => log.error("Error in main func", err));
