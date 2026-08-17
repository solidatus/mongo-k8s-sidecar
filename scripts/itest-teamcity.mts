// Runs the integration harness the way CI needs it: junit reporter on, and the report pulled back out
// of the container into the checkout so TeamCity can pick it up.
//
// The report cannot simply land in a bind-mounted directory. On a containerised build agent the docker
// daemon does not share the agent's filesystem, so a bind mount of the checkout silently resolves to an
// empty directory on the daemon side (see Dockerfile.itest). docker cp goes over the socket, so it works
// regardless of where the daemon is - but it needs a container that still exists after the run, hence
// --name plus an explicit rm instead of --rm.
//
// Node runs this .mts directly by stripping the types - no build step.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const COMPOSE = ["compose", "-f", "docker-compose.itest.yml"];
const CONTAINER = "mongo-k8s-sidecar-itest-runner";

const docker = (args: string[], { check = true }: { check?: boolean } = {}): number => {
  const { status } = spawnSync("docker", args, { stdio: "inherit" });
  if (check && status !== 0) {
    process.exit(status ?? 1);
  }
  return status ?? 1;
};

// A container left behind by a killed run would make --name collide
docker(["rm", "-f", CONTAINER], { check: false });

const testStatus = docker(
  [...COMPOSE, "run", "--build", "--name", CONTAINER, "-e", "VITEST_ARGS=--reporter=default --reporter=junit", "tests"],
  { check: false },
);

// Best-effort: a run that died before vitest wrote anything has no report, and that must not mask the
// test result
mkdirSync("reports", { recursive: true });
docker(["cp", `${CONTAINER}:/app/reports/.`, "reports"], { check: false });
docker(["rm", "-f", CONTAINER], { check: false });

process.exit(testStatus);
