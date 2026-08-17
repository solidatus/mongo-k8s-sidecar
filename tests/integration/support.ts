import { writeFile } from "fs/promises";
import { MongoClient } from "mongodb";

import { sleep } from "../../src/utils.js";

import type { ReplSetConfig, ReplSetStatus } from "../../src/types.js";
import type { V1Pod } from "@kubernetes/client-node";

// Has to agree with docker-compose.itest.yml: the sidecar under test runs in mongo-0's network
// namespace, so POD_IPS[0] is what getLocalIp() returns and therefore which pod wins the election
const POD_IPS = ["10.123.45.10", "10.123.45.11", "10.123.45.12"] as const;
const PORT = 27017;

const podName = (index: number): string => `db-${index}`;

const podIp = (index: number): string => `${POD_IPS[index]}:${PORT}`;

// The host the sidecar is expected to converge on, built the same way utils.getPodFqdn builds it
const podFqdn = (index: number): string => `${podName(index)}.db.test-ns.svc.cluster.local:${PORT}`;

const pod = (index: number, phase: string = "Running"): V1Pod =>
  ({
    metadata: { name: podName(index) },
    spec: {},
    status: { phase: phase, podIP: POD_IPS[index] },
  }) as V1Pod;

// Peer connections opened by the tests themselves, kept apart from the sidecar's own client cache so
// closing one does not disturb the other
const peerClients = new Map<number, MongoClient>();

const peerClient = (index: number): MongoClient => {
  let client = peerClients.get(index);
  if (!client) {
    client = new MongoClient(`mongodb://${POD_IPS[index]}:${PORT}`, {
      connectTimeoutMS: 3000,
      directConnection: true,
      serverSelectionTimeoutMS: 3000,
    });
    peerClients.set(index, client);
  }

  return client;
};

const closePeerClients = async (): Promise<void> => {
  const clients = [...peerClients.values()];
  peerClients.clear();
  await Promise.all(clients.map(async (c) => await c.close().catch(() => undefined)));
};

// A closed client cannot be reconnected, so a mongod that was shut down needs a fresh one
const dropPeerClient = async (index: number): Promise<void> => {
  const client = peerClients.get(index);
  peerClients.delete(index);
  await client?.close().catch(() => undefined);
};

const ping = async (index: number): Promise<boolean> => {
  try {
    const client = peerClient(index);
    await client.db().admin().command({ ping: 1 });
    return true;
  } catch {
    await dropPeerClient(index);
    return false;
  }
};

const waitForMongod = async (index: number): Promise<void> => {
  await until(async () => await ping(index), `mongod ${podName(index)} to accept connections`);
};

// Rewrite the replica set config directly, bypassing the sidecar. Used to put the set into a state
// the sidecar is then expected to correct - the tests can't wait for a real cluster to drift there.
const reconfigDirectly = async (index: number, mutate: (rsConfig: ReplSetConfig) => void): Promise<void> => {
  const db = peerClient(index).db();
  const rsConfig = (await db.admin().command({ replSetGetConfig: 1 })).config as ReplSetConfig;

  mutate(rsConfig);
  rsConfig.version++;

  // eslint-disable-next-line perfectionist/sort-objects
  await db.admin().command({ replSetReconfig: rsConfig, force: false });
};

const statusOf = async (index: number): Promise<ReplSetStatus> => {
  const db = peerClient(index).db();
  return (await db.admin().command({ replSetGetStatus: 1 })) as ReplSetStatus;
};

const configOf = async (index: number): Promise<ReplSetConfig> => {
  const db = peerClient(index).db();
  return (await db.admin().command({ replSetGetConfig: 1 })).config as ReplSetConfig;
};

// Only db-2's container runs mongod under the killswitch wrapper - see docker-compose.itest.yml
const KILLABLE_INDEX = 2;
const KILLSWITCH_FILE = "/killswitch/kill";

// Take a mongod down for real, so its peers see heartbeats stop rather than a clean state change.
// A remote shutdown command is not an option: mongod without auth only accepts it from localhost,
// and the tests are only local to db-0. So the wrapper around db-2's mongod kills it on our behalf,
// then holds it down long enough to be reaped before restarting it.
const killMongod = async (index: number): Promise<void> => {
  if (index !== KILLABLE_INDEX) {
    throw new Error(`Only db-${KILLABLE_INDEX} runs under the killswitch wrapper, asked for db-${index}`);
  }

  await writeFile(KILLSWITCH_FILE, "");
  await dropPeerClient(index);

  await until(async () => !(await ping(index)), `mongod db-${index} to stop answering`, { timeoutMs: 30_000 });
};

type UntilOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

// Poll a condition to a deadline. Anything the condition throws counts as "not yet" - a real cluster
// mid-reconfig or mid-election refuses commands, and that is the normal case here, not a failure.
// The description can be a function, so a timeout message can carry the cluster state as it is at the
// point of failure rather than as it was when the wait started.
const until = async (
  condition: () => boolean | Promise<boolean>,
  description: (() => Promise<string> | string) | string,
  { intervalMs = 500, timeoutMs = 120_000 }: UntilOptions = {},
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  for (;;) {
    try {
      if (await condition()) {
        return;
      }
      lastError = undefined;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "unknown error";
    }

    if (Date.now() >= deadline) {
      const because = lastError ? `, last error: ${lastError}` : "";
      const what = typeof description === "function" ? await description() : description;
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}${because}`);
    }

    await sleep(intervalMs);
  }
};

export {
  closePeerClients,
  configOf,
  killMongod,
  peerClient,
  ping,
  pod,
  POD_IPS,
  podFqdn,
  podIp,
  podName,
  PORT,
  reconfigDirectly,
  statusOf,
  until,
  waitForMongod,
};
