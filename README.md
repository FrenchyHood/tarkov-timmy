# Tarkov Timmy

Never lose your extract again. A live squad map for Escape from Tarkov (PvP): everyone's position, the extracts you have this raid, bosses, danger zones, transits, and your squad's quest objectives, plus a mini-map overlay that floats over the game.

Deploy the `server/` folder to your own Cloudflare account (free) and share room links from there.

```
[Your PC]   Tarkov Timmy app ─┐  HTTPS                        WebSocket
                              ├──────────► Cloudflare Worker ◄───────────► browser / phone / app windows
[Friend PC] Tarkov Timmy app ─┘            + Durable Object per room
                                           + cached tarkov.dev data
```

| Folder | What it is |
| --- | --- |
| `server/` | Cloudflare Worker: serves the map site, keeps each squad room in a Durable Object, caches tarkov.dev data (and serves the last good copy if tarkov.dev is down). Free plan. |
| `desktop/` | **Tarkov Timmy** Windows app (Electron): installer, tray icon, position sharing, overlay, alerts, auto-updates. |
| `companion/` | The original standalone Python companion. Superseded by the app, kept as a no-install fallback. |

## How live position works (BattlEye-safe)

Nothing reads game memory or hooks into the game. The app only reads files Tarkov writes by itself:

1. **Screenshots.** When you press the in-game screenshot key (Print Screen by default), Tarkov names the file after your coordinates and facing. The app reads the name, sends your position, and optionally deletes the file.
2. **Log files.** They say which map you queued into and when the raid starts and ends, so the map switches by itself and the raid timer runs.

**Your marker only updates when you press the screenshot key.** The app deliberately does not press it for you, because simulated keypresses into the game look like a macro to anti-cheat.

The overlay is a normal always-on-top window, not an injected one. It shows over Tarkov only in **Borderless** screen mode (Tarkov Settings → Graphics).

## Using it

- **Create a room** on the site, then click **Invite** to copy the link for your squad.
- **Extracts:** in raid, double-tap **O**, then tick your extracts in the Extracts tab. The whole squad sees them highlighted, and the picks reset each raid.
- **Pings:** right-click (or long-press on a phone) the map: Go here / Enemy / Loot / Danger / I'm here. Squadmates get a sound and a Windows notification.
- **Quests:** detected automatically from Tarkov's logs (accepted quests appear, finished ones drop off), or tick them by hand. Objectives show on the map in your color for everyone.
- **Route tab:** a suggested order to visit your squad's quest objectives plus the best-value loot containers on the way, ending at your ticked extract. Straight lines between stops (there's no walkable-path data for Tarkov). Stops you've screenshotted near drop off.
- **Follow me (◎):** keeps your pin centred at your zoom, also after a refresh. Panning pauses it.
- **PMC / Scav** is detected automatically from the raid start (your PMC profile is learned from raids with a start countdown).
- **Raid timer** with sound alerts at 10 and 5 minutes left.
- **Stash helper** (Stash button): search any item for a verdict (Keep / Needed later / Valuable / Low value) with the reasons, best trader and flea price (and the item's flea level), plus a **Keep list** of everything your squad's active quests and next hideout upgrades need. Set hideout levels once in its Hideout tab. Nothing reads your stash: that would need memory reading, which gets accounts banned.
- **Overlay** (app): **F9** shows/hides it, **F10** switches between clicking the map and clicking through to the game. Drag it by its top bar and resize from any edge or the corner grip; size, position and opacity are remembered. It mirrors the main window's layers, floor, map and route settings. Hotkeys can be changed in Settings.

## Desktop app

```bash
cd desktop
npm install
npm start          # run from source
npm run dist       # build dist/Tarkov-Timmy-Setup-<version>.exe
npm run release    # build, then publish ONE GitHub release with all files (needs the GitHub CLI signed in)
```

- Settings live in `%APPDATA%\Tarkov Timmy\settings.json`.
- Join links: `tarkovtimmy://join/<ROOM>?server=<site origin>` opens the app straight into a room. The site's Squad tab has an "Open this room in the app" button.
- Releasing an update: bump `version` in `desktop/package.json`, write `desktop/release-notes.md`, push, then `npm run release`. The script checks the installer, blockmap and `latest.yml` all uploaded. Installed apps download it in the background and install on next quit.
- The installer is unsigned, so Windows SmartScreen shows "Windows protected your PC" on first run: click **More info → Run anyway**.

## Server

```bash
cd server
npm install
npx wrangler dev       # local at http://localhost:8787
npx wrangler deploy    # publish
```

`GITHUB_REPO` in `server/wrangler.jsonc` sets which repo's latest release the site's "Download for Windows" button serves.

Workers free plan limits are 100k requests a day, and each WebSocket message counts as 1/20 of a request. A squad won't get close.

## Data and credits

- Map art, calibration (`server/public/calibration.json`), extracts, bosses, quests and hazards: [tarkov.dev](https://tarkov.dev) ([MIT](https://github.com/the-hideout/tarkov-dev/blob/main/LICENSE)), PvP data.
- Screenshot and log parsing follows [TarkovMonitor](https://github.com/the-hideout/TarkovMonitor) (MIT).
- Extract keys and gear limits (paracord, no backpack, ...) aren't in the API. The Extracts tab links each map's wiki.

## Ideas for later

- Discord Activity wrapper, so the map launches inside your voice channel.
- Position trail; auto-pick the floor from your height.
