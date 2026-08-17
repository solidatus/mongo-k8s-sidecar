import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  closePeerClients,
  configOf,
  killMongod,
  pod,
  podFqdn,
  podIp,
  reconfigDirectly,
  statusOf,
  until,
  waitForMongod,
} from "./support.js";

// The only thing faked here: there is no Kubernetes API in the harness, so the pod list is fed in.
// Everything else - the connections, the reconfigs, the elections, the heartbeats - is real.
//
// Pods stay Running for the whole suite, including while mongo-2's mongod is down. That is the case
// the sidecar exists for: the Kubernetes API says the pod is fine, only mongod is gone.
vi.mock("../../src/k8s.js", () => ({ getMongoPods: vi.fn() }));

const { getMongoPods } = await import("../../src/k8s.js");
const { closeAllDbs } = await import("../../src/mongo.js");
const { init, workloop } = await import("../../src/worker.js");

const PODS = [pod(0), pod(1), pod(2)];

// One workloop per poll: the sidecar deliberately makes at most one reconfig per iteration, so every
// convergence here takes several of them
const driveUntil = async (
  condition: () => boolean | Promise<boolean>,
  description: (() => Promise<string> | string) | string,
  timeoutMs: number = 120_000,
): Promise<void> => {
  await until(
    async () => {
      await workloop();
      return await condition();
    },
    description,
    { intervalMs: 500, timeoutMs: timeoutMs },
  );
};

const memberHosts = async (): Promise<string[]> => (await configOf(0)).members.map((m) => m.host);

// What the primary itself thinks of every member, for timeout messages: which member went unhealthy,
// when its last heartbeat landed, and whether anyone is primary at all
const memberView = async (): Promise<string> => {
  try {
    const members = (await statusOf(0)).members ?? [];
    return JSON.stringify(
      members.map((m) => ({
        health: m.health,
        lastHeartbeatRecv: m.lastHeartbeatRecv,
        name: m.name,
        self: m.self,
        state: m.stateStr,
      })),
    );
  } catch (err) {
    return `unavailable: ${err instanceof Error ? err.message : "unknown error"}`;
  }
};

const reconfigMemberHostTo = async (from: string, to: string): Promise<void> => {
  await reconfigDirectly(0, (rsConfig) => {
    const member = rsConfig.members.find((m) => m.host === from);
    if (!member) {
      throw new Error(`Member ${from} not found in config: ${rsConfig.members.map((m) => m.host).join(", ")}`);
    }
    member.host = to;
  });
};

beforeAll(async () => {
  vi.mocked(getMongoPods).mockResolvedValue(PODS);

  await Promise.all([waitForMongod(0), waitForMongod(1), waitForMongod(2)]);

  init();
});

afterAll(async () => {
  await closeAllDbs();
  await closePeerClients();
});

describe("replica set lifecycle", () => {
  it("initiates the set on the elected pod and adds every pod under its FQDN", async () => {
    await driveUntil(async () => {
      const hosts = await memberHosts();
      return hosts.length === 3 && hosts.every((h) => h.endsWith(".db.test-ns.svc.cluster.local:27017"));
    }, "the replica set to contain all three pods by FQDN");

    expect(await memberHosts()).toEqual(expect.arrayContaining([podFqdn(0), podFqdn(1), podFqdn(2)]));

    // A set the sidecar built has to be a working one, not just a config document
    const status = await statusOf(0);
    expect(status.members?.filter((m) => m.stateStr === "PRIMARY")).toHaveLength(1);
    expect(status.members?.every((m) => m.health === 1)).toBe(true);
  });

  it("renames a member that is in the set under its pod IP back to its FQDN", async () => {
    // Put the set into the state a pre-normalization sidecar leaves behind. Done directly, because
    // the sidecar itself would never write this.
    await reconfigMemberHostTo(podFqdn(1), podIp(1));
    expect(await memberHosts()).toContain(podIp(1));

    await driveUntil(
      async () => {
        const hosts = await memberHosts();
        return hosts.includes(podFqdn(1)) && !hosts.includes(podIp(1));
      },
      `member ${podIp(1)} to be renamed to ${podFqdn(1)}`,
    );

    // Renaming must not have duplicated the member
    expect(await memberHosts()).toHaveLength(3);
  });

  it("removes a member whose mongod stops answering for longer than the grace period", async () => {
    await killMongod(2);

    // Two separate waits, because they fail for different reasons: the first is mongod noticing the
    // heartbeats stopped, the second is the sidecar acting on it
    await until(
      async () => (await statusOf(0)).members?.some((m) => m.name === podFqdn(2) && !m.health) === true,
      async () => `the set to see ${podFqdn(2)} as unhealthy, members: ${await memberView()}`,
      { timeoutMs: 60_000 },
    );

    await driveUntil(
      async () => {
        const hosts = await memberHosts();
        return hosts.length === 2 && !hosts.includes(podFqdn(2));
      },
      async () => `member ${podFqdn(2)} to be reaped, members: ${await memberView()}`,
      60_000,
    );
  });

  it("adds the pod back once its mongod returns", async () => {
    await waitForMongod(2);

    await driveUntil(
      async () => {
        const hosts = await memberHosts();
        return hosts.length === 3 && hosts.includes(podFqdn(2));
      },
      `member ${podFqdn(2)} to be re-added`,
    );

    await until(async () => {
      const status = await statusOf(0);
      return status.members?.length === 3 && status.members.every((m) => m.health === 1);
    }, "the re-added member to become healthy");
  });
});
