# Bounty Hunting

Bounty Hunting is a native-only EveJS mod that gives characters progression and configurable rewards for delivering the final blow to native NPC combat targets.

It supports NPC ships, dungeon and event NPCs, NPC structures, and NPC drones. Player ship kills, assists, and non-NPC targets are not counted. EveJS's normal NPC and player bounty payouts are left unchanged.

## Requirements

- EveJS `0.12.9`
- Native backend
- Game-server restart after installation, updates, configuration changes, or removal

Docker deployments are not supported.

## Installation

Copy or clone this directory into the EveJS `mods` directory, enable Bounty Hunting in the EveJS Launcher, and restart the Game server.

The mod stores runtime state outside the package at:

```text
<EVEJS data root>/bountyHunting/state.json
```

State is stored per character. Repeated kill notifications are ignored by their kill ID or destruction-event key, so a restart cannot pay the same reward twice.

## Configuration

Edit `config/bounty-hunting.json` while the Game server is stopped, then restart the Game server.

The configuration controls:

- `enabled`
- `diagnostics.enabled` for temporary hook tracing in the server log
- the 50-level XP curve
- the number of recent kills shown in the Mods window
- reward notifications
- the bounty-value thresholds and rewards for Low, Standard, Elite, and Boss NPCs

The default reward table is:

| Tier | Native bounty value | ISK | Skill points | PLEX | XP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Low | Under 10,000 ISK | 25,000 | 1,000 | 0 | 25 |
| Standard | 10,000–99,999 ISK | 75,000 | 2,500 | 1 | 50 |
| Elite | 100,000–999,999 ISK | 150,000 | 5,000 | 1 | 100 |
| Boss | 1,000,000 ISK and above | 300,000 | 10,000 | 2 | 250 |

PLEX is selected deterministically between `plexMinimum` and `plexMaximum` for each kill. Set both values to zero to disable PLEX rewards for a tier.

## In-game window

Open Bounty Hunting from the in-game Mods window. The scrollable window shows:

- level and XP progress
- total NPC kills and kills by tier
- lifetime ISK, skill points, and PLEX rewards
- the latest kill
- recent kill history
- the active reward table

Reward messages are sent as system messages when a reward is settled. Set `notifications.enabled` to `false` to disable them.

For troubleshooting, set `diagnostics.enabled` to `true` and restart the game server. The server log will show whether native bounty, drone destruction, or killmail hooks observed a kill and whether duplicate hook calls were suppressed. Disable diagnostics after testing.

## Reward safety

ISK, PLEX, and skill-point rewards use separate idempotency receipts. If one part of a reward cannot be paid, the remaining work stays pending and is retried by the service. Native combat destruction and native bounty settlement are never blocked by this mod.

## License and maintenance

This project is released under the MIT License. See [LICENSE](LICENSE).

Troublesum is the original author. Others may modify or re-release the mod if it becomes unmaintained, provided credit to Troublesum is retained.

This README and the source include an AI-use disclosure because portions of the implementation and documentation were prepared with AI assistance and reviewed for this project.
