import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // config.js reads the environment once at import time, so these have to be set before any
    // module under test is loaded - vitest applies them to the worker process for us
    env: {
      KUBE_CLUSTER_DOMAIN: "cluster.local",
      KUBE_MONGO_SERVICE_NAME: "db",
      KUBE_NAMESPACE: "test-ns",
      MONGODB_FORCE_RECONFIG_GRACE_SECONDS: "30",
      MONGODB_PORT: "27017",
      MONGODB_UNHEALTHY_SECONDS: "15",
    },
    // Integration tests need real mongods; run them only via `npm run test:integration`.
    exclude: [...configDefaults.exclude, "tests/**/*.integration.test.ts"],
    include: ["tests/**/*.test.ts"],
    // Where the junit reporter writes when enabled (via the test-teamcity script).
    outputFile: { junit: "reports/junit.xml" },
  },
});
