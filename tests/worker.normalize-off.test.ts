import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReplSetStatusMember } from "../src/types.js";

import type { V1Pod } from "@kubernetes/client-node";
import type { Db } from "mongodb";

const NAMESPACE = "test-ns";
const SERVICE = "db";
const PORT = 27017;
const UNHEALTHY_MS = 15 * 1000;

// config.js reads the environment once at import time, so the kill switch can't be flipped per test
// through the environment. Replacing the module is the only way to exercise the off position - and
// utils.js reads the same module, so the FQDNs it builds stay consistent with the values here.
vi.mock("../src/config.js", () => ({
  config: {
    kube: {
      clusterDomain: "cluster.local",
      clusterSkipTLSVerify: false,
      labelSelector: "app=solidatus-db",
      mongoServiceName: SERVICE,
      namespace: NAMESPACE,
      normalizeMemberHosts: false,
    },
    mongo: {
      isConfigSvr: false,
      loopSleepSeconds: 5,
      port: PORT,
      startupGraceSeconds: 300,
      unhealthySeconds: UNHEALTHY_MS / 1000,
    },
  },
}));

vi.mock("../src/k8s.js", () => ({ getMongoPods: vi.fn() }));
vi.mock("../src/mongo.js", () => ({
  addNewReplSetMembers: vi.fn(),
  getDb: vi.fn(),
  initReplSet: vi.fn(),
  isInReplSet: vi.fn(),
  pruneDbCache: vi.fn(),
  renameReplSetMember: vi.fn(),
  replSetGetStatus: vi.fn(),
}));

const LOCAL_IP = "10.0.0.1";
vi.mock("../src/utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils.js")>()),
  getLocalIp: () => LOCAL_IP,
}));

const { addNewReplSetMembers, renameReplSetMember } = await import("../src/mongo.js");
const { init, newUnhealthyTracker, primaryWork } = await import("../src/worker.js");

type UnhealthyTracker = ReturnType<typeof newUnhealthyTracker>;

const fqdn = (hostname: string): string => `${hostname}.${SERVICE}.${NAMESPACE}.svc.cluster.local:${PORT}`;

const pod = (name: string, podIP: string): V1Pod =>
  ({ metadata: { name }, spec: {}, status: { phase: "Running", podIP } }) as V1Pod;

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

describe("primaryWork with KUBE_NORMALIZE_MEMBER_HOSTS off", () => {
  const db = {} as Db;
  const self = pod("db-0", "10.0.0.1");
  const other = pod("db-1", "10.0.0.2");
  const selfMember = member(fqdn("db-0"), { self: true });

  let tracker: UnhealthyTracker;

  beforeEach(() => {
    tracker = newUnhealthyTracker();
    vi.mocked(addNewReplSetMembers).mockClear();
    vi.mocked(renameReplSetMember).mockClear();
  });

  it("leaves a member addressed by IP alone", async () => {
    await primaryWork(db, [self, other], [selfMember, member(`10.0.0.2:${PORT}`)], false, tracker);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });

  it("leaves a member addressed by short service name alone", async () => {
    await primaryWork(db, [self, other], [selfMember, member(`db-1.db:${PORT}`)], false, tracker);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });

  it("leaves our own member alone even when its host name names no pod", async () => {
    await primaryWork(db, [self], [member(`db:${PORT}`, { self: true })], false, tracker);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).not.toHaveBeenCalled();
  });

  it("adds a new pod in the same cycle as a misnamed member, which normalization would have deferred", async () => {
    const third = pod("db-2", "10.0.0.3");

    await primaryWork(db, [self, other, third], [selfMember, member(`10.0.0.2:${PORT}`)], false, tracker);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).toHaveBeenCalledWith(db, [fqdn("db-2")], [], false);
  });

  it("still reaps a dead member", async () => {
    const dead = member(`10.0.0.2:${PORT}`, {
      health: 0,
      lastHeartbeatRecv: new Date(Date.now() - UNHEALTHY_MS - 1000),
    });

    await primaryWork(db, [self, other], [selfMember, dead], false, tracker);

    expect(renameReplSetMember).not.toHaveBeenCalled();
    expect(addNewReplSetMembers).toHaveBeenCalledWith(db, [], [`10.0.0.2:${PORT}`], false);
  });
});
