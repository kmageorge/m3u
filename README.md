# m3u utilities

This project now includes a small utility to split and normalize an M3U playlist so IPTV players group channels cleanly and TV shows/movies don't appear under Live.

## Split UK playlist into Live and VOD

- Input: `uk.m3u`
- Outputs:
  - `channels.m3u` – Live channels with `group-title` metadata
  - `vod.m3u` – VOD items (empty if none detected)

### Run

```bash
npm run split
```

or directly:

```bash
node scripts/split_m3u.js uk.m3u --live-out channels.m3u --vod-out vod.m3u
```

### What it does

- Parses `#EXTINF` entries and collects the following URL, preserving extra lines like `#EXTVLCOPT`
- Adds/normalizes `group-title` based on channel title (BBC, ITV, Channel 4, News, Kids, Movies, etc.)
- Writes two playlists:
  - Live: everything classified as live
  - VOD: entries identified by video file extensions, positive durations, or episode/season patterns (e.g., `S01E02`)

If you want different group names or to fine-tune classification, update `GROUP_PATTERNS` and the logic in `scripts/split_m3u.js`.
