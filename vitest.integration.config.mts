import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // config.js reads the environment once at import time, so these have to be set before any
    // module under test is loaded - vitest applies them to the worker process for us.
    // They have to agree with docker-compose.itest.yml: the pod FQDNs the mongods answer to are built
    // from the service name, namespace and cluster domain here.
    env: {
      KUBE_CLUSTER_DOMAIN: "cluster.local",
      KUBE_MONGO_SERVICE_NAME: "db",
      KUBE_NAMESPACE: "test-ns",
      // A real election has to be allowed to finish inside this, or the tests measure the fence rather
      // than the sidecar - but every scenario that needs a forced reconfig waits it out, so keep it
      // just past mongod's 10s election timeout rather than at the 30s default.
      MONGODB_FORCE_RECONFIG_GRACE_SECONDS: "15",
      MONGODB_PORT: "27017",
      // Both grace periods have to be short, and both matter: whether a killed member is reaped
      // under unhealthySeconds or under the startup grace depends on whether mongod still reports a
      // lastHeartbeatRecv for it, which it does inconsistently. Leaving the startup grace at its
      // 300s default makes the reap test a coin toss.
      MONGODB_STARTUP_GRACE_SECONDS: "8",
      MONGODB_UNHEALTHY_SECONDS: "5",
    },
    // The scenarios share one replica set and walk it through a lifecycle, so they must not race
    fileParallelism: false,
    hookTimeout: 180_000,
    include: ["tests/**/*.integration.test.ts"],
    // Where the junit reporter writes when enabled - see docker-compose.itest.yml
    outputFile: { junit: "reports/integration-junit.xml" },
    // Real elections, initial syncs and heartbeat timeouts, none of which are fast
    testTimeout: 180_000,
  },
});
