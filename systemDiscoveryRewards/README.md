# System Discovery Rewards

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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

## Features

- One-time per-character discovery rewards.
- ISK, unallocated skill points, PLEX, and Explorer XP payouts.
- 50-level Explorer progression.
- Scrollable in-game System Discovery Rewards window.
- Idempotent reward receipts and retry support after interruption.
- System chat notification after each successful reward.

## Requirements

- Native EveJS 0.12.9
- EveJS Launcher 1.0.69 or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy systemDiscoveryRewards into the EveJS mods directory.
2. Keep the manifest at mods/systemDiscoveryRewards/evejs-launcher.mod.json.
3. Enable **System Discovery Rewards** in the EveJS Launcher.
4. Restart the **Game server** and reconnect the client.

## Configuration

Edit mods/systemDiscoveryRewards/config/discovery.json while the Game server is
stopped, then restart the Game server. Important settings include:

- enabled
- knownSpaceOnly and knownSpaceMaxSystemID
- reward.isk, reward.skillPoints, reward.xp, reward.plexMinimum, and reward.plexMaximum
- recentDiscoveryLimit
- progression.maxLevel, progression.xpToNextLevelBase, and progression.xpToNextLevelPerLevel

Runtime state is stored outside the package at:

```text
<EveJS data root>/systemDiscoveryRewards/state.json
```

The state contains per-character discovery records and payout status. ISK, PLEX,
and skill-point grants use stable idempotency keys, so a failed or interrupted
reward can retry without paying twice. Skill points are added as unallocated SP.

## Removal

Disable the mod in the Launcher and restart the Game server. Discovery records
and completed reward receipts remain in the state file unless you remove it
intentionally.

## License and maintenance

This project is released under the MIT License. See [LICENSE](LICENSE).

If the project becomes unmaintained, you may continue working on it, modify it,
and release your own version. Keep credit to the original author, **Troublesum**,
in the documentation and source distribution.

## AI disclosure

Parts of this project were developed with assistance from AI tools. The code,
behavior, testing, documentation, and releases are reviewed and maintained by
Troublesum. AI assistance does not change the license or ownership of this
project.
