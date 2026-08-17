import { beforeEach, describe, expect, it, vi } from "vitest";

// Records every connection the module opens, keyed by the URI it was built from, so the tests can
// assert which host a command actually reached rather than which host was asked for
const constructed: { options: Record<string, unknown>; uri: string }[] = [];
const connects: string[] = [];
const closes: string[] = [];
const commands: { command: unknown; uri: string }[] = [];
let commandImpl: (uri: string) => unknown = () => ({ config: {} });
let connectImpl: (uri: string) => void = () => undefined;

vi.mock("mongodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mongodb")>();

  class FakeMongoClient {
    constructor(
      readonly uri: string,
      readonly options: Record<string, unknown>,
    ) {
      constructed.push({ options: options, uri: uri });
    }

    close(): Promise<void> {
      closes.push(this.uri);
      return Promise.resolve();
    }

    connect(): Promise<void> {
      connects.push(this.uri);
      connectImpl(this.uri);
      return Promise.resolve();
    }

    db(): unknown {
      return {
        admin: () => ({
          command: (command: unknown) => {
            commands.push({ command: command, uri: this.uri });
            return commandImpl(this.uri);
          },
        }),
      };
    }
  }

  return { ...actual, MongoClient: FakeMongoClient };
});

const { MongoServerError } = await import("mongodb");

// The client cache is module level, so every test needs a fresh copy of the module
const loadMongo = async (): Promise<typeof import("../src/mongo.js")> => {
  vi.resetModules();
  return await import("../src/mongo.js");
};

const hostOf = (uri: string): string => uri.replace("mongodb://", "").split(":")[0]!;

beforeEach(() => {
  constructed.length = 0;
  connects.length = 0;
  closes.length = 0;
  commands.length = 0;
  commandImpl = () => ({ config: {} });
  connectImpl = () => undefined;
});

describe("getDb", () => {
  it("opens one connection per host rather than reusing the first one", async () => {
    const { getDb } = await loadMongo();

    await getDb();
    await getDb("10.0.0.2");
    await getDb("10.0.0.3");

    expect(connects.map(hostOf)).toEqual(["127.0.0.1", "10.0.0.2", "10.0.0.3"]);
  });

  it("reuses the cached connection for a host it has already connected to", async () => {
    const { getDb } = await loadMongo();

    await getDb("10.0.0.2");
    await getDb("10.0.0.2");

    expect(connects).toHaveLength(1);
  });

  it("caches nothing when the connection fails, so the next loop retries", async () => {
    const { getDb } = await loadMongo();
    connectImpl = () => {
      throw new Error("connection refused");
    };

    await expect(getDb("10.0.0.2")).rejects.toThrow("connection refused");

    connectImpl = () => undefined;
    await getDb("10.0.0.2");

    expect(connects.map(hostOf)).toEqual(["10.0.0.2", "10.0.0.2"]);
  });
});

describe("pruneDbCache", () => {
  it("closes cached connections to hosts that are no longer running", async () => {
    const { getDb, pruneDbCache } = await loadMongo();

    await getDb("10.0.0.2");
    await getDb("10.0.0.3");

    await pruneDbCache(["10.0.0.2"]);

    expect(closes.map(hostOf)).toEqual(["10.0.0.3"]);
  });

  it("keeps the local connection, which is no pod's address", async () => {
    const { getDb, pruneDbCache } = await loadMongo();

    await getDb();
    await pruneDbCache(["10.0.0.2"]);

    expect(closes).toEqual([]);
  });

  it("reconnects to a pruned host if it comes back, rather than serving a closed client", async () => {
    const { getDb, pruneDbCache } = await loadMongo();

    await getDb("10.0.0.2");
    await pruneDbCache([]);
    await getDb("10.0.0.2");

    expect(connects.map(hostOf)).toEqual(["10.0.0.2", "10.0.0.2"]);
  });

  it("leaves a cache that is entirely live alone", async () => {
    const { getDb, pruneDbCache } = await loadMongo();

    await getDb("10.0.0.2");
    await pruneDbCache(["10.0.0.2"]);

    expect(closes).toEqual([]);
  });
});

describe("isInReplSet", () => {
  it("probes the host it was given, not whichever host connected first", async () => {
    const { getDb, isInReplSet } = await loadMongo();

    // The work loop always opens the local connection before probing any peer
    await getDb();
    await isInReplSet("10.0.0.2");

    expect(commands.map((c) => hostOf(c.uri))).toEqual(["10.0.0.2"]);
  });

  it("reports a peer that is already in a replica set", async () => {
    const { isInReplSet } = await loadMongo();

    await expect(isInReplSet("10.0.0.2")).resolves.toBe(true);
  });

  it("reports false when the peer answers that it is not yet initialised", async () => {
    const { isInReplSet } = await loadMongo();
    commandImpl = () => {
      throw new MongoServerError({ code: 94, message: "no replset config has been received" });
    };

    await expect(isInReplSet("10.0.0.2")).resolves.toBe(false);
  });

  it("keeps the connection to a peer that answered, as that is the normal bootstrap answer", async () => {
    const { isInReplSet } = await loadMongo();
    commandImpl = () => {
      throw new MongoServerError({ code: 94, message: "no replset config has been received" });
    };

    await isInReplSet("10.0.0.2");
    await isInReplSet("10.0.0.2");

    expect(connects).toHaveLength(1);
    expect(closes).toHaveLength(0);
  });

  it("reports true when the peer answers with an error other than not-yet-initialised", async () => {
    const { isInReplSet } = await loadMongo();
    commandImpl = () => {
      throw new MongoServerError({ code: 11_000, message: "some other server error" });
    };

    // Membership is unknown, and a unanimous "no" is what elects a pod to run replSetInitiate -
    // guessing "not in a set" here would initiate a second replica set over a live one
    await expect(isInReplSet("10.0.0.2")).resolves.toBe(true);
  });

  // An auth failure is the one in-set answer that never changes by itself, and it blocks bootstrap of
  // a set that doesn't exist yet - so the log line has to point at the credentials rather than read as
  // a problem with the peer
  it.each([
    [13, "Unauthorized"],
    [18, "Authentication failed"],
  ])("blames our own credentials when a probe cannot authenticate (code %i)", async (code, message) => {
    const { isInReplSet } = await loadMongo();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    commandImpl = () => {
      throw new MongoServerError({ code: code, message: message });
    };

    await expect(isInReplSet("10.0.0.2")).resolves.toBe(true);

    const logged = String(consoleError.mock.calls[0]?.[0]);
    expect(logged).toContain("MONGODB_USERNAME");
    expect(logged).toContain("could not authenticate");
    consoleError.mockRestore();
  });

  it("does not throw when a peer is unreachable, so one bad pod cannot kill the work loop", async () => {
    const { isInReplSet } = await loadMongo();
    connectImpl = () => {
      throw new Error("connection timed out");
    };

    await expect(isInReplSet("10.0.0.2")).resolves.toBe(false);
  });

  it("drops the client after a connection level failure, since pod IPs get recycled", async () => {
    const { isInReplSet } = await loadMongo();
    commandImpl = () => {
      throw new Error("socket closed");
    };

    await isInReplSet("10.0.0.2");
    await isInReplSet("10.0.0.2");

    // Both probes fail, and each drops its own client - so the second probe had to reconnect
    expect(closes.map(hostOf)).toEqual(["10.0.0.2", "10.0.0.2"]);
    expect(connects.map(hostOf)).toEqual(["10.0.0.2", "10.0.0.2"]);
  });

  it("bounds how long a probe can hold the work loop", async () => {
    const { getDb, isInReplSet } = await loadMongo();

    await getDb();
    await isInReplSet("10.0.0.2");

    const local = constructed.find((c) => hostOf(c.uri) === "127.0.0.1")!;
    const peer = constructed.find((c) => hostOf(c.uri) === "10.0.0.2")!;

    expect(peer.options.serverSelectionTimeoutMS).toBe(3000);
    expect(peer.options.connectTimeoutMS).toBe(3000);
    // The local connection has to survive reconfigs, so it keeps the driver defaults
    expect(local.options.serverSelectionTimeoutMS).toBeUndefined();
  });
});
