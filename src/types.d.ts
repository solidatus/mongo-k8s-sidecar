type ReplSetConfig = {
  _id: string;
  configsvr: boolean;
  members: ReplSetConfigMember[];
  version: number;
};

type ReplSetConfigMember = {
  _id: number;
  host: string;
};

/* eslint-disable perfectionist/sort-union-types */
type ReplSetMemberState =
  | "STARTUP"
  | "PRIMARY"
  | "SECONDARY"
  | "RECOVERING"
  | "STARTUP2"
  | "UNKNOWN"
  | "ARBITER"
  | "DOWN"
  | "ROLLBACK"
  | "REMOVED"
  | "RS_ERROR";
/* eslint-enable perfectionist/sort-union-types */

type ReplSetStatus = {
  // A mongod that has been removed from the set still answers replSetGetStatus, but with only a
  // subset of the fields - members among the ones it leaves out.
  members?: ReplSetStatusMember[];
  myState?: number;
  set: string;
};

type ReplSetStatusMember = {
  _id: number;
  health: number;
  lastHeartbeatMessage?: string;
  lastHeartbeatRecv?: Date;
  name: string;
  self: boolean;
  state: number;
  stateStr: ReplSetMemberState;
};

export { ReplSetConfig, ReplSetConfigMember, ReplSetStatus, ReplSetStatusMember };
