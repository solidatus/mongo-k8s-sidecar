import { log } from "./log.js";

interface Config {
  kube: KubeConfig;
  mongo: MongoConfig;
}

interface KubeConfig {
  clusterDomain: string;
  clusterSkipTLSVerify: boolean;
  labelSelector: string;
  mongoServiceName: string;
  namespace: string;
  normalizeMemberHosts: boolean;
}

interface MongoAuthConfig {
  username: string;

  password: string;

  database?: string;
}

interface MongoConfig {
  auth?: MongoAuthConfig;
  port: number;

  tls?: boolean;
  tlsAllowInvalidCertificates?: boolean;
  tlsAllowInvalidHostnames?: boolean;

  isConfigSvr: boolean;

  forceReconfigGraceSeconds: number;
  loopSleepSeconds: number;
  startupGraceSeconds: number;
  unhealthySeconds: number;
}

const loadMongoAuthConfig = (): MongoAuthConfig | undefined => {
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  const database = process.env.MONGODB_AUTHDB;

  if (username && password) {
    return { database, password, username };
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

const normalizeMemberHosts = (): boolean => {
  const normalize = (process.env.KUBE_NORMALIZE_MEMBER_HOSTS || "").trim().toLowerCase();

  // Defaults on, so it's the off switch we have to recognise - in the same spellings isConfigRS accepts
  return !/^(?:n|no|false|0)$/i.test(normalize);
};

const loadConfig = (): Config => {
  return {
    kube: {
      clusterDomain: process.env.KUBE_CLUSTER_DOMAIN || "cluster.local",
      clusterSkipTLSVerify: process.env.KUBE_CLUSTER_SKIP_TLS_VERIFY === "true",
      labelSelector: process.env.MONGO_SIDECAR_POD_LABELS || "app=solidatus-db",
      mongoServiceName: process.env.KUBE_MONGO_SERVICE_NAME || "db",
      namespace: process.env.KUBE_NAMESPACE || "default",
      normalizeMemberHosts: normalizeMemberHosts(),
    },
    mongo: {
      auth: loadMongoAuthConfig(),
      forceReconfigGraceSeconds: parseInt(process.env.MONGODB_FORCE_RECONFIG_GRACE_SECONDS || "30"),
      isConfigSvr: isConfigRS(),

      loopSleepSeconds: parseInt(process.env.MONGODB_LOOP_SLEEP_SECONDS || "5"),
      port: parseInt(process.env.MONGODB_PORT || "27017"),
      startupGraceSeconds: parseInt(process.env.MONGODB_STARTUP_GRACE_SECONDS || "300"),
      tls: process.env.MONGODB_TLS === "true",

      tlsAllowInvalidCertificates: process.env.MONGODB_TLS_ALLOW_INVALID_CERTIFICATES === "true",

      tlsAllowInvalidHostnames: process.env.MONGODB_TLS_ALLOW_INVALID_HOSTNAMES === "true",
      unhealthySeconds: parseInt(process.env.MONGODB_UNHEALTHY_SECONDS || "15"),
    },
  };
};

const config = loadConfig();

export { config };
