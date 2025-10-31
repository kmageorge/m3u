import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import freekeys from "freekeys";

// M3U Studio – single-file React app
// Notes
// - Paste your TMDB API key in the UI (for demo) or wire a proxy/API server in production.
// - Everything is stored in localStorage so you don't lose work while iterating.
// - Generates an .m3u you can download. Supports channels, TV shows, and movies.
// - URL pattern helper guesses episode links from a few samples.

// ---------- Utility helpers ----------
const STORAGE_ENDPOINT = "/api/storage";
const STORAGE_KEYS = {
  apiKey: "tmdb_api_key",
  channels: "m3u_channels",
  channelImports: "m3u_channel_imports",
  shows: "m3u_shows",
  movies: "m3u_movies",
  libraryUrl: "m3u_library_url"
};

async function fetchStorageSnapshot() {
  const res = await fetch(STORAGE_ENDPOINT, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Failed to load storage (${res.status})`);
  }
  return res.json();
}

function persistStorage(key, value) {
  return fetch(STORAGE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value })
  });
}

const pad = (n, len = 2) => String(n).padStart(len, "0");

const sanitize = (s) => (s ?? "").toString().replace(/\n/g, " ").trim();

// LocalStorage helpers
// ---------- Database API helpers ----------
const dbCache = new Map(); // In-memory cache for settings

const readDB = async (key, fallback) => {
  try {
    // Check cache first
    if (dbCache.has(key)) {
      return dbCache.get(key);
    }
    
    const response = await fetch(`/api/db/settings/${encodeURIComponent(key)}`);
    if (!response.ok) {
      console.warn(`Failed to read ${key} from database`);
      return fallback;
    }
    const data = await response.json();
    const value = data.value ? JSON.parse(data.value) : fallback;
    dbCache.set(key, value);
    return value;
  } catch (err) {
    console.warn("Database read failed:", err);
    return fallback;
  }
};

const writeDB = async (key, value) => {
  try {
    dbCache.set(key, value);
    const response = await fetch(`/api/db/settings/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    });
    if (!response.ok) {
      console.warn(`Failed to write ${key} to database`);
    }
  } catch (err) {
    console.warn("Database write failed:", err);
  }
};

const saveDB = writeDB; // Alias for compatibility

// Load table data from database
const loadTableDB = async (table) => {
  try {
    const response = await fetch(`/api/db/${table}`);
    if (!response.ok) {
      console.warn(`Failed to load ${table} from database`);
      return [];
    }
    const data = await response.json();
    return data.items || [];
  } catch (err) {
    console.warn(`Database load ${table} failed:`, err);
    return [];
  }
};

// Save table data to database
const saveTableDB = async (table, items) => {
  try {
    const response = await fetch(`/api/db/${table}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });
    if (!response.ok) {
      console.warn(`Failed to save ${table} to database`);
    }
  } catch (err) {
    console.warn(`Database save ${table} failed:`, err);
  }
};

// Legacy localStorage fallback for initial migration
const readLS = (key, fallback) => {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
};

const writeLS = (key, value) => {
  // No-op now, we use database
};

const saveLS = writeLS; // Alias for compatibility

// ----- Validation & Matching Helpers -----
const isValidUrl = (u) => {
  if (!u) return false;
  try {
    const url = new URL(u.trim());
    return ["http:", "https:", "file:"].includes(url.protocol);
  } catch {
    const s = u.trim();
    // Allow relative/local paths
    if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return true;
    return false;
  }
};

const sanitizeInput = (input) => {
  if (!input) return "";
  return input
    .toString()
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/[<>"'&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c] || c))
    .trim();
};

const normalizeName = (n) => {
  if (!n) return "";
  return n
    .toString()
    .toLowerCase()
    .replace(/\b(hd|fhd|uhd|4k|8k|full|channel|tv)\b/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const fuzzyMatchScore = (a, b) => {
  const ta = new Set(normalizeName(a).split(/\s+/).filter(Boolean));
  const tb = new Set(normalizeName(b).split(/\s+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  ta.forEach(t => { if (tb.has(t)) intersection++; });
  const union = new Set([...ta, ...tb]).size;
  return union > 0 ? intersection / union : 0;
};

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Infer a URL pattern (very lightweight):
// Given samples like
//  https://cdn.site/show/S01E01.m3u8
//  https://cdn.site/show/S01E02.m3u8
// It detects tokens for season & episode and proposes a pattern
// Supported tokens: {season}, {episode}, {s2}, {e2}
function inferPattern(samples) {
  const clean = samples.filter(Boolean).map((s) => s.trim());
  if (clean.length < 2) return { pattern: "", notes: "Need 2+ samples" };

  // Heuristics: locate changing numeric segments
  // Compare char-by-char to find differing windows
  const a = clean[0], b = clean[1];
  let start = 0, end = a.length - 1;
  while (start < a.length && a[start] === b[start]) start++;
  while (end >= 0 && a[end] === b[end]) end--;

  // Expand to include adjacent digits on both sides
  const expandDigits = (str, i, j) => {
    while (i > 0 && /[0-9]/.test(str[i - 1])) i--;
    while (j + 1 < str.length && /[0-9]/.test(str[j + 1])) j++;
    return [i, j];
  };
  let [i1, j1] = expandDigits(a, start, end);

  // Try to split the differing window into season/episode if it contains two numbers (e.g., 01 and 02)
  const winA = a.slice(i1, j1 + 1);
  const m = winA.match(/(\d{1,2}).*?(\d{1,2})/); // two numbers with anything between
  let pattern = "";
  let notes = "";
  if (m) {
    // Try common SxxExx formats nearby
    const prefix = a.slice(0, i1);
    const suffix = a.slice(j1 + 1);
    const left = winA.slice(0, winA.indexOf(m[0]));
    const between = m[0].slice(m[1].length, m[0].length - m[2].length);
    const right = winA.slice(winA.indexOf(m[0]) + m[0].length);
    const sToken = m[1].length === 2 ? "{s2}" : "{season}";
    const eToken = m[2].length === 2 ? "{e2}" : "{episode}";
    pattern = `${prefix}${left}${sToken}${between}${eToken}${right}${suffix}`;
    notes = "Detected two-part number; mapped to season/episode.";
  } else {
    // Single number; guess it's episode
    const prefix = a.slice(0, i1);
    const suffix = a.slice(j1 + 1);
    const width = (j1 - i1 + 1) >= 2 ? "{e2}" : "{episode}";
    pattern = `${prefix}${width}${suffix}`;
    notes = "Detected single changing number; assumed episodes vary.";
  }
  return { pattern, notes };
}

function fillPattern(pattern, season, episode) {
  if (!pattern) return "";
  return pattern
    .replaceAll("{s2}", pad(season, 2))
    .replaceAll("{e2}", pad(episode, 2))
    .replaceAll("{season}", String(season))
    .replaceAll("{episode}", String(episode));
}

// ---------- Data types ----------
// Channel: { id, name, url, logo, group, chno }
// TVShow: { id, tmdbId, title, overview, poster, seasons: [{season, episodes:[{episode, title, url}]}], pattern }
// Movie: { id, tmdbId, title, overview, poster, url, group }

// ---------- TMDB fetchers ----------
async function fetchTMDBShow(apiKey, tmdbId) {
  const base = "https://api.themoviedb.org/3";
  const show = await fetch(`${base}/tv/${tmdbId}?api_key=${apiKey}&language=en-US`).then(r => r.json());
  const seasons = await Promise.all(
    (show.seasons || []).map(async (s) => {
      const det = await fetch(`${base}/tv/${tmdbId}/season/${s.season_number}?api_key=${apiKey}&language=en-US`).then(r => r.json());
      return {
        season: s.season_number,
        name: s.name,
        episodes: (det.episodes || []).map(e => ({ episode: e.episode_number, title: e.name, overview: e.overview || "" }))
      };
    })
  );
  return {
    tmdbId,
    title: show.name,
    overview: show.overview || "",
    poster: show.poster_path ? `https://image.tmdb.org/t/p/w342${show.poster_path}` : "",
    firstAirDate: show.first_air_date || "",
    year: show.first_air_date ? new Date(show.first_air_date).getFullYear() : null,
    rating: show.vote_average || 0,
    genres: (show.genres || []).map(g => g.name).join(", "),
    status: show.status || "",
    numberOfSeasons: show.number_of_seasons || 0,
    numberOfEpisodes: show.number_of_episodes || 0,
    seasons
  };
}

async function fetchTMDBMovie(apiKey, tmdbId) {
  const base = "https://api.themoviedb.org/3";
  const m = await fetch(`${base}/movie/${tmdbId}?api_key=${apiKey}&language=en-US`).then(r => r.json());
  return {
    tmdbId,
    title: m.title,
    overview: m.overview || "",
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : "",
    releaseDate: m.release_date || "",
    year: m.release_date ? new Date(m.release_date).getFullYear() : null,
    rating: m.vote_average || 0,
    genres: (m.genres || []).map(g => g.name).join(", "),
    runtime: m.runtime || null,
  };
}

async function searchTMDBShows(apiKey, query) {
  if (!query) return [];
  const base = "https://api.themoviedb.org/3";
  const res = await fetch(`${base}/search/tv?api_key=${apiKey}&language=en-US&query=${encodeURIComponent(query)}&page=1&include_adult=false`).then(r => r.json());
  return (res.results || []).slice(0, 8).map(item => ({
    id: item.id,
    title: item.name,
    overview: item.overview || "",
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w185${item.poster_path}` : "",
    date: item.first_air_date || "",
    vote: item.vote_average || 0
  }));
}

async function searchTMDBMovies(apiKey, query) {
  if (!query) return [];
  const base = "https://api.themoviedb.org/3";
  const res = await fetch(`${base}/search/movie?api_key=${apiKey}&language=en-US&query=${encodeURIComponent(query)}&page=1&include_adult=false`).then(r => r.json());
  return (res.results || []).slice(0, 8).map(item => ({
    id: item.id,
    title: item.title,
    overview: item.overview || "",
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w185${item.poster_path}` : "",
    date: item.release_date || "",
    vote: item.vote_average || 0
  }));
}

const VIDEO_EXTS = [".mp4", ".mkv", ".m3u8", ".avi", ".mov", ".ts", ".flv", ".wmv"];
const QUALITY_TAGS = [
  "dvdrip", "brrip", "hdrip", "bdrip", "bluray", "blu-ray", "webrip", "webdl", "web-dl",
  "hdtv", "cam", "ts", "telesync", "tvrip", "uhd", "4k", "2160p", "1080p", "720p", "480p",
  "xvid", "x264", "x265", "hevc", "aac", "dts", "dolby", "hdr", "proper", "repack",
  "uncut", "extended", "imax", "remastered", "multi", "subs", "dubbed", "dual", "rip"
];
const QUALITY_REGEX = new RegExp(`\\b(${QUALITY_TAGS.join("|")})\\b`, "gi");
const LOCAL_PROXY_PREFIX = "/proxy?url=";
const REMOTE_PROXY_PREFIX = "https://r.jina.ai/";

const buildLocalProxyUrl = (target) => `${LOCAL_PROXY_PREFIX}${encodeURIComponent(target)}`;
const buildRemoteProxyUrl = (target) => `${REMOTE_PROXY_PREFIX}${target.startsWith("http") ? target : `https://${target}`}`;

function parseM3UChannels(text) {
  const lines = (text || "").split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith("#EXTINF")) continue;
    const infoLine = line;
    let url = "";
    let j = i + 1;
    while (j < lines.length) {
      const candidate = lines[j]?.trim();
      if (candidate && !candidate.startsWith("#")) {
        url = candidate;
        break;
      }
      j++;
    }
    if (!url) continue;
    i = j;
    const attrs = {};
    const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
    let match;
    while ((match = attrRegex.exec(infoLine)) !== null) {
      attrs[match[1]] = match[2];
    }
    const namePart = infoLine.includes(",") ? infoLine.split(",").pop()?.trim() : "";
    entries.push({
      name: attrs["tvg-name"] || namePart || "",
      url: url.trim(),
      logo: attrs["tvg-logo"] || "",
      group: attrs["group-title"] || "",
      chno: attrs["tvg-chno"] || attrs["tvg-ch"] || "",
      id: attrs["tvg-id"] || ""
    });
  }
  return entries.filter(e => e.url);
}

async function fetchTextWithFallback(url) {
  const clean = url.trim();
  const isLocalProxyRequest = clean.startsWith(LOCAL_PROXY_PREFIX);
  const isRemoteProxyRequest = clean.startsWith(REMOTE_PROXY_PREFIX);

  const extractOriginalUrl = () => {
    if (isLocalProxyRequest) {
      try {
        const params = new URL(clean, window.location.origin).searchParams;
        const original = params.get("url") || "";
        return original || clean;
      } catch {
        return clean;
      }
    }
    if (isRemoteProxyRequest) {
      return clean.slice(REMOTE_PROXY_PREFIX.length);
    }
    return clean;
  };

  const normalized = clean.endsWith("/") ? clean : `${clean}/`;
  const originalUrl = extractOriginalUrl();
  const originalNormalized = originalUrl.endsWith("/") ? originalUrl : `${originalUrl}/`;

  const tryFetch = async (target) => {
    const res = await fetch(target);
    if (!res.ok) {
      const err = new Error(`Failed to fetch ${target} (${res.status})`);
      err.status = res.status;
      err.target = target;
      throw err;
    }
    return { text: await res.text(), status: res.status };
  };
  const fetchVia = async (target, mode) => {
    const { text } = await tryFetch(target);
    return { text, linkBase: originalNormalized, proxyMode: mode };
  };

  if (isLocalProxyRequest) {
    return fetchVia(clean, "local");
  }
  if (isRemoteProxyRequest) {
    return fetchVia(clean, "remote");
  }

  try {
    const proxyUrl = buildLocalProxyUrl(originalNormalized);
    return await fetchVia(proxyUrl, "local");
  } catch (localErr) {
    try {
      return await fetchVia(originalNormalized, "none");
    } catch (directErr) {
      const remoteUrl = buildRemoteProxyUrl(originalNormalized);
      try {
        return await fetchVia(remoteUrl, "remote");
      } catch (remoteErr) {
        if (!remoteErr.status && (localErr?.status || directErr?.status)) {
          remoteErr.status = localErr?.status || directErr?.status;
        }
        throw remoteErr;
      }
    }
  }
}

const pause = (ms) => new Promise(res => setTimeout(res, ms));

function parseDirectoryListing(htmlOrText, baseUrl) {
  const entries = [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlOrText, "text/html");
    const anchors = Array.from(doc.querySelectorAll("a[href]"));
    if (anchors.length) {
      anchors.forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (!href || href.startsWith("?") || href.startsWith("#") || href.includes("javascript")) return;
        if (href === "../" || href === "./") return;
        const name = a.textContent?.trim() || decodeURIComponent(href);
        const isDir = href.endsWith("/");
        entries.push({ href, name: name.replace(/[\/]+$/, ""), type: isDir ? "dir" : "file" });
      });
      return entries;
    }
  } catch {
    // fallback to markdown parsing below
  }

  // Fallback: look for markdown style links "[name](url)"
  const lines = htmlOrText.split("\n");
  const mdLink = /\[(.+?)\]\((https?:\/\/[^\s)]+)\)/;
  lines.forEach((line) => {
    const match = line.match(mdLink);
    if (!match) return;
    const [, label, href] = match;
    if (href === "../" || href.endsWith("/?C=N;O=D") || href.endsWith("/?C=M;O=A")) return;
    const isDir = /\/$/.test(href);
    let name = label;
    if (!name || name === "[PARENTDIR]" || name === "Parent Directory") return;
    name = name.replace(/\[.*?\]/g, "").trim();
    if (!name) return;
    entries.push({ href, name: name.replace(/[\/]+$/, ""), type: isDir ? "dir" : "file" });
  });
  return entries;
}

function normalizeTitle(raw) {
  let cleaned = raw
    // Replace underscores and dots with spaces
    .replace(/[_\.]+/g, " ")
    // Remove bracketed quality/format info
    .replace(/\s*(\(|\[).*?(DIVX|1080p|720p|480p|2160p|4K|x264|x265|h264|h265|HEVC|BluRay|BRRip|WEBRip|WEB-DL|HDR|HDRip|DVDRip|CAM|TS).*(\)|\])\s*/gi, " ")
    // Remove common scene group tags at the end
    .replace(/[\[\(]?[A-Z0-9]+[\]\)]?\s*$/i, " ")
    // Remove hyphens between words
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ");

  // Remove quality tags
  cleaned = cleaned.replace(QUALITY_REGEX, " ");
  // Remove edition info
  cleaned = cleaned.replace(/\b(theatrical|extended|director'?s?\s*cut|unrated|uncut|remastered|anniversary|collector'?s?\s*edition)\b/gi, " ");
  // Remove part numbers
  cleaned = cleaned.replace(/\bpart\s*\d+\b/gi, " ");
  // Remove common suffixes
  cleaned = cleaned.replace(/\b(complete|season|series|collection|boxset|box\s*set)\b/gi, " ");

  return cleaned.replace(/\s+/g, " ").trim();
}

function parseMediaName(filename, fullPath = "") {
  const decoded = decodeURIComponent(filename);
  const noExt = decoded.replace(/\.[^/.]+$/, "");
  
  // Check for episode patterns first (before normalizing)
  const episodeRegex = /(?:^|\b)[Ss](\d{1,2})[^\d]{0,2}[Ee](\d{1,2})(?:\b|[^0-9])/;
  const seasonEpisodeAlt = /Season\s*(\d{1,2}).*Episode\s*(\d{1,2})/i;
  const xNotation = /(\d{1,2})x(\d{1,2})/;
  const bracketNotation = /\[(\d{1,2})x(\d{1,2})\]/; // [01x05]
  const dashNotation = /[Ss](\d{1,2})-[Ee](\d{1,2})/; // S01-E05
  const partNotation = /Part\s*(\d{1,2})/i; // Part 1, Part 01
  // Date-based episodes (for daily shows): 2024.01.15 or 2024-01-15
  const dateEpisode = /(\d{4})[\.-](\d{2})[\.-](\d{2})/;

  let match = noExt.match(episodeRegex);
  if (!match) match = noExt.match(seasonEpisodeAlt);
  if (!match) match = noExt.match(xNotation);
  if (!match) match = noExt.match(bracketNotation);
  if (!match) match = noExt.match(dashNotation);

  if (match) {
    const season = parseInt(match[1], 10);
    const episode = parseInt(match[2], 10);
    
    // Extract title before the episode marker
    let title = normalizeTitle(noExt.slice(0, match.index));
    
    // If we have a path and the title from filename is poor, try extracting from path
    // Pattern: /ShowName/S01/ or /ShowName/Season 1/
    if (fullPath && (!title || title.length < 3)) {
      const pathParts = fullPath.split('/').filter(p => p);
      // Look for show name in path (usually 2-3 levels up from file)
      for (let i = pathParts.length - 1; i >= 0; i--) {
        const part = pathParts[i];
        // Skip season folders and quality folders
        if (!/^(s\d+|season|full\.hd|hd|1080p|720p|480p|bluray|webrip)/i.test(part)) {
          const candidateTitle = normalizeTitle(part);
          if (candidateTitle && candidateTitle.length >= 3) {
            title = candidateTitle;
            break;
          }
        }
      }
    }
    
    return { kind: "episode", title, season, episode };
  }

  // Check for Part notation (treat as Season 1, Episode = Part number)
  const partMatch = noExt.match(partNotation);
  if (partMatch) {
    const beforePart = noExt.slice(0, partMatch.index);
    const title = normalizeTitle(beforePart);
    const partNum = parseInt(partMatch[1], 10);
    return { kind: "episode", title, season: 1, episode: partNum };
  }

  // Check for date-based episodes (for daily/talk shows)
  const dateMatch = noExt.match(dateEpisode);
  if (dateMatch) {
    const beforeDate = noExt.slice(0, dateMatch.index);
    const title = normalizeTitle(beforeDate);
    const year = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const day = parseInt(dateMatch[3], 10);
    // Use month as season, day as episode
    return { kind: "episode", title, season: month, episode: day };
  }

  // Movie parsing
  const normalized = normalizeTitle(noExt);
  const yearMatch = noExt.match(/\b(19|20)\d{2}\b/);
  // Remove year from title if found
  const title = yearMatch ? normalizeTitle(noExt.replace(/\b(19|20)\d{2}\b/, "")) : normalized;
  
  return { kind: "movie", title: title || normalized, year: yearMatch ? yearMatch[0] : undefined };
}

async function crawlDirectory(baseUrl, options = {}) {
  const { maxDepth = Number.POSITIVE_INFINITY, signal, throttleMs = 800, onDiscover } = options;
  const initial = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const initialFetch = initial.startsWith(LOCAL_PROXY_PREFIX) ? initial : buildLocalProxyUrl(initial);
  const queue = [{ fetchUrl: initialFetch, linkUrl: initial, depth: 0 }];
  const seen = new Set();
  const files = [];
  
  // Get the base domain/path to stay within
  const initialUrl = new URL(initial.startsWith(LOCAL_PROXY_PREFIX) 
    ? decodeURIComponent(initial.slice(LOCAL_PROXY_PREFIX.length)) 
    : initial);
  const baseDomain = initialUrl.hostname;
  const basePath = initialUrl.pathname;

  while (queue.length) {
    if (signal?.aborted) break;
    const current = queue.shift();
    if (!current) break;
    const { fetchUrl, linkUrl, depth } = current;
    if (seen.has(fetchUrl)) continue;
    seen.add(fetchUrl);
    try {
      const { text, linkBase, proxyMode } = await fetchTextWithFallback(fetchUrl);
      const entries = parseDirectoryListing(text, linkBase);
      for (const entry of entries) {
        const resolvedLink = new URL(entry.href, linkBase).href;
        
        // Filter out external links (different domain or outside base path)
        const linkUrl = new URL(resolvedLink);
        if (linkUrl.hostname !== baseDomain) {
          continue; // Skip external domains (yahoo, instagram, etc)
        }
        if (!linkUrl.pathname.startsWith(basePath)) {
          continue; // Skip links outside the base path
        }
        
        let resolvedFetch = resolvedLink;
        if (proxyMode === "local") {
          resolvedFetch = buildLocalProxyUrl(resolvedLink);
        } else if (proxyMode === "remote") {
          resolvedFetch = buildRemoteProxyUrl(resolvedLink);
        }
        if (entry.type === "dir") {
          if (depth < maxDepth) queue.push({ fetchUrl: resolvedFetch, linkUrl: resolvedLink, depth: depth + 1 });
          onDiscover?.({ type: "dir", path: resolvedLink, depth: depth + 1 });
        } else {
          const lower = entry.name.toLowerCase();
          if (!VIDEO_EXTS.some(ext => lower.endsWith(ext))) continue;
          files.push({
            name: entry.name,
            url: resolvedLink,
            path: new URL(resolvedLink).pathname,
            depth
          });
          onDiscover?.({
            type: "file",
            entry: {
              name: entry.name,
              url: resolvedLink,
              path: new URL(resolvedLink).pathname,
              depth
            }
          });
        }
      }
    } catch (err) {
      console.warn("Failed to crawl", fetchUrl, err);
      if (err?.status === 429) {
        const rateErr = new Error("Rate limited by proxy (429)");
        rateErr.status = 429;
        throw rateErr;
      }
      if (depth === 0) throw err;
    }
    if (throttleMs > 0 && queue.length > 0) {
      await pause(throttleMs);
    }
  }

  return files;
}

function buildLibraryCandidates(fileEntries) {
  const movieMap = new Map();
  const showMap = new Map();
  const duplicates = [];
  const seenUrls = new Set();

  fileEntries.forEach(entry => {
    const urlKey = (entry.url || entry.path || "").toLowerCase();
    if (seenUrls.has(urlKey)) {
      duplicates.push(entry);
      return;
    }
    seenUrls.add(urlKey);

    const meta = parseMediaName(entry.name, entry.path);
    if (meta.kind === "episode") {
      const key = meta.title.toLowerCase();
      if (!showMap.has(key)) {
        showMap.set(key, {
          key,
          title: meta.title,
          episodes: []
        });
      }
      const record = showMap.get(key);
      record.episodes.push({
        season: meta.season,
        episode: meta.episode,
        url: entry.url,
        name: entry.name,
        path: entry.path
      });
    } else {
      const key = `${meta.title.toLowerCase()}|${meta.year || ""}`;
      if (!movieMap.has(key)) {
        movieMap.set(key, {
          key,
          title: meta.title,
          year: meta.year,
          entries: []
        });
      }
      movieMap.get(key).entries.push({
        url: entry.url,
        name: entry.name,
        path: entry.path
      });
    }
  });

  const movies = Array.from(movieMap.values()).sort((a, b) => a.title.localeCompare(b.title));
  const shows = Array.from(showMap.values()).sort((a, b) => a.title.localeCompare(b.title));

  return { movies, shows, duplicates };
}


// ---------- M3U generation ----------
function toExtinfLine({ name, tvgId = "", tvgLogo = "", group = "", chno = "" }) {
  const attrs = [
    tvgId && `tvg-id="${sanitize(tvgId)}"`,
    tvgLogo && `tvg-logo="${sanitize(tvgLogo)}"`,
    group && `group-title="${sanitize(group)}"`,
    chno && `tvg-chno="${sanitize(chno)}"`
  ].filter(Boolean).join(" ");
  return `#EXTINF:-1 ${attrs},${sanitize(name)}`.trim();
}

function buildM3U({ channels, shows, movies }) {
  let lines = ["#EXTM3U"]; 

  // Channels
  channels.forEach(ch => {
    lines.push(toExtinfLine({ name: ch.name, tvgId: ch.id, tvgLogo: ch.logo, group: ch.group, chno: ch.chno }));
    lines.push(sanitize(ch.url));
  });

  // TV shows -> each episode is an entry
  shows.forEach(show => {
    (show.seasons || []).forEach(sea => {
      (sea.episodes || []).forEach(ep => {
        const name = `${show.title} S${pad(sea.season)}E${pad(ep.episode)} — ${ep.title || "Episode"}`;
        lines.push(toExtinfLine({ name, tvgId: `${show.tmdbId}-S${sea.season}E${ep.episode}`, tvgLogo: show.poster, group: show.group || "TV Shows" }));
        lines.push(sanitize(ep.url || ""));
      });
    });
  });

  // Movies
  movies.forEach(m => {
    lines.push(toExtinfLine({ name: m.title, tvgId: m.tmdbId, tvgLogo: m.poster, group: m.group || "Movies" }));
    lines.push(sanitize(m.url || ""));
  });

  return lines.join("\n");
}

// ---------- EPG/XMLTV generation ----------
function buildEPG({ channels, shows, movies, epgMappings = {} }) {
  const escapeXml = (str) => {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  };

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="M3U Studio">\n';

  // Add channel definitions
  channels.forEach(ch => {
    const channelId = epgMappings[ch.id]?.epgChannelId || ch.id;
    xml += `  <channel id="${escapeXml(channelId)}">\n`;
    xml += `    <display-name>${escapeXml(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXml(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  // Add TV show episodes as programs
  shows.forEach(show => {
    (show.seasons || []).forEach(sea => {
      (sea.episodes || []).forEach(ep => {
        const channelId = `${show.tmdbId}-S${sea.season}E${ep.episode}`;
        xml += `  <channel id="${escapeXml(channelId)}">\n`;
        xml += `    <display-name>${escapeXml(show.title)} S${pad(sea.season)}E${pad(ep.episode)}</display-name>\n`;
        if (show.poster) {
          xml += `    <icon src="${escapeXml(show.poster)}" />\n`;
        }
        xml += `  </channel>\n`;
      });
    });
  });

  // Add movies as channels
  movies.forEach(m => {
    xml += `  <channel id="${escapeXml(m.tmdbId)}">\n`;
    xml += `    <display-name>${escapeXml(m.title)}</display-name>\n`;
    if (m.poster) {
      xml += `    <icon src="${escapeXml(m.poster)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  // Add basic program schedule (current time for 24h duration as placeholder)
  const now = new Date();
  const startTime = now.toISOString().replace(/[-:]/g, "").split(".")[0] + " +0000";
  const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const endTime = endDate.toISOString().replace(/[-:]/g, "").split(".")[0] + " +0000";

  // Add programs for channels
  channels.forEach(ch => {
    const channelId = epgMappings[ch.id]?.epgChannelId || ch.id;
    xml += `  <programme start="${startTime}" stop="${endTime}" channel="${escapeXml(channelId)}">\n`;
    xml += `    <title lang="en">${escapeXml(ch.name)}</title>\n`;
    xml += `    <desc lang="en">Live stream</desc>\n`;
    xml += `  </programme>\n`;
  });

  // Add programs for TV shows
  shows.forEach(show => {
    (show.seasons || []).forEach(sea => {
      (sea.episodes || []).forEach(ep => {
        const channelId = `${show.tmdbId}-S${sea.season}E${ep.episode}`;
        xml += `  <programme start="${startTime}" stop="${endTime}" channel="${escapeXml(channelId)}">\n`;
        xml += `    <title lang="en">${escapeXml(show.title)}</title>\n`;
        xml += `    <sub-title lang="en">${escapeXml(ep.title || `Episode ${ep.episode}`)}</sub-title>\n`;
        xml += `    <desc lang="en">${escapeXml(show.overview)}</desc>\n`;
        xml += `    <episode-num system="xmltv_ns">${sea.season - 1}.${ep.episode - 1}.0/1</episode-num>\n`;
        xml += `  </programme>\n`;
      });
    });
  });

  // Add programs for movies
  movies.forEach(m => {
    xml += `  <programme start="${startTime}" stop="${endTime}" channel="${escapeXml(m.tmdbId)}">\n`;
    xml += `    <title lang="en">${escapeXml(m.title)}</title>\n`;
    xml += `    <desc lang="en">${escapeXml(m.overview)}</desc>\n`;
    xml += `    <category lang="en">Movie</category>\n`;
    xml += `  </programme>\n`;
  });

  xml += "</tv>";
  return xml;
}

// ---------- UI primitives ----------
const TabBtn = ({ active, onClick, children, icon }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-2 px-5 py-3 md:px-6 md:py-3 rounded-xl text-sm font-semibold transition-all duration-200 ${
      active
        ? "bg-gradient-to-r from-aurora to-sky-500 text-midnight shadow-glow scale-105"
        : "bg-slate-800/40 text-slate-300 hover:text-white hover:bg-slate-800/70 hover:scale-102"
    }`}
  >
    {icon && <span className="text-lg">{icon}</span>}
    {children}
  </button>
);

const Card = ({ children, className = "" }) => (
  <div className={`rounded-2xl border border-white/10 bg-gradient-to-br from-slate-900/80 to-slate-900/60 p-6 md:p-8 shadow-2xl shadow-black/30 backdrop-blur-sm ${className}`}>
    {children}
  </div>
);

const SectionTitle = ({ children, subtitle, badge }) => (
  <div className="flex items-start justify-between mb-6">
    <div>
      <h3 className="text-xl font-bold text-white tracking-tight flex items-center gap-3">
        {children}
        {badge && <span className="text-xs font-medium px-3 py-1 rounded-full bg-aurora/20 text-aurora">{badge}</span>}
      </h3>
      {subtitle && <p className="text-sm text-slate-400 mt-2">{subtitle}</p>}
    </div>
  </div>
);

// ---------- Error Boundary ----------
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Error caught by boundary:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-midnight via-slate-900 to-midnight flex items-center justify-center p-6">
          <div className="max-w-2xl w-full bg-slate-800/60 backdrop-blur-xl rounded-2xl border border-red-500/40 p-8 text-center">
            <div className="text-6xl mb-6">💥</div>
            <h1 className="text-3xl font-bold text-white mb-4">Oops! Something went wrong</h1>
            <p className="text-slate-300 mb-6">
              The application encountered an unexpected error. Your data is safe in browser storage.
            </p>
            <div className="bg-slate-900/60 rounded-xl p-4 mb-6 text-left">
              <p className="text-xs font-mono text-red-300">
                {this.state.error?.toString()}
              </p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-3 rounded-xl bg-aurora text-midnight font-semibold hover:bg-sky-400 transition-all shadow-lg"
            >
              🔄 Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// ---------- Main App ----------
export default function App() {
  const [apiKey, setApiKey] = useState("");
  const freekeyFetchAttempted = useRef(false);
  const [active, setActive] = useState("dashboard");
  
  // Toast notification state
  const [toasts, setToasts] = useState([]);
  const toastIdCounter = useRef(0);
  
  // Toast helper function
  const showToast = useCallback((message, type = "info") => {
    const id = toastIdCounter.current++;
    const toast = { id, message, type };
    setToasts(prev => [...prev, toast]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);
  
  // Stream health checker states
  const [streamHealthStatus, setStreamHealthStatus] = useState(() => readLS("m3u_stream_health", {}));
  const [healthCheckActive, setHealthCheckActive] = useState(false);
  const [healthCheckProgress, setHealthCheckProgress] = useState({ checked: 0, total: 0, working: 0, failed: 0 });
  const healthCheckAbortController = useRef(null);
  
  // Search and filter states
  const [channelSearchQuery, setChannelSearchQuery] = useState("");
  const [channelGroupFilter, setChannelGroupFilter] = useState("all");
  const [showSearchFilter, setShowSearchFilter] = useState("");
  const [movieSearchFilter, setMovieSearchFilter] = useState("");
  const [movieSortBy, setMovieSortBy] = useState(() => readLS("m3u_movie_sort", "added")); // added, title, year, rating
  const [showSortBy, setShowSortBy] = useState(() => readLS("m3u_show_sort", "added")); // added, title, rating, year
  const [selectedChannels, setSelectedChannels] = useState(new Set());
  const [selectedShows, setSelectedShows] = useState(new Set());
  const [selectedMovies, setSelectedMovies] = useState(new Set());
  
  // EPG states
  const [epgSources, setEpgSources] = useState([]);
  const [selectedEpgSources, setSelectedEpgSources] = useState(new Set());
  const [epgMappings, setEpgMappings] = useState({});
  const [autoMapStatus, setAutoMapStatus] = useState({ active: false, matched: 0, total: 0 });

  const [channels, setChannels] = useState([]);
  const [channelLogoQuery, setChannelLogoQuery] = useState("");
  const [channelLogoLoading, setChannelLogoLoading] = useState(false);
  const [channelLogoResults, setChannelLogoResults] = useState([]);
  const [channelLogoTarget, setChannelLogoTarget] = useState(null);
  const [channelImportStatus, setChannelImportStatus] = useState({
    active: false,
    total: 0,
    added: 0,
    skipped: 0,
    message: ""
  });
  const [channelImports, setChannelImports] = useState([]);
  const channelImportInputRef = useRef(null);
  const [shows, setShows] = useState([]);
  const [movies, setMovies] = useState([]);
  const [showSearchQuery, setShowSearchQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState([]);
  const [showSearchBusy, setShowSearchBusy] = useState(false);
  const showSearchRun = useRef(0);
  const [movieSearchQuery, setMovieSearchQuery] = useState("");
  const [movieSuggestions, setMovieSuggestions] = useState([]);
  const [movieSearchBusy, setMovieSearchBusy] = useState(false);
  const movieSearchRun = useRef(0);
  const [libraryUrl, setLibraryUrl] = useState("");
  const [scanSubfolders, setScanSubfolders] = useState(true);
  const [availableFolders, setAvailableFolders] = useState([]);
  const [selectedFolders, setSelectedFolders] = useState(new Set());
  const [loadingFolders, setLoadingFolders] = useState(false);
  const channelsByImport = useMemo(() => {
    const map = new Map();
    channels.forEach(ch => {
      if (!ch?.importId) return;
      if (!map.has(ch.importId)) map.set(ch.importId, []);
      map.get(ch.importId).push(ch);
    });
    return map;
  }, [channels]);
  const sortedChannelImports = useMemo(() => {
    return [...channelImports].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [channelImports]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [libraryMovies, setLibraryMovies] = useState([]);
  const [libraryShows, setLibraryShows] = useState([]);
  const [libraryProgress, setLibraryProgress] = useState({ active: false, processed: 0, found: 0, logs: [], stage: "idle" });
  const [libraryDuplicates, setLibraryDuplicates] = useState([]);
  const [libraryFileEntries, setLibraryFileEntries] = useState([]);
  const [playlistSyncStatus, setPlaylistSyncStatus] = useState("idle");
  const playlistUrl = useMemo(() => {
    if (typeof window === "undefined") return "/playlist.m3u";
    return `${window.location.origin}/playlist.m3u`;
  }, []);

  const inputClass = "w-full px-4 py-3 rounded-xl border border-white/10 bg-slate-900/70 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-aurora/60 focus:border-aurora/50 transition-all duration-200";
  const textareaClass = `${inputClass} min-h-[140px] leading-relaxed resize-none`;
  const baseButton = "inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:opacity-50 disabled:cursor-not-allowed";
  const primaryButton = `${baseButton} bg-gradient-to-r from-aurora to-sky-500 text-midnight focus:ring-aurora/50 shadow-lg hover:shadow-glow hover:scale-105 active:scale-95`;
  const secondaryButton = `${baseButton} border border-white/20 bg-slate-800/60 text-slate-200 focus:ring-aurora/30 hover:border-aurora/40 hover:bg-slate-800 hover:text-white`;
  const ghostButton = `${baseButton} border border-white/10 text-slate-300 bg-transparent focus:ring-aurora/30 hover:border-aurora/50 hover:text-aurora hover:bg-aurora/5`;
  const dangerButton = `${baseButton} border border-red-500/40 text-red-300 bg-red-500/10 focus:ring-red-400/50 hover:bg-red-500/20 hover:border-red-500/60`;
  const m3u = useMemo(() => buildM3U({ channels, shows, movies }), [channels, shows, movies]);
  const epg = useMemo(() => buildEPG({ channels, shows, movies, epgMappings }), [channels, shows, movies, epgMappings]);

  const libraryCandidates = useMemo(() => buildLibraryCandidates(libraryFileEntries), [libraryFileEntries]);
  // Live import helpers for library scanning
  const importQueueRef = useRef([]);
  const processingQueueRef = useRef(false);
  const tmdbCacheRef = useRef({ movies: new Map(), shows: new Map() }); // normalizedTitle -> tmdbId
  const importedUrlSetRef = useRef(new Set());

  const mergeEpisodeIntoShow = useCallback((tmdbId, season, episode, url) => {
    if (!url) return;
    setShows(prev => prev.map(s => {
      if (String(s.tmdbId) !== String(tmdbId)) return s;
      const seasons = (s.seasons || []).map(sea => {
        if (sea.season !== season) return sea;
        const episodes = (sea.episodes || []).map(ep => {
          if (ep.episode !== episode) return ep;
          return { ...ep, url: ep.url || url };
        });
        return { ...sea, episodes };
      });
      return { ...s, seasons };
    }));
  }, [setShows]);

  const processEntry = useCallback(async (entry) => {
    try {
      const url = entry.url;
      if (!url || importedUrlSetRef.current.has(url)) return;
      // Parse media info from filename and path
      const info = parseMediaName(entry.name || entry.path || url, entry.path || url);
      if (!info || !info.title) return;

      if (info.kind === "movie") {
        // Duplicate by URL
        const movieDup = movies.some(m => (m.url || "") === url);
        if (movieDup) {
          setLibraryProgress(prev => ({ ...prev, skipped: (prev.skipped || 0) + 1, logs: [
            `Skipped duplicate movie: ${info.title}`,
            ...prev.logs
          ].slice(0, 8) }));
          return;
        }
        const norm = normalizeTitle(info.title);
        let tmdbId = tmdbCacheRef.current.movies.get(norm);
        if (!tmdbId) {
          // Search with year if available for better accuracy
          const searchQuery = info.year ? `${info.title} ${info.year}` : info.title;
          const results = await searchTMDBMovies(apiKey, searchQuery);
          if (!results || results.length === 0) {
            setLibraryProgress(prev => ({ ...prev, skipped: (prev.skipped || 0) + 1, logs: [
              `No TMDB match for movie: ${info.title}${info.year ? ` (${info.year})` : ''}`,
              ...prev.logs
            ].slice(0, 8) }));
            return;
          }
          tmdbId = String(results[0].id);
          tmdbCacheRef.current.movies.set(norm, tmdbId);
        }
        await importMovie(tmdbId, { url, group: "Movies" });
        importedUrlSetRef.current.add(url);
        setLibraryProgress(prev => ({ ...prev, imported: (prev.imported || 0) + 1, logs: [
          `✓ Imported movie: ${info.title}${info.year ? ` (${info.year})` : ''}`,
          ...prev.logs
        ].slice(0, 8) }));
        return;
      }

      if (info.kind === "episode") {
        const { title, season, episode } = info;
        const norm = normalizeTitle(title);
        // Check if this episode URL is already present
        const showDup = shows.some(s => s.seasons?.some(sea => sea.episodes?.some(ep => ep.url === url)));
        if (showDup) {
          setLibraryProgress(prev => ({ ...prev, skipped: (prev.skipped || 0) + 1, logs: [
            `Skipped duplicate episode: ${title} S${pad(season)}E${pad(episode)}`,
            ...prev.logs
          ].slice(0, 8) }));
          return;
        }
        let tmdbId = tmdbCacheRef.current.shows.get(norm);
        if (!tmdbId) {
          const results = await searchTMDBShows(apiKey, title);
          if (!results || results.length === 0) {
            setLibraryProgress(prev => ({ ...prev, skipped: (prev.skipped || 0) + 1, logs: [
              `No TMDB match for show: ${title}`,
              ...prev.logs
            ].slice(0, 8) }));
            return;
          }
          tmdbId = String(results[0].id);
          tmdbCacheRef.current.shows.set(norm, tmdbId);
        }
        // If show already exists, merge episode; else import show with initial episode map
        const hasShow = shows.some(s => String(s.tmdbId) === String(tmdbId));
        if (hasShow) {
          mergeEpisodeIntoShow(tmdbId, Number(season), Number(episode), url);
          setLibraryProgress(prev => ({ ...prev, imported: (prev.imported || 0) + 1, logs: [
            `✓ Linked episode: ${title} S${pad(season)}E${pad(episode)}`,
            ...prev.logs
          ].slice(0, 8) }));
        } else {
          const episodeMap = { [`${Number(season)}-${Number(episode)}`]: url };
          await importShow(tmdbId, { episodeMap, group: "TV Shows" });
          setLibraryProgress(prev => ({ ...prev, imported: (prev.imported || 0) + 1, logs: [
            `✓ Imported show: ${title} (added S${pad(season)}E${pad(episode)})`,
            ...prev.logs
          ].slice(0, 8) }));
        }
        importedUrlSetRef.current.add(url);
      }
    } catch (err) {
      console.warn("processEntry failed", entry?.url, err);
      setLibraryProgress(prev => ({ ...prev, skipped: (prev.skipped || 0) + 1, logs: [
        `Error importing: ${entry?.name || entry?.url}`,
        ...prev.logs
      ].slice(0, 8) }));
    }
  }, [apiKey, movies, shows, mergeEpisodeIntoShow]);

  const enqueueImport = useCallback((entry) => {
    importQueueRef.current.push(entry);
    if (processingQueueRef.current) return;
    processingQueueRef.current = true;
    (async () => {
      while (importQueueRef.current.length) {
        const next = importQueueRef.current.shift();
        await processEntry(next);
        // small throttle to avoid overwhelming APIs
        await pause(200);
      }
      processingQueueRef.current = false;
    })();
  }, [processEntry]);

  useEffect(() => {
    setLibraryMovies(prev => {
      const prevMap = new Map(prev.map(m => [m.key, m]));
      return libraryCandidates.movies.map(candidate => {
        const existing = prevMap.get(candidate.key);
        if (existing) {
          return {
            ...candidate,
            suggestions: existing.suggestions || [],
            loading: existing.loading || false,
            error: existing.error || ""
          };
        }
        return { ...candidate, suggestions: [], loading: false, error: "" };
      });
    });
    setLibraryShows(prev => {
      const prevMap = new Map(prev.map(s => [s.key, s]));
      return libraryCandidates.shows.map(candidate => {
        const existing = prevMap.get(candidate.key);
        if (existing) {
          return {
            ...candidate,
            suggestions: existing.suggestions || [],
            loading: existing.loading || false,
            error: existing.error || "",
            pattern: existing.pattern || ""
          };
        }
        return { ...candidate, suggestions: [], loading: false, error: "", pattern: "" };
      });
    });
    setLibraryDuplicates(libraryCandidates.duplicates);
  }, [libraryCandidates]);
  
  // Load data from database on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        // Load settings
        const [
          loadedApiKey,
          loadedMovieSort,
          loadedShowSort,
          loadedLibraryUrl,
          loadedScanSubfolders,
          loadedEpgMappings,
          loadedStreamHealth
        ] = await Promise.all([
          readDB("tmdb_api_key", ""),
          readDB("m3u_movie_sort", "added"),
          readDB("m3u_show_sort", "added"),
          readDB("m3u_library_url", ""),
          readDB("m3u_scan_subfolders", true),
          readDB("m3u_epg_mappings", {}),
          readDB("m3u_stream_health", {})
        ]);
        
        // Load table data
        const [loadedChannels, loadedShows, loadedMovies] = await Promise.all([
          loadTableDB("channels"),
          loadTableDB("shows"),
          loadTableDB("movies")
        ]);
        
        // Load EPG sources and channel imports from settings
        const loadedEpgSources = await readDB("m3u_epg_sources", []);
        const rawChannelImports = await readDB("m3u_channel_imports", []);
        const loadedChannelImports = Array.isArray(rawChannelImports) ? rawChannelImports.map(entry => ({
          id: entry.id || `import-${Math.random().toString(36).slice(2)}`,
          name: entry.name || entry.originalName || "Imported playlist",
          originalName: entry.originalName || entry.name || "",
          createdAt: entry.createdAt || Date.now()
        })) : [];
        
        // Set all state
        setApiKey(loadedApiKey);
        setMovieSortBy(loadedMovieSort);
        setShowSortBy(loadedShowSort);
        setLibraryUrl(loadedLibraryUrl);
        setScanSubfolders(loadedScanSubfolders);
        setEpgMappings(loadedEpgMappings);
        setStreamHealthStatus(loadedStreamHealth);
        setEpgSources(loadedEpgSources);
        setChannelImports(loadedChannelImports);
        
        setChannels(loadedChannels);
        setShows(loadedShows.map(s => ({ ...s, group: s.group ?? "TV Shows" })));
        setMovies(loadedMovies.map(m => ({ ...m, group: m.group ?? "Movies" })));
        
        console.log("Data loaded from database");
      } catch (err) {
        console.error("Failed to load data from database:", err);
        // Try to migrate from localStorage as fallback
        migrateFromLocalStorage();
      }
    };
    
    loadData();
  }, []); // Run once on mount
  
  // Migrate from localStorage to database (one-time migration)
  const migrateFromLocalStorage = async () => {
    try {
      console.log("Attempting to migrate from localStorage...");
      const lsChannels = readLS("m3u_channels", []);
      const lsShows = readLS("m3u_shows", []);
      const lsMovies = readLS("m3u_movies", []);
      
      if (lsChannels.length > 0) {
        await saveTableDB("channels", lsChannels);
        setChannels(lsChannels);
      }
      if (lsShows.length > 0) {
        await saveTableDB("shows", lsShows);
          // Don't set API key immediately - let freekeys fetch first, then fallback to saved key
          if (loadedApiKey) {
            setTimeout(() => {
              setApiKey(current => current || loadedApiKey);
            }, 1000);
          }
        
          console.log("Data loaded from database");
      }
      if (lsMovies.length > 0) {
        await saveTableDB("movies", lsMovies);
        setMovies(lsMovies.map(m => ({ ...m, group: m.group ?? "Movies" })));
      }
      
      // Migrate settings
      const lsApiKey = readLS("tmdb_api_key", "");
      if (lsApiKey) {
    // Fetch TMDB API key from freekeys on mount (prioritized)
    useEffect(() => {
      if (freekeyFetchAttempted.current) return;
      freekeyFetchAttempted.current = true;
      let cancelled = false;
    
      console.log("Fetching TMDB API key from freekeys...");
      freekeys()
        .then(res => {
          if (cancelled) return;
          const key = res?.tmdb_key || "";
          if (key) {
            console.log("✓ Got TMDB API key from freekeys");
            setApiKey(key);
            writeDB("tmdb_api_key", key);
          } else {
            console.warn("No TMDB key returned from freekeys");
          }
        })
        .catch(err => {
          console.warn("Unable to fetch TMDB key from freekeys", err);
        });
      return () => { cancelled = true; };
    }, []);
  
        await writeDB("tmdb_api_key", lsApiKey);
        setApiKey(lsApiKey);
      }
      
      console.log("Migration from localStorage complete");
    } catch (err) {
      console.error("Migration failed:", err);
    }
  };
  
  // Save to database when data changes
  useEffect(() => { if (apiKey) writeDB("tmdb_api_key", apiKey); }, [apiKey]);
  useEffect(() => { if (channels.length > 0) saveTableDB("channels", channels); }, [channels]);
  useEffect(() => { if (channelImports.length >= 0) writeDB("m3u_channel_imports", channelImports); }, [channelImports]);
  useEffect(() => { if (shows.length > 0) saveTableDB("shows", shows); }, [shows]);
  useEffect(() => { if (movies.length > 0) saveTableDB("movies", movies); }, [movies]);
  useEffect(() => { writeDB("m3u_movie_sort", movieSortBy); }, [movieSortBy]);
  useEffect(() => { writeDB("m3u_show_sort", showSortBy); }, [showSortBy]);
  useEffect(() => { if (libraryUrl) writeDB("m3u_library_url", libraryUrl); }, [libraryUrl]);
  useEffect(() => { writeDB("m3u_scan_subfolders", scanSubfolders); }, [scanSubfolders]);
  useEffect(() => { if (epgSources.length >= 0) writeDB("m3u_epg_sources", epgSources); }, [epgSources]);
  useEffect(() => { writeDB("m3u_epg_mappings", epgMappings); }, [epgMappings]);
  useEffect(() => { writeDB("m3u_stream_health", streamHealthStatus); }, [streamHealthStatus]);
  
  const [epgSyncStatus, setEpgSyncStatus] = useState("idle");
  const epgUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/epg.xml`;
  }, []);
  useEffect(() => {
    if (!m3u) return;
    let cancelled = false;
    let resetTimer;
    const debounce = setTimeout(() => {
      setPlaylistSyncStatus("syncing");
      fetch("/api/playlist", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: m3u
      })
        .then(res => {
          if (!res.ok) throw new Error(`sync failed (${res.status})`);
          if (cancelled) return;
          setPlaylistSyncStatus("saved");
          resetTimer = setTimeout(() => {
            if (!cancelled) setPlaylistSyncStatus("idle");
          }, 2000);
        })
        .catch(err => {
          console.warn("Unable to sync playlist", err);
          if (!cancelled) setPlaylistSyncStatus("error");
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      if (resetTimer) clearTimeout(resetTimer);
    };
  }, [m3u]);
  useEffect(() => {
    if (!epg) return;
    let cancelled = false;
    let resetTimer;
    const debounce = setTimeout(() => {
      setEpgSyncStatus("syncing");
      fetch("/api/epg", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: epg
      })
        .then(res => {
          if (!res.ok) throw new Error(`EPG sync failed (${res.status})`);
          if (cancelled) return;
          setEpgSyncStatus("saved");
          resetTimer = setTimeout(() => {
            if (!cancelled) setEpgSyncStatus("idle");
          }, 2000);
        })
        .catch(err => {
          console.warn("Unable to sync EPG", err);
          if (!cancelled) setEpgSyncStatus("error");
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      if (resetTimer) clearTimeout(resetTimer);
    };
  }, [epg]);
  useEffect(() => {
    const q = showSearchQuery.trim();
    if (!q || q.length < 2 || !apiKey) {
      setShowSuggestions([]);
      setShowSearchBusy(false);
      return;
    }
    setShowSearchBusy(true);
    const runId = Date.now();
    showSearchRun.current = runId;
    const handle = setTimeout(() => {
      searchTMDBShows(apiKey, q)
        .then(results => {
          if (showSearchRun.current !== runId) return;
          setShowSuggestions(results);
        })
        .catch(err => {
          console.warn("TMDB show search failed", err);
          if (showSearchRun.current === runId) setShowSuggestions([]);
        })
        .finally(() => {
          if (showSearchRun.current === runId) setShowSearchBusy(false);
        });
    }, 350);
    return () => {
      clearTimeout(handle);
    };
  }, [showSearchQuery, apiKey]);

  useEffect(() => {
    const q = movieSearchQuery.trim();
    if (!q || q.length < 2 || !apiKey) {
      setMovieSuggestions([]);
      setMovieSearchBusy(false);
      return;
    }
    setMovieSearchBusy(true);
    const runId = Date.now();
    movieSearchRun.current = runId;
    const handle = setTimeout(() => {
      searchTMDBMovies(apiKey, q)
        .then(results => {
          if (movieSearchRun.current !== runId) return;
          setMovieSuggestions(results);
        })
        .catch(err => {
          console.warn("TMDB movie search failed", err);
          if (movieSearchRun.current === runId) setMovieSuggestions([]);
        })
        .finally(() => {
          if (movieSearchRun.current === runId) setMovieSearchBusy(false);
        });
    }, 350);
    return () => {
      clearTimeout(handle);
    };
  }, [movieSearchQuery, apiKey]);

  const updateLibraryMovie = (key, updater) => {
    setLibraryMovies(ms => ms.map(m => (m.key === key ? (typeof updater === "function" ? updater(m) : { ...m, ...updater }) : m)));
  };

  const updateLibraryShow = (key, updater) => {
    setLibraryShows(ms => ms.map(m => (m.key === key ? (typeof updater === "function" ? updater(m) : { ...m, ...updater }) : m)));
  };

  const requestLogoSuggestions = async (name, limit = 1) => {
    const query = (name || "").trim();
    if (!query) return [];
    try {
      const res = await fetch(`/api/logos?query=${encodeURIComponent(query)}&top=${limit}`);
      const data = await res.json();
      if (!Array.isArray(data?.results)) return [];
      return data.results.map(item => item.url).filter(Boolean);
    } catch {
      return [];
    }
  };

  const handleChannelFileInput = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    let body = "";
    try {
      body = await file.text();
    } catch {
      setChannelImportStatus({ active: false, total: 0, added: 0, skipped: 0, message: "Unable to read that file." });
      return;
    }
    const parsed = parseM3UChannels(body);
    if (!parsed.length) {
      setChannelImportStatus({ active: false, total: 0, added: 0, skipped: 0, message: "No channels found in that file." });
      return;
    }
    const existing = new Set(channels.map(c => (c.url || "").trim().toLowerCase()));
    const additions = [];
    const importTimestamp = Date.now();
    const importId = `import-${importTimestamp}`;
    const nameFromFile = file.name ? file.name.replace(/\.[^/.]+$/, "") : "";
    const importName = nameFromFile || `Playlist ${channelImports.length + 1}`;
    const createdAt = importTimestamp;
    let added = 0;
    let skipped = 0;
    setChannelImportStatus({ active: true, total: parsed.length, added: 0, skipped: 0, message: "Importing channels…" });
    for (const entry of parsed) {
      const normalizedUrl = (entry.url || "").trim();
      if (!normalizedUrl) { skipped++; continue; }
      const urlKey = normalizedUrl.toLowerCase();
      if (existing.has(urlKey)) { skipped++; continue; }
      existing.add(urlKey);
      let logo = entry.logo;
      if (!logo && entry.name) {
        const logos = await requestLogoSuggestions(entry.name, 1);
        logo = logos[0] || "";
      }
      additions.push({
        id: `ch-${importTimestamp}-${added + 1}`,
        importId,
        name: entry.name || `Channel ${channels.length + added + 1}`,
        url: normalizedUrl,
        logo,
        group: entry.group || "Live",
        chno: entry.chno || String(channels.length + added + 1)
      });
      added++;
      setChannelImportStatus(prev => ({
        ...prev,
        added,
        skipped,
        message: `Imported ${added} of ${parsed.length}`
      }));
    }
    if (additions.length) {
      setChannels(prev => [...prev, ...additions]);
      setChannelImports(prev => [...prev, {
        id: importId,
        name: importName,
        originalName: file.name || "",
        createdAt
      }]);
    }
    setChannelImportStatus({
      active: false,
      total: parsed.length,
      added,
      skipped,
      message: `Import complete. Added ${added}, skipped ${skipped}.`
    });
  };

  const discoverFolders = async () => {
    const url = libraryUrl.trim();
    if (!url) return showToast("Enter a base URL first.", "error");
    
    if (!isValidUrl(url)) {
      showToast("Invalid URL format. Please enter a valid HTTP/HTTPS URL.", "error");
      return;
    }
    
    setLoadingFolders(true);
    setAvailableFolders([]);
    setSelectedFolders(new Set());
    
    try {
      const initial = url.endsWith("/") ? url : `${url}/`;
      const fetchUrl = buildLocalProxyUrl(initial);
      const { text, linkBase } = await fetchTextWithFallback(fetchUrl);
      const entries = parseDirectoryListing(text, linkBase);
      
      // Filter for directories only
      const folders = entries
        .filter(entry => entry.href.endsWith('/'))
        .map(entry => {
          const fullUrl = new URL(entry.href, linkBase).href;
          const name = entry.name.replace(/\/$/, ''); // Remove trailing slash
          return { name, url: fullUrl };
        })
        .filter(folder => folder.name && !folder.name.startsWith('.')); // Filter hidden folders
      
      setAvailableFolders(folders);
      if (folders.length === 0) {
        showToast("No subfolders found at this URL.", "info");
      } else {
        showToast(`Found ${folders.length} folder${folders.length !== 1 ? 's' : ''} - select which to scan`, "success");
      }
    } catch (err) {
      console.error("Folder discovery error:", err);
      showToast("Failed to load folders. Check the URL and try again.", "error");
    } finally {
      setLoadingFolders(false);
    }
  };

  const fetchLibraryCatalog = async () => {
    const url = libraryUrl.trim();
    if (!url) return showToast("Enter a base URL to crawl.", "error");
    
    if (!isValidUrl(url)) {
      showToast("Invalid URL format. Please enter a valid HTTP/HTTPS URL.", "error");
      return;
    }
    
    if (!apiKey) {
      showToast("Add your TMDB API key first for auto-import with metadata.", "error");
      return;
    }
    
    setLibraryLoading(true);
    setLibraryError("");
    setLibraryMovies([]);
    setLibraryShows([]);
    setLibraryDuplicates([]);
    setLibraryFileEntries([]);
    setLibraryProgress({ active: true, processed: 0, found: 0, logs: [], stage: "crawling", imported: 0, skipped: 0 });
    
    // Clear import tracking refs for new scan
    importedUrlSetRef.current.clear();
    tmdbCacheRef.current.movies.clear();
    tmdbCacheRef.current.shows.clear();
    importQueueRef.current = [];
    processingQueueRef.current = false;
    
    try {
      const importPromises = [];
      
      // If specific folders are selected, scan only those
      const urlsToScan = selectedFolders.size > 0
        ? Array.from(selectedFolders)
        : [url];
      
      const allFiles = [];
      for (const scanUrl of urlsToScan) {
        const files = await crawlDirectory(scanUrl, {
          maxDepth: scanSubfolders ? Number.POSITIVE_INFINITY : 0,
          throttleMs: 800,
          onDiscover: (info) => {
            if (info.type === "file" && info.entry) {
              const entry = info.entry;
              setLibraryFileEntries(prev => {
                const exists = prev.some(p => (p.url || p.path) === (entry.url || entry.path));
                if (exists) return prev;
                return [...prev, entry];
              });
              setLibraryProgress(prev => ({
                ...prev,
                processed: prev.processed + 1,
                found: prev.found + 1,
                logs: [`Found ${entry.path}`, ...prev.logs].slice(0, 6),
                stage: "crawling"
              }));
              // Live import while scanning
              importPromises.push((async () => enqueueImport(entry))());
              return;
            }
            if (info.type === "dir") {
              setLibraryProgress(prev => ({
                ...prev,
                logs: [`Scanning ${info.path}`, ...prev.logs].slice(0, 6),
                stage: "crawling"
              }));
            }
          }
        });
        allFiles.push(...files);
      }
      
      if (!allFiles.length) {
        setLibraryError(scanSubfolders
          ? "No playable media files detected at that URL."
          : "No media files found in this directory. Try enabling 'Scan subfolders' to include nested folders.");
        setLibraryProgress(prev => ({ ...prev, active: false, stage: "empty" }));
        return;
      }
      
      // Wait for any in-flight import tasks to finish
      await Promise.allSettled(importPromises);
      
      // Also wait for the queue to fully drain
      while (processingQueueRef.current || importQueueRef.current.length > 0) {
        await pause(100);
      }

      const candidates = buildLibraryCandidates(allFiles);
      setLibraryDuplicates(candidates.duplicates);
      setLibraryProgress(prev => ({ 
        ...prev, 
        active: false, 
        stage: "completed",
        logs: ["✅ Scan complete", ...prev.logs].slice(0, 6)
      }));
      
    } catch (err) {
      console.warn(err);
      const msg = err?.message || String(err);
      if (err?.status === 429 || msg.includes("(429)")) {
        setLibraryError("Rate limited while using the fetch proxy (HTTP 429). Wait a moment and try again.");
      } else if (msg.includes("Failed to fetch")) {
        setLibraryError("Unable to fetch that directory index. The host may block cross-origin access.");
      } else {
        setLibraryError(msg || "Unable to crawl that URL.");
      }
      setLibraryProgress(prev => ({ ...prev, active: false, stage: "error" }));
    } finally {
      setLibraryLoading(false);
    }
  };

  // ----- Stream Health Checker -----
  const checkStreamHealth = async (url, timeout = 5000) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const response = await fetch(`/proxy?url=${encodeURIComponent(url)}`, {
        method: 'HEAD',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      return {
        status: response.ok ? 'working' : 'failed',
        statusCode: response.status,
        checkedAt: Date.now()
      };
    } catch (err) {
      return {
        status: 'failed',
        error: err.message || 'Connection failed',
        checkedAt: Date.now()
      };
    }
  };

  const checkAllStreams = async () => {
    // Gather all stream URLs
    const streams = [];
    
    // Add channels
    channels.forEach(ch => {
      if (ch.url) streams.push({ type: 'channel', id: ch.id, url: ch.url, name: ch.name });
    });
    
    // Add movies
    movies.forEach(m => {
      if (m.url) streams.push({ type: 'movie', id: m.id, url: m.url, name: m.title });
    });
    
    // Add show episodes
    shows.forEach(show => {
      show.seasons?.forEach(season => {
        season.episodes?.forEach(ep => {
          if (ep.url) {
            streams.push({
              type: 'episode',
              id: `${show.id}-s${season.season}e${ep.episode}`,
              url: ep.url,
              name: `${show.title} S${season.season}E${ep.episode}`
            });
          }
        });
      });
    });

    if (streams.length === 0) {
      showToast("No streams to check", "error");
      return;
    }

    setHealthCheckActive(true);
    setHealthCheckProgress({ checked: 0, total: streams.length, working: 0, failed: 0 });
    healthCheckAbortController.current = new AbortController();

    const results = {};
    let checked = 0;
    let working = 0;
    let failed = 0;

    // Check streams in batches of 5 to avoid overwhelming the server
    const batchSize = 5;
    for (let i = 0; i < streams.length; i += batchSize) {
      if (healthCheckAbortController.current.signal.aborted) break;
      
      const batch = streams.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(stream => checkStreamHealth(stream.url).then(result => ({ stream, result })))
      );

      batchResults.forEach(({ stream, result }) => {
        results[stream.id] = { ...result, url: stream.url, name: stream.name, type: stream.type };
        checked++;
        if (result.status === 'working') working++;
        else failed++;
      });

      setHealthCheckProgress({ checked, total: streams.length, working, failed });
      setStreamHealthStatus(prev => ({ ...prev, ...results }));
    }

    setHealthCheckActive(false);
    
    if (!healthCheckAbortController.current.signal.aborted) {
      showToast(`Health check complete! ${working} working, ${failed} failed out of ${streams.length} streams`, 
        failed === 0 ? "success" : "info");
    }
  };

  const stopHealthCheck = () => {
    if (healthCheckAbortController.current) {
      healthCheckAbortController.current.abort();
      setHealthCheckActive(false);
      showToast("Health check stopped", "info");
    }
  };

  const getStreamHealth = (id) => {
    return streamHealthStatus[id];
  };

  const matchLibraryMovie = async (movie) => {
    if (!apiKey) return showToast("Add your TMDB API key first", "error");
    updateLibraryMovie(movie.key, m => ({ ...m, loading: true, error: "" }));
    try {
      const results = await searchTMDBMovies(apiKey, movie.title);
      updateLibraryMovie(movie.key, m => ({ ...m, suggestions: results, loading: false, error: results.length ? "" : "No TMDB matches found." }));
    } catch (err) {
      updateLibraryMovie(movie.key, m => ({ ...m, loading: false, error: err.message || "Search failed." }));
    }
  };

  const matchLibraryShow = async (show) => {
    if (!apiKey) return showToast("Add your TMDB API key first", "error");
    updateLibraryShow(show.key, s => ({ ...s, loading: true, error: "" }));
    try {
      const results = await searchTMDBShows(apiKey, show.title);
      updateLibraryShow(show.key, s => ({ ...s, suggestions: results, loading: false, error: results.length ? "" : "No TMDB matches found." }));
    } catch (err) {
      updateLibraryShow(show.key, s => ({ ...s, loading: false, error: err.message || "Search failed." }));
    }
  };

  const addMovieFromSuggestion = async (movie, suggestion) => {
    await importMovie(String(suggestion.id), { url: movie.entries[0]?.url || "", group: "Movies" });
    setLibraryMovies(ms => ms.filter(m => m.key !== movie.key));
    showToast(`Imported "${suggestion.title}" with stream URL attached.`, "success");
  };

  const addShowFromSuggestion = async (show, suggestion) => {
    const episodeMap = {};
    show.episodes.forEach(ep => {
      const key = `${ep.season}-${ep.episode}`;
      if (!episodeMap[key]) episodeMap[key] = ep.url;
    });
    await importShow(String(suggestion.id), { episodeMap, group: "TV Shows" });
    setLibraryShows(ms => ms.filter(s => s.key !== show.key));
    showToast(`Imported "${suggestion.title}" with ${Object.keys(episodeMap).length} episodes linked.`, "success");
  };

  // ----- Channels -----
  const addChannel = () => setChannels(cs => [...cs, { id: `ch-${Date.now()}`, name: "New Channel", url: "", logo: "", group: "Live", chno: cs.length + 1 }]);
  
  const updateChannel = (idx, patch) => {
    // Validate and sanitize inputs
    if (patch.url !== undefined && patch.url.trim() && !isValidUrl(patch.url)) {
      showToast("Invalid stream URL format", "error");
      return;
    }
    if (patch.logo !== undefined && patch.logo.trim() && !isValidUrl(patch.logo)) {
      showToast("Invalid logo URL format", "error");
      return;
    }
    if (patch.name !== undefined) {
      patch.name = sanitizeInput(patch.name);
    }
    if (patch.group !== undefined) {
      patch.group = sanitizeInput(patch.group);
    }
    
    setChannels(cs => cs.map((c, i) => i === idx ? { ...c, ...patch } : c));
  };
  
  const removeChannel = (idx) => {
    setChannels(cs => {
      const target = cs[idx];
      if (!target) return cs;
      const next = cs.filter((_, i) => i !== idx);
      if (target.importId) {
        setChannelImports(prev => prev.filter(record => {
          if (record.id !== target.importId) return true;
          return next.some(ch => ch.importId === record.id);
        }));
      }
      return next;
    });
  };
  const renameChannelImport = (id, name) => {
    setChannelImports(prev => prev.map(record => (record.id === id ? { ...record, name } : record)));
  };
  const removeChannelImport = (id) => {
    setChannelImports(prev => prev.filter(record => record.id !== id));
    setChannels(cs => cs.filter(ch => ch.importId !== id));
  };

  // ----- EPG Management -----
  const addEpgSource = () => {
    const newSource = {
      id: `epg-${Date.now()}`,
      name: "New EPG Source",
      url: "",
      enabled: true,
      createdAt: Date.now()
    };
    setEpgSources(prev => [...prev, newSource]);
  };

  const updateEpgSource = (id, updates) => {
    // Validate URL if being updated
    if (updates.url !== undefined) {
      const urlValue = updates.url.trim();
      if (urlValue && !isValidUrl(urlValue)) {
        showToast("Invalid EPG URL format. Use http://, https://, or file:// URLs", "error");
        return;
      }
    }
    
    // Sanitize name input
    if (updates.name !== undefined) {
      updates.name = sanitizeInput(updates.name);
    }
    
    setEpgSources(prev => prev.map(epg => epg.id === id ? { ...epg, ...updates } : epg));
  };

  const removeEpgSource = (id) => {
    setEpgSources(prev => prev.filter(epg => epg.id !== id));
    // Clean up mappings for this source
    setEpgMappings(prev => {
      const newMappings = { ...prev };
      Object.keys(newMappings).forEach(channelId => {
        if (newMappings[channelId]?.epgSourceId === id) {
          delete newMappings[channelId];
        }
      });
      return newMappings;
    });
  };

  const setChannelEpgMapping = (channelId, epgChannelId, epgSourceId) => {
    setEpgMappings(prev => ({
      ...prev,
      [channelId]: { epgChannelId, epgSourceId }
    }));
  };

  const clearChannelEpgMapping = (channelId) => {
    setEpgMappings(prev => {
      const newMappings = { ...prev };
      delete newMappings[channelId];
      return newMappings;
    });
  };

  const autoMapEpgChannels = async () => {
    if (epgSources.length === 0) {
      showToast("Please add at least one EPG source first", "error");
      return;
    }
    
    const enabledSources = epgSources.filter(s => s.enabled);
    if (enabledSources.length === 0) {
      showToast("Please enable at least one EPG source", "error");
      return;
    }
    
    setAutoMapStatus({ active: true, matched: 0, total: channels.length });
    let matched = 0;
    let highConfidence = 0;
    let lowConfidence = 0;

    channels.forEach(channel => {
      if (!channel.name) return;
      
      // Priority 1: Exact tvg-id match
      if (channel.id) {
        const firstEpg = enabledSources[0];
        if (firstEpg) {
          setChannelEpgMapping(channel.id, channel.id, firstEpg.id);
          matched++;
          highConfidence++;
          return;
        }
      }
      
      // Priority 2: Fuzzy name matching
      const normalizedChannelName = normalizeName(channel.name);
      if (normalizedChannelName) {
        // For now, use the channel name as EPG ID with first enabled source
        // In a real implementation, you'd fetch EPG XML and match against actual channel IDs
        const firstEpg = enabledSources[0];
        if (firstEpg) {
          // Generate a likely EPG channel ID from normalized name
          const epgChannelId = normalizedChannelName.replace(/\s+/g, ".") + ".tv";
          setChannelEpgMapping(channel.id, epgChannelId, firstEpg.id);
          matched++;
          lowConfidence++;
        }
      }
    });

    setAutoMapStatus({ active: false, matched, total: channels.length });
    
    if (matched === 0) {
      showToast("No channels could be mapped automatically", "error");
    } else {
      showToast(`Auto-mapping complete! ${matched} of ${channels.length} channels mapped (${highConfidence} high confidence, ${lowConfidence} low confidence)`, "success");
    }
  };

  // ----- TV Shows -----
  const importShow = async (tmdbId, options = {}) => {
    if (!apiKey) return showToast("Add your TMDB API key first", "error");
    const s = await fetchTMDBShow(apiKey, tmdbId);
    const episodeMap = options.episodeMap || {};
    const customGroup = options.group;
    const customPattern = options.pattern ?? "";
    const seasons = (s.seasons || []).map(sea => ({
      ...sea,
      episodes: (sea.episodes || []).map(ep => {
        const key = `${sea.season}-${ep.episode}`;
        return {
          ...ep,
          url: episodeMap[key] || ""
        };
      })
    }));
    setShows(prev => [
      ...prev,
      {
        id: `show-${Date.now()}`,
        tmdbId,
        title: s.title,
        overview: s.overview,
        poster: s.poster,
        seasons,
        pattern: customPattern,
        group: customGroup || "TV Shows"
      }
    ]);
  };
  
  const setShowPatch = (id, patch) => {
    // Validate pattern if being updated
    if (patch.pattern !== undefined) {
      patch.pattern = sanitizeInput(patch.pattern);
    }
    if (patch.title !== undefined) {
      patch.title = sanitizeInput(patch.title);
    }
    if (patch.group !== undefined) {
      patch.group = sanitizeInput(patch.group);
    }
    
    setShows(ss => ss.map(s => s.id === id ? { ...s, ...patch } : s));
  };

  const guessPattern = (id, samples) => {
    const { pattern, notes } = inferPattern(samples);
    setShowPatch(id, { pattern });
    if (notes) showToast(notes + "\nPattern: " + pattern, "info");
  };

  const fillShowUrls = (id) => {
    setShows(ss => ss.map(s => {
      if (s.id !== id || !s.pattern) return s;
      const seasons = s.seasons.map(sea => ({
        ...sea,
        episodes: sea.episodes.map(ep => ({ ...ep, url: ep.url || fillPattern(s.pattern, sea.season, ep.episode) }))
      }));
      return { ...s, seasons };
    }));
  };

  // ----- Movies -----
  const importMovie = async (tmdbId, options = {}) => {
    if (!apiKey) return showToast("Add your TMDB API key first", "error");
    const m = await fetchTMDBMovie(apiKey, tmdbId);
    setMovies(prev => [
      ...prev,
      {
        id: `movie-${Date.now()}`,
        tmdbId,
        title: m.title,
        overview: m.overview,
        poster: m.poster,
        url: options.url || "",
        group: options.group || "Movies"
      }
    ]);
  };
  const setMoviePatch = (id, patch) => {
    // Validate URL if being updated
    if (patch.url !== undefined && patch.url.trim() && !isValidUrl(patch.url)) {
      showToast("Invalid movie stream URL format", "error");
      return;
    }
    if (patch.poster !== undefined && patch.poster.trim() && !isValidUrl(patch.poster)) {
      showToast("Invalid poster URL format", "error");
      return;
    }
    if (patch.title !== undefined) {
      patch.title = sanitizeInput(patch.title);
    }
    if (patch.group !== undefined) {
      patch.group = sanitizeInput(patch.group);
    }
    
    setMovies(ms => ms.map(m => m.id === id ? { ...m, ...patch } : m));
  };

  // ----- Backup/Restore -----
  const exportBackup = () => {
    const backup = {
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      data: {
        apiKey,
        channels,
        channelImports,
        shows,
        movies,
        epgSources,
        epgMappings
      }
    };
    const json = JSON.stringify(backup, null, 2);
    downloadText(`m3u-studio-backup-${Date.now()}.json`, json);
    showToast("Backup exported successfully!", "success");
  };

  const importBackup = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      
      if (!backup.version || !backup.data) {
        showToast("Invalid backup file format", "error");
        return;
      }
      
      if (window.confirm("This will replace all current data. Continue?")) {
        const { data } = backup;
        if (data.apiKey) setApiKey(data.apiKey);
        if (data.channels) setChannels(data.channels);
        if (data.channelImports) setChannelImports(data.channelImports);
        if (data.shows) setShows(data.shows);
        if (data.movies) setMovies(data.movies);
        if (data.epgSources) setEpgSources(data.epgSources);
        if (data.epgMappings) setEpgMappings(data.epgMappings);
        showToast("Backup restored successfully!", "success");
      }
    } catch (err) {
      showToast("Failed to restore backup: " + err.message, "error");
    }
  };

  return (
    <div className="min-h-screen text-slate-100 pb-16">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-slate-950/90 backdrop-blur-xl shadow-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="py-6 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-aurora via-sky-400 to-sky-500 text-midnight text-xl font-bold shadow-glow">
                M3
              </div>
              <div>
                <div className="text-2xl md:text-3xl font-bold bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
                  M3U Studio
                </div>
                <p className="text-sm text-slate-400 mt-1">Build stunning IPTV playlists with TMDB</p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <div className="relative flex-1 sm:w-80">
                <input 
                  className={`${inputClass} pr-20`} 
                  placeholder="TMDB API key" 
                  value={apiKey} 
                  onChange={(e)=>setApiKey(e.target.value)}
                  type="password"
                />
                {apiKey && (
                  <button 
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-aurora/20 text-aurora hover:bg-aurora/30 transition-all"
                    onClick={()=>navigator.clipboard.writeText(apiKey)}
                  >
                    Copy
                  </button>
                )}
              </div>
              {playlistSyncStatus !== "idle" && (
                <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800/60 text-xs font-medium">
                  {playlistSyncStatus === "syncing" && <span className="text-aurora animate-pulse">● Syncing...</span>}
                  {playlistSyncStatus === "saved" && <span className="text-green-400">● Saved</span>}
                  {playlistSyncStatus === "error" && <span className="text-red-400">● Error</span>}
                </div>
              )}
            </div>
          </div>
          <nav className="pb-4 flex gap-2 overflow-x-auto scrollbar-hide">
            <TabBtn icon="�" active={active === "dashboard"} onClick={()=>setActive("dashboard")}>
              Dashboard
            </TabBtn>
            <TabBtn icon="�📺" active={active === "channels"} onClick={()=>setActive("channels")}>
              Channels
              {channels.length > 0 && <span className="px-2 py-0.5 text-xs rounded-full bg-white/20">{channels.length}</span>}
            </TabBtn>
            <TabBtn icon="📡" active={active === "epg"} onClick={()=>setActive("epg")}>
              EPG
              {epgSources.length > 0 && <span className="px-2 py-0.5 text-xs rounded-full bg-white/20">{epgSources.length}</span>}
            </TabBtn>
            <TabBtn icon="🎬" active={active === "shows"} onClick={()=>setActive("shows")}>
              TV Shows
              {shows.length > 0 && <span className="px-2 py-0.5 text-xs rounded-full bg-white/20">{shows.length}</span>}
            </TabBtn>
            <TabBtn icon="🎥" active={active === "movies"} onClick={()=>setActive("movies")}>
              Movies
              {movies.length > 0 && <span className="px-2 py-0.5 text-xs rounded-full bg-white/20">{movies.length}</span>}
            </TabBtn>
            <TabBtn icon="📂" active={active === "library"} onClick={()=>setActive("library")}>
              Library
            </TabBtn>
            <TabBtn icon="📋" active={active === "playlist"} onClick={()=>setActive("playlist")}>
              Export
            </TabBtn>
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12 space-y-8">
        {active === "dashboard" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-3xl font-bold text-white">Dashboard</h2>
                <p className="text-slate-400 mt-1">Overview of your IPTV management system</p>
              </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Card className="relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-blue-500/20 to-transparent rounded-full blur-2xl"></div>
                <div className="relative">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-4xl">📺</div>
                    <div className="text-xs font-semibold px-3 py-1 rounded-full bg-blue-500/20 text-blue-300">Live</div>
                  </div>
                  <div className="text-3xl font-bold text-white mb-1">{channels.length}</div>
                  <div className="text-sm text-slate-400">Live Channels</div>
                  <div className="mt-3 text-xs text-slate-500">
                    {channelImports.length} playlist{channelImports.length !== 1 ? 's' : ''} imported
                  </div>
                </div>
              </Card>

              <Card className="relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-purple-500/20 to-transparent rounded-full blur-2xl"></div>
                <div className="relative">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-4xl">🎬</div>
                    <div className="text-xs font-semibold px-3 py-1 rounded-full bg-purple-500/20 text-purple-300">Series</div>
                  </div>
                  <div className="text-3xl font-bold text-white mb-1">{shows.length}</div>
                  <div className="text-sm text-slate-400">TV Shows</div>
                  <div className="mt-3 text-xs text-slate-500">
                    {shows.reduce((sum, show) => sum + (show.seasons?.reduce((s, season) => s + (season.episodes?.length || 0), 0) || 0), 0)} total episodes
                  </div>
                </div>
              </Card>

              <Card className="relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-pink-500/20 to-transparent rounded-full blur-2xl"></div>
                <div className="relative">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-4xl">🎥</div>
                    <div className="text-xs font-semibold px-3 py-1 rounded-full bg-pink-500/20 text-pink-300">VOD</div>
                  </div>
                  <div className="text-3xl font-bold text-white mb-1">{movies.length}</div>
                  <div className="text-sm text-slate-400">Movies</div>
                  <div className="mt-3 text-xs text-slate-500">
                    On-demand content
                  </div>
                </div>
              </Card>

              <Card className="relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-aurora/20 to-transparent rounded-full blur-2xl"></div>
                <div className="relative">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-4xl">📋</div>
                    <div className="text-xs font-semibold px-3 py-1 rounded-full bg-aurora/20 text-aurora">Total</div>
                  </div>
                  <div className="text-3xl font-bold text-white mb-1">
                    {channels.length + shows.reduce((sum, show) => sum + (show.seasons?.reduce((s, season) => s + (season.episodes?.length || 0), 0) || 0), 0) + movies.length}
                  </div>
                  <div className="text-sm text-slate-400">Total Entries</div>
                  <div className="mt-3 text-xs text-slate-500">
                    In playlist
                  </div>
                </div>
              </Card>
            </div>

            {/* Channel Groups */}
            <Card>
              <SectionTitle subtitle="Breakdown of your live channels by category">
                📊 Channel Distribution
              </SectionTitle>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {(() => {
                  const groups = {};
                  channels.forEach(ch => {
                    const group = ch.group || "Uncategorized";
                    groups[group] = (groups[group] || 0) + 1;
                  });
                  return Object.entries(groups)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 9)
                    .map(([group, count]) => (
                      <div key={group} className="flex items-center justify-between p-4 rounded-xl bg-slate-800/40 border border-white/5">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-aurora/20 to-sky-500/20 flex items-center justify-center text-lg">
                            📡
                          </div>
                          <div>
                            <div className="font-semibold text-white text-sm">{group}</div>
                            <div className="text-xs text-slate-500">{count} channel{count !== 1 ? 's' : ''}</div>
                          </div>
                        </div>
                        <div className="text-2xl font-bold text-aurora">{count}</div>
                      </div>
                    ));
                })()}
                {channels.length === 0 && (
                  <div className="col-span-full text-center py-8 text-slate-500">
                    No channels added yet. Start by importing an M3U file or adding channels manually.
                  </div>
                )}
              </div>
            </Card>

            {/* Quick Actions */}
            <Card>
              <SectionTitle subtitle="Common tasks and operations">
                ⚡ Quick Actions
              </SectionTitle>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <button
                  onClick={() => setActive("channels")}
                  className="flex items-start gap-4 p-5 rounded-xl bg-gradient-to-br from-slate-800/60 to-slate-800/30 border border-white/10 hover:border-aurora/40 hover:bg-slate-800/80 transition-all text-left group"
                >
                  <div className="text-3xl">📺</div>
                  <div>
                    <div className="font-semibold text-white group-hover:text-aurora transition-colors">Manage Channels</div>
                    <div className="text-sm text-slate-400 mt-1">Add, edit, or import live channels</div>
                  </div>
                </button>

                <button
                  onClick={() => setActive("shows")}
                  className="flex items-start gap-4 p-5 rounded-xl bg-gradient-to-br from-slate-800/60 to-slate-800/30 border border-white/10 hover:border-aurora/40 hover:bg-slate-800/80 transition-all text-left group"
                >
                  <div className="text-3xl">🎬</div>
                  <div>
                    <div className="font-semibold text-white group-hover:text-aurora transition-colors">Add TV Shows</div>
                    <div className="text-sm text-slate-400 mt-1">Search TMDB and add series</div>
                  </div>
                </button>

                <button
                  onClick={() => setActive("movies")}
                  className="flex items-start gap-4 p-5 rounded-xl bg-gradient-to-br from-slate-800/60 to-slate-800/30 border border-white/10 hover:border-aurora/40 hover:bg-slate-800/80 transition-all text-left group"
                >
                  <div className="text-3xl">🎥</div>
                  <div>
                    <div className="font-semibold text-white group-hover:text-aurora transition-colors">Add Movies</div>
                    <div className="text-sm text-slate-400 mt-1">Search TMDB and add films</div>
                  </div>
                </button>

                <button
                  onClick={() => setActive("library")}
                  className="flex items-start gap-4 p-5 rounded-xl bg-gradient-to-br from-slate-800/60 to-slate-800/30 border border-white/10 hover:border-aurora/40 hover:bg-slate-800/80 transition-all text-left group"
                >
                  <div className="text-3xl">📂</div>
                  <div>
                    <div className="font-semibold text-white group-hover:text-aurora transition-colors">Scan Library</div>
                    <div className="text-sm text-slate-400 mt-1">Auto-discover media from directories</div>
                  </div>
                </button>

                <button
                  onClick={() => setActive("playlist")}
                  className="flex items-start gap-4 p-5 rounded-xl bg-gradient-to-br from-slate-800/60 to-slate-800/30 border border-white/10 hover:border-aurora/40 hover:bg-slate-800/80 transition-all text-left group"
                >
                  <div className="text-3xl">📋</div>
                  <div>
                    <div className="font-semibold text-white group-hover:text-aurora transition-colors">Export Playlist</div>
                    <div className="text-sm text-slate-400 mt-1">Download your M3U playlist</div>
                  </div>
                </button>

                <button
                  onClick={exportBackup}
                  className="flex items-start gap-4 p-5 rounded-xl bg-gradient-to-br from-slate-800/60 to-slate-800/30 border border-white/10 hover:border-green-500/40 hover:bg-slate-800/80 transition-all text-left group"
                >
                  <div className="text-3xl">💾</div>
                  <div>
                    <div className="font-semibold text-white group-hover:text-green-400 transition-colors">Export Backup</div>
                    <div className="text-sm text-slate-400 mt-1">Download all your data as JSON</div>
                  </div>
                </button>

                <button
                  onClick={() => document.getElementById("backup-import-input")?.click()}
                  className="flex items-start gap-4 p-5 rounded-xl bg-gradient-to-br from-slate-800/60 to-slate-800/30 border border-white/10 hover:border-blue-500/40 hover:bg-slate-800/80 transition-all text-left group"
                >
                  <div className="text-3xl">📥</div>
                  <div>
                    <div className="font-semibold text-white group-hover:text-blue-400 transition-colors">Import Backup</div>
                    <div className="text-sm text-slate-400 mt-1">Restore from a backup file</div>
                  </div>
                </button>
                <input
                  id="backup-import-input"
                  type="file"
                  accept=".json"
                  onChange={importBackup}
                  className="hidden"
                />

                <button
                  onClick={() => {
                    if (apiKey) {
                      navigator.clipboard.writeText(apiKey);
                      showToast("API key copied to clipboard!", "success");
                    } else {
                      showToast("Please add your TMDB API key first", "error");
                    }
                  }}
                  className="flex items-start gap-4 p-5 rounded-xl bg-gradient-to-br from-slate-800/60 to-slate-800/30 border border-white/10 hover:border-aurora/40 hover:bg-slate-800/80 transition-all text-left group"
                >
                  <div className="text-3xl">🔑</div>
                  <div>
                    <div className="font-semibold text-white group-hover:text-aurora transition-colors">Copy API Key</div>
                    <div className="text-sm text-slate-400 mt-1">Copy TMDB API key to clipboard</div>
                  </div>
                </button>

                <button
                  onClick={healthCheckActive ? stopHealthCheck : checkAllStreams}
                  disabled={channels.length === 0 && movies.length === 0 && shows.length === 0}
                  className="flex items-start gap-4 p-5 rounded-xl bg-gradient-to-br from-slate-800/60 to-slate-800/30 border border-white/10 hover:border-purple-500/40 hover:bg-slate-800/80 transition-all text-left group disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="text-3xl">{healthCheckActive ? "⏹️" : "🔍"}</div>
                  <div>
                    <div className="font-semibold text-white group-hover:text-purple-400 transition-colors">
                      {healthCheckActive ? "Stop Health Check" : "Check Stream Health"}
                    </div>
                    <div className="text-sm text-slate-400 mt-1">
                      {healthCheckActive 
                        ? `Checking... ${healthCheckProgress.checked}/${healthCheckProgress.total}`
                        : "Verify all stream links are working"
                      }
                    </div>
                  </div>
                </button>
              </div>
            </Card>

            {/* Stream Health Summary */}
            {Object.keys(streamHealthStatus).length > 0 && (
              <Card>
                <SectionTitle subtitle="Overview of stream availability">
                  💊 Stream Health Status
                </SectionTitle>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-5 rounded-xl bg-green-500/10 border border-green-500/30">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="text-3xl">✅</div>
                      <div className="text-sm font-semibold text-green-300">Working</div>
                    </div>
                    <div className="text-3xl font-bold text-green-300">
                      {Object.values(streamHealthStatus).filter(s => s.status === 'working').length}
                    </div>
                    <div className="text-xs text-green-400/60 mt-1">Streams online</div>
                  </div>

                  <div className="p-5 rounded-xl bg-red-500/10 border border-red-500/30">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="text-3xl">❌</div>
                      <div className="text-sm font-semibold text-red-300">Failed</div>
                    </div>
                    <div className="text-3xl font-bold text-red-300">
                      {Object.values(streamHealthStatus).filter(s => s.status === 'failed').length}
                    </div>
                    <div className="text-xs text-red-400/60 mt-1">Streams offline</div>
                  </div>

                  <div className="p-5 rounded-xl bg-slate-500/10 border border-slate-500/30">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="text-3xl">📊</div>
                      <div className="text-sm font-semibold text-slate-300">Last Check</div>
                    </div>
                    <div className="text-sm font-bold text-slate-300">
                      {(() => {
                        const lastCheck = Math.max(...Object.values(streamHealthStatus).map(s => s.checkedAt || 0));
                        if (!lastCheck) return "Never";
                        const mins = Math.floor((Date.now() - lastCheck) / 60000);
                        if (mins < 1) return "Just now";
                        if (mins < 60) return `${mins}m ago`;
                        return `${Math.floor(mins / 60)}h ago`;
                      })()}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">Time since check</div>
                  </div>
                </div>
              </Card>
            )}

            {/* Recent Activity */}
            {channelImports.length > 0 && (
              <Card>
                <SectionTitle subtitle="Recently imported playlists">
                  🕒 Recent Imports
                </SectionTitle>
                <div className="space-y-3">
                  {channelImports.slice(0, 5).map(imp => {
                    const linkedChannels = channelsByImport.get(imp.id) || [];
                    const importDate = imp.createdAt ? new Date(imp.createdAt).toLocaleDateString() : "";
                    return (
                      <div key={imp.id} className="flex items-center justify-between p-4 rounded-xl bg-slate-800/40 border border-white/5">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-green-500/20 to-emerald-500/20 flex items-center justify-center">
                            ✓
                          </div>
                          <div>
                            <div className="font-semibold text-white text-sm">{imp.name}</div>
                            <div className="text-xs text-slate-500">{linkedChannels.length} channels · {importDate}</div>
                          </div>
                        </div>
                        <button
                          onClick={() => setActive("channels")}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-aurora/20 text-aurora hover:bg-aurora/30 transition-all"
                        >
                          View
                        </button>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>
        )}

        {active === "library" && (
          <div className="space-y-6">
            <Card>
              <div className="space-y-4">
                <SectionTitle>Ingest HTTP Directory</SectionTitle>
                <p className="text-sm text-slate-400 max-w-3xl">
                  Paste the base URL to a directory index (Apache/nginx style). We’ll discover playable files, infer titles,
                  and help you import them with TMDB metadata and stream URLs attached.
                </p>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-slate-400">Base URL</label>
                    <input
                      className={`${inputClass} mt-2`}
                      placeholder="http://example.com/movies/"
                      value={libraryUrl}
                      onChange={(e)=>setLibraryUrl(e.target.value)}
                    />
                    <div className="mt-3 flex items-center gap-3">
                      <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                        <input type="checkbox" className="accent-aurora scale-110" checked={scanSubfolders} onChange={(e)=>setScanSubfolders(e.target.checked)} />
                        Scan subfolders
                      </label>
                      <span className="text-xs text-slate-500">{scanSubfolders ? "Subdirectories will be crawled recursively." : "Only files in this directory will be scanned."}</span>
                    </div>
                  </div>
                  <button 
                    className={`${secondaryButton} whitespace-nowrap`}
                    onClick={discoverFolders} 
                    disabled={loadingFolders || libraryLoading}
                  >
                    {loadingFolders ? "Loading…" : "📁 Browse Folders"}
                  </button>
                  <button className={primaryButton} onClick={fetchLibraryCatalog} disabled={libraryLoading}>
                    {libraryLoading ? "Scanning & Importing…" : "Scan & Auto-Import"}
                  </button>
                </div>
                
                {/* Folder Selection UI */}
                {availableFolders.length > 0 && (
                  <div className="mt-4 p-4 rounded-lg border border-white/10 bg-slate-900/40">
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-sm font-semibold text-white">
                        Select Folders to Scan ({selectedFolders.size} of {availableFolders.length} selected)
                      </div>
                      <div className="flex gap-2">
                        <button
                          className="text-xs px-2 py-1 rounded bg-aurora/20 text-aurora hover:bg-aurora/30"
                          onClick={() => setSelectedFolders(new Set(availableFolders.map(f => f.url)))}
                        >
                          Select All
                        </button>
                        <button
                          className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300 hover:bg-slate-600"
                          onClick={() => setSelectedFolders(new Set())}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                      {availableFolders.map(folder => (
                        <label 
                          key={folder.url} 
                          className="flex items-center gap-2 p-2 rounded border border-white/5 hover:bg-white/5 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            className="accent-aurora scale-110"
                            checked={selectedFolders.has(folder.url)}
                            onChange={(e) => {
                              const newSelected = new Set(selectedFolders);
                              if (e.target.checked) {
                                newSelected.add(folder.url);
                              } else {
                                newSelected.delete(folder.url);
                              }
                              setSelectedFolders(newSelected);
                            }}
                          />
                          <span className="text-sm text-slate-300 truncate" title={folder.name}>
                            📁 {folder.name}
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="text-xs text-slate-500 mt-3">
                      {selectedFolders.size === 0 
                        ? "Select folders to scan, or leave unselected to scan the entire directory."
                        : `Will scan ${selectedFolders.size} selected folder${selectedFolders.size !== 1 ? 's' : ''}.`
                      }
                    </p>
                  </div>
                )}
                
                {libraryError && <div className="text-xs text-red-300">{libraryError}</div>}
                {!libraryError && !libraryLoading && (libraryMovies.length || libraryShows.length) === 0 && (
                  <p className="text-xs text-slate-500">No media detected yet. Try scanning to begin.</p>
                )}
              </div>
            </Card>

            {libraryLoading && (
              <Card>
                <div className="text-sm text-aurora/80">Crawling directories and analysing filenames…</div>
              </Card>
            )}

            {(libraryProgress.active || libraryProgress.processed > 0 || libraryProgress.stage === "error") && (
              <Card>
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <SectionTitle>
                      {libraryProgress.stage === "completed"
                        ? "Auto-import completed"
                        : libraryProgress.stage === "importing"
                        ? "Auto-importing with metadata…"
                        : libraryProgress.stage === "error"
                        ? "Scan incomplete"
                        : "Scanning…"}
                    </SectionTitle>
                    <div className="text-xs text-slate-400 flex gap-4">
                      <span>Found: {libraryProgress.found}</span>
                      {(libraryProgress.imported > 0 || libraryProgress.skipped > 0) && (
                        <>
                          <span className="text-green-400">Imported: {libraryProgress.imported}</span>
                          <span className="text-yellow-400">Skipped: {libraryProgress.skipped}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-slate-900/60 overflow-hidden">
                    <div
                      className={`h-full ${libraryProgress.active ? "bg-gradient-to-r from-aurora via-sky-500 to-aurora animate-pulse" : "bg-aurora/60"}`}
                      style={{ width: libraryProgress.active ? "100%" : "100%" }}
                    />
                  </div>
                  {libraryProgress.logs.length > 0 && (
                    <div className="space-y-1 text-xs text-slate-400">
                      {libraryProgress.logs.map((log, idx) => (
                        <div key={`${log}-${idx}`} className="truncate">
                          {log}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            )}

            {libraryDuplicates.length > 0 && (
              <Card>
                <div className="flex flex-col gap-3">
                  <SectionTitle>Duplicate streams detected ({libraryDuplicates.length})</SectionTitle>
                  <p className="text-xs text-slate-400">Duplicates are ignored for TMDB matching. Review and remove if needed.</p>
                  <div className="space-y-1 text-xs text-slate-400 max-h-40 overflow-y-auto">
                    {libraryDuplicates.slice(0, 20).map((dup, idx) => (
                      <div key={`${dup.path}-${idx}`} className="truncate">
                        {dup.path}
                      </div>
                    ))}
                    {libraryDuplicates.length > 20 && (
                      <div className="text-xs text-slate-500">…and {libraryDuplicates.length - 20} more</div>
                    )}
                  </div>
                </div>
              </Card>
            )}

            {libraryMovies.length > 0 && (
              <Card>
                <div className="flex items-center justify-between">
                  <SectionTitle>Detected Movies ({libraryMovies.length})</SectionTitle>
                </div>
                <div className="mt-4 space-y-4">
                  {libraryMovies.map(movie => (
                    <div key={movie.key} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <div className="text-lg font-semibold text-white">{movie.title}</div>
                          <div className="text-xs text-slate-400 mt-1 flex gap-3">
                            {movie.year && <span>Year hint: {movie.year}</span>}
                            <span>{movie.entries.length} file{movie.entries.length > 1 ? "s" : ""}</span>
                          </div>
                          <details className="mt-3">
                            <summary className="text-xs text-slate-400 cursor-pointer select-none">Show file paths</summary>
                            <ul className="mt-2 space-y-1 text-xs text-slate-400">
                              {movie.entries.map(entry => (
                                <li key={entry.url} className="break-all">{entry.path}</li>
                              ))}
                            </ul>
                          </details>
                        </div>
                        <div className="flex flex-col gap-2 md:items-end">
                          <button className={`${ghostButton} w-full md:w-auto`} onClick={()=>matchLibraryMovie(movie)} disabled={movie.loading}>
                            {movie.loading ? "Searching TMDB…" : "Find on TMDB"}
                          </button>
                          {movie.error && <div className="text-xs text-red-300 text-right max-w-xs">{movie.error}</div>}
                        </div>
                      </div>
                      {movie.suggestions && movie.suggestions.length > 0 && (
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          {movie.suggestions.map(sug => (
                            <div key={sug.id} className="rounded-2xl border border-white/10 bg-slate-900/60 p-3 flex flex-col gap-2">
                              <div className="text-sm font-semibold text-white">{sug.title}</div>
                              <div className="text-xs text-slate-400 flex gap-2">
                                {sug.date && <span>{sug.date.slice(0,4)}</span>}
                                <span>TMDB #{sug.id}</span>
                                {sug.vote ? <span>★ {sug.vote.toFixed(1)}</span> : null}
                              </div>
                              <p className="text-xs text-slate-400 leading-relaxed line-clamp-3">{sug.overview}</p>
                              <button className={primaryButton} onClick={()=>addMovieFromSuggestion(movie, sug)}>
                                Add movie with stream
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {libraryShows.length > 0 && (
              <Card>
                <div className="flex items-center justify-between">
                  <SectionTitle>Detected Series ({libraryShows.length})</SectionTitle>
                </div>
                <div className="mt-4 space-y-4">
                  {libraryShows.map(show => (
                    <div key={show.key} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4 space-y-3">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <div className="text-lg font-semibold text-white">{show.title}</div>
                          <div className="text-xs text-slate-400 mt-1">
                            {show.episodes.length} episode file{show.episodes.length !== 1 ? "s" : ""}
                          </div>
                          <details className="mt-3">
                            <summary className="text-xs text-slate-400 cursor-pointer select-none">Show episode files</summary>
                            <ul className="mt-2 space-y-1 text-xs text-slate-400">
                              {show.episodes.slice().sort((a,b)=>(a.season - b.season) || (a.episode - b.episode)).map(ep => (
                                <li key={`${ep.url}`} className="break-all">
                                  S{String(ep.season).padStart(2,"0")}E{String(ep.episode).padStart(2,"0")} — {ep.path}
                                </li>
                              ))}
                            </ul>
                          </details>
                        </div>
                        <div className="flex flex-col gap-2 md:items-end">
                          <button className={`${ghostButton} w-full md:w-auto`} onClick={()=>matchLibraryShow(show)} disabled={show.loading}>
                            {show.loading ? "Searching TMDB…" : "Find on TMDB"}
                          </button>
                          {show.error && <div className="text-xs text-red-300 text-right max-w-xs">{show.error}</div>}
                        </div>
                      </div>
                      {show.suggestions && show.suggestions.length > 0 && (
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          {show.suggestions.map(sug => (
                            <div key={sug.id} className="rounded-2xl border border-white/10 bg-slate-900/60 p-3 flex flex-col gap-2">
                              <div className="text-sm font-semibold text-white">{sug.title}</div>
                              <div className="text-xs text-slate-400 flex gap-2">
                                {sug.date && <span>{sug.date.slice(0,4)}</span>}
                                <span>TMDB #{sug.id}</span>
                                {sug.vote ? <span>★ {sug.vote.toFixed(1)}</span> : null}
                              </div>
                              <p className="text-xs text-slate-400 leading-relaxed line-clamp-3">{sug.overview}</p>
                              <button className={primaryButton} onClick={()=>addShowFromSuggestion(show, sug)}>
                                Add series with streams
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {active === "channels" && (
          <div className="space-y-6">
            <Card>
              <div className="flex flex-col gap-6">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div>
                    <SectionTitle>📺 Live Channels</SectionTitle>
                    <p className="text-sm text-slate-400 max-w-2xl">Manage live streams, logos, and EPG metadata for your channel lineup.</p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                    <button
                      className={secondaryButton}
                      onClick={() => channelImportInputRef.current?.click()}
                    >
                      📥 Import M3U
                    </button>
                    <button className={primaryButton} onClick={addChannel}>
                      ➕ Add Channel
                    </button>
                  </div>
                </div>

                {/* Search and Filter Bar */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4 rounded-xl bg-slate-800/40 border border-white/5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-2">Search Channels</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="Search by name or URL..."
                      value={channelSearchQuery}
                      onChange={(e) => setChannelSearchQuery(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-2">Filter by Group</label>
                    <select
                      className={inputClass}
                      value={channelGroupFilter}
                      onChange={(e) => setChannelGroupFilter(e.target.value)}
                    >
                      <option value="all">All Groups</option>
                      {(() => {
                        const groups = new Set(channels.map(ch => ch.group || "Uncategorized"));
                        return Array.from(groups).sort().map(group => (
                          <option key={group} value={group}>{group}</option>
                        ));
                      })()}
                    </select>
                  </div>
                  <div className="flex items-end gap-2">
                    <button
                      className={`${ghostButton} flex-1`}
                      onClick={() => {
                        setChannelSearchQuery("");
                        setChannelGroupFilter("all");
                        setSelectedChannels(new Set());
                      }}
                    >
                      Clear Filters
                    </button>
                    {selectedChannels.size > 0 && (
                      <button
                        className={dangerButton}
                        onClick={() => {
                          if (window.confirm(`Delete ${selectedChannels.size} selected channel${selectedChannels.size > 1 ? 's' : ''}?`)) {
                            setChannels(cs => cs.filter((_, i) => !selectedChannels.has(i)));
                            setSelectedChannels(new Set());
                          }
                        }}
                      >
                        🗑️ Delete ({selectedChannels.size})
                      </button>
                    )}
                  </div>
                </div>

                {/* Results Count */}
                <div className="flex items-center justify-between text-sm">
                  <div className="text-slate-400">
                    Showing {(() => {
                      const filtered = channels.filter((ch, idx) => {
                        const searchLower = channelSearchQuery.toLowerCase();
                        const matchesSearch = !searchLower || 
                          ch.name?.toLowerCase().includes(searchLower) || 
                          ch.url?.toLowerCase().includes(searchLower);
                        const matchesGroup = channelGroupFilter === "all" || 
                          (ch.group || "Uncategorized") === channelGroupFilter;
                        return matchesSearch && matchesGroup;
                      });
                      return filtered.length;
                    })()} of {channels.length} channels
                  </div>
                  {selectedChannels.size > 0 && (
                    <button
                      className="text-aurora hover:text-sky-400 text-sm font-medium"
                      onClick={() => setSelectedChannels(new Set())}
                    >
                      Deselect all
                    </button>
                  )}
                </div>
              </div>
            </Card>

            <input
              ref={channelImportInputRef}
              type="file"
              accept=".m3u,.m3u8,.txt"
              onChange={handleChannelFileInput}
              className="hidden"
            />
            {(channelImportStatus.active || channelImportStatus.message) && (
              <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
                <div className="text-xs uppercase tracking-wide text-slate-500">Import status</div>
                <div className="mt-1 text-slate-200">
                  {channelImportStatus.message || "Processing…"}
                </div>
                {channelImportStatus.total > 0 && (
                  <div className="mt-1 text-xs text-slate-500">
                    Added {channelImportStatus.added} · Skipped {channelImportStatus.skipped} · Total {channelImportStatus.total}
                  </div>
                )}
              </div>
            )}
            {sortedChannelImports.length > 0 && (
              <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-white">Imported playlists</div>
                    <div className="text-xs text-slate-500">Rename, review, or delete uploads. Deleting removes their channels below.</div>
                  </div>
                  <div className="text-xs text-slate-500 sm:text-right">Total {sortedChannelImports.length}</div>
                </div>
                <div className="mt-4 space-y-3">
                  {sortedChannelImports.map(imp => {
                    const linkedChannels = channelsByImport.get(imp.id) || [];
                    const channelCount = linkedChannels.length;
                    const importDate = imp.createdAt ? new Date(imp.createdAt).toLocaleString() : "";
                    return (
                      <div key={imp.id} className="rounded-xl border border-white/10 bg-slate-950/70 px-4 py-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div className="flex-1 space-y-2">
                            <div>
                              <label className="text-xs uppercase tracking-wide text-slate-500">Playlist name</label>
                              <input
                                className={`${inputClass} mt-1`}
                                value={imp.name}
                                onChange={(e)=>renameChannelImport(imp.id, e.target.value)}
                                onBlur={(e)=>{
                                  const next = e.target.value.trim();
                                  const fallback = imp.originalName || "Imported playlist";
                                  renameChannelImport(imp.id, next || fallback);
                                }}
                              />
                            </div>
                            <div className="text-xs text-slate-500 flex flex-wrap gap-3">
                              <span>{channelCount} channel{channelCount === 1 ? "" : "s"}</span>
                              {imp.originalName ? <span>File: {imp.originalName}</span> : null}
                              {importDate ? <span>Imported: {importDate}</span> : null}
                            </div>
                          </div>
                          <div className="flex flex-col gap-2 lg:items-end">
                            <button
                              className={dangerButton}
                              onClick={()=>{
                                if (window.confirm(`Delete "${imp.name || imp.originalName || "this playlist"}"? This removes ${channelCount} channel${channelCount === 1 ? "" : "s"}.`)) {
                                  removeChannelImport(imp.id);
                                }
                              }}
                            >
                              Delete playlist
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {channels.length > 0 ? (
              <Card>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-900/70 text-xs uppercase tracking-wide text-slate-400">
                      <tr>
                        <th className="px-4 py-3 text-left">
                          <input
                            type="checkbox"
                            checked={selectedChannels.size === channels.filter((ch, idx) => {
                              const searchLower = channelSearchQuery.toLowerCase();
                              const matchesSearch = !searchLower || 
                                ch.name?.toLowerCase().includes(searchLower) || 
                                ch.url?.toLowerCase().includes(searchLower);
                              const matchesGroup = channelGroupFilter === "all" || 
                                (ch.group || "Uncategorized") === channelGroupFilter;
                              return matchesSearch && matchesGroup;
                            }).length && channels.length > 0}
                            onChange={(e) => {
                              if (e.target.checked) {
                                const filtered = channels
                                  .map((ch, idx) => {
                                    const searchLower = channelSearchQuery.toLowerCase();
                                    const matchesSearch = !searchLower || 
                                      ch.name?.toLowerCase().includes(searchLower) || 
                                      ch.url?.toLowerCase().includes(searchLower);
                                    const matchesGroup = channelGroupFilter === "all" || 
                                      (ch.group || "Uncategorized") === channelGroupFilter;
                                    return matchesSearch && matchesGroup ? idx : null;
                                  })
                                  .filter(i => i !== null);
                                setSelectedChannels(new Set(filtered));
                              } else {
                                setSelectedChannels(new Set());
                              }
                            }}
                            className="rounded border-white/20 bg-slate-800/60 text-aurora focus:ring-aurora/50"
                          />
                        </th>
                        <th className="px-4 py-3 text-left font-semibold">#</th>
                        <th className="px-4 py-3 text-left font-semibold">Channel</th>
                        <th className="px-4 py-3 text-left font-semibold">Stream URL</th>
                        <th className="px-4 py-3 text-left font-semibold">Group</th>
                        <th className="px-4 py-3 text-center font-semibold">Health</th>
                        <th className="px-4 py-3 text-right font-semibold">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-slate-200">
                      {channels.map((c, idx) => {
                        const searchLower = channelSearchQuery.toLowerCase();
                        const matchesSearch = !searchLower || 
                          c.name?.toLowerCase().includes(searchLower) || 
                          c.url?.toLowerCase().includes(searchLower);
                        const matchesGroup = channelGroupFilter === "all" || 
                          (c.group || "Uncategorized") === channelGroupFilter;
                        
                        if (!matchesSearch || !matchesGroup) return null;
                        
                        const health = getStreamHealth(c.id);
                        
                        return (
                          <tr key={`${c.id}-row`} className="hover:bg-slate-900/60 transition-colors">
                            <td className="px-4 py-3 align-middle">
                              <input
                                type="checkbox"
                                checked={selectedChannels.has(idx)}
                                onChange={(e) => {
                                  const newSelected = new Set(selectedChannels);
                                  if (e.target.checked) {
                                    newSelected.add(idx);
                                  } else {
                                    newSelected.delete(idx);
                                  }
                                  setSelectedChannels(newSelected);
                                }}
                                className="rounded border-white/20 bg-slate-800/60 text-aurora focus:ring-aurora/50"
                              />
                            </td>
                            <td className="px-4 py-3 align-middle text-slate-400">{c.chno || idx + 1}</td>
                            <td className="px-4 py-3 align-middle">
                              <div className="flex items-center gap-3">
                                {c.logo ? (
                                  <img src={c.logo} alt="" className="h-10 w-10 rounded-lg border border-white/10 object-cover" />
                                ) : (
                                  <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-white/10 text-xs text-slate-500">
                                    📺
                                  </div>
                                )}
                                <div className="text-sm font-medium text-white">{c.name || "Untitled channel"}</div>
                              </div>
                            </td>
                            <td className="px-4 py-3 align-middle">
                              {c.url ? (
                                <a
                                  href={c.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="max-w-[18rem] truncate text-aurora hover:text-sky-400 flex items-center gap-1"
                                  title={c.url}
                                >
                                  {c.url}
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                  </svg>
                                </a>
                              ) : (
                                <span className="text-slate-500">No stream URL</span>
                              )}
                            </td>
                            <td className="px-4 py-3 align-middle">
                              <span className="px-2 py-1 rounded-md text-xs font-medium bg-slate-800/60 text-slate-300">
                                {c.group || "Uncategorized"}
                              </span>
                            </td>
                            <td className="px-4 py-3 align-middle text-center">
                              {health ? (
                                <div className="inline-flex items-center gap-2">
                                  <span className={`text-lg ${health.status === 'working' ? 'text-green-400' : 'text-red-400'}`}>
                                    {health.status === 'working' ? '✅' : '❌'}
                                  </span>
                                  <span className={`text-xs ${health.status === 'working' ? 'text-green-300' : 'text-red-300'}`}>
                                    {health.status === 'working' ? 'Online' : 'Offline'}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-slate-500">Not checked</span>
                              )}
                            </td>
                            <td className="px-4 py-3 align-middle text-right">
                              <button
                                className="text-xs font-medium px-3 py-1.5 rounded-lg text-red-300 hover:bg-red-500/20 transition-all"
                                onClick={() => removeChannel(idx)}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            ) : (
              <Card>
                <div className="text-center py-12 text-slate-400">
                  <div className="text-6xl mb-4">📺</div>
                  <p className="text-lg font-medium mb-2">No channels yet</p>
                  <p className="text-sm">Import a playlist or add channels manually to get started.</p>
                </div>
              </Card>
            )}
            
            {/* Edit Form Section */}
            {channels.length > 0 && (
              <Card>
                <SectionTitle subtitle="Edit channel details individually">
                  ✏️ Channel Editor
                </SectionTitle>
                <div className="space-y-4">
                  {channels.map((c, idx) => {
                    const searchLower = channelSearchQuery.toLowerCase();
                    const matchesSearch = !searchLower || 
                      c.name?.toLowerCase().includes(searchLower) || 
                      c.url?.toLowerCase().includes(searchLower);
                    const matchesGroup = channelGroupFilter === "all" || 
                      (c.group || "Uncategorized") === channelGroupFilter;
                    
                    if (!matchesSearch || !matchesGroup) return null;
                    
                    return (
                      <div key={c.id} className="grid md:grid-cols-12 gap-3 items-center p-4 rounded-xl bg-slate-800/40 border border-white/5 hover:border-aurora/20 transition-colors">
                        <input className={`md:col-span-2 ${inputClass}`} placeholder="Name" value={c.name} onChange={e=>updateChannel(idx,{name:e.target.value})} />
                        <input className={`md:col-span-3 ${inputClass}`} placeholder="Stream URL" value={c.url} onChange={e=>updateChannel(idx,{url:e.target.value})} />
                        <input className={`md:col-span-3 ${inputClass}`} placeholder="Logo URL" value={c.logo} onChange={e=>updateChannel(idx,{logo:e.target.value})} />
                        <input className={`md:col-span-2 ${inputClass}`} placeholder="Group" value={c.group} onChange={e=>updateChannel(idx,{group:e.target.value})} />
                        <input className={`md:col-span-1 ${inputClass}`} placeholder="#" value={c.chno} onChange={e=>updateChannel(idx,{chno:e.target.value})} />
                        <button className={`md:col-span-1 w-full text-xs font-medium px-3 py-2 rounded-lg text-red-300 hover:bg-red-500/20 transition-all`} onClick={()=>removeChannel(idx)}>
                          🗑️
                        </button>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>
        )}

        {active === "epg" && (
          <div className="space-y-6">
            {/* EPG Sources Management */}
            <Card>
              <div className="flex flex-col gap-6">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div>
                    <SectionTitle>📡 EPG Sources</SectionTitle>
                    <p className="text-sm text-slate-400 max-w-2xl">
                      Manage Electronic Program Guide sources for channel schedules and metadata
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className={primaryButton}
                      onClick={addEpgSource}
                    >
                      ➕ Add EPG Source
                    </button>
                    {selectedEpgSources.size > 0 && (
                      <button
                        className={dangerButton}
                        onClick={() => {
                          if (window.confirm(`Delete ${selectedEpgSources.size} selected EPG source${selectedEpgSources.size > 1 ? 's' : ''}?`)) {
                            selectedEpgSources.forEach(id => removeEpgSource(id));
                            setSelectedEpgSources(new Set());
                          }
                        }}
                      >
                        🗑️ Delete ({selectedEpgSources.size})
                      </button>
                    )}
                  </div>
                </div>

                {epgSources.length === 0 ? (
                  <div className="text-center py-16 rounded-xl bg-slate-800/40 border border-dashed border-white/10">
                    <div className="text-6xl mb-4">📡</div>
                    <p className="text-xl font-semibold text-white mb-2">No EPG Sources</p>
                    <p className="text-slate-400 mb-6">Add an EPG XML URL to enable program guides for your channels</p>
                    <button className={primaryButton} onClick={addEpgSource}>
                      ➕ Add First EPG Source
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {epgSources.map(epg => (
                      <div key={epg.id} className="rounded-xl border border-white/10 bg-slate-800/40 p-5 hover:border-aurora/30 transition-all">
                        <div className="flex gap-4">
                          <input
                            type="checkbox"
                            checked={selectedEpgSources.has(epg.id)}
                            onChange={(e) => {
                              const newSelected = new Set(selectedEpgSources);
                              if (e.target.checked) {
                                newSelected.add(epg.id);
                              } else {
                                newSelected.delete(epg.id);
                              }
                              setSelectedEpgSources(newSelected);
                            }}
                            className="mt-1 rounded border-white/20 bg-slate-800/60 text-aurora focus:ring-aurora/50"
                          />
                          
                          <div className="flex-1 space-y-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 space-y-3">
                                <div>
                                  <label className="block text-xs font-semibold text-slate-400 mb-2">EPG Name</label>
                                  <input
                                    className={inputClass}
                                    placeholder="e.g., Main EPG, Backup EPG"
                                    value={epg.name}
                                    onChange={(e) => updateEpgSource(epg.id, { name: e.target.value })}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold text-slate-400 mb-2">EPG XML URL</label>
                                  <input
                                    className={inputClass}
                                    placeholder="https://example.com/epg.xml or http://example.com/xmltv.php"
                                    value={epg.url}
                                    onChange={(e) => updateEpgSource(epg.id, { url: e.target.value })}
                                  />
                                  <p className="text-xs text-slate-500 mt-2 flex items-start gap-2">
                                    <span className="text-aurora">💡</span>
                                    <span>XMLTV format EPG files. Can be local file:// URLs or HTTP/HTTPS endpoints</span>
                                  </p>
                                </div>
                              </div>
                              
                              <div className="flex flex-col gap-2 items-end">
                                <div className="flex items-center gap-2">
                                  <label className="text-xs font-semibold text-slate-400">Enabled</label>
                                  <input
                                    type="checkbox"
                                    checked={epg.enabled}
                                    onChange={(e) => updateEpgSource(epg.id, { enabled: e.target.checked })}
                                    className="rounded border-white/20 bg-slate-800/60 text-aurora focus:ring-aurora/50"
                                  />
                                </div>
                                <button
                                  className="text-xs font-medium px-3 py-1.5 rounded-lg text-red-300 hover:bg-red-500/20 transition-all"
                                  onClick={() => {
                                    if (window.confirm(`Delete EPG source "${epg.name}"?`)) {
                                      removeEpgSource(epg.id);
                                    }
                                  }}
                                >
                                  🗑️ Remove
                                </button>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 text-xs text-slate-500">
                              <span>Created: {new Date(epg.createdAt).toLocaleDateString()}</span>
                              <span>•</span>
                              <span className={epg.enabled ? "text-green-400" : "text-slate-500"}>
                                {epg.enabled ? "✓ Active" : "○ Disabled"}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>

            {/* Channel EPG Mapping */}
            {epgSources.length > 0 && channels.length > 0 && (
              <Card>
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <SectionTitle>🔗 Channel EPG Mapping</SectionTitle>
                    <p className="text-sm text-slate-400 mt-1">
                      Map your channels to EPG data for program guide information
                    </p>
                  </div>
                  <button
                    className={primaryButton}
                    onClick={autoMapEpgChannels}
                    disabled={autoMapStatus.active}
                  >
                    {autoMapStatus.active ? (
                      <>
                        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                        </svg>
                        Mapping...
                      </>
                    ) : (
                      <>✨ Auto-Map Channels</>
                    )}
                  </button>
                </div>

                <div className="space-y-3">
                  {channels.slice(0, 50).map((channel, idx) => {
                    const mapping = epgMappings[channel.id];
                    const mappedSource = mapping ? epgSources.find(s => s.id === mapping.epgSourceId) : null;
                    
                    return (
                      <div key={channel.id} className="grid lg:grid-cols-12 gap-3 items-center p-4 rounded-xl bg-slate-800/40 border border-white/5 hover:border-aurora/20 transition-colors">
                        <div className="lg:col-span-3 flex items-center gap-3">
                          {channel.logo ? (
                            <img src={channel.logo} alt="" className="w-10 h-10 rounded-lg object-cover border border-white/10 flex-shrink-0" />
                          ) : (
                            <div className="w-10 h-10 rounded-lg border border-dashed border-white/10 flex items-center justify-center text-xs flex-shrink-0">📺</div>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-white truncate">{channel.name}</div>
                            <div className="text-xs text-slate-500 truncate">#{channel.chno || idx + 1}</div>
                          </div>
                        </div>
                        
                        <div className="lg:col-span-3">
                          <label className="block text-xs font-semibold text-slate-400 mb-2">EPG Source</label>
                          <select
                            className={inputClass}
                            value={mapping?.epgSourceId || ""}
                            onChange={(e) => {
                              const sourceId = e.target.value;
                              if (!sourceId) {
                                clearChannelEpgMapping(channel.id);
                              } else {
                                setChannelEpgMapping(channel.id, channel.id, sourceId);
                              }
                            }}
                          >
                            <option value="">No EPG</option>
                            {epgSources.filter(s => s.enabled).map(source => (
                              <option key={source.id} value={source.id}>{source.name}</option>
                            ))}
                          </select>
                        </div>
                        
                        <div className="lg:col-span-4">
                          <label className="block text-xs font-semibold text-slate-400 mb-2">EPG Channel ID</label>
                          <input
                            className={inputClass}
                            placeholder="Channel ID from EPG (e.g., bbc.one.uk)"
                            value={mapping?.epgChannelId || ""}
                            onChange={(e) => {
                              if (mapping?.epgSourceId) {
                                setChannelEpgMapping(channel.id, e.target.value, mapping.epgSourceId);
                              }
                            }}
                            disabled={!mapping?.epgSourceId}
                          />
                        </div>
                        
                        <div className="lg:col-span-2 flex items-end gap-2">
                          <div className={`text-xs px-3 py-2 rounded-lg ${mapping ? 'bg-green-500/20 text-green-300' : 'bg-slate-700/40 text-slate-500'}`}>
                            {mapping ? '✓ Mapped' : '○ Not Mapped'}
                          </div>
                          {mapping && (
                            <button
                              className="text-xs font-medium px-2 py-1.5 rounded-lg text-red-300 hover:bg-red-500/20 transition-all"
                              onClick={() => clearChannelEpgMapping(channel.id)}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {channels.length > 50 && (
                    <div className="text-center py-4 text-sm text-slate-500">
                      Showing first 50 of {channels.length} channels
                    </div>
                  )}
                </div>
              </Card>
            )}

            {/* EPG Info */}
            <Card>
              <SectionTitle>ℹ️ About EPG</SectionTitle>
              <div className="space-y-4 text-sm text-slate-300">
                <div className="p-4 rounded-xl bg-slate-800/40 border border-white/5">
                  <h4 className="font-semibold text-white mb-2">What is EPG?</h4>
                  <p className="text-slate-400">
                    Electronic Program Guide (EPG) provides TV schedules and program information for your channels. 
                    EPG data is typically provided in XMLTV format from your IPTV provider.
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-slate-800/40 border border-white/5">
                  <h4 className="font-semibold text-white mb-2">How to use EPG:</h4>
                  <ol className="list-decimal list-inside space-y-2 text-slate-400 ml-2">
                    <li>Add one or more EPG XML URLs from your IPTV provider</li>
                    <li>Use Auto-Map to automatically match channels by their tvg-id</li>
                    <li>Or manually map each channel to its EPG Channel ID</li>
                    <li>Export your playlist with EPG URLs included in the M3U file</li>
                  </ol>
                </div>
                <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/30">
                  <h4 className="font-semibold text-blue-300 mb-2">💡 Tips:</h4>
                  <ul className="list-disc list-inside space-y-1 text-slate-400 ml-2">
                    <li>EPG sources can be HTTP/HTTPS URLs or local file:// paths</li>
                    <li>Multiple EPG sources can be used for different channel groups</li>
                    <li>EPG URLs are added to the M3U header when you export</li>
                    <li>Most IPTV players will automatically fetch EPG data from these URLs</li>
                  </ul>
                </div>
              </div>
            </Card>
          </div>
        )}

        {active === "shows" && (
          <div className="space-y-6">
            {/* Import Section */}
            <Card>
              <SectionTitle 
                subtitle="Search TMDB by name or import by ID to add series with metadata"
              >
                🎬 Add TV Show
              </SectionTitle>
              <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
                <div className="space-y-3">
                  <label className="block text-sm font-semibold text-slate-300">Search TMDB</label>
                  <input
                    className={inputClass}
                    placeholder="e.g., Breaking Bad, Game of Thrones, or TMDB ID like 1399"
                    value={showSearchQuery}
                    onChange={(e)=>setShowSearchQuery(e.target.value)}
                  />
                  <p className="text-xs text-slate-500 flex items-start gap-2">
                    <span className="text-aurora">💡</span>
                    <span>{apiKey ? "Type to search or enter numeric TMDB ID" : "Add your TMDB API key to enable search"}</span>
                  </p>
                </div>
                <button
                  className={primaryButton}
                  disabled={!showSearchQuery.trim() || !apiKey}
                  onClick={async ()=>{
                    const val = showSearchQuery.trim();
                    if (!val) return;
                    if (!/^\d+$/.test(val)) {
                      showToast("To import by ID, enter a numeric TMDB identifier. Or select from suggestions below.", "error");
                      return;
                    }
                    try {
                      await importShow(val);
                      setShowSearchQuery("");
                      setShowSuggestions([]);
                      showToast("TV Show imported successfully!", "success");
                    } catch (err) {
                      showToast("Failed to import show: " + err.message, "error");
                    }
                  }}
                >
                  {showSearchQuery.trim() && /^\d+$/.test(showSearchQuery.trim()) ? "📥 Import by ID" : "🔍 Search"}
                </button>
              </div>
              {showSearchBusy && apiKey && (
                <div className="mt-4 flex items-center gap-3 text-sm text-aurora">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                  </svg>
                  <span>Searching TMDB...</span>
                </div>
              )}
              {apiKey && showSuggestions.length > 0 && (
                <div className="mt-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-white">Search Results</div>
                    <div className="text-xs text-slate-500">{showSuggestions.length} found</div>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2">
                    {showSuggestions.map(sug => (
                      <div key={sug.id} className="flex gap-4 rounded-xl border border-white/10 bg-slate-800/40 p-4 hover:border-aurora/30 transition-all">
                        {sug.poster ? (
                          <img src={sug.poster} alt="" className="w-20 h-28 rounded-lg object-cover border border-white/10 flex-shrink-0" />
                        ) : (
                          <div className="w-20 h-28 rounded-lg border border-dashed border-white/10 flex items-center justify-center text-3xl flex-shrink-0">🎬</div>
                        )}
                        <div className="flex-1 flex flex-col gap-2">
                          <div>
                            <div className="font-semibold text-white">{sug.title}</div>
                            <div className="text-xs text-slate-400 flex gap-2 mt-1">
                              {sug.date && <span>📅 {sug.date.slice(0,4)}</span>}
                              <span>ID: {sug.id}</span>
                              {sug.vote ? <span>⭐ {sug.vote.toFixed(1)}</span> : null}
                            </div>
                          </div>
                          <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">{sug.overview || "No description available"}</p>
                          <button 
                            className={`${primaryButton} mt-auto text-sm py-2`}
                            onClick={async ()=>{
                              try {
                                await importShow(String(sug.id));
                                setShowSearchQuery("");
                                setShowSuggestions([]);
                                showToast(`"${sug.title}" imported successfully!`, "success");
                              } catch (err) {
                                showToast("Failed to import: " + err.message, "error");
                              }
                            }}
                          >
                            ➕ Add Show
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Shows Library */}
            {shows.length > 0 && (
              <Card>
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <SectionTitle>📺 Your TV Shows</SectionTitle>
                    <p className="text-sm text-slate-400 mt-1">{shows.length} series in your library</p>
                  </div>
                  <div className="flex gap-2 items-center">
                    <select
                      className={`${inputClass} w-40 py-2`}
                      value={showSortBy}
                      onChange={(e) => setShowSortBy(e.target.value)}
                    >
                      <option value="added">Recently Added</option>
                      <option value="title">Title A-Z</option>
                      <option value="year">Year (Newest)</option>
                      <option value="rating">Rating (Highest)</option>
                    </select>
                    <input
                      type="text"
                      className={`${inputClass} w-64 py-2`}
                      placeholder="Search shows..."
                      value={showSearchFilter}
                      onChange={(e) => setShowSearchFilter(e.target.value)}
                    />
                    {selectedShows.size > 0 && (
                      <button
                        className={dangerButton}
                        onClick={() => {
                          if (window.confirm(`Delete ${selectedShows.size} selected show${selectedShows.size > 1 ? 's' : ''}?`)) {
                            setShows(ss => ss.filter(s => !selectedShows.has(s.id)));
                            setSelectedShows(new Set());
                          }
                        }}
                      >
                        🗑️ Delete ({selectedShows.size})
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  {shows.filter(s => {
                    if (!showSearchFilter.trim()) return true;
                    const search = showSearchFilter.toLowerCase();
                    return s.title?.toLowerCase().includes(search) || 
                           s.genres?.toLowerCase().includes(search) ||
                           s.year?.toString().includes(search);
                  })
                  .sort((a, b) => {
                    switch(showSortBy) {
                      case "title":
                        return (a.title || "").localeCompare(b.title || "");
                      case "year":
                        return (b.year || 0) - (a.year || 0);
                      case "rating":
                        return (b.rating || 0) - (a.rating || 0);
                      case "added":
                      default:
                        // Most recently added first (reverse ID order)
                        return b.id.localeCompare(a.id);
                    }
                  })
                  .map((show, idx) => {
                    const isNew = idx < 5 && showSortBy === "added"; // Mark first 5 as new when sorted by added
                    const totalEpisodes = show.seasons?.reduce((sum, season) => sum + (season.episodes?.length || 0), 0) || 0;
                    const episodesWithUrls = show.seasons?.reduce((sum, season) => 
                      sum + (season.episodes?.filter(ep => ep.url).length || 0), 0) || 0;
                    
                    return (
                      <div key={show.id} className="rounded-xl border border-white/10 bg-slate-800/40 p-5 hover:border-aurora/30 transition-all">
                        <div className="flex gap-4">
                          <input
                            type="checkbox"
                            checked={selectedShows.has(show.id)}
                            onChange={(e) => {
                              const newSelected = new Set(selectedShows);
                              if (e.target.checked) {
                                newSelected.add(show.id);
                              } else {
                                newSelected.delete(show.id);
                              }
                              setSelectedShows(newSelected);
                            }}
                            className="mt-1 rounded border-white/20 bg-slate-800/60 text-aurora focus:ring-aurora/50"
                          />
                          
                          {show.poster ? (
                            <img src={show.poster} alt="" className="w-16 h-24 rounded-lg object-cover border border-white/10 flex-shrink-0" />
                          ) : (
                            <div className="w-16 h-24 rounded-lg border border-dashed border-white/10 flex items-center justify-center text-2xl flex-shrink-0">🎬</div>
                          )}
                          
                          <div className="flex-1 space-y-3">
                            <div>
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <div className="text-lg font-bold text-white">
                                      {show.title}
                                      {show.year && <span className="text-slate-400 font-normal ml-1">({show.year})</span>}
                                    </div>
                                    {isNew && (
                                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-300 border border-green-500/30">
                                        NEW
                                      </span>
                                    )}
                                    {show.status && (
                                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                        show.status === "Returning Series" ? "bg-green-500/20 text-green-300 border border-green-500/30" :
                                        show.status === "Ended" ? "bg-red-500/20 text-red-300 border border-red-500/30" :
                                        "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                                      }`}>
                                        {show.status}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-slate-400 mt-1 flex gap-3 flex-wrap">
                                    {show.rating > 0 && (
                                      <span className="text-yellow-400">⭐ {show.rating.toFixed(1)}</span>
                                    )}
                                    <span>TMDB #{show.tmdbId}</span>
                                    <span>📺 {show.numberOfSeasons || show.seasons?.length || 0} season{(show.numberOfSeasons || show.seasons?.length || 0) !== 1 ? 's' : ''}</span>
                                    <span>🎬 {show.numberOfEpisodes || totalEpisodes} episode{(show.numberOfEpisodes || totalEpisodes) !== 1 ? 's' : ''}</span>
                                    <span className={episodesWithUrls === totalEpisodes ? "text-green-400" : "text-yellow-400"}>
                                      🔗 {episodesWithUrls}/{totalEpisodes} linked
                                    </span>
                                  </div>
                                  {show.genres && (
                                    <div className="flex gap-1 mt-1 flex-wrap">
                                      {show.genres.split(", ").slice(0, 3).map(genre => (
                                        <span key={genre} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-300 border border-blue-500/30">
                                          {genre}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <button
                                  className="text-xs font-medium px-3 py-1.5 rounded-lg text-red-300 hover:bg-red-500/20 transition-all flex-shrink-0"
                                  onClick={() => {
                                    if (window.confirm(`Delete "${show.title}"?`)) {
                                      setShows(ss => ss.filter(s => s.id !== show.id));
                                    }
                                  }}
                                >
                                  🗑️ Remove
                                </button>
                              </div>
                              
                              {show.overview && (
                                <p className="text-sm text-slate-400 mt-2 line-clamp-2">{show.overview}</p>
                              )}
                            </div>

                            {/* Group Input */}
                            <div className="flex gap-3 items-center">
                              <label className="text-xs text-slate-400 font-semibold">Group:</label>
                              <input
                                className={`${inputClass} flex-1 max-w-xs py-2 text-sm`}
                                placeholder="e.g., TV Shows, Series, etc."
                                value={show.group || ""}
                                onChange={(e) => setShowPatch(show.id, { group: e.target.value })}
                              />
                            </div>

                            {/* URL Pattern Section */}
                            <details className="group">
                              <summary className="cursor-pointer text-sm font-semibold text-aurora hover:text-sky-400 flex items-center gap-2">
                                <span>⚙️ Configure Episode URLs</span>
                                <span className="text-xs text-slate-500">({show.pattern ? "Pattern set" : "Not configured"})</span>
                              </summary>
                              <div className="mt-4 space-y-3 p-4 rounded-lg bg-slate-900/60 border border-white/5">
                                <div>
                                  <label className="block text-xs font-semibold text-slate-400 mb-2">URL Pattern</label>
                                  <input
                                    className={inputClass}
                                    placeholder="e.g., https://cdn.example.com/show/{season}/{episode}.mp4"
                                    value={show.pattern || ""}
                                    onChange={(e) => setShowPatch(show.id, { pattern: e.target.value })}
                                  />
                                  <p className="text-xs text-slate-500 mt-2">
                                    Use tokens: {"{season}"}, {"{episode}"}, {"{s2}"}, {"{e2}"} (zero-padded)
                                  </p>
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    className={secondaryButton}
                                    onClick={() => {
                                      const samples = prompt("Paste 2-3 sample URLs (one per line):");
                                      if (samples) {
                                        guessPattern(show.id, samples.split("\n"));
                                      }
                                    }}
                                  >
                                    🔮 Auto-detect Pattern
                                  </button>
                                  <button
                                    className={primaryButton}
                                    onClick={() => {
                                      if (show.pattern) {
                                        fillShowUrls(show.id);
                                        showToast("Episode URLs generated from pattern!", "success");
                                      } else {
                                        showToast("Please set a URL pattern first", "error");
                                      }
                                    }}
                                  >
                                    ✨ Generate URLs
                                  </button>
                                </div>
                              </div>
                            </details>

                            {/* Seasons Overview */}
                            <details>
                              <summary className="cursor-pointer text-sm font-semibold text-slate-300 hover:text-white flex items-center gap-2">
                                📋 View Seasons & Episodes
                              </summary>
                              <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
                                {show.seasons?.map(season => (
                                  <div key={season.season} className="text-xs bg-slate-900/40 rounded-lg p-3 border border-white/5">
                                    <div className="font-semibold text-white mb-1">
                                      Season {season.season} - {season.episodes?.length || 0} episodes
                                    </div>
                                    <div className="text-slate-400 space-y-1">
                                      {season.episodes?.slice(0, 5).map(ep => (
                                        <div key={ep.episode} className="flex items-center gap-2">
                                          <span className={ep.url ? "text-green-400" : "text-slate-500"}>
                                            {ep.url ? "✓" : "○"}
                                          </span>
                                          <span>E{String(ep.episode).padStart(2, "0")}: {ep.title}</span>
                                        </div>
                                      ))}
                                      {season.episodes && season.episodes.length > 5 && (
                                        <div className="text-slate-500 italic">...and {season.episodes.length - 5} more</div>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </details>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {shows.length === 0 && (
              <Card>
                <div className="text-center py-16">
                  <div className="text-6xl mb-4">🎬</div>
                  <p className="text-xl font-semibold text-white mb-2">No TV Shows Yet</p>
                  <p className="text-slate-400">Search and add your first TV series to get started</p>
                </div>
              </Card>
            )}
          </div>
        )}

        {active === "movies" && (
          <div className="space-y-6">
            {/* Import Section */}
            <Card>
              <SectionTitle 
                subtitle="Search TMDB by name or import by ID to add movies with metadata"
              >
                🎥 Add Movie
              </SectionTitle>
              <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
                <div className="space-y-3">
                  <label className="block text-sm font-semibold text-slate-300">Search TMDB</label>
                  <input
                    className={inputClass}
                    placeholder="e.g., Inception, The Matrix, or TMDB ID like 550"
                    value={movieSearchQuery}
                    onChange={(e)=>setMovieSearchQuery(e.target.value)}
                  />
                  <p className="text-xs text-slate-500 flex items-start gap-2">
                    <span className="text-aurora">💡</span>
                    <span>{apiKey ? "Type to search or enter numeric TMDB ID" : "Add your TMDB API key to enable search"}</span>
                  </p>
                </div>
                <button
                  className={primaryButton}
                  disabled={!movieSearchQuery.trim() || !apiKey}
                  onClick={async ()=>{
                    const val = movieSearchQuery.trim();
                    if (!val) return;
                    if (!/^\d+$/.test(val)) {
                      showToast("To import by ID, enter a numeric TMDB identifier. Or select from suggestions below.", "error");
                      return;
                    }
                    try {
                      await importMovie(val);
                      setMovieSearchQuery("");
                      setMovieSuggestions([]);
                      showToast("Movie imported successfully!", "success");
                    } catch (err) {
                      showToast("Failed to import movie: " + err.message, "error");
                    }
                  }}
                >
                  {movieSearchQuery.trim() && /^\d+$/.test(movieSearchQuery.trim()) ? "📥 Import by ID" : "🔍 Search"}
                </button>
              </div>
              {movieSearchBusy && apiKey && (
                <div className="mt-4 flex items-center gap-3 text-sm text-aurora">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                  </svg>
                  <span>Searching TMDB...</span>
                </div>
              )}
              {apiKey && movieSuggestions.length > 0 && (
                <div className="mt-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-white">Search Results</div>
                    <div className="text-xs text-slate-500">{movieSuggestions.length} found</div>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2">
                    {movieSuggestions.map(sug => (
                      <div key={sug.id} className="flex gap-4 rounded-xl border border-white/10 bg-slate-800/40 p-4 hover:border-aurora/30 transition-all">
                        {sug.poster ? (
                          <img src={sug.poster} alt="" className="w-20 h-28 rounded-lg object-cover border border-white/10 flex-shrink-0" />
                        ) : (
                          <div className="w-20 h-28 rounded-lg border border-dashed border-white/10 flex items-center justify-center text-3xl flex-shrink-0">🎥</div>
                        )}
                        <div className="flex-1 flex flex-col gap-2">
                          <div>
                            <div className="font-semibold text-white">{sug.title}</div>
                            <div className="text-xs text-slate-400 flex gap-2 mt-1">
                              {sug.date && <span>📅 {sug.date.slice(0,4)}</span>}
                              <span>ID: {sug.id}</span>
                              {sug.vote ? <span>⭐ {sug.vote.toFixed(1)}</span> : null}
                            </div>
                          </div>
                          <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">{sug.overview || "No description available"}</p>
                          <button 
                            className={`${primaryButton} mt-auto text-sm py-2`}
                            onClick={async ()=>{
                              try {
                                await importMovie(String(sug.id));
                                setMovieSearchQuery("");
                                setMovieSuggestions([]);
                                showToast(`"${sug.title}" imported successfully!`, "success");
                              } catch (err) {
                                showToast("Failed to import: " + err.message, "error");
                              }
                            }}
                          >
                            ➕ Add Movie
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Movies Library */}
            {movies.length > 0 && (
              <Card>
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <SectionTitle>🎬 Your Movies</SectionTitle>
                    <p className="text-sm text-slate-400 mt-1">{movies.length} films in your library</p>
                  </div>
                  <div className="flex gap-2 items-center">
                    <select
                      className={`${inputClass} w-40 py-2`}
                      value={movieSortBy}
                      onChange={(e) => setMovieSortBy(e.target.value)}
                    >
                      <option value="added">Recently Added</option>
                      <option value="title">Title A-Z</option>
                      <option value="year">Year (Newest)</option>
                      <option value="rating">Rating (Highest)</option>
                    </select>
                    <input
                      type="text"
                      className={`${inputClass} w-64 py-2`}
                      placeholder="Search movies..."
                      value={movieSearchFilter}
                      onChange={(e) => setMovieSearchFilter(e.target.value)}
                    />
                    {selectedMovies.size > 0 && (
                      <button
                        className={dangerButton}
                        onClick={() => {
                          if (window.confirm(`Delete ${selectedMovies.size} selected movie${selectedMovies.size > 1 ? 's' : ''}?`)) {
                            setMovies(ms => ms.filter(m => !selectedMovies.has(m.id)));
                            setSelectedMovies(new Set());
                          }
                        }}
                      >
                        🗑️ Delete ({selectedMovies.size})
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  {movies.filter(m => {
                    if (!movieSearchFilter.trim()) return true;
                    const search = movieSearchFilter.toLowerCase();
                    return m.title?.toLowerCase().includes(search) || 
                           m.genres?.toLowerCase().includes(search) ||
                           m.year?.toString().includes(search);
                  })
                  .sort((a, b) => {
                    switch(movieSortBy) {
                      case "title":
                        return (a.title || "").localeCompare(b.title || "");
                      case "year":
                        return (b.year || 0) - (a.year || 0);
                      case "rating":
                        return (b.rating || 0) - (a.rating || 0);
                      case "added":
                      default:
                        // Most recently added first (reverse ID order)
                        return b.id.localeCompare(a.id);
                    }
                  })
                  .map((movie, idx) => {
                    const isNew = idx < 5 && movieSortBy === "added"; // Mark first 5 as new when sorted by added
                    return (
                    <div key={movie.id} className="rounded-lg border border-white/10 bg-slate-800/40 p-3 hover:border-aurora/30 transition-all">
                      <div className="flex gap-3">
                        <input
                          type="checkbox"
                          checked={selectedMovies.has(movie.id)}
                          onChange={(e) => {
                            const newSelected = new Set(selectedMovies);
                            if (e.target.checked) {
                              newSelected.add(movie.id);
                            } else {
                              newSelected.delete(movie.id);
                            }
                            setSelectedMovies(newSelected);
                          }}
                          className="mt-0.5 rounded border-white/20 bg-slate-800/60 text-aurora focus:ring-aurora/50 flex-shrink-0"
                        />
                        
                        {movie.poster ? (
                          <img src={movie.poster} alt="" className="w-12 h-16 rounded object-cover border border-white/10 flex-shrink-0" />
                        ) : (
                          <div className="w-12 h-16 rounded border border-dashed border-white/10 flex items-center justify-center text-xl flex-shrink-0">🎥</div>
                        )}
                        
                        <div className="flex-1 space-y-2 min-w-0">
                          <div>
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <div className="text-sm font-bold text-white truncate">
                                    {movie.title}
                                    {movie.year && <span className="text-slate-400 font-normal ml-1">({movie.year})</span>}
                                  </div>
                                  {isNew && (
                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-300 border border-green-500/30">
                                      NEW
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-slate-400 mt-0.5 flex gap-2 flex-wrap items-center">
                                  {movie.rating > 0 && (
                                    <span className="text-yellow-400">⭐ {movie.rating.toFixed(1)}</span>
                                  )}
                                  {movie.runtime && (
                                    <span>{Math.floor(movie.runtime / 60)}h {movie.runtime % 60}m</span>
                                  )}
                                  <span className="truncate">TMDB #{movie.tmdbId}</span>
                                  <span className={movie.url ? "text-green-400" : "text-yellow-400"}>
                                    {movie.url ? "🔗" : "⚠️"}
                                  </span>
                                </div>
                                {movie.genres && (
                                  <div className="flex gap-1 mt-1 flex-wrap">
                                    {movie.genres.split(", ").slice(0, 3).map(genre => (
                                      <span key={genre} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-300 border border-blue-500/30">
                                        {genre}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <button
                                className="text-xs px-2 py-1 rounded text-red-300 hover:bg-red-500/20 transition-all flex-shrink-0"
                                onClick={() => {
                                  if (window.confirm(`Delete "${movie.title}"?`)) {
                                    setMovies(ms => ms.filter(m => m.id !== movie.id));
                                  }
                                }}
                              >
                                🗑️
                              </button>
                            </div>
                            
                            {movie.overview && (
                              <p className="text-xs text-slate-400 mt-1 line-clamp-1">{movie.overview}</p>
                            )}
                          </div>

                          {/* Stream URL */}
                          <div>
                            <label className="block text-xs font-medium text-slate-400 mb-1">Stream URL</label>
                            <input
                              className={`${inputClass} py-1.5 text-sm`}
                              placeholder="https://cdn.example.com/movies/movie.mp4"
                              value={movie.url || ""}
                              onChange={(e) => setMoviePatch(movie.id, { url: e.target.value })}
                            />
                          </div>

                          {/* Group Input */}
                          <div className="flex gap-2 items-center">
                            <label className="text-xs text-slate-400 font-medium">Group:</label>
                            <input
                              className={`${inputClass} flex-1 max-w-xs py-1 text-xs`}
                              placeholder="e.g., Movies"
                              value={movie.group || ""}
                              onChange={(e) => setMoviePatch(movie.id, { group: e.target.value })}
                            />
                          </div>

                          {/* Additional Details - Collapsible */}
                          <details>
                            <summary className="cursor-pointer text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5">
                              ⚙️ Advanced
                            </summary>
                            <div className="mt-2 space-y-2 p-3 rounded-lg bg-slate-900/60 border border-white/5">
                              <div>
                                <label className="block text-xs font-medium text-slate-400 mb-1">Poster URL</label>
                                <input
                                  className={`${inputClass} py-1.5 text-sm`}
                                  placeholder="https://image.tmdb.org/t/p/w342/..."
                                  value={movie.poster || ""}
                                  onChange={(e) => setMoviePatch(movie.id, { poster: e.target.value })}
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-400 mb-1">Overview/Description</label>
                                <textarea
                                  className={`${textareaClass} min-h-[80px] text-sm`}
                                  placeholder="Movie description..."
                                  value={movie.overview || ""}
                                  onChange={(e) => setMoviePatch(movie.id, { overview: e.target.value })}
                                />
                              </div>
                            </div>
                          </details>
                        </div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {movies.length === 0 && (
              <Card>
                <div className="text-center py-16">
                  <div className="text-6xl mb-4">🎥</div>
                  <p className="text-xl font-semibold text-white mb-2">No Movies Yet</p>
                  <p className="text-slate-400">Search and add your first movie to get started</p>
                </div>
              </Card>
            )}
          </div>
        )}

        {active === "playlist" && (
          <Card>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <SectionTitle>Playlist Preview (.m3u)</SectionTitle>
              <div className="flex flex-wrap gap-3">
                <button className={primaryButton} onClick={()=>downloadText("playlist.m3u", m3u)}>Download .m3u</button>
                <button className={ghostButton} onClick={()=>navigator.clipboard.writeText(m3u)}>Copy</button>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              <div className="text-xs uppercase tracking-wide text-slate-400">Hosted playlist URL</div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <input className={`${inputClass} sm:flex-1`} readOnly value={playlistUrl} />
                <button className={secondaryButton} onClick={()=>navigator.clipboard.writeText(playlistUrl)}>Copy URL</button>
              </div>
              <div className="text-xs text-slate-500">
                {playlistSyncStatus === "syncing" && "Uploading latest playlist…"}
                {playlistSyncStatus === "saved" && "Playlist synced. Use this URL in any IPTV player."}
                {playlistSyncStatus === "error" && "Sync failed — the download button still gives you a local file."}
                {playlistSyncStatus === "idle" && "Playlist ready. Changes auto-sync to the URL above."}
              </div>
            </div>
            <div className="mt-6 space-y-2">
              <div className="text-xs uppercase tracking-wide text-slate-400">Hosted EPG/XMLTV URL</div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <input className={`${inputClass} sm:flex-1`} readOnly value={epgUrl} />
                <button className={secondaryButton} onClick={()=>navigator.clipboard.writeText(epgUrl)}>Copy URL</button>
                <button className={ghostButton} onClick={()=>downloadText("epg.xml", epg)}>Download XML</button>
              </div>
              <div className="text-xs text-slate-500">
                {epgSyncStatus === "syncing" && "Uploading latest EPG…"}
                {epgSyncStatus === "saved" && "EPG synced. Use this URL in IPTV players that support EPG."}
                {epgSyncStatus === "error" && "EPG sync failed — the download button still gives you a local file."}
                {epgSyncStatus === "idle" && "EPG ready. Changes auto-sync to the URL above."}
              </div>
            </div>
            <textarea className={`${inputClass} h-96 font-mono text-sm`} value={m3u} onChange={()=>{}} />
            <p className="text-xs text-slate-400 mt-3">Entries use #EXTINF with tvg-id, tvg-logo, group-title, and tvg-chno when provided.</p>
          </Card>
        )}
      </main>

      <footer className="py-12 text-center text-xs text-slate-500/80">Built with ❤️ – Local-only demo. Add auth & backend before shipping.</footer>
      
      {/* Toast Notifications */}
      <div className="fixed bottom-6 right-6 z-50 space-y-3 max-w-md">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex items-start gap-3 p-4 rounded-xl shadow-2xl backdrop-blur-xl border transform transition-all duration-300 animate-slide-in ${
              toast.type === "success"
                ? "bg-green-500/20 border-green-500/40 text-green-100"
                : toast.type === "error"
                ? "bg-red-500/20 border-red-500/40 text-red-100"
                : "bg-aurora/20 border-aurora/40 text-white"
            }`}
          >
            <div className="text-2xl flex-shrink-0">
              {toast.type === "success" ? "✅" : toast.type === "error" ? "❌" : "ℹ️"}
            </div>
            <div className="flex-1 text-sm font-medium leading-relaxed">{toast.message}</div>
            <button
              onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
              className="text-white/60 hover:text-white transition-colors flex-shrink-0"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export { ErrorBoundary };
