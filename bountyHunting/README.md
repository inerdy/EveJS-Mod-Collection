# Bounty Hunting

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Bounty Hunting is a native-only EveJS mod that gives characters progression and
configurable rewards for delivering the final blow to native NPC combat
targets.

It supports NPC ships, dungeon and event NPCs, NPC structures, and NPC drones.
Player ship kills, assists, and non-NPC targets are not counted. EveJS's normal
NPC and player bounty payouts are left unchanged.

## Features

- 50-level NPC bounty-hunting XP progression.
- Configurable ISK, skill-point, PLEX, and XP rewards by bounty tier.
- Lifetime kill statistics and recent-kill history.
- A scrollable in-game Bounty Hunting window.
- Idempotent reward settlement with retry support after partial failure.
- Reward batching aligned with EveJS's native bounty payout timing.

## Requirements

- Native EveJS `0.12.9` — [EveJS Discord](https://discord.gg/WpYh9zpNrx)
- [EveJS Launcher `1.0.69`](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy `bountyHunting` into the EveJS `mods` directory.
2. Keep the manifest at `mods/bountyHunting/evejs-launcher.mod.json`.
3. Enable **Bounty Hunting** in the EveJS Launcher.
4. Restart the **Game server** and reconnect the client.
5. Open **Mods > Bounty Hunting** in-game.

The mod stores runtime state outside the package at:

```text
<EveJS data root>/bountyHunting/state.json
```

State is stored per character. Repeated kill notifications are ignored by their
kill ID or destruction-event key, so a restart cannot pay the same reward twice.

## Configuration

Edit `config/bounty-hunting.json` while the Game server is stopped, then
restart the Game server.

The configuration controls:

- `enabled`
- `diagnostics.enabled` for temporary hook tracing in the server log
- the 50-level XP curve
- the number of recent kills shown in the Mods window
- `payoutDelayMs`, the fallback reward-batch delay when EveJS does not provide a native payout time
- reward notifications
- bounty-value thresholds and rewards for Low, Standard, Elite, and Boss NPCs

The default reward table is:

| Tier | Native bounty value | ISK | Skill points | PLEX | XP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Low | Under 10,000 ISK | 25,000 | 1,000 | 0 | 25 |
| Standard | 10,000–99,999 ISK | 75,000 | 2,500 | 1 | 50 |
| Elite | 100,000–999,999 ISK | 150,000 | 5,000 | 1 | 100 |
| Boss | 1,000,000 ISK and above | 300,000 | 10,000 | 2 | 250 |

PLEX is selected deterministically between `plexMinimum` and `plexMaximum`
for each kill. Set both values to zero to disable PLEX rewards for a tier.

## In-game view

The scrollable Bounty Hunting window shows:

- level and XP progress
- total NPC kills and kills by tier
- lifetime ISK, skill points, and PLEX rewards
- the latest kill
- recent kill history
- the active reward table

Reward messages are sent as system messages when a reward is settled. Set
`notifications.enabled` to `false` to disable them.

Kills, XP, and lifetime statistics are recorded as soon as the final blow is
confirmed. ISK, PLEX, and skill-point rewards are grouped per character and
settled as one combined reward at the native EveJS bounty payout time. If no
native payout time is available, the mod uses `payoutDelayMs`.

For troubleshooting, set `diagnostics.enabled` to `true` and restart the
game server. Disable diagnostics after testing.

## Reward safety

ISK, PLEX, and skill-point rewards use separate batch idempotency receipts. If
one part of a reward cannot be paid, the remaining work stays pending and is
retried by the service without repeating successful portions. Native combat
destruction and native bounty settlement are never blocked by this mod.

## Removal

Disable the mod in the Launcher and restart the Game server. Character
progression and reward receipts remain in the state file unless you remove it
intentionally.

## License and maintenance

This project is released under the [MIT License](LICENSE).

Troublesum is the original author. Others may modify or re-release the mod if it
becomes unmaintained, provided credit to Troublesum is retained.

## AI disclosure

Parts of this project were developed with assistance from AI tools. The code,
behavior, testing, documentation, and releases are reviewed and maintained by
Troublesum. AI assistance does not change the license or ownership of this
project.
