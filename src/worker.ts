import { Db, MongoServerError } from "mongodb";

import { config } from "./config.js";
import { getMongoPods } from "./k8s.js";
import { log } from "./log.js";
import {
  addNewReplSetMembers,
  getDb,
  initReplSet,
  isInReplSet,
  pruneDbCache,
  renameReplSetMember,
  replSetGetConfig,
  replSetGetStatus,
} from "./mongo.js";
import { ReplSetStatus, ReplSetStatusMember } from "./types.js";
import { getLocalIp, getPodFqdn, getPodHostname, getPodIp } from "./utils.js";

import type { V1Pod } from "@kubernetes/client-node";

let hostIp: string | undefined;
let hostIpAndPort: string | undefined;

const init = (): void => {
  hostIp = getLocalIp();
  if (!hostIp) {
    throw new Error("could not find local ip");
  }

  hostIpAndPort = `${hostIp}:${config.mongo.port}`;
};

// The one place a pod is turned into the host its probe connects to, so the connection cache and the
// prune that empties it can never disagree about how a pod is spelled.
const probeHost = (pod: V1Pod): string => pod.status?.podIP ?? "";

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

    // Peer connections are cached and pods never come back on the same IP, so drop the ones no
    // running pod answers on. Uses probeHost, the address the probes are actually keyed by.
    await pruneDbCache(runningPods.map(probeHost));

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

const inReplicaSet = async (db: Db, pods: V1Pod[], status: ReplSetStatus, gate: ForceGate = forceReconfigGate) => {
  // If we're already in a rs and we ARE the primary, do the work of the primary instance (i.e. adding others)
  // If we're already in a rs and we ARE NOT the primary, just continue, nothing to do
  // If we're already in a rs and NO ONE is a primary, elect someone to do the work for a primary
  //
  // No members list means this mongod has been removed from the set (state REMOVED): it holds a
  // config it isn't in, so it has no view of the set to act on and no standing to reconfig it.
  // Nothing to do but wait - the set's own primary sees this pod missing and adds it back.
  const members = status.members;
  if (!members) {
    log.warn("Pod is not a member of the replica set it is configured for, waiting to be re-added", {
      myState: status.myState,
      set: status.set,
    });
    return;
  }

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
  if (primaryExists) {
    // With a primary in the set every reconfig carries mongod's own version check, so whatever made
    // a forced one look necessary is over
    clearForceGate(gate);
    return;
  }

  if (!podElection(pods)) {
    return;
  }

  const now = new Date().getTime();
  if (!forceReconfigAllowed(gate, now)) {
    return;
  }

  log.info("Pod has been elected as secondary to do primary work");
  markForced(gate, now);
  await primaryWork(db, pods, members, true);
};

const primaryWork = async (
  db: Db,
  pods: V1Pod[],
  members: ReplSetStatusMember[],
  force: boolean,
  tracker: UnhealthyTracker = unhealthyTracker,
): Promise<void> => {
  const addrDead = addrToRemoveLoop(members, tracker);

  // A member host has to name one specific mongod and resolve from outside this namespace, so the
  // pod FQDN is the only correct form. Converge on it before adding anything, one member per loop,
  // so a rename never shares a reconfig with an add or a remove.
  //
  // Reaping comes first though: a reconfig needs a majority of voting members reachable, so a dead
  // member can block the rename indefinitely - and the early return below would then stop us ever
  // reaping it. The two would wedge each other, in exactly the situation we most need to recover.
  if (addrDead.length === 0 && config.kube.normalizeMemberHosts) {
    const rename = memberToRename(pods, members);
    if (rename) {
      // Same force as the membership reconfig below: without a primary this pod is a secondary, and
      // mongod rejects a non-forced reconfig there - which would throw before add & remove ever run
      if (await renameReplSetMember(db, rename.from, rename.to, force)) {
        return;
      }
    }
  }

  // Loop over all the pods we have and see if any of them aren't in the current rs members array
  // Add them if not
  const addrNew = addrToAddLoop(pods, members, true);

  if (addrNew.length !== 0 || addrDead.length !== 0) {
    log.info("Addresses to add ", addrNew);
    log.info("Addresses to remove ", addrDead);

    await addNewReplSetMembers(db, addrNew, addrDead, force);
  }
};

const notInReplicaSet = async (db: Db, pods: V1Pod[]): Promise<void> => {
  const testRequests = pods
    .filter((p) => p.status?.phase === "Running" && p.status?.podIP)
    .map(async (p) => await isInReplSet(probeHost(p)));

  const results = await Promise.all(testRequests);
  if (results.some((r) => r)) {
    return; // there's a ppd in a replica set
  }

  // The pod the election picked is the seed of the new set, and it is this pod - take the address from
  // the winner itself rather than from wherever the list happens to be ordered
  const elected = electedPod(pods);
  if (elected?.status?.podIP !== hostIp) {
    return;
  }

  log.info("Pod has been elected for replica set init");
  await initReplSet(db, getPodFqdn(elected) || hostIpAndPort!);
};

const invalidReplicaSet = async (db: Db, pods: V1Pod[], gate: ForceGate = forceReconfigGate): Promise<void> => {
  log.info("Invalid replica set");
  if (!podElection(pods)) {
    log.info("Didn't win pod election, returning");
    return;
  }

  log.info("Won pod election, working out what a forced reinit would have to add");

  // replSetGetStatus is what failed here, so we have no member list from it - but the local config
  // doc still reads, and a forced reconfig appends to it rather than replacing it. Compare against
  // those hosts or we re-add every pod under a second name, duplicating each mongod.
  const rsConfig = await replSetGetConfig(db);
  const members = rsConfig.members.map((m) => ({ name: m.host }));

  // Nothing to remove: the addresses we can't tie to a running pod are exactly the ones the remove
  // loop reaps once status answers again, and a reconfig does one thing at a time.
  //
  // Error 93 also covers "this config does not contain us", and then the member list is non-empty
  // but has no entry for this pod - so unlike the status path we can't take our own membership for
  // granted and skip ourselves, or the pod driving the reinit is the one member it never adds.
  const addrToAdd = addrToAddLoop(pods, members, false);

  // A forced reconfig writes the same config back, which is not something error 93 recovers from - it
  // only bumps the version. With nothing to add there is nothing here to fix, and reconfiguring
  // anyway churns the version on every loop forever.
  if (addrToAdd.length === 0) {
    log.warn("Replica set config is invalid but every running pod is already a member, not reconfiguring", {
      members: members.map((m) => m.name),
    });
    return;
  }

  // Error 93 is not a state that clears on its own, but a second sidecar racing this write turns one
  // forced reconfig into a lost update - so the same fence applies here. Checked after the work above,
  // which reconfigures nothing, so a loop with nothing to do doesn't consume the grace.
  const now = new Date().getTime();
  if (!forceReconfigAllowed(gate, now)) {
    return;
  }

  markForced(gate, now);
  await addNewReplSetMembers(db, addrToAdd, [], true);
};

// Sorts a copy: callers read this pod's own membership and the seed address out of the list they
// passed, and an election must not be the thing that decides what order they see it in.
const electedPod = (pods: V1Pod[]): undefined | V1Pod => {
  // String sorting IP addresses doesn't provide a correct sort order but does provide a consistent sort order!
  // And that's all we need to consistently elect the same pod
  return pods.filter((p) => p.status?.podIP).sort((a, b) => a.status!.podIP!.localeCompare(b.status!.podIP!))[0];
};

const podElection = (pods: V1Pod[]): boolean => {
  return electedPod(pods)?.status?.podIP === hostIp;
};

// A pod can already be in the replica set under a spelling we didn't choose: a short service-scoped
// name (pod.svc), a bare pod name, or an IP. Comparing the FQDN we'd generate against those misses
// the match and we add the pod a second time - mongod then sees a member with its own member ID,
// marks it unreachable, and we reap and re-add it on every loop.
const isSameMemberAsPod = (memberName: string, pod: V1Pod): boolean => {
  if (memberName === getPodFqdn(pod) || memberName === getPodIp(pod)) {
    return true;
  }

  const podHostname = getPodHostname(pod);
  if (!podHostname) {
    return false;
  }

  const portSeparator = memberName.lastIndexOf(":");
  if (portSeparator === -1 || memberName.slice(portSeparator + 1) !== String(config.mongo.port)) {
    return false;
  }

  const labels = memberName.slice(0, portSeparator).split(".");
  if (labels[0] !== podHostname) {
    return false;
  }

  // A bare pod name carries nothing else to check. Anything longer names a service, and anything
  // longer still a namespace - both have to agree with ours, otherwise it's a same-named pod behind
  // another service or in another namespace.
  if (labels.length > 1 && labels[1] !== config.kube.mongoServiceName) {
    return false;
  }

  return labels.length < 3 || labels[2] === config.kube.namespace;
};

// Find one member whose host isn't the FQDN of the pod behind it. Two ways to tie a member to a
// pod: mongod flags its own entry with self, whatever host name that entry uses - which is the only
// handle we get on a name like a bare service name - and for the rest we fall back to matching the
// host name against each pod.
const memberToRename = (pods: V1Pod[], members: ReplSetStatusMember[]): undefined | { from: string; to: string } => {
  const runningPods = pods.filter((p) => p.status?.phase === "Running");

  for (const member of members) {
    const pod =
      member.self ?
        runningPods.find((p) => getPodIp(p) === hostIpAndPort)
      : runningPods.find((p) => isSameMemberAsPod(member.name, p));

    const podFqdn = getPodFqdn(pod);
    if (!podFqdn || member.name === podFqdn) {
      continue;
    }

    // Another member already holds the FQDN - a duplicate of this pod under a second name. Leave it
    // to the remove loop to reap, then the rename has somewhere to go.
    if (members.some((m) => m.name === podFqdn)) {
      continue;
    }

    return { from: member.name, to: podFqdn };
  }

  return undefined;
};

// Members here only need a host name, so this takes the common shape of a status member and a config
// member - the forced-reinit path has only the latter.
// selfIsMember says whether this pod can be assumed to already be in the given members list, however
// its entry is spelled. Only replSetGetStatus answering proves that; a config doc read off disk does
// not, so that caller passes false and takes the name matching below for its answer.
const addrToAddLoop = (pods: V1Pod[], members: { name: string }[], selfIsMember: boolean): string[] => {
  const addrs: string[] = [];
  for (const pod of pods) {
    if (pod.status?.phase !== "Running") {
      continue;
    }

    const podIp = getPodIp(pod);
    const podFqdn = getPodFqdn(pod);

    // Our own mongod answered with a non-empty members list, so it is a member under whatever host
    // name that config happens to use - even one we can't recognise, like a bare service name. Adding
    // our own address again would duplicate it.
    // An empty list means there is nothing to be a member of, so we do have to add ourselves.
    if (selfIsMember && members.length > 0 && podIp === hostIpAndPort) {
      continue;
    }

    const podInRs = members.some((m) => isSameMemberAsPod(m.name, pod));

    if (!podInRs) {
      const addr = podFqdn || podIp;
      if (addr) {
        // Name the pod and what we compared against: if the pod is in fact already a member under a
        // host name we failed to recognise, this is the line that shows it
        log.info(`Pod ${pod.metadata?.name} is not a member, adding ${addr}`, {
          existingMembers: members.map((m) => m.name),
        });
        addrs.push(addr);
      } else {
        log.warn(`Could not find address for a pod, skipping`);
      }
    }
  }
  return addrs;
};

// A forced reconfig is the one write we make with no concurrency check: force skips mongod's config
// version and term check, so two sidecars that both decide to do primary work don't get an error out
// of it, they get a lost update - the second config replaces the first and silently drops whatever it
// had added. Every sidecar runs the same election over its own view of the pod list, and those views
// disagree exactly while pods are appearing and going away, which is also when no primary exists.
//
// mongod offers nothing to compare-and-swap against on a forced write, so the fence is time. Two
// clocks, and both of them narrow the window rather than close it:
type ForceGate = {
  // First loop we saw the condition a forced reconfig would fix. An ordinary election takes about ten
  // seconds, and a rolling restart is a handful of loops with no primary - neither wants our help.
  // Waiting the grace out also gives the pod lists time to agree, so the election has one winner.
  forceNeededSince?: number;
  // A forced reconfig we have already written. mongod has to elect on that config before the next
  // observation means anything, and a force built off a config that hasn't landed yet is how one
  // rename per loop becomes a run of forced reconfigs.
  lastForcedAt?: number;
};

const newForceGate = (): ForceGate => ({});

// Spans work loop iterations like the tracker below, and for the same reason takes the gate as an
// argument everywhere so tests can pass a fresh one.
const forceReconfigGate = newForceGate();

const clearForceGate = (gate: ForceGate): void => {
  delete gate.forceNeededSince;
  delete gate.lastForcedAt;
};

const forceReconfigAllowed = (gate: ForceGate, now: number): boolean => {
  const graceMs = config.mongo.forceReconfigGraceSeconds * 1000;

  gate.forceNeededSince ??= now;

  const neededForSeconds = Math.round((now - gate.forceNeededSince) / 1000);
  if (now - gate.forceNeededSince < graceMs) {
    log.info("Withholding forced reconfig, giving the set time to elect a primary of its own", {
      neededForSeconds,
      waitingForSeconds: config.mongo.forceReconfigGraceSeconds,
    });
    return false;
  }

  if (gate.lastForcedAt !== undefined && now - gate.lastForcedAt < graceMs) {
    log.info("Withholding forced reconfig, one was written too recently to have taken effect", {
      writtenSecondsAgo: Math.round((now - gate.lastForcedAt) / 1000),
    });
    return false;
  }

  return true;
};

// Recorded before the reconfig rather than after: a write that throws may still have landed, and
// either way the answer to a failed force is not to force again on the next loop.
const markForced = (gate: ForceGate, now: number): void => {
  gate.lastForcedAt = now;
};

// When mongod has never had a heartbeat back from a member it reports lastHeartbeatRecv as the
// epoch, which is arbitrarily old - so a member that is merely still starting up looks long dead and
// gets removed on the next loop, whatever unhealthySeconds says. For those we time the grace period
// from when we first saw the member unhealthy instead, keyed by member name.
type UnhealthyTracker = Map<string, number>;

const newUnhealthyTracker = (): UnhealthyTracker => new Map();

// The grace period spans workloop iterations, so the tracker has to outlive one. Every function that
// reads or writes it takes it as an argument, so tests can pass a fresh one instead of clearing this.
const unhealthyTracker = newUnhealthyTracker();

const addrToRemoveLoop = (members: ReplSetStatusMember[], tracker: UnhealthyTracker): string[] => {
  const now = new Date().getTime();

  const memberNames = new Set(members.map((m) => m.name));
  for (const name of tracker.keys()) {
    if (!memberNames.has(name)) {
      tracker.delete(name);
    }
  }

  return members.filter((m) => shouldRemoveMember(m, now, tracker)).map((m) => m.name);
};

const shouldRemoveMember = (member: ReplSetStatusMember, now: number, tracker: UnhealthyTracker): boolean => {
  if (member.health) {
    tracker.delete(member.name);
    return false;
  }

  const heartbeatRecv = member.lastHeartbeatRecv?.getTime() ?? 0;

  let unhealthySince: number;
  let graceSeconds: number;
  if (heartbeatRecv > 0) {
    // The member was reachable once, so it really has gone away - unhealthySeconds is the answer
    unhealthySince = heartbeatRecv;
    graceSeconds = config.mongo.unhealthySeconds;
    tracker.delete(member.name);
  } else {
    // Never reachable, which is also what a mongod still loading a large dataset looks like. Its pod
    // is Running, so removing it only gets it re-added on the next loop, and since the tracker entry
    // is pruned when it leaves the set the grace period restarts each time - churn that never
    // converges. Give it a grace long enough to cover startup rather than unhealthySeconds.
    unhealthySince = tracker.get(member.name) ?? now;
    graceSeconds = Math.max(config.mongo.startupGraceSeconds, config.mongo.unhealthySeconds);
    tracker.set(member.name, unhealthySince);
  }

  const remove = now - unhealthySince > graceSeconds * 1000;

  if (remove) {
    // mongod's own account of why it can't reach the member, which is usually the whole story
    log.info(`Removing unhealthy member ${member.name}`, {
      lastHeartbeatMessage: member.lastHeartbeatMessage,
      lastHeartbeatRecv: member.lastHeartbeatRecv,
      state: member.stateStr,
      unhealthyForSeconds: Math.round((now - unhealthySince) / 1000),
    });
  }

  return remove;
};

export {
  addrToAddLoop,
  addrToRemoveLoop,
  clearForceGate,
  forceReconfigGate,
  init,
  inReplicaSet,
  isSameMemberAsPod,
  memberToRename,
  newForceGate,
  newUnhealthyTracker,
  primaryWork,
  workloop,
};

export type { ForceGate, UnhealthyTracker };
