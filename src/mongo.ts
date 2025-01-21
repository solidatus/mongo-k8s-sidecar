import { Db, MongoClient } from "mongodb";

import { config } from "./config";
import { log } from "./log";
import { ReplSetConfig, ReplSetStatus } from "./types";
import { range, sleep } from "./utils";

let mongoClient: MongoClient | null = null;

const getDb = async (host: string = "127.0.0.1"): Promise<Db> => {
  if (mongoClient === null) {
    mongoClient = await createMongoClient(host);
  }

  return mongoClient.db();
};

const createMongoClient = async (host: string): Promise<MongoClient> => {
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
  });

  // test the connection
  log.info("Connecting to MongoDB");
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
  log.info("replSetReconfig", rsConfig);
  rsConfig.version++;

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
  rsConfig.members[0].host = host;

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

const addNewMembers = (rsConfig: ReplSetConfig, addrs: string[]): void => {
  if (addrs.length === 0) {
    return;
  }

  let newMemberId = 0;
  const memberIds = rsConfig.members.map((m) => m._id);

  for (const addr of addrs) {
    // search for the next available member ID (max 255)
    newMemberId = range(newMemberId, 256).find((i) => !memberIds.includes(i)) ?? -1;
    if (newMemberId === -1) {
      throw new Error("No available member ID");
    }
    memberIds.push(newMemberId);

    // We can get a race condition where the member config has been updated since we created the list of addresses to add
    // so we do another loop to make sure we don't add duplicates
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
  const db = await getDb(ip);

  try {
    const rsConfig = await replSetGetConfig(db);
    return !!rsConfig;
  } catch {
    return false;
  }
};

export { addNewReplSetMembers, getDb, initReplSet, isInReplSet, replSetGetStatus };
