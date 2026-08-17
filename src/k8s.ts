import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";

import { config } from "./config.js";

import type { Cluster, V1Pod } from "@kubernetes/client-node";

// Built on first use rather than at import: loadFromDefault() needs a kubeconfig on disk or the
// in-cluster service account, so doing it at import makes this module unimportable anywhere else -
// including from a test that only wants the pod list stubbed.
let k8sApi: CoreV1Api | undefined;

const getApi = (): CoreV1Api => {
  if (k8sApi) {
    return k8sApi;
  }

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

  k8sApi = kc.makeApiClient(CoreV1Api);
  return k8sApi;
};

const getMongoPods = async (): Promise<V1Pod[]> => {
  const kubeConfig = config.kube;
  const podList = await getApi().listNamespacedPod({
    labelSelector: kubeConfig.labelSelector,
    namespace: kubeConfig.namespace,
  });

  return podList.items;
};

export { getMongoPods };
