# M3U Studio – Current Architecture (Nov 2025)

This document summarizes the current system, its strengths/limitations, and sets the stage for a richer library management model.

## Overview

- Frontend
  - Admin SPA (React) in `m_3_u_studio_tmdb_powered_playlist_builder.jsx` bundled to `main.js`.
  - Standalone player at `/player` (React via CDN in `player.html`).
  - Video.js is used for playback with proxy and ffmpeg HLS transcode fallback.
- Backend
  - `server.js` (Express + SQLite).
  - User-scoped tables: `settings`, `channels`, `shows`, `movies` with JSON `data` payloads.
  - Hosted outputs: `/playlist.m3u`, `/epg.xml`.
  - Utilities: `/proxy` (streaming with Range + CORS), `/api/logos`, ffmpeg transcode service.
  - Xtream-compatible API: `/player_api.php`, `/xmltv.php`, `/get.php`, `/live|/movie|/series`.

## Data model (today)

- Channels: flat array with `{id, name, url, logo, group, chno, importId}` per user.
- Shows: array with `{tmdbId, title, poster, overview, seasons:[{season,episodes:[{episode,title,url}]}], group, ...}`.
- Movies: array with `{tmdbId, title, poster, overview, url, group, ...}`.
- Playlists (imports): kept in settings as `m3u_channel_imports` with `enabled` flag.

Pros:
- Simple and flexible, idempotent migrations, works offline.
- TMDB metadata enrichments are present.

Limitations:
- Sources are single URLs per item (no variants/fallbacks).
- No provider abstraction (ownership, schedule, refresh policies).
- No per-item health/state (dead link quarantine, last-checked, failure reason).
- Bulk actions exist but no powerful queries, tags, or facets.
- Player build for `/player` is runtime-compilation (Tailwind CDN + Babel), not production-grade.
- Transcode service is ephemeral, not policy-driven (bitrate ladders, profiles).

## Gaps impacting "library management"

- Management granularity: cannot attach multiple sources per asset with priority and automatic fallback.
- Provenance: items don't track which provider/import created them and how to refresh.
- Quality metadata: resolution, codecs, bitrate, language, captions are not modeled.
- Indexing/filtering: search facets by country/language/quality/tags are missing.
- Health: no automated background prober, no retry/triage workflow.
- History: no watch history, favorites, continue-watching.
- Admin UX scale: single mega-React file; hard to evolve.

## Immediate wins

- Add a Provider model and Source model without breaking existing data.
- Persist stream health and quality metrics.
- Add tags and facets (country, language, quality, provider).
- Compile the standalone player and Tailwind for production.

