var dns = require('dns');
var log = require('./log');

var getMongoPodLabels = function() {
  return process.env.MONGO_SIDECAR_POD_LABELS || false;
};

var getMongoPodLabelCollection = function() {
  var podLabels = getMongoPodLabels();
  if (!podLabels) {
    return false;
  }
  var labels = process.env.MONGO_SIDECAR_POD_LABELS.split(',');
  for (var i in labels) {
    var keyAndValue = labels[i].split('=');
    labels[i] = {
      key: keyAndValue[0],
      value: keyAndValue[1]
    };
  }

  return labels;
};

var getk8sROServiceAddress = function() {
  return process.env.KUBERNETES_SERVICE_HOST + ":" + process.env.KUBERNETES_SERVICE_PORT
};

/**
 * @returns k8sClusterDomain should the name of the kubernetes domain where the cluster is running.
 * Can be convigured via the environmental variable 'KUBERNETES_CLUSTER_DOMAIN'.
 */
var getK8sClusterDomain = function() {
  var domain = process.env.KUBERNETES_CLUSTER_DOMAIN || "cluster.local";
  verifyCorrectnessOfDomain(domain);
  return domain;
};

/**
 * Calls a reverse DNS lookup to ensure that the given custom domain name matches the actual one.
 * Raises a console warning if that is not the case.
 * @param clusterDomain the domain to verify.
 */
var verifyCorrectnessOfDomain = function(clusterDomain) {
  if (!clusterDomain) {
    return;
  }

  var servers = dns.getServers();
  if (!servers || !servers.length) {
    log.log(`dns.getServers() didn't return any results when verifying the cluster domain '${clusterDomain}'.`);
    return;
  }

  // In the case that we can resolve the DNS servers, we get the first and try to retrieve its host.
  dns.reverse(servers[0], function(err, host) {
    if (err) {
      log.warn(`Error occurred trying to verify the cluster domain '${clusterDomain}'`);
    }
    else if (host.length < 1 || !host[0].endsWith(clusterDomain)) {
      log.warn(`Possibly wrong cluster domain name! Detected '${clusterDomain}' but expected similar to '${host}'`);
    }
    else {
      log.log(`The cluster domain '${clusterDomain}' was successfully verified.`);
    }
  });
};

/**
 * @returns k8sMongoServiceName should be the name of the (headless) k8s service operating the mongo pods.
 */
var getK8sMongoServiceName = function() {
  return process.env.KUBERNETES_MONGO_SERVICE_NAME || false;
};

/**
 * @returns mongoPort this is the port on which the mongo instances run. Default is 27017.
 */
var getMongoDbPort = function() {
  var mongoPort = process.env.MONGO_PORT || 27017;
  log.log(`Using mongo port: ${mongoPort}`, );
  return mongoPort;
};

/**
 *  @returns boolean to define the RS as a configsvr or not. Default is false
 */
var isConfigRS = function() {
  var configSvr = (process.env.CONFIG_SVR || '').trim().toLowerCase();
  var configSvrBool = /^(?:y|yes|true|1)$/i.test(configSvr);
  if (configSvrBool) {
    log.log("ReplicaSet is configured as a configsvr");
  }

  return configSvrBool;
};

/**
 * @returns boolean
 */
var stringToBool = function(boolStr) {
  var isTrue = ( boolStr === 'true' ) || false;

  return isTrue;
};

module.exports = {
  namespace: process.env.KUBE_NAMESPACE,
  username: process.env.MONGODB_USERNAME,
  password: process.env.MONGODB_PASSWORD,
  database: process.env.MONGODB_DATABASE || 'local',
  loopSleepSeconds: process.env.MONGO_SIDECAR_SLEEP_SECONDS || 5,
  unhealthySeconds: process.env.MONGO_SIDECAR_UNHEALTHY_SECONDS || 15,
  mongoSSLEnabled: stringToBool(process.env.MONGO_SSL_ENABLED),
  mongoSSLAllowInvalidCertificates: stringToBool(process.env.MONGO_SSL_ALLOW_INVALID_CERTIFICATES),
  mongoSSLAllowInvalidHostnames: stringToBool(process.env.MONGO_SSL_ALLOW_INVALID_HOSTNAMES),
  env: process.env.NODE_ENV || 'local',
  mongoPodLabels: getMongoPodLabels(),
  mongoPodLabelCollection: getMongoPodLabelCollection(),
  k8sROServiceAddress: getk8sROServiceAddress(),
  k8sMongoServiceName: getK8sMongoServiceName(),
  k8sClusterDomain: getK8sClusterDomain(),
  mongoPort: getMongoDbPort(),
  isConfigRS: isConfigRS(),
};
