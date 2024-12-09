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
  members: ReplSetStatusMember[];
  set: string;
};

type ReplSetStatusMember = {
  _id: number;
  health: number;
  lastHeartbeatRecv?: Date;
  name: string;
  self: boolean;
  state: number;
  stateStr: ReplSetMemberState;
};

export { ReplSetConfig, ReplSetConfigMember, ReplSetStatus, ReplSetStatusMember };
