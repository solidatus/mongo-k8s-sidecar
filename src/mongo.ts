import { Db, MongoClient, MongoServerError } from "mongodb";

import { config } from "./config.js";
import { log } from "./log.js";
import { ReplSetConfig, ReplSetStatus } from "./types.js";
import { range, sleep } from "./utils.js";

// Keyed by host: the local mongod and every peer we probe need their own connection. A single shared
// client would answer peer queries from whichever host connected first, which silently turns
// "is any peer already in a replica set?" into "am I in a replica set?"
const mongoClients = new Map<string, MongoClient>();

// Probing a peer must not stall the work loop: a pod that is Running as far as the API is concerned
// but whose mongod is unreachable would otherwise hold us for the driver's 30s default. Only used
// for peer probes - the local connection keeps the default, as it has to survive reconfigs.
const probeTimeoutMs = 3000;

const getDb = async (host: string = "127.0.0.1", timeoutMs?: number): Promise<Db> => {
  let mongoClient = mongoClients.get(host);
  if (mongoClient === undefined) {
    // Nothing is cached until connect() resolves, so a failed connection is retried next loop
    mongoClient = await createMongoClient(host, timeoutMs);
    mongoClients.set(host, mongoClient);
  }

  return mongoClient.db();
};

const closeDb = async (host: string): Promise<void> => {
  const mongoClient = mongoClients.get(host);
  if (mongoClient === undefined) {
    return;
  }

  mongoClients.delete(host);
  try {
    await mongoClient.close();
  } catch (err) {
    log.debug(`Failed to close MongoDB client for ${host}`, err);
  }
};

// The cache is module level and outlives any one caller, so anything that wants to let the process
// (or a test file) end has to drop every connection, not just the ones it opened itself.
const closeAllDbs = async (): Promise<void> => {
  await Promise.all([...mongoClients.keys()].map(async (host) => await closeDb(host)));
};

// The local connection is opened under getDb's default host, which is no pod's address, so it is
// never in a caller's list of live hosts and has to be spared by name.
const localHost = "127.0.0.1";

// A successful probe leaves its client cached, and pods do not come back on the same IP - so without
// this the cache grows by one client per pod restart for the life of the process, each with a
// monitor still heartbeating an address nothing answers on. Callers pass the hosts they would probe
// this cycle, in the same spelling they probe with, and everything else is dropped.
const pruneDbCache = async (liveHosts: string[]): Promise<void> => {
  const keep = new Set([...liveHosts, localHost]);
  const stale = [...mongoClients.keys()].filter((host) => !keep.has(host));
  if (stale.length === 0) {
    return;
  }

  log.info(`Closing cached MongoDB connections to hosts that are no longer running`, { hosts: stale });
  await Promise.all(stale.map(async (host) => await closeDb(host)));
};

const createMongoClient = async (host: string, timeoutMs?: number): Promise<MongoClient> => {
  const mongoConfig = config.mongo;
  const authConfig = mongoConfig.auth;

  let uri =
    authConfig ?
      `mongodb://${encodeURIComponent(authConfig.username)}:${encodeURIComponent(authConfig.password)}@${host}:${mongoConfig.port}`
    : `mongodb://${host}:${mongoConfig.port}`;
  if (authConfig?.database) {
    uri += `/${authConfig.database}`;
  }

  const mongoClient = new MongoClient(uri, {
    appName: "mongo-k8s-sidecar",
    directConnection: true,
    tls: mongoConfig.tls,
    tlsAllowInvalidCertificates: mongoConfig.tlsAllowInvalidCertificates,
    tlsAllowInvalidHostnames: mongoConfig.tlsAllowInvalidHostnames,
    ...(timeoutMs === undefined ? {} : { connectTimeoutMS: timeoutMs, serverSelectionTimeoutMS: timeoutMs }),
  });

  // test the connection
  log.info(`Connecting to MongoDB at ${host}`);
  await mongoClient.connect();

  return mongoClient;
};

const replSetGetConfig = async (db: Db): Promise<ReplSetConfig> => {
  return (await db.admin().command({ replSetGetConfig: 1 })).config as ReplSetConfig;
};

const replSetGetStatus = async (db: Db): Promise<ReplSetStatus> => {
  return (await db.admin().command({ replSetGetStatus: 1 })) as ReplSetStatus;
};

const replSetReconfig = async (db: Db, rsConfig: ReplSetConfig, force: boolean = false): Promise<void> => {
  rsConfig.version++;

  // Log after the increment so the version here is the one being written, and keep it to the parts
  // that change - the settings block is static noise on a loop that reconfigs every few seconds
  log.info("replSetReconfig", {
    force: force,
    members: rsConfig.members.map((m) => `${m._id}: ${m.host}`),
    version: rsConfig.version,
  });
  log.debug("replSetReconfig full config", rsConfig);

  // MongoDB gets fussy if the command name (replSetReconfig) is not the first key in the object
  // eslint-disable-next-line perfectionist/sort-objects
  await db.admin().command({ replSetReconfig: rsConfig, force: force });
};

const initReplSet = async (db: Db, host: string): Promise<void> => {
  log.info("initReplSet", host);

  await db.admin().command({ replSetInitiate: {} });

  const rsConfig = await replSetGetConfig(db);
  log.info("initial rsConfig", rsConfig);

  rsConfig.configsvr = config.mongo.isConfigSvr;
  rsConfig.members[0]!.host = host;

  const retryTimes = 20;
  const sleepInterval = 500;
  for (let i = 0; i < retryTimes; i++) {
    try {
      await replSetReconfig(db, rsConfig);
      break;
    } catch (err) {
      if (i === retryTimes - 1) {
        // last attempt failed
        throw err;
      }

      log.warn(`replSetReconfig failed, retrying in ${sleepInterval}ms`);
      await sleep(sleepInterval);
    }
  }
};

const addNewReplSetMembers = async (db: Db, newAddrs: string[], deadAddrs: string[], force: boolean): Promise<void> => {
  const rsConfig = await replSetGetConfig(db);

  removeDeadMembers(rsConfig, deadAddrs);
  addNewMembers(rsConfig, newAddrs);

  await replSetReconfig(db, rsConfig, force);
};

// Returns whether a reconfig actually happened - the caller skips the rest of its cycle for a rename,
// so a no-op here must not cost it that cycle.
const renameReplSetMember = async (db: Db, from: string, to: string, force: boolean = false): Promise<boolean> => {
  const rsConfig = await replSetGetConfig(db);

  const member = rsConfig.members.find((m) => m.host === from);
  if (!member) {
    log.warn(`Member ${from} is no longer in the replica set, not renaming`);
    return false;
  }
  if (rsConfig.members.some((m) => m.host === to)) {
    log.warn(`Member ${to} already exists in the replica set, not renaming ${from}`);
    return false;
  }

  log.info(`Renaming member ${from} to ${to}`);
  member.host = to;

  await replSetReconfig(db, rsConfig, force);
  return true;
};

const addNewMembers = (rsConfig: ReplSetConfig, addrs: string[]): void => {
  if (addrs.length === 0) {
    return;
  }

  let newMemberId = 0;
  const memberIds = rsConfig.members.map((m) => m._id);

  for (const addr of addrs) {
    // We can get a race condition where the member config has been updated since we created the list of addresses to add
    // so we do another loop to make sure we don't add duplicates. Checked before claiming an ID, or
    // a skipped address takes an ID with it.
    let exists = false;
    for (const member of rsConfig.members) {
      if (member.host === addr) {
        log.warn(`Member ${addr} already exists in the replica set, not adding`);
        exists = true;
        break;
      }
    }
    if (exists) {
      continue;
    }

    // search for the next available member ID (max 255)
    newMemberId = range(newMemberId, 256).find((i) => !memberIds.includes(i)) ?? -1;
    if (newMemberId === -1) {
      throw new Error("No available member ID");
    }
    memberIds.push(newMemberId);

    const cfg = {
      _id: newMemberId,
      host: addr,
    };
    rsConfig.members.push(cfg);
  }
};

const removeDeadMembers = (rsConfig: ReplSetConfig, addrs: string[]): void => {
  if (addrs.length === 0) {
    return;
  }

  rsConfig.members = rsConfig.members.filter((m) => !addrs.includes(m.host));
};

const isInReplSet = async (ip: string): Promise<boolean> => {
  try {
    // getDb has to be inside the try: connecting to a peer can fail, and a single unreachable pod
    // must not take down the caller's Promise.all and with it the whole work loop iteration
    const db = await getDb(ip, probeTimeoutMs);
    const rsConfig = await replSetGetConfig(db);
    return !!rsConfig;
  } catch (err) {
    if (err instanceof MongoServerError) {
      // NotYetInitialized: the server answered, it just isn't in a replica set. The connection is
      // fine, so keep it cached - during bootstrap this is the expected answer from every peer,
      // every loop.
      if (err.code === 94) {
        return false;
      }

      // Unauthorized and AuthenticationFailed are not a fact about the peer at all, they are a fact
      // about our own configuration - wrong credentials, or an authDb that doesn't exist. That answer
      // never changes on its own, and since the user is normally created after the replica set exists,
      // the condition cannot clear by itself either: bootstrap of a new set never happens until
      // someone fixes the config. The answer is still in-set, because guessing "not in a set" here is
      // what splits the brain - but this line has to name the cause rather than read as a peer problem.
      if (err.code === 13 || err.code === 18) {
        log.error(
          `Replica set probe of ${ip} could not authenticate - check MONGODB_USERNAME, MONGODB_PASSWORD and ` +
            `MONGODB_AUTHDB. Treating the peer as in-set, so this sidecar will not initiate a replica set while ` +
            `this lasts, and a set that does not exist yet will not be created at all`,
          err,
        );
        return true;
      }

      // Any other server side error (a transient state change, an unexpected refusal) leaves
      // the peer's membership unknown. Report it as in-set: the caller only uses a unanimous "no"
      // to elect itself for replSetInitiate, and initiating against a set that already exists
      // splits the brain. A stalled bootstrap is recoverable, a second replica set is not.
      //
      // Logged as an error rather than a warning for the same reason as the auth case above: if this
      // does turn out to be a state the peer never leaves, this is the only line that says why.
      log.error(`Replica set probe of ${ip} returned an unexpected server error, assuming in-set`, err);
      return true;
    }

    // Anything else is a connection level failure. Pod IPs get recycled onto other pods, so drop
    // the client rather than reusing a connection to a host that may not be that pod any more.
    log.debug(`Replica set probe of ${ip} failed`, err);
    await closeDb(ip);
    return false;
  }
};

export {
  addNewReplSetMembers,
  closeAllDbs,
  getDb,
  initReplSet,
  isInReplSet,
  pruneDbCache,
  renameReplSetMember,
  replSetGetConfig,
  replSetGetStatus,
};
