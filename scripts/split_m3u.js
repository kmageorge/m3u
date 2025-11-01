#!/usr/bin/env node
/**
 * Split and professionally organize an M3U playlist into Live channels and VOD playlists.
 * Enhancements:
 * - Preserves metadata (#EXTINF attrs, extra header lines like #EXTVLCOPT)
 * - Adds/normalizes group-title for clean grouping (BBC, ITV, News, Sports, Kids, Movies, etc.)
 * - Cleans titles (remove [tags]/(quality) suffixes) and normalizes naming
 * - Deduplicates channels per group by keeping the best quality/source
 * - Sorts groups and channels alphabetically for a polished experience
 * - Heuristically separates VOD (movies/episodes) from Live
 */

const fs = require('fs');
const path = require('path');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.mpg', '.mpeg', '.ts']);

// Patterns used to infer channel groups by title
const GROUP_PATTERNS = [
  // Broadcasters
  { re: /\b(bbc one|bbc two|bbc three|bbc four|cbbc|cbeebies|bbc scotland)\b/i, group: 'UK / BBC' },
  { re: /\b(itv\s?1|itv\s?2|itv\s?3|itv\s?4|itv\s?x|itv\b)\b/i, group: 'UK / ITV' },
  { re: /\b(channel\s?4|more4|e4|4seven|film4)\b/i, group: 'UK / Channel 4' },
  { re: /\b(channel\s?5|5star|5usa|5select)\b/i, group: 'UK / Channel 5' },
  // Genres
  { re: /\b(\bgb news\b|bbc news|sky news|arise|bloomberg|cnbc|inside crime|iran international|alhiwar|arise news|bloomberg tv|cnbc europe|euro news|euronews|international)\b/i, group: 'UK / News' },
  { re: /\b(sky\s?sports|bt sport|eurosport|premier sports|mutv|horse\s?&?\s?country)\b/i, group: 'UK / Sports' },
  { re: /\b(cartoon|kids|cbeebies|cbbc|nick|disney|boomerang|babytv)\b/i, group: 'UK / Kids' },
  { re: /\b(shop|shopping|gems|gemporia|jewellery|jewelry)\b/i, group: 'UK / Shopping' },
  { re: /\b(movie|movies|film4|great!\s?movies|great!\s?romance|great!\s?mystery|cinema)\b/i, group: 'UK / Movies' },
  { re: /\b(religion|islam|ahlulbayt|iqra|deen\s?tv|faith|loveworld|kicc|iman|eman|hala london|hadi tv)\b/i, group: 'UK / Religion' },
  { re: /\b(music|brit asia|frecuencia musical|afrobeats|mtv)\b/i, group: 'UK / Music' },
  { re: /\b(horse & country|horse and country|hobby|lifestyle)\b/i, group: 'UK / Lifestyle' },
  // Fallthroughs
  { re: /\b(scotland|london|yorkshire|lincolnshire|east|south west|wales|northern ireland)\b/i, group: 'UK / Regional' },
  { re: /\b(arab|iran|turkish|kurdish|french|indonesian|thai|vietnam)\b/i, group: 'UK / International' },
];

function parseArgs(argv) {
  const args = { input: null, liveOut: 'live_channels.m3u', vodOut: 'vod_playlist.m3u' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!args.input) {
      args.input = a;
      continue;
    }
    if (a === '--live-out') {
      args.liveOut = argv[++i];
      continue;
    }
    if (a === '--vod-out') {
      args.vodOut = argv[++i];
      continue;
    }
  }
  if (!args.input) {
    console.error('Usage: node scripts/split_m3u.js <input.m3u> [--live-out channels.m3u] [--vod-out vod.m3u]');
    process.exit(2);
  }
  return args;
}

function parseExtinf(line) {
  // Example: #EXTINF:-1 tvg-id="..." group-title="...",Title
  const m = line.match(/^#EXTINF:([^,]*?)(?:\s([^,]*))?,(.*)$/i);
  if (!m) return null;
  const duration = (m[1] || '').trim();
  const attrsText = (m[2] || '').trim();
  const title = (m[3] || '').trim();
  const attrs = {};
  if (attrsText) {
    // key="value" or key=value pairs separated by spaces
    const re = /(\w[\w-]*?)=("([^"]*)"|([^\s"]+))/g;
    let mm;
    while ((mm = re.exec(attrsText)) !== null) {
      const key = mm[1];
      const val = mm[3] !== undefined ? mm[3] : mm[4];
      attrs[key] = val;
    }
  }
  return { duration, attrs, title };
}

function buildExtinf(duration, attrs, title) {
  const parts = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    // Quote if contains spaces or special chars
    const needsQuote = /[\s,]/.test(String(v));
    parts.push(`${k}=${needsQuote ? '"' + String(v) + '"' : v}`);
  }
  const attrBlock = parts.length ? ' ' + parts.join(' ') : '';
  return `#EXTINF:${duration || '-1'}${attrBlock},${title}`;
}

function inferGroup(title, existingGroup) {
  if (existingGroup && existingGroup.trim()) return existingGroup;
  const t = title.toLowerCase();
  for (const { re, group } of GROUP_PATTERNS) {
    if (re.test(t)) return group;
  }
  return 'UK / Misc';
}

function isVod({ duration, attrs, title }, url) {
  // 1) Explicit video file extensions
  const cleanUrl = (url || '').split('?')[0].split('#')[0];
  const ext = path.extname(cleanUrl).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return true;

  // 2) Duration-based: VOD often has a positive duration; Live is commonly -1
  const d = parseInt(duration, 10);
  if (!Number.isNaN(d) && d > 0) return true;

  // 3) Episode/Season patterns
  const ttl = (title || '').toLowerCase();
  if (/s\d{1,2}e\d{1,2}/i.test(ttl)) return true; // S01E02
  if (/(season\s?\d+|episode\s?\d+)/i.test(ttl)) return true;

  // 4) Groups explicitly marked as VOD/MOVIES/SERIES
  const grp = (attrs['group-title'] || attrs['group'] || '').toLowerCase();
  if (/(\bvod\b|\bmovies?\b|\bseries\b)/i.test(grp) && VIDEO_EXTS.has(ext)) return true;

  return false;
}

// ---------- Professionalization helpers ----------
function cleanTitle(rawTitle) {
  if (!rawTitle) return '';
  let t = rawTitle.trim();
  // Remove quality in parentheses e.g., (1080p), (720p)
  t = t.replace(/\((?:\d{3,4}p|hd|sd)\)/gi, '').trim();
  // Remove bracketed tags e.g., [Geo-blocked], [Not 24/7]
  t = t.replace(/\[[^\]]+\]/g, '').trim();
  // Collapse multiple spaces
  t = t.replace(/\s{2,}/g, ' ').trim();
  // Normalize common typos/casing
  t = t.replace(/Jewelery/gi, 'Jewellery');
  return t;
}

function qualityScoreFrom(title, url) {
  let score = 0;
  const t = (title || '').toLowerCase();
  const u = (url || '').toLowerCase();
  if (/1080p|\bfull\s?hd\b/.test(t) || /1080/.test(u)) score += 30;
  if (/720p|\bhd\b/.test(t) || /720/.test(u)) score += 20;
  if (/576p|480p|sd/.test(t) || /576|480/.test(u)) score += 10;
  if (u.includes('.m3u8')) score += 8;
  if (u.includes('.mpd')) score += 4;
  if (u.startsWith('https://')) score += 3;
  if (u.startsWith('http://')) score += 1;
  // Penalize obviously proxied or unstable hosts lightly
  if (/\b(playstop|workers\.dev|bozztv|canlitvapp)\b/.test(u)) score -= 2;
  return score;
}

function splitM3U(inputPath, liveOutPath, vodOutPath) {
  const content = fs.readFileSync(inputPath, 'utf8');
  const lines = content.split(/\r?\n/);

  const liveEntries = [];
  const vodEntries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (!line.startsWith('#EXTINF:')) continue; // skip global headers or unsupported lines

    const parsed = parseExtinf(line);
    if (!parsed) continue;

    // Collect any extra header lines between EXTINF and URL (e.g., #EXTVLCOPT)
    const extraHeaders = [];
    let url = '';
    let j = i + 1;
    for (; j < lines.length; j++) {
      const ln = lines[j].trim();
      if (!ln) continue; // skip blanks
      if (ln.startsWith('#')) {
        // Preserve extra headers like #EXTVLCOPT, #KODIPROP
        if (!ln.startsWith('#EXTINF') && !ln.startsWith('#EXTM3U')) {
          extraHeaders.push(ln);
        }
        continue;
      }
      // Non-comment: assume URL
      url = ln;
      break;
    }
    i = j; // advance outer loop to URL line index

    // Normalize group-title and title
    const cleanedTitle = cleanTitle(parsed.title);
    const group = inferGroup(cleanedTitle, parsed.attrs['group-title'] || parsed.attrs['group']);
    parsed.attrs['group-title'] = group;

    // Optional: set tvg-country if missing
    if (!parsed.attrs['tvg-country']) parsed.attrs['tvg-country'] = 'UK';
    // Optional: set tvg-name if missing (use cleaned title)
    if (!parsed.attrs['tvg-name']) parsed.attrs['tvg-name'] = cleanedTitle;

    const isVodItem = isVod(parsed, url);

    const entry = {
      duration: parsed.duration,
      attrs: parsed.attrs,
      title: cleanedTitle,
      url,
      headers: extraHeaders,
      group,
      score: qualityScoreFrom(parsed.title, url),
      key: `${group}|${cleanedTitle}`.toLowerCase(),
      urlKey: `${url}`
    };

    if (isVodItem) vodEntries.push(entry); else liveEntries.push(entry);
  }

  // Deduplicate by (group,title) keeping best score, also avoid duplicate URLs
  function dedupe(entries) {
    const byKey = new Map();
    const seenUrls = new Set();
    for (const e of entries) {
      if (!e.url) continue;
      if (seenUrls.has(e.urlKey)) continue; // same url already present
      const prev = byKey.get(e.key);
      if (!prev || e.score > prev.score) {
        byKey.set(e.key, e);
      }
      seenUrls.add(e.urlKey);
    }
    return Array.from(byKey.values());
  }

  const liveDeduped = dedupe(liveEntries);
  const vodDeduped = dedupe(vodEntries);

  // Sort by group then title
  function sortEntries(list) {
    return list.sort((a, b) => {
      if (a.group === b.group) return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
      return a.group.localeCompare(b.group, 'en', { sensitivity: 'base' });
    });
  }

  const liveSorted = sortEntries(liveDeduped);
  const vodSorted = sortEntries(vodDeduped);

  // Emit M3U files
  const liveLines = ['#EXTM3U'];
  for (const e of liveSorted) {
    const ext = buildExtinf(e.duration, e.attrs, e.title);
    liveLines.push(ext);
    for (const h of e.headers) liveLines.push(h);
    liveLines.push(e.url);
  }
  const vodLines = ['#EXTM3U'];
  for (const e of vodSorted) {
    const ext = buildExtinf(e.duration, e.attrs, e.title);
    vodLines.push(ext);
    for (const h of e.headers) vodLines.push(h);
    vodLines.push(e.url);
  }

  fs.writeFileSync(liveOutPath, liveLines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(vodOutPath, vodLines.join('\n') + '\n', 'utf8');
}

if (require.main === module) {
  const { input, liveOut, vodOut } = parseArgs(process.argv);
  splitM3U(path.resolve(input), path.resolve(liveOut), path.resolve(vodOut));
  console.log(`Done. Live: ${path.resolve(liveOut)}\n      VOD: ${path.resolve(vodOut)}`);
}
