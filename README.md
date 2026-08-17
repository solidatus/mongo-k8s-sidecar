# Mongo Kubernetes Replica Set Sidecar

## Publish Guide

1. PR `master` into `stable`. PR TC build needs approval to start.
1. TC build on new `stable` commit will be auto-triggered. Will publish to dev, prod & external repos.
1. The `stable` TC build will also auto-patch-bump, so ideally merge back `stable` into `master`.

---

This project is as a PoC to setup a mongo replica set using Kubernetes. It should handle resizing of any type and be
resilient to the various conditions both mongo and kubernetes can find themselves in.

## How to use it

The docker image is hosted on docker hub and can be found here:
https://hub.docker.com/r/cvallance/mongo-k8s-sidecar/

An example kubernetes replication controller can be found in the examples directory on github here:
https://github.com/cvallance/mongo-k8s-sidecar

There you will also find some helper scripts to test out creating the replica set and resizing it.

### Settings

Boolean variables are read as the literal string `true` unless stated otherwise.

| Environment Variable | Required | Default | Description |
| --- | --- | --- | --- |
| KUBE_NAMESPACE | NO | default | The namespace to look up pods in. |
| MONGO_SIDECAR_POD_LABELS | NO | app=solidatus-db | The label selector used to find the mongo pods. This should be a comma separated list of key values the same as the podTemplate labels. See above for example. |
| MONGODB_LOOP_SLEEP_SECONDS | NO | 5 | This is how long to sleep between work cycles. |
| MONGODB_UNHEALTHY_SECONDS | NO | 15 | This is how many seconds a replica set member that has been reachable at least once has to get healthy again before automatically being removed from the replica set. |
| MONGODB_STARTUP_GRACE_SECONDS | NO | 300 | This is how many seconds a member that has never been reachable is given before being removed. A mongod loading a large dataset is not reachable yet but its pod is Running, so removing it early only gets it re-added on the next cycle. Values below MONGODB_UNHEALTHY_SECONDS are ignored. |
| MONGODB_FORCE_RECONFIG_GRACE_SECONDS | NO | 30 | This is how many seconds the set is left to elect a primary of its own before a sidecar writes a forced reconfig, and how long it then waits before writing another. A forced reconfig skips MongoDB's config version check, so two sidecars writing one at the same time lose one of the two updates; the wait keeps that to states the set cannot get out of by itself. Should comfortably exceed the replica set's `electionTimeoutMillis` (10s by default). |
| MONGODB_PORT | NO | 27017 | Configures the mongo port, allows the usage of non-standard ports. |
| MONGODB_CONFIG_SVR | NO | false | Configures the [configsvr](https://docs.mongodb.com/manual/reference/replica-configuration/#rsconf.configsvr) variable when initializing the replicaset. Accepts `y`, `yes`, `true` or `1`. |
| KUBE_MONGO_SERVICE_NAME | NO | db | This should point to the MongoDB Kubernetes (headless) service that identifies all the pods. It is used for setting up the DNS configuration for the mongo pods, instead of the default pod IPs. Works only with the StatefulSets' stable network ID. |
| KUBE_CLUSTER_DOMAIN | NO | cluster.local | This allows the specification of a custom cluster domain name. Used for the creation of a stable network ID of the k8s Mongo   pods. An example could be: "kube.local". |
| KUBE_CLUSTER_SKIP_TLS_VERIFY | NO | false | If `true`, the k8s server's certificate will not be checked for validity. |
| KUBE_NORMALIZE_MEMBER_HOSTS | NO | true | Existing replica set members whose host is not the pod's stable network ID are renamed to it, one member per work cycle. Set to `false`, `no`, `n` or `0` (case-insensitive) to leave existing member hosts untouched. Any other value - including an unrecognised one - leaves normalization on. |
| LOG_DEBUG | NO | false | If `true`, logs additional detail, including the full replica set config on every reconfig. |
| MONGODB_USERNAME | NO | | Configures the mongo username for authentication. Authentication is only used if both this and `MONGODB_PASSWORD` are set. |
| MONGODB_PASSWORD | NO | | Configures the mongo password for authentication. |
| MONGODB_AUTHDB | NO | | Configures the mongo authentication database. |
| MONGODB_TLS | NO | false | Enable TLS for MongoDB. |
| MONGODB_TLS_ALLOW_INVALID_CERTIFICATES | NO | false | This should be set to `true` if you want to use self signed certificates. |
| MONGODB_TLS_ALLOW_INVALID_HOSTNAMES | NO | false | This should be set to `true` if your certificates FQDN's do not match the host name set in your replset. |

In its default configuration the sidecar uses the pods' IPs for the MongodDB replica names. Here is a trimmed example:
```
[ { _id: 1,
   name: '10.48.0.70:27017',
   stateStr: 'PRIMARY',
   ...},
 { _id: 2,
   name: '10.48.0.72:27017',
   stateStr: 'SECONDARY',
   ...},
 { _id: 3,
   name: '10.48.0.73:27017',
   stateStr: 'SECONDARY',
   ...} ]
```

If you want to use the StatefulSets' stable network ID, you have to make sure that you have the `KUBE_MONGO_SERVICE_NAME`
environmental variable set. Then the MongoDB replica set node names could look like this:
```
[ { _id: 1,
   name: 'mongo-prod-0.mongodb.db-namespace.svc.cluster.local:27017',
   stateStr: 'PRIMARY',
   ...},
 { _id: 2,
   name: 'mongo-prod-1.mongodb.db-namespace.svc.cluster.local:27017',
   stateStr: 'SECONDARY',
   ...},
 { _id: 3,
   name: 'mongo-prod-2.mongodb.db-namespace.svc.cluster.local:27017',
   stateStr: 'SECONDARY',
   ...} ]
```
StatefulSet name: `mongo-prod`.
Headless service name: `mongodb`.
Namespace: `db-namespace`.

Read more about the stable network IDs
<a href="https://kubernetes.io/docs/concepts/abstractions/controllers/statefulsets/#stable-network-id">here</a>.

An example for a stable network pod ID looks like this:
`$(statefulset name)-$(ordinal).$(service name).$(namespace).svc.cluster.local`.
The `statefulset name` + the `ordinal` form the pod name, the `service name` is passed via `KUBE_MONGO_SERVICE_NAME`,
the namespace is extracted from the pod metadata and the rest is static.

A thing to consider when running a cluster with the mongo-k8s-sidecar is that it will prefer the stateful set stable
network ID to the pod IP, for both new entries and existing ones. A member host has to identify one specific mongod and
resolve from outside the namespace, and the stable network ID is the only form that does both, so by default the sidecar
renames existing members onto it - one member per work cycle, in its own reconfig. Set `KUBE_NORMALIZE_MEMBER_HOSTS` to
`false`, `no`, `n` or `0` (case-insensitive, surrounding whitespace ignored) to leave existing member hosts as they are.
Normalization is on by default, and only those spellings turn it off - any other value, including a typo such as `off` or
`disabled`, leaves it on.

The sidecar recognises a pod that is already a member under a name it would not have chosen itself, and will not add a
second entry for it. That covers the pod IP, the namespace-scoped short name (`mongo-prod-0.mongodb:27017`), and - via
mongod's own `self` flag - a name that identifies no pod at all, such as a bare headless service name. Adding a duplicate
entry for a mongod that is already a member makes mongod report `Received heartbeat from member with the same member ID
as ourself`, and the duplicate is then removed as unhealthy and re-added on every cycle.

Example of mongo replica names the sidecar understands:
```
10.48.0.72:27017 # Uses the default pod IP name
mongo-prod-0.mongodb:27017 # Uses the namespace-scoped short name
mongo-prod-0.mongodb.db-namespace.svc.cluster.local:27017 # Uses the stable network ID
```

With normalization enabled, all of the above converge on the stable network ID. Anything that points at more than one
mongod - a bare headless service name, for example - is only recognised for the pod running the sidecar itself, so avoid
it in a preconfigured replica set.

#### MongoDB Command
The following is an example of how you would update the mongo command enabling ssl and using a certificate obtained from a secret and mounted at /data/ssl/mongodb.pem

Command
```
        - name: my-mongo
          image: mongo
          command:
            - mongod
            - "--replSet"
            - heroku
            - "--bind_ip"
            - 0.0.0.0
            - "--smallfiles"
            - "--noprealloc"
            - "--sslMode"
            - "requireSSL"
            - "--sslPEMKeyFile"
            - "/data/ssl/mongodb.pem"
            - "--sslAllowConnectionsWithoutCertificates"
            - "--sslAllowInvalidCertificates"
            - "--sslAllowInvalidHostnames"
```

Volume & Volume Mount
```
          volumeMounts:
            - name: mongo-persistent-storage
              mountPath: /data/db
            - name: mongo-ssl
              mountPath: /data/ssl
        - name: mongo-sidecar
          image: cvallance/mongo-k8s-sidecar:latest
          env:
            - name: MONGO_SIDECAR_POD_LABELS
              value: "role=mongo,environment=prod"
            - name: MONGODB_TLS
              value: 'true'
      volumes:
        - name: mongo-ssl
          secret:
            secretName: mongo
```

#### Creating Secret for SSL
Use the Makefile:

| Environment Variable | Required | Default | Description |
| --- | --- | --- | --- |
| MONGO_SECRET_NAME | NO | mongo-ssl | This is the name that the secret containing the SSL certificates will be created with. |
| KUBECTL_NAMESPACE | NO | default | This is the namespace in which the secret containing the SSL certificates will be created. |

```
export MONGO_SECRET_NAME=mongo-ssl
export KUBECTL_NAMESPACE=default
cd examples && make generate-certificate
```

or

Generate them on your own and push the secrets `kube create secret generic mongo --from-file=./keys`
where `keys` is a directory containing your SSL pem file named `mongodb.pem`

## Tests

Everything test related lives in `tests/`:

| Path                              | What                                                | How to run                 |
| --------------------------------- | --------------------------------------------------- | -------------------------- |
| `tests/*.test.ts`                 | Unit tests. No mongod, no Kubernetes, milliseconds.  | `npm test`                 |
| `tests/integration/*.integration.test.ts` | Integration tests against three real mongods. | `npm run test:integration` |

On TeamCity use `npm run test-teamcity` and `npm run test:integration-teamcity` instead: same tests,
plus a JUnit XML report under `reports/` for TeamCity's XML report processing to pick up. Always add
`npm run test:integration:down` as an always-run step, since an interrupted suite leaves the mongods up
holding their replica set config.

### Integration tests

`npm run test:integration` brings up `docker-compose.itest.yml`: three `mongo:7` containers plus a
container running the test suite, and takes about a minute.

The only thing faked is the Kubernetes API: the pod list is stubbed, and everything else - the
connections, `replSetInitiate`, every reconfig, the elections and the heartbeats - is real. The
harness mirrors the real deployment closely enough that this works:

- the test runner shares mongo-0's network namespace, so exactly as in a pod, `127.0.0.1` is its own
  mongod and `getLocalIp()` returns an address the pod list also claims
- each mongod carries its pod FQDN as a network alias, so member hosts written as
  `db-0.db.test-ns.svc.cluster.local` resolve and heartbeat for real
- addresses are static, with mongo-0's the lowest, because the sidecar gives the work to the pod with
  the lowest IP

The scenarios walk one replica set through a lifecycle in order - bootstrap, host normalization,
reaping a dead member, re-adding it - so they share state by design and must not be reordered or run
in parallel.

mongod refuses a remote `shutdown` when running without auth, so failure injection goes through a
killswitch file on a volume shared with mongo-2, whose mongod runs under a wrapper that kills it and
holds it down for 60s. Both grace periods (`MONGODB_UNHEALTHY_SECONDS`, `MONGODB_STARTUP_GRACE_SECONDS`)
are pinned low in `vitest.integration.config.mts`: which one applies to a killed member depends on
whether mongod still reports a `lastHeartbeatRecv` for it, which it does inconsistently.

Not covered yet: authenticated connections (needs a keyfile, and the localhost exception makes
bootstrapping one awkward while the sidecar is the thing doing `replSetInitiate`), TLS, and configsvr
replica sets.

## Debugging

TODO: Instructions for cloning, mounting and watching

## Still to do

- Add to circleCi
- Alter k8s call so that we don't have to filter in memory
