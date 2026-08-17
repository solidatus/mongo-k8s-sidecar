import { describe, expect, it, vi } from "vitest";

import { renameReplSetMember } from "../src/mongo.js";
import { ReplSetConfig } from "../src/types.js";

import type { Db } from "mongodb";

const PORT = 27017;

const rsConfig = (hosts: string[], version: number = 3): ReplSetConfig => ({
  _id: "rs0",
  configsvr: false,
  members: hosts.map((host, i) => ({ _id: i, host })),
  version,
});

// replSetGetConfig hands back a fresh copy each time, the way a real round trip would: the
// production code mutates the config it is given, so a shared object would let the test's own
// fixture be edited out from under its assertions.
const fakeDb = (config: ReplSetConfig) => {
  const command = vi.fn((cmd: Record<string, unknown>) => {
    if ("replSetGetConfig" in cmd) {
      return Promise.resolve({ config: structuredClone(config) });
    }
    return Promise.resolve({ ok: 1 });
  });

  return { command, db: { admin: () => ({ command }) } as unknown as Db };
};

// The second command is the reconfig - the first is always the replSetGetConfig read
const reconfigArg = (command: ReturnType<typeof fakeDb>["command"]) => command.mock.calls[1]?.[0];

describe("renameReplSetMember", () => {
  const ip = `10.0.0.2:${PORT}`;
  const fqdn = `db-1.db.test-ns.svc.cluster.local:${PORT}`;
  const otherFqdn = `db-0.db.test-ns.svc.cluster.local:${PORT}`;

  it("moves only the named member onto the new host", async () => {
    const { command, db } = fakeDb(rsConfig([otherFqdn, ip, `10.0.0.3:${PORT}`]));

    await renameReplSetMember(db, ip, fqdn);

    expect(reconfigArg(command)).toMatchObject({
      replSetReconfig: {
        members: [
          { _id: 0, host: otherFqdn },
          { _id: 1, host: fqdn },
          { _id: 2, host: `10.0.0.3:${PORT}` },
        ],
      },
    });
  });

  it("keeps the member's _id, so mongod sees a moved member rather than a new one", async () => {
    const { command, db } = fakeDb(rsConfig([otherFqdn, ip]));

    await renameReplSetMember(db, ip, fqdn);

    const members = (reconfigArg(command) as { replSetReconfig: ReplSetConfig }).replSetReconfig.members;
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.host === fqdn)?._id).toBe(1);
  });

  it("increments the config version by exactly one", async () => {
    const { command, db } = fakeDb(rsConfig([otherFqdn, ip], 7));

    await renameReplSetMember(db, ip, fqdn);

    expect(reconfigArg(command)).toMatchObject({ replSetReconfig: { version: 8 } });
  });

  it("passes force through to the reconfig", async () => {
    const { command, db } = fakeDb(rsConfig([otherFqdn, ip]));

    await renameReplSetMember(db, ip, fqdn, true);

    expect(reconfigArg(command)).toMatchObject({ force: true });
  });

  it("defaults to an unforced reconfig", async () => {
    const { command, db } = fakeDb(rsConfig([otherFqdn, ip]));

    await renameReplSetMember(db, ip, fqdn);

    expect(reconfigArg(command)).toMatchObject({ force: false });
  });

  it("reconfigs nothing when the member has already left the set", async () => {
    // The rename target came from a replSetGetStatus taken before this read - the member can be gone
    // by now, and reconfiguring on that stale view would resurrect it
    const { command, db } = fakeDb(rsConfig([otherFqdn]));

    await renameReplSetMember(db, ip, fqdn);

    expect(command).toHaveBeenCalledTimes(1);
  });

  it("reconfigs nothing when another member already holds the target host", async () => {
    // Two members on one host is a config mongod rejects, and writing it would take the set down.
    // The duplicate is the remove loop's job, not this one's.
    const { command, db } = fakeDb(rsConfig([otherFqdn, ip, fqdn]));

    await renameReplSetMember(db, ip, fqdn);

    expect(command).toHaveBeenCalledTimes(1);
  });

  it("reconfigs nothing when asked to rename a member onto its own host", async () => {
    const { command, db } = fakeDb(rsConfig([otherFqdn, fqdn]));

    await renameReplSetMember(db, fqdn, fqdn);

    expect(command).toHaveBeenCalledTimes(1);
  });
});
