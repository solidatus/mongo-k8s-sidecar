type ReplSetConfig = {
  _id: string;
  version: number;
  configsvr: boolean;
  members: ReplSetConfigMember[];
};

type ReplSetConfigMember = {
  _id: number;
  host: string;
};

type ReplSetStatus = {
  set: string;
  members: ReplSetStatusMember[];
};

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

type ReplSetStatusMember = {
  _id: number;
  name: string;
  health: number;
  state: number;
  stateStr: ReplSetMemberState;
  lastHeartbeatRecv?: Date;
  self: boolean;
};

export { ReplSetConfig, ReplSetConfigMember, ReplSetStatus, ReplSetStatusMember };
