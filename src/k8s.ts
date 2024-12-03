import { CoreV1Api, KubeConfig, V1Pod } from "@kubernetes/client-node";
import { config } from "./config";

const kc = new KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(CoreV1Api);

const getMongoPods = async (): Promise<V1Pod[]> => {
  const kubeConfig = config.kube;
  const res = await k8sApi.listNamespacedPod(
    kubeConfig.namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    kubeConfig.labelSelector,
  );

  return res.body.items;
};

export { getMongoPods };
