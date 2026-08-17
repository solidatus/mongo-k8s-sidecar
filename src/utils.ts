import os from "os";

import { config } from "./config.js";

import type { V1Pod } from "@kubernetes/client-node";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const range = (start: number, end: number): number[] => Array.from({ length: end - start }, (_, i) => i + start);

const getLocalIp = (): string | undefined => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]?.find((iface) => iface.family === "IPv4" && !iface.internal);
    if (iface) {
      return iface.address;
    }
  }
  return undefined;
};

const getHostname = (): string => os.hostname();

const getPodIp = (pod: V1Pod): string | undefined => {
  return pod.status?.podIP ? `${pod.status?.podIP}:${config.mongo.port}` : undefined;
};

const getPodHostname = (pod: undefined | V1Pod): string | undefined => pod?.spec?.hostname ?? pod?.metadata?.name;

const getPodFqdn = (pod: undefined | V1Pod): string | undefined => {
  const hostname = getPodHostname(pod);

  return hostname ?
      `${hostname}.${config.kube.mongoServiceName}.${config.kube.namespace}.svc.${config.kube.clusterDomain}:${config.mongo.port}`
    : undefined;
};

export { getHostname, getLocalIp, getPodFqdn, getPodHostname, getPodIp, range, sleep };
