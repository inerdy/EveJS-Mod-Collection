# System Discovery Rewards

System Discovery Rewards gives each character a one-time reward for entering a
known-space solar system that EveJS has not previously recorded as visited.

The default reward is 250,000 ISK, 10,000 unallocated skill points, 100 Explorer
XP, and a deterministic random 1–3 PLEX amount. Explorer progression uses a
50-level curve: Level 2 requires 1,000 XP and each later level requires 250 more
XP than the previous level. Levels are tracking-only and do not change future
payouts.

The mod reads EveJS map telemetry before the native scene attachment records a
visit. Systems already present in that telemetry are treated as discovered, so
installing the mod does not grant retroactive rewards. Login, reconnect,
docking, undocking, and same-system movement do not count. Successful stargate,
solar-system, and clone-vat transfers into a new known-space system do count.
Wormhole and Abyssal systems are excluded by default.

## Compatibility and installation

- EveJS 0.12.9
- Native backend
- A game-server restart after enabling or updating the mod

Install the package at `mods/systemDiscoveryRewards`, enable it in the EveJS
Launcher, and restart the Game server. The launcher delivers a System
Discovery Rewards window through the in-game Mods menu. Each successful reward
also appears as a system chat notification.

## Configuration

Edit `mods/systemDiscoveryRewards/config/discovery.json` while the Game server
is stopped, then restart the Game server. Important settings include:

- `enabled`
- `knownSpaceOnly` and `knownSpaceMaxSystemID`
- `reward.isk`, `reward.skillPoints`, `reward.xp`, `reward.plexMinimum`, and
  `reward.plexMaximum`
- `recentDiscoveryLimit`
- `progression.maxLevel`, `progression.xpToNextLevelBase`, and
  `progression.xpToNextLevelPerLevel`

Runtime state is stored outside the package at:

```text
<EVEJS data root>/systemDiscoveryRewards/state.json
```

The state contains per-character discovery records and payout status. ISK, PLEX,
and skill-point grants use stable idempotency keys, so a failed or interrupted
reward can retry without paying twice. Skill points are added as unallocated SP.

## GitHub installation

Clone this repository into the EveJS `mods` directory, enable the mod in the
EveJS Launcher, and restart the Game server:

```powershell
git clone <repository-url> mods/systemDiscoveryRewards
```
