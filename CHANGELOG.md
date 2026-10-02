# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).
Releases before 0.18.0: see git history.

## [0.18.1]

### Changed

- Updated dependencies, fixing known vulnerabilities.

## [0.18.0]

Makes replica set management more reliable: fixes cases where the sidecar could create a second replica set, drop a member or add the same pod twice. After upgrading, existing members are renamed to their pod's stable network name, one per cycle, unless `KUBE_NORMALIZE_MEMBER_HOSTS` is set to `false`.

### Added

- `KUBE_NORMALIZE_MEMBER_HOSTS` (default `true`): renames existing replica set members to their pod's stable network name, one member per cycle. Set to `false` to leave member host names as they are.
- `MONGODB_STARTUP_GRACE_SECONDS` (default `300`): how long a member that has never been reachable gets before it is removed, so a mongod still loading a large dataset is not removed while it starts.
- `MONGODB_FORCE_RECONFIG_GRACE_SECONDS` (default `30`): how long the replica set gets to elect a primary by itself before the sidecar forces a reconfig, and the minimum time between forced reconfigs.
- `LOG_DEBUG` (default `false`): logs extra detail, including the full replica set config on every reconfig.

### Changed

- The image no longer contains `npm`.
- Clearer logs when a member is removed: the reason, its state and how long it was unhealthy.
- Shorter reconfig logs. The full config is only logged with `LOG_DEBUG`.

### Fixed

- A pod that started with an empty data directory could create a second replica set next to the live one.
- Two sidecars could force reconfigs at the same time and silently drop a member.
- The same pod could be added to the replica set twice under different host names.
- One unreachable pod could stall the sidecar for every other pod.
- The sidecar crashed when its own mongod had been removed from the replica set. It now waits to be added back.
- Removing dead members and renaming members could block each other.
- When the sidecar cannot log in to a mongod, it now says so and names the credential settings to check. The replica set is not created until this is fixed.
- The settings table in the README now matches the real setting names and defaults.
- Updated dependencies, fixing known vulnerabilities.
