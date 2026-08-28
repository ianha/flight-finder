# flight-deal-finder

Personal watcher for business-class award seats between **Toronto (YYZ) / Chicago (ORD) / Vancouver (YVR) / Los Angeles (LAX)** and **Tokyo (NRT/HND)**, priced in points on **Aeroplan, BA Avios, Qatar Avios, and Flying Blue**. It polls continuously, texts you (SMS via Twilio) when it finds:

- a **one-way under 90,000 points**, or
- a **roundtrip pairing under 180,000 points total** (booked as two one-ways; a leg may exceed 90k),

and serves a local web console at `http://127.0.0.1:8787` for browsing deals, a price calendar, and editing configuration. See [PRD.md](PRD.md) for full requirements.

**Award availability data provided by [seats.aero](https://seats.aero)** (Partner API, Pro subscription required).

## Setup

### 1. seats.aero Pro + API key

1. Subscribe to [seats.aero Pro](https://seats.aero) — start with the **monthly** plan ($9.99).
2. Immediately check **Settings → API**: the Partner API tab is granted at seats.aero's discretion (geo-restricted for some accounts). If you don't see it, contact them before annualizing.
3. Copy the `pro_…` key.

### 2. Twilio account for SMS

1. Create a [Twilio](https://www.twilio.com) account and buy an SMS-capable phone number (~US$1.15/mo + per-message fees; US-bound texts may require A2P 10DLC registration).
2. Copy the **Account SID** and **Auth Token** from the Twilio Console into `.env`.
3. Put your Twilio number in `config.yaml` under `sms.from`, and the number(s) to text under `sms.to` — E.164 format, e.g. `+14165551234`.

### 3. Install

```bash
npm install && npm run build
```

```bash
cp config.example.yaml config.yaml && cp .env.example .env
```

Fill both secrets into `.env`. Everything else (routes, thresholds, stay window, polling interval) lives in `config.yaml` — every key is optional and documented in the example file, and all of it is editable later in the web UI.

### 4. First-run checks

```bash
node dist/cli.js test-sms
```

```bash
node dist/cli.js routes-audit
```

```bash
node dist/cli.js probe-british
```

```bash
node dist/cli.js search --dry-run
```

- `test-sms` sends a canned digest through Twilio end to end — check your phone.
- `routes-audit` shows how far out seats.aero actually crawls each of your routes (`NumDaysOut`); deals beyond a route's horizon cannot be seen.
- `probe-british` answers whether the undocumented BA Avios source works in the API. If it reports SUPPORTED, add `british` to `search.sources` in config — BA pricing then stops being an estimate.
- `search --dry-run` runs a full cycle and prints the digest without sending an SMS or recording alert state.

### 5. Install the always-on service (launchd)

```bash
which node
```

Edit `launchd/com.ianha.deal-finder.plist` and replace `/usr/local/bin/node` with that path, then:

```bash
cp launchd/com.ianha.deal-finder.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.ianha.deal-finder.plist
```

Verify:

```bash
launchctl list | grep deal-finder
```

```bash
tail -f data/deal-finder.log
```

Open **http://127.0.0.1:8787** — the console is localhost-only (the machine is the auth boundary; there is no login).

> **Sleep note:** a sleeping Mac doesn't poll; missed intervals coalesce into one run at wake. For a lid-closed MacBook keep "Prevent automatic sleeping when the display is off" enabled (or use `caffeinate`).

## CLI

| Command | What it does |
|---|---|
| `deal-finder serve` | Always-on service: internal scheduler + web console (what launchd runs) |
| `deal-finder search [--dry-run] [--json]` | One poll cycle now; dry-run prints the digest, sends nothing, records nothing |
| `deal-finder test-sms` | Sends a canned digest through Twilio |
| `deal-finder routes-audit` | Per-route crawl-horizon report |
| `deal-finder probe-british` | Tests the undocumented `british` source |
| `deal-finder status` | Quota, last cycle, data freshness, recent alerts |

Global flags: `--config <path>` (default `./config.yaml`), `--verbose`.

## How it works

Every cycle (default: 2 h): two paginated cached-search calls cover the whole grid in both directions → records land in SQLite (`data/deals.db`) → one-way and roundtrip detection runs with your thresholds → new/improved deals are deduped (re-alert only on a ≥15% price drop vs the best ever alerted, or reappearance after ≥7 days gone) → qualifying deals get flight-level detail lookups (capped, budget-aware) → one compact digest SMS (full detail in the console). Alert state is committed only after a successful send, so failures retry naturally next cycle.

**Quota discipline:** the API allows 1,000 calls/day (midnight UTC reset). The app self-caps at `api.dailyCallBudget` (900), watches the `X-RateLimit-Remaining` header, skips detail lookups below `api.reserveCalls`, and skips whole cycles rather than exhausting the quota.

**BA Avios estimates:** BA Avios is not a documented API source. Oneworld space (JAL/AA nonstops) is detected via the `american`/`alaska` sources and priced from static 2026 Avios distance-band charts (Qatar's chart is verified; BA's long-haul bands are ~+10% post-Dec-2025 community estimates). These deals are loudly flagged **~est** everywhere — JAL's 2026 fuel surcharges (≈US$370–440/sector) are *not* included. Run `probe-british` periodically to check whether direct BA data has become available.

## Caveats (read before booking)

- Cached data is minutes-to-hours stale; phantom availability happens. **Always verify on the program's own site** — every alert links out and shows data age.
- Points prices exclude taxes/surcharges; the `qatar` source returns no tax data at all.
- Air Canada-operated Aeroplan awards and Flying Blue are dynamically priced — cached prices for them drift fastest. The `aeroplan` source is also deliberately rate-limited by seats.aero (Air Canada's ongoing lawsuit against them); expect it to lag, and know it could disappear entirely.
- API access is revocable and discretionary; the app degrades gracefully (read-only console on existing data).

## Development

```bash
npm test
```

```bash
npm run dev -- search --dry-run
```

```bash
npm run dev:web
```

The entire pipeline is testable without an API key: `test/mockServer.ts` plays seats.aero (pagination, 400/429/5xx modes), fixtures build realistic records, and 55 tests cover detection boundaries, pairing, dedupe, the HTTP API, and comment-preserving config writes. `npm run dev:web` serves the UI on :5173 proxying `/api` to :8787.

### Manual UI checklist (after `npm run build`, against real or mock data)

- Each tab renders; deal filters change the table; estimate badges show on proxy deals
- Calendar day click opens the day panel; bands match the legend
- Config: edit → Save → toast → `config.yaml` diff shows the change *and* your comments intact; invalid input shows an inline field error and blocks save; interval edit changes "next scheduled run" on Status
- Run Now disables while a cycle runs and the history gains a `manual` row
- `curl http://<your-lan-ip>:8787/api/health` from another machine fails (loopback-only)
- seats.aero attribution visible on every screen and SMS

## Data & state

Everything lives in `data/deals.db` (SQLite, WAL): availability snapshots, alert history with dedupe anchors, cycle history, and the API-call ledger. Deleting it is safe — the next cycle rebuilds, though alert dedupe history is lost (expect one burst of re-alerts).
