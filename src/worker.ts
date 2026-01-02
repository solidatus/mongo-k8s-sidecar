import { Db, MongoServerError } from "mongodb";

import { config } from "./config.js";
import { getMongoPods } from "./k8s.js";
import { log } from "./log.js";
import { addNewReplSetMembers, getDb, initReplSet, isInReplSet, replSetGetStatus } from "./mongo.js";
import { ReplSetStatus, ReplSetStatusMember } from "./types.js";
import { getLocalIp, getPodFqdn, getPodIp } from "./utils.js";

import type { V1Pod } from "@kubernetes/client-node";

let hostIp: string | undefined;
let hostIpAndPort: string | undefined;

const init = async (): Promise<void> => {
  hostIp = getLocalIp();
  if (!hostIp) {
    throw new Error("could not find local ip");
  }

  hostIpAndPort = `${hostIp}:${config.mongo.port}`;
};

const workloop = async (): Promise<void> => {
  if (!hostIp || !hostIpAndPort) {
    throw new Error("hostIp or hostIpAndPort not initialized");
  }

  try {
    const pods = await getMongoPods();
    const db = await getDb();

    const runningPods = pods.filter((p) => p.status?.phase === "Running" && p.status?.podIP);
    if (runningPods.length === 0) {
      throw new Error("no running pods found");
    }

    try {
      const status = await replSetGetStatus(db);
      await inReplicaSet(db, runningPods, status);
    } catch (err) {
      if (err instanceof MongoServerError) {
        if (err.code === 94) {
          await notInReplicaSet(db, runningPods);
        } else if (err.code === 93) {
          await invalidReplicaSet(db, runningPods);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
  } catch (err) {
    log.error("Error in worker workloop", err);
  }
};

const inReplicaSet = async (db: Db, pods: V1Pod[], status: ReplSetStatus) => {
  // If we're already in a rs and we ARE the primary, do the work of the primary instance (i.e. adding others)
  // If we're already in a rs and we ARE NOT the primary, just continue, nothing to do
  // If we're already in a rs and NO ONE is a primary, elect someone to do the work for a primary
  const members = status.members;

  let primaryExists = false;
  for (const member of members) {
    if (member.state === 1 && member.stateStr === "PRIMARY") {
      if (member.self) {
        await primaryWork(db, pods, members, false);
      } else {
        log.info("Pod is not primary, continuing");
      }
      primaryExists = true;
      break;
    }
  }
  if (!primaryExists && podElection(pods)) {
    log.info("Pod has been elected as secondary to do primary work");
    await primaryWork(db, pods, members, true);
  }
};

const primaryWork = async (db: Db, pods: V1Pod[], members: ReplSetStatusMember[], force: boolean): Promise<void> => {
  // Loop over all the pods we have and see if any of them aren't in the current rs members array
  // Add them if not
  const addrNew = addrToAddLoop(pods, members);
  const addrDead = addrToRemoveLoop(members);

  if (addrNew.length !== 0 || addrDead.length !== 0) {
    log.info("Addresses to add ", addrNew);
    log.info("Addresses to remove ", addrDead);

    await addNewReplSetMembers(db, addrNew, addrDead, force);
  }
};

const notInReplicaSet = async (db: Db, pods: V1Pod[]): Promise<void> => {
  const testRequests = pods
    .filter((p) => p.status?.phase === "Running" && p.status?.podIP)
    .map(async (p) => await isInReplSet(p.status?.podIP ?? ""));

  const results = await Promise.all(testRequests);
  if (results.some((r) => r)) {
    return; // there's a ppd in a replica set
  }

  if (podElection(pods)) {
    log.info("Pod has been elected for replica set init");
    const primary = pods[0];
    const primaryFqdn = getPodFqdn(primary);
    await initReplSet(db, primaryFqdn || hostIpAndPort!);
  }
};

const invalidReplicaSet = async (db: Db, pods: V1Pod[]): Promise<void> => {
  log.info("Invalid replica set");
  if (!podElection(pods)) {
    log.info("Didn't win pod election, returning");
    return;
  }

  log.info("Won pod election, forcing reinit");
  const addrToAdd = addrToAddLoop(pods, []);
  const addrToRemove = addrToRemoveLoop([]);

  await addNewReplSetMembers(db, addrToAdd, addrToRemove, true);
};

const podElection = (pods: V1Pod[]): boolean => {
  pods.sort((a, b) => {
    const aIp = a.status?.podIP;
    const bIp = b.status?.podIP;
    if (!aIp || !bIp) {
      return 0;
    }
    // String sorting IP addresses doesn't provide a correct sort order but does provide a consistent sort order!
    // And that's all we need to consistently elect the same pod
    return aIp.localeCompare(bIp);
  });

  return pods[0].status?.podIP === hostIp;
};

const addrToAddLoop = (pods: V1Pod[], members: ReplSetStatusMember[]): string[] => {
  const addrs: string[] = [];
  for (const pod of pods) {
    if (pod.status?.phase !== "Running") {
      continue;
    }

    const podIp = getPodIp(pod);
    const podFqdn = getPodFqdn(pod);
    const podInRs = members.some((m) => m.name === podFqdn || m.name === podIp);

    if (!podInRs) {
      const addr = podFqdn || podIp;
      if (addr) {
        addrs.push(addr);
      } else {
        log.warn(`Could not find address for a pod, skipping`);
      }
    }
  }
  return addrs;
};

const addrToRemoveLoop = (members: ReplSetStatusMember[]) => {
  return members.filter(shouldRemoveMember).map((m) => m.name);
};

const shouldRemoveMember = (member: ReplSetStatusMember): boolean => {
  const unhealthyThreshold = new Date(new Date().getTime() - config.mongo.unhealthySeconds * 1000);
  return !member.health && !!member.lastHeartbeatRecv && member.lastHeartbeatRecv < unhealthyThreshold;
};

export { init, workloop };
