import { log } from "./log";

interface Config {
  kube: KubeConfig;
  mongo: MongoConfig;
}

interface KubeConfig {
  clusterDomain: string;
  labelSelector: string;
  mongoServiceName: string;
  namespace: string;
}

interface MongoAuthConfig {
  username: string;

  password: string;
}

interface MongoConfig {
  auth?: MongoAuthConfig;
  database: string;
  port: number;

  tls?: boolean;
  tlsAllowInvalidCertificates?: boolean;
  tlsAllowInvalidHostnames?: boolean;

  isConfigSvr: boolean;

  loopSleepSeconds: number;
  unhealthySeconds: number;
}

const loadMongoAuthConfig = (): MongoAuthConfig | undefined => {
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;

  if (username && password) {
    return { password, username };
  }

  return undefined;
};

const isConfigRS = (): boolean => {
  const configSvr = (process.env.MONGODB_CONFIG_SVR || "").trim().toLowerCase();
  const configSvrBool = /^(?:y|yes|true|1)$/i.test(configSvr);

  if (configSvrBool) {
    log.info("ReplicaSet is configured as configsvr");
  }

  return configSvrBool;
};

const loadConfig = (): Config => {
  return {
    kube: {
      clusterDomain: process.env.KUBE_CLUSTER_DOMAIN || "cluster.local",
      labelSelector: process.env.MONGO_SIDECAR_POD_LABELS || "app=solidatus-db",
      mongoServiceName: process.env.KUBE_MONGO_SERVICE_NAME || "db",
      namespace: process.env.KUBE_NAMESPACE || "default",
    },
    mongo: {
      auth: loadMongoAuthConfig(),
      database: process.env.MONGODB_DATABASE || "local",
      isConfigSvr: isConfigRS(),

      loopSleepSeconds: parseInt(process.env.MONGODB_LOOP_SLEEP_SECONDS || "5"),
      port: parseInt(process.env.MONGODB_PORT || "27017"),
      tls: process.env.MONGODB_TLS === "true",

      tlsAllowInvalidCertificates: process.env.MONGODB_TLS_ALLOW_INVALID_CERTIFICATES === "true",

      tlsAllowInvalidHostnames: process.env.MONGODB_TLS_ALLOW_INVALID_HOSTNAMES === "true",
      unhealthySeconds: parseInt(process.env.MONGODB_UNHEALTHY_SECONDS || "15"),
    },
  };
};

const config = loadConfig();

export { config };
