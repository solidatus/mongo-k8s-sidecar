import { MongoServerError } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReplSetConfig, ReplSetConfigMember, ReplSetStatusMember } from "../src/types.js";

import type { V1Pod } from "@kubernetes/client-node";
import type { Db } from "mongodb";
import type { MockInstance } from "vitest";

// k8s.js builds a KubeConfig at import time, which needs a real kubeconfig on disk. mongo.js opens
// no connection at import, but worker.js only ever calls into it from the paths we aren't testing.
vi.mock("../src/k8s.js", () => ({ getMongoPods: vi.fn() }));
vi.mock("../src/mongo.js", () => ({
  addNewReplSetMembers: vi.fn(),
  getDb: vi.fn(),
  initReplSet: vi.fn(),
  isInReplSet: vi.fn(),
  pruneDbCache: vi.fn(),
  renameReplSetMember: vi.fn(),
  replSetGetConfig: vi.fn(),
  replSetGetStatus: vi.fn(),
}));

// Pin the address init() picks up so 'self' resolution is deterministic
const LOCAL_IP = "10.0.0.1";
vi.mock("../src/utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils.js")>()),
  getLocalIp: () => LOCAL_IP,
}));

const { getMongoPods } = await import("../src/k8s.js");
const {
  addNewReplSetMembers,
  getDb,
  initReplSet,
  isInReplSet,
  renameReplSetMember,
  replSetGetConfig,
  replSetGetStatus,
} = await import("../src/mongo.js");
const {
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
} = await import("../src/worker.js");

type ForceGate = ReturnType<typeof newForceGate>;
type UnhealthyTracker = ReturnType<typeof newUnhealthyTracker>;

// Matches vitest.config.mts, which is what config.js loaded
const NAMESPACE = "test-ns";
const SERVICE = "db";
const PORT = 27017;
const UNHEALTHY_MS = 15 * 1000;
const STARTUP_GRACE_MS = 300 * 1000;
const FORCE_GRACE_MS = 30 * 1000;

const fqdn = (hostname: string, service: string = SERVICE, namespace: string = NAMESPACE): string =>
  `${hostname}.${service}.${namespace}.svc.cluster.local:${PORT}`;

const pod = (name: string, podIP: string, phase: string = "Running", hostname?: string): V1Pod =>
  ({
    metadata: { name },
    spec: hostname ? { hostname } : {},
    status: { phase, podIP },
  }) as V1Pod;

const member = (name: string, overrides: Partial<ReplSetStatusMember> = {}): ReplSetStatusMember => ({
  _id: 0,
  health: 1,
  name,
  self: false,
  state: 2,
  stateStr: "SECONDARY",
  ...overrides,
});

init();

describe("isSameMemberAsPod", () => {
  const db0 = pod("db-0", "10.0.0.1");

  it("matches the pod FQDN", () => {
    expect(isSameMemberAsPod(fqdn("db-0"), db0)).toBe(true);
  });

  it("matches the pod IP and port", () => {
    expect(isSameMemberAsPod(`10.0.0.1:${PORT}`, db0)).toBe(true);
  });

  it("matches the service-scoped short name, which carries no namespace", () => {
    expect(isSameMemberAsPod(`db-0.db:${PORT}`, db0)).toBe(true);
  });

  it("matches a bare pod name", () => {
    expect(isSameMemberAsPod(`db-0:${PORT}`, db0)).toBe(true);
  });

  it("prefers spec.hostname over metadata.name", () => {
    const renamed = pod("db-0", "10.0.0.1", "Running", "mongo-0");
    expect(isSameMemberAsPod(`mongo-0:${PORT}`, renamed)).toBe(true);
    expect(isSameMemberAsPod(`db-0:${PORT}`, renamed)).toBe(false);
  });

  it("rejects a different hostname", () => {
    expect(isSameMemberAsPod(fqdn("db-1"), db0)).toBe(false);
  });

  it("rejects the same pod name in another namespace", () => {
    expect(isSameMemberAsPod(fqdn("db-0", SERVICE, "other-ns"), db0)).toBe(false);
  });

  it("rejects the same pod name behind another service", () => {
    expect(isSameMemberAsPod(fqdn("db-0", "other-svc"), db0)).toBe(false);
  });

  it("rejects a different port", () => {
    expect(isSameMemberAsPod(`db-0.db.${NAMESPACE}.svc.cluster.local:27018`, db0)).toBe(false);
  });

  it("rejects a host with no port at all", () => {
    expect(isSameMemberAsPod("db-0", db0)).toBe(false);
  });

  it("rejects a pod with no hostname to compare against", () => {
    const nameless = { spec: {}, status: { phase: "Running" } } as V1Pod;
    expect(isSameMemberAsPod(`db-0:${PORT}`, nameless)).toBe(false);
  });
});

describe("memberToRename", () => {
  const self = pod("db-0", "10.0.0.1");
  const other = pod("db-1", "10.0.0.2");

  it("returns nothing when every member already uses its pod FQDN", () => {
    const members = [member(fqdn("db-0"), { self: true }), member(fqdn("db-1"))];
    expect(memberToRename([self, other], members)).toBeUndefined();
  });

  it("renames a member addressed by IP", () => {
    const members = [member(fqdn("db-0"), { self: true }), member(`10.0.0.2:${PORT}`)];
    expect(memberToRename([self, other], members)).toEqual({ from: `10.0.0.2:${PORT}`, to: fqdn("db-1") });
  });

  it("renames a member addressed by short service name", () => {
    const members = [member(fqdn("db-0"), { self: true }), member(`db-1.db:${PORT}`)];
    expect(memberToRename([self, other], members)).toEqual({ from: `db-1.db:${PORT}`, to: fqdn("db-1") });
  });

  it("resolves self by local IP even when the host name is unrecognisable", () => {
    const members = [member(`db:${PORT}`, { self: true })];
    expect(memberToRename([self, other], members)).toEqual({ from: `db:${PORT}`, to: fqdn("db-0") });
  });

  it("skips a rename whose target FQDN is already held by another member", () => {
    const members = [member(fqdn("db-0"), { self: true }), member(`10.0.0.2:${PORT}`), member(fqdn("db-1"))];
    expect(memberToRename([self, other], members)).toBeUndefined();
  });

  it("ignores pods that aren't Running", () => {
    const pending = pod("db-1", "10.0.0.2", "Pending");
    const members = [member(fqdn("db-0"), { self: true }), member(`10.0.0.2:${PORT}`)];
    expect(memberToRename([self, pending], members)).toBeUndefined();
  });

  it("ignores members with no pod behind them", () => {
    const members = [member(fqdn("db-0"), { self: true }), member(fqdn("db-9"))];
    expect(memberToRename([self], members)).toBeUndefined();
  });

  it("returns only the first rename, so a reconfig never carries two", () => {
    const members = [member(fqdn("db-0"), { self: true }), member(`10.0.0.2:${PORT}`), member(`db-2.db:${PORT}`)];
    const third = pod("db-2", "10.0.0.3");
    expect(memberToRename([self, other, third], members)).toEqual({
      from: `10.0.0.2:${PORT}`,
      to: fqdn("db-1"),
    });
  });
});

describe("addrToAddLoop", () => {
  const self = pod("db-0", "10.0.0.1");
  const other = pod("db-1", "10.0.0.2");

  it("adds a pod that is not a member", () => {
    expect(addrToAddLoop([self, other], [member(fqdn("db-0"), { self: true })], true)).toEqual([fqdn("db-1")]);
  });

  it("adds nothing when every pod is already a member", () => {
    expect(addrToAddLoop([self, other], [member(fqdn("db-0"), { self: true }), member(fqdn("db-1"))], true)).toEqual(
      [],
    );
  });

  it("recognises members addressed by IP or short name", () => {
    const members = [member(`10.0.0.1:${PORT}`, { self: true }), member(`db-1.db:${PORT}`)];
    expect(addrToAddLoop([self, other], members, true)).toEqual([]);
  });

  it("never re-adds ourselves when the members list is non-empty, whatever host name we're under", () => {
    // Our own mongod answered replSetGetStatus, so it is a member under some name we can't parse
    expect(addrToAddLoop([self], [member(`db:${PORT}`, { self: true })], true)).toEqual([]);
  });

  it("adds ourselves when the members list is empty, which is the forced reinit path", () => {
    expect(addrToAddLoop([self, other], [], true)).toEqual([fqdn("db-0"), fqdn("db-1")]);
  });

  it("adds ourselves to a non-empty list our own name is missing from when membership isn't assumed", () => {
    // The config-doc caller can't take its own membership on trust: a config that doesn't contain us
    // is one of the things error 93 means, and then we are the member nobody else will add
    expect(addrToAddLoop([self, other], [{ name: fqdn("db-1") }], false)).toEqual([fqdn("db-0")]);
  });

  it("still recognises our own name when membership isn't assumed", () => {
    expect(addrToAddLoop([self], [{ name: fqdn("db-0") }], false)).toEqual([]);
    expect(addrToAddLoop([self], [{ name: `10.0.0.1:${PORT}` }], false)).toEqual([]);
  });

  it("skips pods that aren't Running", () => {
    expect(addrToAddLoop([self, pod("db-1", "10.0.0.2", "Pending")], [], true)).toEqual([fqdn("db-0")]);
  });

  it("falls back to the pod IP when there is no hostname to build an FQDN from", () => {
    const nameless = { spec: {}, status: { phase: "Running", podIP: "10.0.0.2" } } as V1Pod;
    expect(addrToAddLoop([nameless], [], true)).toEqual([`10.0.0.2:${PORT}`]);
  });

  it("skips a pod with neither hostname nor IP", () => {
    const empty = { spec: {}, status: { phase: "Running" } } as V1Pod;
    expect(addrToAddLoop([empty], [], true)).toEqual([]);
  });
});

describe("addrToRemoveLoop", () => {
  let tracker: UnhealthyTracker;

  beforeEach(() => {
    tracker = newUnhealthyTracker();
    vi.useRealTimers();
  });

  it("keeps healthy members", () => {
    expect(addrToRemoveLoop([member(fqdn("db-0"), { health: 1 })], tracker)).toEqual([]);
  });

  it("removes an unhealthy member whose last heartbeat is older than the threshold", () => {
    const stale = member(fqdn("db-0"), {
      health: 0,
      lastHeartbeatRecv: new Date(Date.now() - UNHEALTHY_MS - 1000),
    });
    expect(addrToRemoveLoop([stale], tracker)).toEqual([fqdn("db-0")]);
  });

  it("keeps an unhealthy member whose last heartbeat is recent", () => {
    const recent = member(fqdn("db-0"), { health: 0, lastHeartbeatRecv: new Date(Date.now() - 1000) });
    expect(addrToRemoveLoop([recent], tracker)).toEqual([]);
  });

  it("gives a member that has never heartbeat the startup grace from first sighting", () => {
    vi.useFakeTimers();
    // The epoch is what mongod reports before the first heartbeat back - arbitrarily old, but the
    // member may simply still be starting up
    const starting = member(fqdn("db-0"), { health: 0, lastHeartbeatRecv: new Date(0) });

    expect(addrToRemoveLoop([starting], tracker)).toEqual([]);

    // Well past unhealthySeconds: a mongod loading a large dataset is still Running, so removing it
    // here only gets it re-added and the grace restarted, forever
    vi.advanceTimersByTime(UNHEALTHY_MS + 1000);
    expect(addrToRemoveLoop([starting], tracker)).toEqual([]);

    vi.advanceTimersByTime(STARTUP_GRACE_MS - UNHEALTHY_MS - 1000);
    expect(addrToRemoveLoop([starting], tracker)).toEqual([]);

    vi.advanceTimersByTime(2000);
    expect(addrToRemoveLoop([starting], tracker)).toEqual([fqdn("db-0")]);
  });

  it("treats a missing lastHeartbeatRecv the same as the epoch", () => {
    vi.useFakeTimers();
    const starting = member(fqdn("db-0"), { health: 0 });

    expect(addrToRemoveLoop([starting], tracker)).toEqual([]);

    vi.advanceTimersByTime(STARTUP_GRACE_MS + 1000);
    expect(addrToRemoveLoop([starting], tracker)).toEqual([fqdn("db-0")]);
  });

  it("restarts the grace period once a member recovers", () => {
    vi.useFakeTimers();
    const name = fqdn("db-0");

    addrToRemoveLoop([member(name, { health: 0, lastHeartbeatRecv: new Date(0) })], tracker);
    vi.advanceTimersByTime(UNHEALTHY_MS - 1000);

    // A healthy sighting clears the entry, so the clock starts again from here
    addrToRemoveLoop([member(name, { health: 1 })], tracker);
    expect(tracker.has(name)).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(addrToRemoveLoop([member(name, { health: 0, lastHeartbeatRecv: new Date(0) })], tracker)).toEqual([]);
  });

  it("forgets a member that leaves the set, so a re-added one starts fresh", () => {
    vi.useFakeTimers();
    const name = fqdn("db-0");

    addrToRemoveLoop([member(name, { health: 0, lastHeartbeatRecv: new Date(0) })], tracker);
    vi.advanceTimersByTime(UNHEALTHY_MS - 1000);

    // Member gone from the set entirely - its tracking entry must go with it
    addrToRemoveLoop([], tracker);
    expect(tracker.has(name)).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(addrToRemoveLoop([member(name, { health: 0, lastHeartbeatRecv: new Date(0) })], tracker)).toEqual([]);
  });

  it("does not reap a starting member on the cadence of a remove/re-add cycle", () => {
    vi.useFakeTimers();
    const name = fqdn("db-0");
    const starting = () => member(name, { health: 0, lastHeartbeatRecv: new Date(0) });

    // Whatever a removal does to the tracker, the member must survive several unhealthySeconds
    // worth of loops - otherwise it is removed and re-added on every cycle and never converges
    for (let i = 0; i < 5; i++) {
      expect(addrToRemoveLoop([starting()], tracker)).toEqual([]);
      vi.advanceTimersByTime(UNHEALTHY_MS);
    }
  });

  it("removes several unhealthy members at once", () => {
    const stale = (name: string) =>
      member(name, { health: 0, lastHeartbeatRecv: new Date(Date.now() - UNHEALTHY_MS - 1000) });
    expect(addrToRemoveLoop([stale(fqdn("db-0")), member(fqdn("db-1")), stale(fqdn("db-2"))], tracker)).toEqual([
      fqdn("db-0"),
      fqdn("db-2"),
    ]);
  });

  it("returns nothing for an empty members list", () => {
    expect(addrToRemoveLoop([], tracker)).toEqual([]);
  });

  it("tracks only members that have never heartbeat", () => {
    const withHeartbeat = member(fqdn("db-0"), { health: 0, lastHeartbeatRecv: new Date(Date.now() - 1000) });
    const never = member(fqdn("db-1"), { health: 0, lastHeartbeatRecv: new Date(0) });

    addrToRemoveLoop([withHeartbeat, never, member(fqdn("db-2"))], tracker);

    // A real heartbeat time is its own clock, so only db-1 needs an entry
    expect([...tracker.keys()]).toEqual([fqdn("db-1")]);
  });
});

describe("primaryWork", () => {
  const db = {} as Db;
  const self = pod("db-0", "10.0.0.1");
  const other = pod("db-1", "10.0.0.2");
  const selfMember = member(fqdn("db-0"), { self: true });
  const dead = (name: string) =>
    member(name, { health: 0, lastHeartbeatRecv: new Date(Date.now() - UNHEALTHY_MS - 1000) });

  let tracker: UnhealthyTracker;

  beforeEach(() => {
    tracker = newUnhealthyTracker();
    vi.mocked(addNewReplSetMembers).mockClear();
    vi.mocked(renameReplSetMember).mockClear();
  });

  it("reaps a dead member before renaming anything", async () => {
    // db-1 is both misnamed and dead. A reconfig needs a majority reachable, so renaming first
    // would fail forever and the early return would stop us ever reaping it
    await primaryWork(db, [self, other], [selfMember, dead(`10.0.0.2:${PORT}`)], false, tracker);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).toHaveBeenCalledWith(db, [], [`10.0.0.2:${PORT}`], false);
  });

  it("renames once nothing needs reaping, and does not touch membership in the same reconfig", async () => {
    await primaryWork(db, [self, other], [selfMember, member(`10.0.0.2:${PORT}`)], false, tracker);

    expect(renameReplSetMember).toHaveBeenCalledWith(db, `10.0.0.2:${PORT}`, fqdn("db-1"), false);
    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });

  it("forces the rename reconfig when we're a secondary doing primary work", async () => {
    // Non-forced reconfig on a secondary is rejected by mongod, which would throw before add/remove
    await primaryWork(db, [self, other], [selfMember, member(`10.0.0.2:${PORT}`)], true, tracker);

    expect(renameReplSetMember).toHaveBeenCalledWith(db, `10.0.0.2:${PORT}`, fqdn("db-1"), true);
  });

  it("adds new pods once every member name has converged", async () => {
    const third = pod("db-2", "10.0.0.3");

    await primaryWork(db, [self, other, third], [selfMember, member(fqdn("db-1"))], false, tracker);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).toHaveBeenCalledWith(db, [fqdn("db-2")], [], false);
  });

  it("reconfigs nothing when the set already matches the pods", async () => {
    await primaryWork(db, [self, other], [selfMember, member(fqdn("db-1"))], false, tracker);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });
});

describe("inReplicaSet", () => {
  const db = {} as Db;
  const self = pod("db-0", "10.0.0.1");
  const other = pod("db-1", "10.0.0.2");
  const third = pod("db-2", "10.0.0.3");
  const primary = (name: string, overrides: Partial<ReplSetStatusMember> = {}) =>
    member(name, { state: 1, stateStr: "PRIMARY", ...overrides });

  // No tracker argument here: inReplicaSet owns the module-level one, which these cases never write
  // to - every member they pass is healthy. The force gate is passed in, since these cases do write
  // to it and a forced reconfig withheld by another test's leftover clock would look like a pass.
  let gate: ForceGate;

  beforeEach(() => {
    vi.mocked(addNewReplSetMembers).mockClear();
    vi.mocked(renameReplSetMember).mockClear();
    gate = newForceGate();
    vi.useRealTimers();
  });

  // Elapsed time is the only fence a forced reconfig has, so anything that has to force walks the
  // clock forward the way the work loop would
  const runLoops = async (pods: V1Pod[], members: ReplSetStatusMember[], loops: number) => {
    for (let i = 0; i < loops; i++) {
      if (i > 0) {
        vi.advanceTimersByTime(FORCE_GRACE_MS + 1000);
      }
      await inReplicaSet(db, pods, { members, set: "rs0" }, gate);
    }
  };

  it("does nothing when removed from the set, where mongod reports no members at all", async () => {
    // Only a single pod is running, so this one would otherwise win the election and do primary work
    await inReplicaSet(db, [self], { myState: 10, set: "rs0" });

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });

  // The removed-set case above passes trivially if nothing ever reconfigs, so pin the cases that
  // must reconfig alongside it
  it("does primary work unforced when we are the primary", async () => {
    const members = [primary(fqdn("db-0"), { self: true }), member(fqdn("db-1"))];

    await inReplicaSet(db, [self, other, third], { members, set: "rs0" }, gate);

    expect(addNewReplSetMembers).toHaveBeenCalledWith(db, [fqdn("db-2")], [], false);
  });

  it("does nothing when another member is the primary", async () => {
    const members = [member(fqdn("db-0"), { self: true }), primary(fqdn("db-1"))];

    await inReplicaSet(db, [self, other, third], { members, set: "rs0" }, gate);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });

  it("forces primary work once no primary has persisted for the force grace", async () => {
    vi.useFakeTimers();
    const members = [member(fqdn("db-0"), { self: true }), member(fqdn("db-1"))];

    // A forced reconfig has no version check behind it, so the first sighting of no primary buys
    // nothing but the start of a clock - an ordinary election is still in progress at this point
    await runLoops([self, other, third], members, 1);
    expect(addNewReplSetMembers).not.toHaveBeenCalled();

    await runLoops([self, other, third], members, 2);
    expect(addNewReplSetMembers).toHaveBeenCalledExactlyOnceWith(db, [fqdn("db-2")], [], true);
  });

  it("does not force again until the last forced reconfig has had time to take effect", async () => {
    vi.useFakeTimers();
    const members = [member(fqdn("db-0"), { self: true }), member(fqdn("db-1"))];

    await runLoops([self, other, third], members, 2);
    expect(addNewReplSetMembers).toHaveBeenCalledTimes(1);

    // mongod has to elect on the config we just wrote before another observation means anything, and
    // a second force in that window is built off a config that may not have landed
    vi.advanceTimersByTime(FORCE_GRACE_MS - 1000);
    await inReplicaSet(db, [self, other, third], { members, set: "rs0" }, gate);
    expect(addNewReplSetMembers).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    await inReplicaSet(db, [self, other, third], { members, set: "rs0" }, gate);
    expect(addNewReplSetMembers).toHaveBeenCalledTimes(2);
  });

  it("restarts the force grace once the set has elected a primary of its own", async () => {
    vi.useFakeTimers();
    const noPrimary = [member(fqdn("db-0"), { self: true }), member(fqdn("db-1"))];
    const withPrimary = [primary(fqdn("db-0"), { self: true }), member(fqdn("db-1"))];

    // Nearly through the grace, then the set sorts itself out - the next spell without a primary is a
    // new one and has to wait all over again, or a flapping primary adds up to a forced reconfig
    await inReplicaSet(db, [self, other, third], { members: noPrimary, set: "rs0" }, gate);
    vi.advanceTimersByTime(FORCE_GRACE_MS - 1000);
    await inReplicaSet(db, [self, other, third], { members: withPrimary, set: "rs0" }, gate);
    vi.mocked(addNewReplSetMembers).mockClear();

    vi.advanceTimersByTime(2000);
    await inReplicaSet(db, [self, other, third], { members: noPrimary, set: "rs0" }, gate);

    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });

  it("does nothing when there is no primary and another pod wins the election", async () => {
    vi.useFakeTimers();
    const lowest = pod("db-9", "10.0.0.0");
    const members = [member(fqdn("db-0"), { self: true }), member(fqdn("db-1"))];

    await runLoops([self, other, lowest], members, 3);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });
});

// Error 93 (InvalidReplicaSetConfig) is the one path that can't read the set through
// replSetGetStatus, so it works off the local config doc instead - a different member shape, a
// different notion of what this pod's own membership can be assumed to be, and a forced reconfig on a
// live set if it gets either wrong.
describe("workloop on an invalid replica set config", () => {
  const db = {} as Db;
  const self = pod("db-0", "10.0.0.1");
  const other = pod("db-1", "10.0.0.2");

  const configMember = (host: string, _id: number = 0): ReplSetConfigMember => ({ _id, host });
  const rsConfig = (...members: ReplSetConfigMember[]): ReplSetConfig => ({
    _id: "rs0",
    configsvr: false,
    members,
    version: 1,
  });

  const invalidConfig = () => {
    const err = new MongoServerError({ codeName: "InvalidReplicaSetConfig", message: "invalid" });
    err.code = 93;
    return err;
  };

  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.mocked(addNewReplSetMembers).mockClear();
    vi.mocked(replSetGetConfig).mockClear();
    vi.mocked(getDb).mockResolvedValue(db);
    vi.mocked(replSetGetStatus).mockRejectedValue(invalidConfig());
    // workloop swallows everything it throws, so an assertion that some reconfig didn't happen would
    // pass just as happily on a TypeError. Fail the test on the log line that swallowing writes.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // workloop owns the module-level gate, so unlike inReplicaSet these cases can't be handed a fresh
    // one - and a clock left running by an earlier test would let the first loop force a reconfig
    vi.useFakeTimers();
    clearForceGate(forceReconfigGate);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.useRealTimers();
  });

  // Two loops with the force grace between them: error 93 is fixed by a forced reconfig, and the
  // first sighting of it only starts that clock
  const runLoop = async (pods: V1Pod[], config: ReplSetConfig) => {
    vi.mocked(getMongoPods).mockResolvedValue(pods);
    vi.mocked(replSetGetConfig).mockResolvedValue(config);

    await workloop();
    expect(addNewReplSetMembers).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FORCE_GRACE_MS + 1000);
    await workloop();

    expect(consoleError).not.toHaveBeenCalled();
  };

  it("adds the pods the config is missing, forced, and against the config's own host names", async () => {
    // Config addresses db-1 by IP: compared against the FQDN we would generate that looks like a
    // non-member, and adding it duplicates the mongod under a second name
    await runLoop([self, other], rsConfig(configMember(fqdn("db-0")), configMember(`10.0.0.2:${PORT}`, 1)));

    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });

  it("adds this pod when the config it holds does not contain it", async () => {
    // The other meaning of error 93. Nobody else is going to add us: the pods in that config can't
    // see a member that isn't there, and this pod won the election to fix it
    await runLoop([self, other], rsConfig(configMember(fqdn("db-1"))));

    expect(addNewReplSetMembers).toHaveBeenCalledWith(db, [fqdn("db-0")], [], true);
  });

  it("adds a pod missing from the config alongside ourselves", async () => {
    const third = pod("db-2", "10.0.0.3");

    await runLoop([self, other, third], rsConfig(configMember(fqdn("db-1"))));

    expect(addNewReplSetMembers).toHaveBeenCalledWith(db, [fqdn("db-0"), fqdn("db-2")], [], true);
  });

  it("does not reconfigure when every running pod is already in the config", async () => {
    // A forced reconfig of an unchanged config doesn't clear error 93, it only bumps the version -
    // and the work loop would do it again every few seconds forever
    await runLoop([self, other], rsConfig(configMember(fqdn("db-0")), configMember(fqdn("db-1"), 1)));

    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });

  it("does nothing at all when another pod wins the election", async () => {
    const lowest = pod("db-9", "10.0.0.0");

    await runLoop([self, lowest], rsConfig(configMember(fqdn("db-9"))));

    expect(replSetGetConfig).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });
});

// The bootstrap path is the one place an address is taken from the pod list rather than from the
// replica set, so it is the one that can pick the wrong pod if it reads the list in the wrong order.
describe("workloop on a replica set that does not exist yet", () => {
  const db = {} as Db;
  const self = pod("db-0", "10.0.0.1");
  const higher = pod("db-1", "10.0.0.2");

  const notYetInitialized = () => {
    const err = new MongoServerError({ codeName: "NotYetInitialized", message: "no replset config" });
    err.code = 94;
    return err;
  };

  beforeEach(() => {
    vi.mocked(initReplSet).mockClear();
    vi.mocked(getDb).mockResolvedValue(db);
    vi.mocked(replSetGetStatus).mockRejectedValue(notYetInitialized());
    vi.mocked(isInReplSet).mockResolvedValue(false);
  });

  it("seeds the set with the elected pod's own address, whatever order the pod list arrives in", async () => {
    // This pod holds the lowest IP and so wins, but the API listed it last
    vi.mocked(getMongoPods).mockResolvedValue([higher, self]);

    await workloop();

    expect(initReplSet).toHaveBeenCalledWith(db, fqdn("db-0"));
  });

  it("does not initiate a set when a peer is already in one", async () => {
    vi.mocked(getMongoPods).mockResolvedValue([self, higher]);
    vi.mocked(isInReplSet).mockResolvedValue(true);

    await workloop();

    expect(initReplSet).not.toHaveBeenCalled();
  });

  it("does not initiate a set when another pod wins the election", async () => {
    vi.mocked(getMongoPods).mockResolvedValue([self, pod("db-9", "10.0.0.0")]);

    await workloop();

    expect(initReplSet).not.toHaveBeenCalled();
  });
});

describe("member host convergence", () => {
  const pods = [pod("db-0", "10.0.0.1"), pod("db-1", "10.0.0.2"), pod("db-2", "10.0.0.3")];

  // Drive memberToRename the way the work loop does - one rename per cycle, applied before the next
  // call - and assert it runs out of work. Single-cycle tests can't see the two failures that would
  // actually cost us a cluster: a rename that keeps re-proposing itself, and a pair that swap names
  // back and forth forever, both of which reconfig the live set on every pass.
  const converge = (members: ReplSetStatusMember[], maxCycles: number = 20) => {
    let current = members;
    const applied: { from: string; to: string }[] = [];

    for (let i = 0; i < maxCycles; i++) {
      const rename = memberToRename(pods, current);
      if (!rename) {
        return { applied, members: current };
      }

      applied.push(rename);
      current = current.map((m) => (m.name === rename.from ? { ...m, name: rename.to } : m));
    }

    throw new Error(`Did not converge in ${maxCycles} cycles: ${JSON.stringify(applied)}`);
  };

  it("converges a set addressed entirely by pod IP, one rename per member", () => {
    const members = [
      member(`10.0.0.1:${PORT}`, { self: true }),
      member(`10.0.0.2:${PORT}`),
      member(`10.0.0.3:${PORT}`),
    ];

    const { applied, members: result } = converge(members);

    expect(applied).toHaveLength(3);
    expect(result.map((m) => m.name)).toEqual([fqdn("db-0"), fqdn("db-1"), fqdn("db-2")]);
  });

  it("converges a set of mixed spellings", () => {
    const members = [
      member(`db:${PORT}`, { self: true }), // names no pod at all - only 'self' ties it to one
      member(`db-1.db:${PORT}`),
      member(fqdn("db-2")),
    ];

    const { applied, members: result } = converge(members);

    expect(applied).toHaveLength(2);
    expect(result.map((m) => m.name)).toEqual([fqdn("db-0"), fqdn("db-1"), fqdn("db-2")]);
  });

  it("proposes nothing further once every member holds its pod FQDN", () => {
    const members = [member(fqdn("db-0"), { self: true }), member(fqdn("db-1")), member(fqdn("db-2"))];

    expect(converge(members).applied).toEqual([]);
  });

  it("leaves a member no pod backs alone rather than cycling on it", () => {
    const members = [member(fqdn("db-0"), { self: true }), member(`10.0.0.2:${PORT}`), member(fqdn("db-9"))];

    const { applied, members: result } = converge(members);

    expect(applied).toEqual([{ from: `10.0.0.2:${PORT}`, to: fqdn("db-1") }]);
    expect(result.map((m) => m.name)).toContain(fqdn("db-9"));
  });

  it("stops rather than collapsing a duplicate pair onto one host", () => {
    // db-1 is in the set twice, under its IP and its FQDN. Renaming the IP entry would write a
    // config with two members on one host, which mongod rejects - the remove loop reaps it instead.
    const members = [member(fqdn("db-0"), { self: true }), member(`10.0.0.2:${PORT}`), member(fqdn("db-1"))];

    expect(converge(members).applied).toEqual([]);
  });

  it("never renames a member onto a name another member is about to vacate", () => {
    // Both entries are misnamed and both would resolve onto FQDNs currently free. If the second
    // rename targeted the name the first just left, the two would trade places on every cycle.
    const members = [member(`10.0.0.2:${PORT}`, { _id: 1 }), member(`db-2.db:${PORT}`, { _id: 2 })];

    const { applied } = converge(members);

    const vacated = new Set(applied.map((r) => r.from));
    expect(applied.filter((r) => vacated.has(r.to))).toEqual([]);
  });
});
