# Library Management Roadmap

A phased plan to move from a basic library to a robust, provider-centric, quality-aware catalog.

## Phase 1 – Foundations (Low Risk)

- Data model extensions (backward compatible):
  - Providers: `{ id, name, type: 'm3u'|'xtream'|'dir', url, refreshCron, enabled }`
  - Sources: attach to channels/movies/episodes: `{ id, itemId, kind:'channel'|'movie'|'episode', url, providerId, quality:{height,codec,audio}, lang, tags:[], priority, enabled }`
  - Health: per source `{ lastCheckedAt, status:'ok'|'fail'|'unstable', lastError, avgStartupMs, successRate }`
  - Tags: freeform labels on items and sources
- API
  - `/api/providers` CRUD and refresh trigger
  - `/api/health/check?sourceId=...` and background prober (batch)
- Admin UI
  - Providers tab with manual refresh
  - Item details pane showing all sources with drag-to-reorder priority
  - Faceted filters: provider, status, quality, language, tags
- Player behavior
  - Multi-source fallback: try best quality OK source, then downgrade
- Build
  - Compile `/player` (remove in-browser Babel) and build Tailwind CSS

## Phase 2 – Intelligence & Automation

- Scheduled refresh per provider (cron) with diffing (added/removed/changed)
- Auto-dedupe and merge variants; per-channel preferred logo naming
- Health scoring with quarantine (auto-disable failing sources, auto-retry)
- EPG mapping assistant (auto-match by fuzzy name and country)
- Playback telemetry (startup time, errors) flowing into health stats
- Watch history, favorites, continue watching

## Phase 3 – Quality & Delivery

- Transcode profiles: `mobile-1.5Mbps`, `tv-4Mbps`, `copy` with heuristics
- HLS manifest rewrite for muxing audio-only streams
- Optional proxy delivery mode for Xtream streaming endpoints (not redirect)
- Artwork caching (proxy and size variants) with local disk storage
- RBAC: admin/editor/viewer roles; audit log of edits

## Phase 4 – Scale & Maintenance

- TypeScript refactor of server & admin app; Zod validation for payloads
- Modularize admin UI (components, routes) and add unit tests
- CI: lint/typecheck/test; container image with multi-arch
- Backup/export: snapshot DB, export/import JSON for items/providers

## Acceptance criteria snapshots

- Phase 1: From Admin, I can add 2 providers (M3U + Xtream), refresh them, see multiple sources under a channel, re-order them, and the player falls back if the first fails.
- Phase 2: A channel with a failing source is automatically quarantined after 3 consecutive failures and an email/log entry is created.
- Phase 3: Selecting profile "TV 4Mbps" transcodes a problematic MKV to HLS with an appropriate ladder and audio AAC stereo.
- Phase 4: Repository builds in CI with tests and typechecks, and the player loads without CDN Babel/Tailwind.
