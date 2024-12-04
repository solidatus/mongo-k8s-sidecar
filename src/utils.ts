import { V1Pod } from "@kubernetes/client-node";
import os from "os";

import { config } from "./config";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const range = (start: number, end: number) => Array.from({ length: end - start }, (_, i) => i + start);

const getLocalIp = (): string | undefined => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]?.find((iface) => iface.family === "IPv4" && !iface.internal);
    if (iface) {
      return iface.address;
    }
  }
};

const getHostname = (): string => os.hostname();

const getPodIp = (pod: V1Pod): string | undefined => `${pod.status?.podIP}:${config.mongo.port}`;

const getPodFqdn = (pod: V1Pod): string | undefined => {
  const hostname = pod.spec?.hostname ?? pod.metadata?.name;

  return `${hostname}.${config.kube.mongoServiceName}.${config.kube.namespace}.svc.${config.kube.clusterDomain}:${config.mongo.port}`;
};

export { getHostname, getLocalIp, getPodFqdn, getPodIp, range, sleep };
