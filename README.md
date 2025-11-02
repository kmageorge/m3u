# M3U Studio – TMDB‑powered IPTV playlist builder

A full-featured web admin app to import, curate, and export IPTV playlists with rich TMDB metadata for movies and TV shows, EPG mapping, and multi‑playlist management. Includes a small CLI utility to split/normalize raw M3U files.


## Quick start

Prerequisites:
- Node.js 18+ (built‑in fetch is required by the server)
- npm

Install, build, and run:

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000 in your browser.

First‑run admin:
- The server creates a default admin user if none exists:
  - username: `admin`
  - password: `admin123`
  - change this immediately in production (set JWT_SECRET too)


## Features

- Import and manage multiple M3U playlists
  - Preview channels before importing, pick exactly which to include
  - Per‑playlist enable/disable toggle (disabled playlists are excluded from export)
  - Replace file: re‑import a playlist in place without breaking links
  - Rename and delete playlists (deleting removes linked channels)
- Channels admin
  - Search, filter, edit fields (name, URL, logo, group, channel number)
  - Health status placeholders and bulk selection
- TMDB‑powered library
  - Add movies and TV shows with rich TMDB metadata (posters, ratings, genres, runtime, creators/cast, certifications, more)
  - Group movies (by genre/year/group/certification)
  - Refresh metadata: per‑item, bulk selected, or refresh all
  - Delete All Movies / Delete All Shows
- EPG management
  - Manage multiple EPG sources; map channels to IDs (per‑source)
  - Build and host an XMLTV EPG at `/epg.xml`
- Export
  - Build a clean .m3u with channels + library items
  - Hosted playlist endpoint `/playlist.m3u` and EPG endpoint `/epg.xml`
  - Copy or download directly from the UI
 - Playback
   - Built-in web player (at `/player`) with Channels/Movies/Shows and a modal player
   - Automatic ffmpeg HLS transcode fallback for broader codec support
 - Providers (Phase 1)
   - Manage upstream providers (M3U or Xtream) in the Providers tab
   - Enable/disable, refresh (stubbed), and delete providers
   - Foundation for multi-source attachment and health checks
- Admin Settings (Danger Zone)
  - Delete All Channels (also clears imported playlists)
  - Delete All TV Shows
  - Delete All Movies
  - Delete EVERYTHING (all the above)

See docs:
- docs/ARCHITECTURE.md – current architecture and limitations
- docs/ROADMAP.md – phased plan to improve library management


## Environment variables

These are optional but recommended in production:

- `PORT` – server port (default 3000)
- `JWT_SECRET` – secret for auth tokens (default: demo value; set a strong one)
- `PROXY_TIMEOUT` – ms timeout for the `/proxy` endpoint (default 15000)
- `BING_IMAGE_API_KEY` – enables `/api/logos` channel logo search; leave unset to disable

Example:

```bash
export PORT=3000
export JWT_SECRET="please-change-me"
export BING_IMAGE_API_KEY="<your-key>"
npm start
```


## How it works

App structure:
- Frontend React app: `m_3_u_studio_tmdb_powered_playlist_builder.jsx` (bundled to `main.js`)
- Server: `server.js` (Express, SQLite)
- Static shell: `index.html`

Persistence:
- Uses a local SQLite DB file `m3u_studio.db` (auto‑created)
- Data is user‑scoped (multi‑user capable). Admin tools in UI for user management.

Authentication:
- JWT cookies; register/login endpoints; default admin is created on first run
- Admin‑only UI: Users and Settings tabs

Hosted outputs:
- Playlist: `GET /playlist.m3u`
- EPG XML: `GET /epg.xml`
- The UI auto‑syncs current playlist/EPG via `POST /api/playlist` and `POST /api/epg`.

Utility endpoints:
- `GET /proxy?url=<http/https URL>` – simple controlled proxy for CORS‑unsafe resources
- `GET /api/logos?query=<name>&top=8` – channel logo suggestions (requires `BING_IMAGE_API_KEY`)


## API reference (summary)

Authentication
- POST `/api/auth/register` – { username, email, password } → { user, token }
- POST `/api/auth/login` – { username, password } → { user, token }
- POST `/api/auth/logout`
- GET `/api/auth/me` – current user
- POST `/api/auth/change-password` – { currentPassword, newPassword }

Admin (require admin role)
- GET `/api/admin/users` – list users
- POST `/api/admin/users/:id/role` – { role: "user" | "admin" }
- DELETE `/api/admin/users/:id`

Settings (scoped by user; JSON value)
- GET `/api/db/settings/:key`
- POST `/api/db/settings/:key` – { value }

Data tables (scoped by user)
- GET `/api/db/:table` – where table ∈ { channels, shows, movies }
- POST `/api/db/:table` – { items: [] } replaces table contents
- POST `/api/db/:table/add` – { item } upsert a single item
- DELETE `/api/db/:table/:id`

Hosted outputs
- GET `/playlist.m3u` – latest exported M3U
- POST `/api/playlist` – update hosted M3U body
- GET `/epg.xml` – latest exported EPG XML
- POST `/api/epg` – update hosted EPG XML body

Utilities
- GET `/proxy?url=...` – basic HTTP(S) proxy with timeout
- GET `/api/logos?query=...&top=8` – channel logos (requires Bing API key)

Providers and Sources (Phase 1)
- Providers
  - GET `/api/providers` – list providers
  - POST `/api/providers` – create or upsert provider { id?, name, type: "m3u"|"xtream", url?, refreshCron?, enabled }
  - DELETE `/api/providers/:id` – remove provider
  - POST `/api/providers/:id/refresh` – schedule a refresh (stub)
- Sources
  - GET `/api/sources?kind=&itemKey=` – list attached sources (kind: channel|movie|episode; itemKey is your item ID)
  - POST `/api/sources` – create or upsert a source { id?, kind, itemKey, providerId?, url, quality?, lang?, tags?, priority?, enabled? }
  - DELETE `/api/sources/:id` – remove a source

Transcoding
- POST `/api/transcode/start` – { src } → { id, playlistUrl }
- POST `/api/transcode/stop` – { id }
- GET `/transcode/:id/:file` – serves HLS playlist and segments


## Deployment

Production checklist
- Set a strong `JWT_SECRET` and do not commit it
- Place behind a reverse proxy (Nginx/Caddy) with HTTPS
- Persist the SQLite database file `m3u_studio.db` (bind mount or volume)
- Restrict `/proxy` usage (trust boundary) and monitor logs
- Optionally disable `/api/logos` by omitting `BING_IMAGE_API_KEY`

Run as a service (example)

```bash
# Install deps and build once
npm ci
npm run build

# Start
PORT=3000 JWT_SECRET="change-me" node server.js
```

Reverse proxy snippet (Nginx example)

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Backups
- Regularly back up `m3u_studio.db` while the service is stopped or use SQLite‑safe snapshotting.

### Transcode fallback (ffmpeg)

To maximize audio/video compatibility, the player can fall back to a server-side HLS transcode powered by ffmpeg when direct playback fails (e.g., unsupported codecs like E-AC-3/DTS in some browsers):

- The web player attempts direct playback first; on error, it requests `/api/transcode/start` and switches to the returned HLS stream.
- Transcode sessions auto-clean after inactivity; closing the modal stops the active session.

Environment variables to tune transcoding:
- `TRANSCODE_COPY_VIDEO=1` – try video copy instead of re-encode (if compatible)
- `TRANSCODE_COPY_AUDIO=1` – try audio copy instead of AAC
- `FFMPEG_PRESET=veryfast` – x264 preset (ultrafast…slower)
- `HLS_TIME=4` – segment duration seconds
- `HLS_LIST_SIZE=6` – number of segments in playlist

Note: ffmpeg must be installed and available on the server PATH.


## Using the app

1) Import channels
- Click Import and choose an M3U file
- Use the preview modal to select the channels you want
- The import is recorded as a playlist; you can rename, disable, replace, or delete it later

2) Manage playlists
- Toggle Enabled to exclude/include its channels from the exported .m3u and EPG
- Use Replace file to re‑import in place (keeps the playlist ID)

3) Add movies and shows
- Search and add via TMDB; rich fields are pulled automatically
- Use the refresh buttons to update metadata over time

4) EPG
- Add one or more EPG sources and map channel IDs
- Copy hosted URLs from the Export tab for your IPTV player

5) Export
- Copy or download `.m3u` and `epg.xml` from the Export tab
- Or point your player at the hosted endpoints

6) Admin Settings
- Bulk delete data when needed (double‑confirm prompts for safety)

See also: `ENHANCED_UI_GUIDE.md` for a visual tour of the Movies/Shows UI with badges, profiles, and list/grid views.


## CLI utility: split and normalize an M3U

This repository includes a utility to split a raw playlist into Live and VOD for cleaner grouping.

Input: `uk.m3u`
Outputs:
- `channels.m3u` – cleaned Live channels with normalized `group-title`
- `vod.m3u` – likely VOD entries (movies/episodes)

Run:

```bash
npm run split
```

or directly:

```bash
node scripts/split_m3u.js uk.m3u --live-out channels.m3u --vod-out vod.m3u
```

What it does:
- Parses `#EXTINF` entries, preserves extra header lines (e.g., `#EXTVLCOPT`)
- Normalizes groups (BBC, ITV, Channel 4, News, Kids, Movies, etc.)
- Deduplicates by (group,title), keeps best‑quality source
- Sorts groups and channels for a polished experience
- Heuristically separates VOD (file extensions, positive durations, SxxExx)

Tune behavior by editing `GROUP_PATTERNS` and logic in `scripts/split_m3u.js`.


## Troubleshooting

- Build issues: ensure Node 18+ and run `npm install` before `npm run build`
- 401/403 from APIs: you must be logged in; use default admin on first run
- Playlist/EPG blank: check the Export tab; ensure at least one playlist is enabled
- Logos API empty: set `BING_IMAGE_API_KEY` or leave blank to disable
- Database: the `m3u_studio.db` SQLite file is local; back it up regularly


## License

ISC
