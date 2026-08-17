# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).
Releases before 0.18.0: see git history.

## [0.18.0]

### Added

- `KUBE_NORMALIZE_MEMBER_HOSTS` (default `true`): rename existing members onto the pod's stable network ID, one per cycle.
- `MONGODB_FORCE_RECONFIG_GRACE_SECONDS` (default `30`): how long the set is left to elect a primary of its own before a sidecar writes a forced reconfig, and how long it waits before writing another.
- `LOG_DEBUG` and a `log.debug` level; full replica set config logged there.
- Unit tests (`vitest`), run with `npm test`.

### Changed

- Match a pod against members by pod IP, short name, bare pod name, or mongod's `self` flag - not just exact FQDN. Stops duplicate members.
- Reap dead members before renaming; skip renames while any removal is pending. Otherwise the two wedge each other.
- Time the unhealthy grace period from first-seen-unhealthy when `lastHeartbeatRecv` is the epoch, so starting members aren't removed early.
- Log removals with `lastHeartbeatMessage`, state and unhealthy duration.
- `replSetReconfig` logs members/version/force after the version increment; full config moved to debug.
- Build via `tsconfig.build.json`, keeping tests out of `dist`.

### Fixed

- Cache one MongoDB client per host instead of one globally. The "is any peer already in a replica set?" guard before `replSetInitiate` was probing the local mongod for every peer, so it always answered no - a pod that came up with an empty data dir and won the IP-sorted election could initiate a competing set alongside the live one.
- Peer probes get a 3s connect/server-selection timeout and no longer throw, so one unreachable pod can't stall or abort a work loop iteration. Clients dropped after a connection-level failure, since pod IPs get recycled.
- Crash when `replSetGetStatus` omits `members` (state `REMOVED`); now waits to be re-added.
- Forced reconfigs (the no-primary path, and error 93 recovery) are fenced by time. `force` skips mongod's config version and term check, so with a sidecar per mongod two pods whose pod lists disagree could both win their own election and write over each other, silently dropping a member. Both paths now wait out `MONGODB_FORCE_RECONFIG_GRACE_SECONDS` before forcing - most no-primary spells are just an election in progress - and won't force again until that long after the last one, which also stops a run of renames becoming a run of forced reconfigs.
- Replica set bootstrap takes its seed address from the pod that won the election rather than from the first entry of the pod list, which the election used to reorder in place as a side effect.
- A probe that fails to authenticate (codes 13, 18) now says so and names the credentials to check. It is still reported as in-set, since guessing otherwise splits the brain, but it is our own misconfiguration and it blocks bootstrap until fixed.
- README settings table matched to the code (`MONGODB_*` names, corrected defaults).
