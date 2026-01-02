import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";

import { config } from "./config.js";

import type { Cluster, V1Pod } from "@kubernetes/client-node";

const kc = new KubeConfig();
kc.loadFromDefault();

if (config.kube.clusterSkipTLSVerify) {
  // Cluster.skipTLSVerify is readonly. Let's respect it and create new cluster objects.
  // Assigning to KubeConfig.clusters appears to be the way, same as the 'loadFromCluster' in config.js of the k8s client lib.
  kc.clusters = kc.clusters.map<Cluster>((cluster) => ({
    ...cluster,
    skipTLSVerify: true,
  }));
}

const k8sApi = kc.makeApiClient(CoreV1Api);

const getMongoPods = async (): Promise<V1Pod[]> => {
  const kubeConfig = config.kube;
  const podList = await k8sApi.listNamespacedPod({
    labelSelector: kubeConfig.labelSelector,
    namespace: kubeConfig.namespace,
  });

  return podList.items;
};

export { getMongoPods };
