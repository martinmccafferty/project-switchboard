# Project Switchboard

A TelPal 301-Ivory retro telephone, turned into a Wi-Fi AI telephone and smart-home interface — without changing how it looks or feels.

Pick up the handset (or press HANDS FREE), and you're talking to an AI. The original brass bell rings when something needs your attention. The phone itself stays completely stock: an ESP32-S3 pretends to be the telephone exchange at the other end of the line.

## Status

**Phase 0 — identification & documentation.** No hardware wired yet. See the [engineering log](docs/engineering-log.md) for everything we know, suspect, and have decided.

## Architecture (in principle)

```
[Unmodified TelPal] --RJ11--> [SLIC line module] <-> [audio codec] <-> [ESP32-S3] --Wi-Fi--> [AI relay] <-> [speech + LLM]
                                                                                                  +--> Google Home
```

## Repository layout

| Path | Contents |
|---|---|
| `docs/` | Engineering log, pinouts, photos |
| `firmware/` | ESP32-S3 firmware (from Phase 2) |
| `relay/` | AI relay service (from Phase 2) |

## Ground rules

- Never commit secrets (Wi-Fi passwords, API keys). They go in local, git-ignored config files.
- Every discovery, decision, and test result is recorded in `docs/engineering-log.md`.
