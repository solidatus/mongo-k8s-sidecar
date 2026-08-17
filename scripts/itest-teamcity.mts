// Runs the integration harness the way CI needs it: junit reporter on, the report pulled back out of the
// container into the checkout so TeamCity can pick it up, and the compose stack torn down afterwards -
// all under one exit code.
//
// The teardown lives here rather than as a second line in the TeamCity build step on purpose. A bash step
// without `set -e` reports the status of its *last* command, so a "run tests; tear down" step is always
// green: the teardown succeeds even when the tests never ran. Everything below is best-effort except the
// test run itself, whose status is the only thing this script exits with.
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

const docker = (args: string[]): number => {
  const { status } = spawnSync("docker", args, { stdio: "inherit" });
  return status ?? 1;
};

// Housekeeping whose failure says nothing about the tests: "no such container" on a clean agent is the
// normal case, so its noise stays out of the build log
const dockerQuietly = (args: string[]): void => {
  spawnSync("docker", args, { stdio: "ignore" });
};

// A container left behind by a killed run would make --name collide
dockerQuietly(["rm", "-f", CONTAINER]);

// The image is built as its own step, before anything brings the stack up, because `run --build` builds
// with the dependencies already started - and by then the rs network exists with its pinned
// 10.123.45.0/24 subnet. The build shares the host's network namespace (see build.network in the compose
// file), so that route is in scope while npm talks to the registry, and on CI it swallowed the traffic:
// npm resolved the registry fine and then sat in a read until ETIMEDOUT. Building first keeps the two
// apart. Note the stack's own teardown at the end is what makes the *next* run's build safe too.
const buildStatus = docker([...COMPOSE, "build", "tests"]);

const testStatus =
  buildStatus === 0 ?
    docker([...COMPOSE, "run", "--name", CONTAINER, "-e", "VITEST_ARGS=--reporter=default --reporter=junit", "tests"])
  : buildStatus;

// A run that died before vitest wrote anything has no report to copy, and that must not mask the test
// result
mkdirSync("reports", { recursive: true });
dockerQuietly(["cp", `${CONTAINER}:/app/reports/.`, "reports"]);
dockerQuietly(["rm", "-f", CONTAINER]);

docker([...COMPOSE, "down", "-v", "--remove-orphans"]);

process.exit(testStatus);
