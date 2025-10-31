import React, { useEffect, useMemo, useRef, useState } from "react";
import freekeys from "freekeys";

// M3U Studio – single-file React app
// Notes
// - Paste your TMDB API key in the UI (for demo) or wire a proxy/API server in production.
// - Everything is stored in localStorage so you don't lose work while iterating.
// - Generates an .m3u you can download. Supports channels, TV shows, and movies.
// - URL pattern helper guesses episode links from a few samples.

// ---------- Utility helpers ----------
const saveLS = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const readLS = (k, d) => {
  try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; } catch { return d; }
};

const pad = (n, len = 2) => String(n).padStart(len, "0");

const sanitize = (s) => (s ?? "").toString().replace(/\n/g, " ").trim();

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
    .replace(/[_\.]+/g, " ")
    .replace(/\s*(\(|\[).*?(DIVX|1080p|720p|x264|x265|BluRay|WEBRip|HDR).*(\)|\])\s*/gi, " ")
    .replace(/\s+/g, " ");

  cleaned = cleaned.replace(QUALITY_REGEX, " ");
  cleaned = cleaned.replace(/-\s*(theatrical|extended|director's cut)$/i, " ");
  cleaned = cleaned.replace(/\bpart\s*\d+$/i, " ");

  return cleaned.replace(/\s+/g, " ").trim();
}

function parseMediaName(filename) {
  const decoded = decodeURIComponent(filename);
  const noExt = decoded.replace(/\.[^/.]+$/, "");
  const normalized = normalizeTitle(noExt);
  const episodeRegex = /(?:^|\b)[Ss](\d{1,2})[^\d]{0,2}[Ee](\d{1,2})(?:\b|[^0-9])/;
  const seasonEpisodeAlt = /Season\s*(\d{1,2}).*Episode\s*(\d{1,2})/i;
  const xNotation = /(\d{1,2})x(\d{1,2})/;

  let match = normalized.match(episodeRegex);
  if (!match) match = normalized.match(seasonEpisodeAlt);
  if (!match) match = normalized.match(xNotation);

  if (match) {
    const season = parseInt(match[1], 10);
    const episode = parseInt(match[2], 10);
    const title = normalizeTitle(normalized.slice(0, match.index).replace(/[-_\.\s]+$/g, " ").trim()) || normalized;
    return { kind: "episode", showTitle: title, season, episode };
  }

  const yearMatch = normalized.match(/\b(19|20)\d{2}\b/);
  const title = normalizeTitle(normalized.replace(/\b(19|20)\d{2}\b/, "").trim());
  return { kind: "movie", title: title || normalized, year: yearMatch ? yearMatch[0] : undefined };
}

async function crawlDirectory(baseUrl, options = {}) {
  const { maxDepth = 2, signal, throttleMs = 800, onDiscover } = options;
  const initial = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const initialFetch = initial.startsWith(LOCAL_PROXY_PREFIX) ? initial : buildLocalProxyUrl(initial);
  const queue = [{ fetchUrl: initialFetch, linkUrl: initial, depth: 0 }];
  const seen = new Set();
  const files = [];

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

  fileEntries.forEach(entry => {
    const meta = parseMediaName(entry.name);
    if (meta.kind === "episode") {
      const key = meta.showTitle.toLowerCase();
      if (!showMap.has(key)) {
        showMap.set(key, {
          key,
          title: meta.showTitle,
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

  return { movies, shows };
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

// ---------- UI primitives ----------
const TabBtn = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-4 py-2 md:px-5 md:py-3 rounded-full text-sm font-medium transition border ${
      active
        ? "bg-aurora text-midnight border-aurora shadow-glow"
        : "bg-slate-800/60 text-slate-300 border-transparent hover:text-white hover:border-aurora/60 hover:bg-slate-800"
    }`}
  >
    {children}
  </button>
);

const Card = ({ children }) => (
  <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-6 shadow-xl shadow-black/20 backdrop-blur">
    {children}
  </div>
);

const SectionTitle = ({ children }) => (
  <h3 className="text-lg font-semibold mb-4 text-white tracking-wide">{children}</h3>
);

// ---------- Main App ----------
export default function App() {
  const [apiKey, setApiKey] = useState(readLS("tmdb_api_key", ""));
  const freekeyFetchAttempted = useRef(false);
  const [active, setActive] = useState("channels");

  const [channels, setChannels] = useState(() => readLS("m3u_channels", []));
  const [shows, setShows] = useState(() => readLS("m3u_shows", []).map(s => ({ ...s, group: s.group ?? "TV Shows" })));
  const [movies, setMovies] = useState(() => readLS("m3u_movies", []).map(m => ({ ...m, group: m.group ?? "Movies" })));
  const [showSearchQuery, setShowSearchQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState([]);
  const [showSearchBusy, setShowSearchBusy] = useState(false);
  const showSearchRun = useRef(0);
  const [movieSearchQuery, setMovieSearchQuery] = useState("");
  const [movieSuggestions, setMovieSuggestions] = useState([]);
  const [movieSearchBusy, setMovieSearchBusy] = useState(false);
  const movieSearchRun = useRef(0);
  const [libraryUrl, setLibraryUrl] = useState(() => readLS("m3u_library_url", ""));
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [libraryMovies, setLibraryMovies] = useState([]);
  const [libraryShows, setLibraryShows] = useState([]);
  const [libraryProgress, setLibraryProgress] = useState({ active: false, processed: 0, found: 0, logs: [], stage: "idle" });
  const [playlistSyncStatus, setPlaylistSyncStatus] = useState("idle");
  const playlistUrl = useMemo(() => {
    if (typeof window === "undefined") return "/playlist.m3u";
    return `${window.location.origin}/playlist.m3u`;
  }, []);

  const inputClass = "w-full px-4 py-3 rounded-2xl border border-white/10 bg-slate-900/70 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-aurora/60 focus:border-transparent transition";
  const textareaClass = `${inputClass} min-h-[140px] leading-relaxed`;
  const baseButton = "inline-flex items-center justify-center px-5 py-3 rounded-full font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-950";
  const primaryButton = `${baseButton} bg-gradient-to-r from-aurora to-sky-500 text-midnight focus:ring-aurora/50 shadow-glow hover:from-aurora/90 hover:to-sky-400`;
  const secondaryButton = `${baseButton} border border-white/10 bg-slate-900/70 text-slate-200 focus:ring-aurora/30 hover:border-aurora/40 hover:text-white`;
  const ghostButton = `${baseButton} border border-white/10 text-slate-200 bg-transparent focus:ring-aurora/30 hover:border-aurora/50 hover:text-white`;
  const dangerButton = `${baseButton} border border-red-500/40 text-red-200 bg-red-500/10 focus:ring-red-400/50 hover:bg-red-500/20`;
  const m3u = useMemo(() => buildM3U({ channels, shows, movies }), [channels, shows, movies]);
  useEffect(() => saveLS("tmdb_api_key", apiKey), [apiKey]);
  useEffect(() => saveLS("m3u_channels", channels), [channels]);
  useEffect(() => saveLS("m3u_shows", shows), [shows]);
  useEffect(() => saveLS("m3u_movies", movies), [movies]);
  useEffect(() => saveLS("m3u_library_url", libraryUrl), [libraryUrl]);
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
    if (freekeyFetchAttempted.current || apiKey) return;
    freekeyFetchAttempted.current = true;
    let cancelled = false;
    freekeys()
      .then(res => {
        if (cancelled) return;
        const key = res?.tmdb_key || "";
        if (key && !apiKey) setApiKey(key);
      })
      .catch(err => {
        console.warn("Unable to fetch TMDB key from freekeys", err);
      });
    return () => { cancelled = true; };
  }, [apiKey]);

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

  const fetchLibraryCatalog = async () => {
    const url = libraryUrl.trim();
    if (!url) return alert("Enter a base URL to crawl.");
    setLibraryLoading(true);
    setLibraryError("");
    setLibraryMovies([]);
    setLibraryShows([]);
    setLibraryProgress({ active: true, processed: 0, found: 0, logs: [], stage: "crawling" });
    try {
      const files = await crawlDirectory(url, {
        maxDepth: 4,
        throttleMs: 800,
        onDiscover: (info) => {
          setLibraryProgress(prev => {
            if (!prev.active) return prev;
            if (info.type === "dir") {
              const message = `Scanning ${info.path}`;
              const logs = [message, ...prev.logs].slice(0, 6);
              return { ...prev, logs, stage: "crawling" };
            }
            const message = `Found ${info.entry.path}`;
            const logs = [message, ...prev.logs].slice(0, 6);
            return {
              ...prev,
              processed: prev.processed + 1,
              found: prev.found + 1,
              logs,
              stage: "crawling"
            };
          });
        }
      });
      if (!files.length) {
        setLibraryError("No playable media files detected at that URL.");
        setLibraryProgress(prev => ({ ...prev, active: false, stage: "empty" }));
        return;
      }
      const candidates = buildLibraryCandidates(files);
      setLibraryMovies(candidates.movies.map(m => ({ ...m, suggestions: [], loading: false, error: "" })));
      setLibraryShows(candidates.shows.map(s => ({ ...s, suggestions: [], loading: false, error: "" })));
      setLibraryProgress(prev => ({ ...prev, active: false, stage: "completed" }));
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

  const matchLibraryMovie = async (movie) => {
    if (!apiKey) return alert("Add your TMDB API key first");
    updateLibraryMovie(movie.key, m => ({ ...m, loading: true, error: "" }));
    try {
      const results = await searchTMDBMovies(apiKey, movie.title);
      updateLibraryMovie(movie.key, m => ({ ...m, suggestions: results, loading: false, error: results.length ? "" : "No TMDB matches found." }));
    } catch (err) {
      updateLibraryMovie(movie.key, m => ({ ...m, loading: false, error: err.message || "Search failed." }));
    }
  };

  const matchLibraryShow = async (show) => {
    if (!apiKey) return alert("Add your TMDB API key first");
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
    alert(`Imported "${suggestion.title}" with stream URL attached.`);
  };

  const addShowFromSuggestion = async (show, suggestion) => {
    const episodeMap = {};
    show.episodes.forEach(ep => {
      const key = `${ep.season}-${ep.episode}`;
      if (!episodeMap[key]) episodeMap[key] = ep.url;
    });
    await importShow(String(suggestion.id), { episodeMap, group: "TV Shows" });
    setLibraryShows(ms => ms.filter(s => s.key !== show.key));
    alert(`Imported "${suggestion.title}" with ${Object.keys(episodeMap).length} episodes linked.`);
  };

  // ----- Channels -----
  const addChannel = () => setChannels(cs => [...cs, { id: `ch-${Date.now()}`, name: "New Channel", url: "", logo: "", group: "Live", chno: cs.length + 1 }]);
  const updateChannel = (idx, patch) => setChannels(cs => cs.map((c, i) => i === idx ? { ...c, ...patch } : c));
  const removeChannel = (idx) => setChannels(cs => cs.filter((_, i) => i !== idx));

  // ----- TV Shows -----
  const importShow = async (tmdbId, options = {}) => {
    if (!apiKey) return alert("Add your TMDB API key first");
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
  const setShowPatch = (id, patch) => setShows(ss => ss.map(s => s.id === id ? { ...s, ...patch } : s));

  const guessPattern = (id, samples) => {
    const { pattern, notes } = inferPattern(samples);
    setShowPatch(id, { pattern });
    if (notes) alert(notes + "\nPattern: " + pattern);
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
    if (!apiKey) return alert("Add your TMDB API key first");
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
  const setMoviePatch = (id, patch) => setMovies(ms => ms.map(m => m.id === id ? { ...m, ...patch } : m));

  return (
    <div className="min-h-screen text-slate-100 pb-16">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950/70 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-5 md:flex-row md:items-center">
          <div className="flex items-start md:items-center gap-4 flex-1">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-aurora to-sky-500 text-midnight text-lg font-semibold shadow-glow">
              M3
            </div>
            <div>
              <div className="text-2xl font-semibold text-white">M3U Studio</div>
              <p className="text-sm text-slate-400 mt-1">Craft cinematic IPTV playlists with TMDB powered metadata.</p>
            </div>
          </div>
          <div className="flex flex-col md:flex-row md:items-center gap-3 w-full md:w-auto">
            <input className={`${inputClass} w-full md:w-80`} placeholder="TMDB API key" value={apiKey} onChange={(e)=>setApiKey(e.target.value)} />
            <button className={secondaryButton} onClick={()=>navigator.clipboard.writeText(apiKey)}>Copy</button>
          </div>
        </div>
        <nav className="max-w-6xl mx-auto px-6 pb-6 flex flex-wrap gap-3">
          <TabBtn active={active === "channels"} onClick={()=>setActive("channels")}>Channels</TabBtn>
          <TabBtn active={active === "shows"} onClick={()=>setActive("shows")}>TV Shows</TabBtn>
          <TabBtn active={active === "movies"} onClick={()=>setActive("movies")}>Movies</TabBtn>
          <TabBtn active={active === "library"} onClick={()=>setActive("library")}>Library Index</TabBtn>
          <TabBtn active={active === "playlist"} onClick={()=>setActive("playlist")}>Playlist .m3u</TabBtn>
        </nav>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-8">
        {active === "library" && (
          <div className="space-y-6">
            <Card>
              <div className="space-y-4">
                <SectionTitle>Ingest HTTP Directory</SectionTitle>
                <p className="text-sm text-slate-400 max-w-3xl">
                  Paste the base URL to a directory index (Apache/nginx style). We’ll discover playable files, infer titles,
                  and help you import them with TMDB metadata and stream URLs attached.
                </p>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-slate-400">Base URL</label>
                    <input
                      className={`${inputClass} mt-2`}
                      placeholder="http://example.com/movies/"
                      value={libraryUrl}
                      onChange={(e)=>setLibraryUrl(e.target.value)}
                    />
                    <p className="mt-3 text-xs text-slate-500">
                      Subfolders are scanned automatically. Deep libraries may take a little longer.
                    </p>
                  </div>
                  <button className={primaryButton} onClick={fetchLibraryCatalog} disabled={libraryLoading}>
                    {libraryLoading ? "Scanning…" : "Scan Library"}
                  </button>
                </div>
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
                        ? "Scan completed"
                        : libraryProgress.stage === "error"
                        ? "Scan incomplete"
                        : "Scanning…"}
                    </SectionTitle>
                    <div className="text-xs text-slate-400">
                      Found {libraryProgress.found} file{libraryProgress.found === 1 ? "" : "s"}
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
          <Card>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <SectionTitle>Channels</SectionTitle>
                <p className="text-sm text-slate-400 max-w-2xl">Manage live streams, logos, and EPG metadata for your channel lineup.</p>
              </div>
              <button className={primaryButton} onClick={addChannel}>Add channel</button>
            </div>
            <div className="mt-6 grid gap-4">
              {channels.map((c, idx) => (
                <div key={c.id} className="grid md:grid-cols-12 gap-3 items-center p-4 rounded-2xl border border-white/10 bg-slate-950/60 shadow-inner shadow-black/20">
                  <input className={`md:col-span-2 ${inputClass}`} placeholder="Name" value={c.name} onChange={e=>updateChannel(idx,{name:e.target.value})} />
                  <input className={`md:col-span-3 ${inputClass}`} placeholder="Stream URL" value={c.url} onChange={e=>updateChannel(idx,{url:e.target.value})} />
                  <input className={`md:col-span-3 ${inputClass}`} placeholder="Logo URL" value={c.logo} onChange={e=>updateChannel(idx,{logo:e.target.value})} />
                  <input className={`md:col-span-2 ${inputClass}`} placeholder="Group" value={c.group} onChange={e=>updateChannel(idx,{group:e.target.value})} />
                  <input className={`md:col-span-1 ${inputClass}`} placeholder="#" value={c.chno} onChange={e=>updateChannel(idx,{chno:e.target.value})} />
                  <button className={`md:col-span-1 w-full ${dangerButton}`} onClick={()=>removeChannel(idx)}>Remove</button>
                </div>
              ))}
            </div>
          </Card>
        )}

        {active === "shows" && (
          <div className="space-y-6">
            <Card>
              <div className="space-y-4">
                <SectionTitle>Import TV Show</SectionTitle>
                <p className="text-sm text-slate-400 max-w-3xl">
                  Search TMDB by name to get instant suggestions, or paste a numeric TMDB ID and import directly.
                </p>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-slate-400">Search TMDB</label>
                    <input
                      className={`${inputClass} mt-2`}
                      placeholder="e.g. Game of Thrones or 1399"
                      value={showSearchQuery}
                      onChange={(e)=>setShowSearchQuery(e.target.value)}
                    />
                    <p className="mt-2 text-xs text-slate-500">
                      {apiKey ? "Type at least two characters to fetch suggestions." : "Add your TMDB API key above to enable name search."}
                    </p>
                  </div>
                  <button
                    className={`${primaryButton} disabled:opacity-50 disabled:cursor-not-allowed`}
                    disabled={!showSearchQuery.trim()}
                    onClick={async ()=>{
                      const val = showSearchQuery.trim();
                      if (!val) return;
                      if (!/^\d+$/.test(val)) {
                        alert("Importing by ID expects a numeric TMDB identifier. Pick a suggestion below or paste an ID.");
                        return;
                      }
                      await importShow(val);
                      setShowSearchQuery("");
                      setShowSuggestions([]);
                    }}
                  >
                    Import by ID
                  </button>
                </div>
                {showSearchBusy && apiKey && (
                  <div className="text-xs text-aurora/80">Searching TMDB…</div>
                )}
                {apiKey && showSuggestions.length > 0 && (
                  <div className="space-y-3">
                    <div className="text-xs uppercase tracking-wide text-slate-400">Suggestions</div>
                    <div className="grid gap-3">
                      {showSuggestions.map(sug => (
                        <div key={sug.id} className="flex gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                          {sug.poster ? (
                            <img src={sug.poster} alt="" className="w-16 h-24 rounded-xl object-cover border border-white/10" />
                          ) : (
                            <div className="w-16 h-24 rounded-xl border border-dashed border-white/10 flex items-center justify-center text-[10px] text-slate-500">
                              No art
                            </div>
                          )}
                          <div className="flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-white">{sug.title}</div>
                                <div className="text-xs text-slate-400 mt-1 flex gap-2">
                                  <span>{sug.date ? sug.date.slice(0,4) : "—"}</span>
                                  <span>TMDB #{sug.id}</span>
                                  {sug.vote ? <span>★ {sug.vote.toFixed(1)}</span> : null}
                                </div>
                              </div>
                              <button
                                className={primaryButton}
                                onClick={async ()=>{
                                  await importShow(String(sug.id));
                                  setShowSearchQuery("");
                                  setShowSuggestions([]);
                                }}
                              >
                                Add show
                              </button>
                            </div>
                            <p className="mt-2 text-xs text-slate-400 leading-relaxed line-clamp-3">{sug.overview}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>

            {shows.map(s => (
              <Card key={s.id}>
                <div className="flex flex-col gap-6 md:flex-row md:gap-8">
                  <div className="w-full md:w-40 lg:w-48">
                    {s.poster ? (
                      <img src={s.poster} alt="poster" className="h-full w-full min-h-[12rem] rounded-2xl border border-white/10 object-cover shadow-xl shadow-black/30" />
                    ) : (
                      <div className="flex h-full min-h-[12rem] items-center justify-center rounded-2xl border border-dashed border-white/10 text-xs text-slate-500">
                        No poster yet
                      </div>
                    )}
                  </div>
                  <div className="flex-1 space-y-6">
                    <div className="grid gap-4 lg:grid-cols-12">
                      <div className="space-y-4 lg:col-span-7">
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">Title</label>
                          <input className={`${inputClass} mt-2`} value={s.title} onChange={e=>setShowPatch(s.id,{title:e.target.value})} />
                        </div>
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">Overview</label>
                          <textarea className={`${textareaClass} mt-2`} value={s.overview || ""} onChange={e=>setShowPatch(s.id,{overview:e.target.value})} />
                        </div>
                      </div>
                      <div className="space-y-4 lg:col-span-5">
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">Playlist group</label>
                          <input className={`${inputClass} mt-2`} placeholder="Defaults to TV Shows" value={s.group || ""} onChange={e=>setShowPatch(s.id,{group:e.target.value})} />
                        </div>
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">Poster URL</label>
                          <input className={`${inputClass} mt-2`} placeholder="https://…" value={s.poster || ""} onChange={e=>setShowPatch(s.id,{poster:e.target.value})} />
                        </div>
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">TMDB ID</label>
                          <div className="mt-2 rounded-2xl border border-white/5 bg-slate-950/60 px-4 py-3 text-sm text-slate-400">{s.tmdbId}</div>
                        </div>
                      </div>
                    </div>

                    <div className="grid items-start gap-4 lg:grid-cols-12">
                      <div className="space-y-2 lg:col-span-7">
                        <label className="block text-xs uppercase tracking-wide text-slate-400">Episode URL pattern</label>
                        <input className={`${inputClass} mt-2`} placeholder="e.g. https://cdn/show/S{s2}E{e2}.m3u8" value={s.pattern || ""} onChange={e=>setShowPatch(s.id,{pattern:e.target.value})} />
                        <p className="text-xs text-slate-500">Use tokens like {"{s2}"} or {"{e2}"} to auto-build episode links.</p>
                      </div>
                      <div className="flex flex-wrap justify-end gap-3 lg:col-span-5">
                        <button className={ghostButton} onClick={()=>{
                          const inputs = [
                            document.getElementById(`samp1-${s.id}`)?.value,
                            document.getElementById(`samp2-${s.id}`)?.value,
                            document.getElementById(`samp3-${s.id}`)?.value,
                          ].map(v => v?.trim()).filter(Boolean);
                          if (inputs.length < 2) {
                            alert("Add at least two sample episode URLs in the helper section to guess a pattern.");
                            return;
                          }
                          guessPattern(s.id, inputs);
                        }}>Guess pattern</button>
                        <button className={secondaryButton} onClick={()=>fillShowUrls(s.id)}>Fill missing URLs</button>
                        <button className={dangerButton} onClick={()=>setShows(ss=>ss.filter(x=>x.id!==s.id))}>Remove show</button>
                      </div>
                    </div>

                    <details className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/50">
                      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-slate-200 hover:text-white">Sample URLs helper</summary>
                      <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-3">
                        <input id={`samp1-${s.id}`} className={inputClass} placeholder="Sample URL 1" />
                        <input id={`samp2-${s.id}`} className={inputClass} placeholder="Sample URL 2" />
                        <input id={`samp3-${s.id}`} className={inputClass} placeholder="Sample URL 3 (optional)" />
                        <p className="sm:col-span-2 lg:col-span-3 text-xs text-slate-500">Provide streams from consecutive episodes so we can recognise the pattern.</p>
                      </div>
                    </details>

                    <div className="flex items-center gap-3">
                      <span className="px-3 py-1 rounded-full bg-aurora/20 text-aurora text-xs font-semibold">{(s.seasons || []).length} Seasons</span>
                      <span className="text-xs text-slate-400">Episodes: {(s.seasons || []).reduce((acc, sea)=>acc+(sea.episodes?.length||0),0)}</span>
                    </div>

                    <div className="space-y-4">
                      {s.seasons.sort((a,b)=>a.season-b.season).map(sea => (
                        <details key={sea.season} className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/50">
                          <summary className="cursor-pointer select-none font-medium px-4 py-3 text-slate-200 text-sm hover:text-white">Season {sea.season} · {sea.episodes.length} episodes</summary>
                          <div className="mt-2 grid gap-3 px-4 pb-4">
                            {sea.episodes.sort((a,b)=>a.episode-b.episode).map(ep => (
                              <div key={ep.episode} className="grid md:grid-cols-12 gap-3 items-center rounded-2xl border border-white/10 bg-slate-950/60 p-3 shadow-inner shadow-black/20">
                                <div className="md:col-span-2 text-sm font-medium text-slate-200">E{pad(ep.episode)} {ep.title || "Episode"}</div>
                                <input className={`md:col-span-8 ${inputClass}`} placeholder="Stream URL" value={ep.url || ""} onChange={e=>{
                                  setShows(ss=>ss.map(sss=>{
                                    if(sss.id!==s.id) return sss;
                                    return {...sss, seasons: sss.seasons.map(x=> x.season===sea.season ? {...x, episodes: x.episodes.map(y=> y.episode===ep.episode ? {...y, url: e.target.value} : y)} : x)};
                                  }));
                                }} />
                                <button className={`md:col-span-2 w-full ${ghostButton}`} onClick={()=>{
                                  setShows(ss=>ss.map(sss=>{
                                    if(sss.id!==s.id) return sss;
                                    const url = sss.pattern ? fillPattern(sss.pattern, sea.season, ep.episode) : (ep.url||"");
                                    return {...sss, seasons: sss.seasons.map(x=> x.season===sea.season ? {...x, episodes: x.episodes.map(y=> y.episode===ep.episode ? {...y, url} : y)} : x)};
                                  }));
                                }}>Derive</button>
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {active === "movies" && (
          <div className="space-y-6">
            <Card>
              <div className="space-y-4">
                <SectionTitle>Import Movie</SectionTitle>
                <p className="text-sm text-slate-400 max-w-3xl">
                  Find films by name or paste a TMDB ID. Suggestions help you grab the right entry without leaving the builder.
                </p>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-slate-400">Search TMDB</label>
                    <input
                      className={`${inputClass} mt-2`}
                      placeholder="e.g. Fight Club or 550"
                      value={movieSearchQuery}
                      onChange={(e)=>setMovieSearchQuery(e.target.value)}
                    />
                    <p className="mt-2 text-xs text-slate-500">
                      {apiKey ? "Suggestions appear after typing two characters." : "Add your TMDB API key above to enable name search."}
                    </p>
                  </div>
                  <button
                    className={`${primaryButton} disabled:opacity-50 disabled:cursor-not-allowed`}
                    disabled={!movieSearchQuery.trim()}
                    onClick={async ()=>{
                      const val = movieSearchQuery.trim();
                      if (!val) return;
                      if (!/^\d+$/.test(val)) {
                        alert("Importing by ID expects a numeric TMDB identifier. Pick a suggestion below or paste an ID.");
                        return;
                      }
                      await importMovie(val);
                      setMovieSearchQuery("");
                      setMovieSuggestions([]);
                    }}
                  >
                    Import by ID
                  </button>
                </div>
                {movieSearchBusy && apiKey && (
                  <div className="text-xs text-aurora/80">Searching TMDB…</div>
                )}
                {apiKey && movieSuggestions.length > 0 && (
                  <div className="space-y-3">
                    <div className="text-xs uppercase tracking-wide text-slate-400">Suggestions</div>
                    <div className="grid gap-3">
                      {movieSuggestions.map(sug => (
                        <div key={sug.id} className="flex gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                          {sug.poster ? (
                            <img src={sug.poster} alt="" className="w-16 h-24 rounded-xl object-cover border border-white/10" />
                          ) : (
                            <div className="w-16 h-24 rounded-xl border border-dashed border-white/10 flex items-center justify-center text-[10px] text-slate-500">
                              No art
                            </div>
                          )}
                          <div className="flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-white">{sug.title}</div>
                                <div className="text-xs text-slate-400 mt-1 flex gap-2">
                                  <span>{sug.date ? sug.date.slice(0,4) : "—"}</span>
                                  <span>TMDB #{sug.id}</span>
                                  {sug.vote ? <span>★ {sug.vote.toFixed(1)}</span> : null}
                                </div>
                              </div>
                              <button
                                className={primaryButton}
                                onClick={async ()=>{
                                  await importMovie(String(sug.id));
                                  setMovieSearchQuery("");
                                  setMovieSuggestions([]);
                                }}
                              >
                                Add movie
                              </button>
                            </div>
                            <p className="mt-2 text-xs text-slate-400 leading-relaxed line-clamp-3">{sug.overview}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>

            {movies.map(m => (
              <Card key={m.id}>
                <div className="flex flex-col gap-6 md:flex-row md:gap-8">
                  <div className="w-full md:w-40 lg:w-48">
                    {m.poster ? (
                      <img src={m.poster} alt="poster" className="h-full w-full min-h-[12rem] rounded-2xl border border-white/10 object-cover shadow-xl shadow-black/30" />
                    ) : (
                      <div className="flex h-full min-h-[12rem] items-center justify-center rounded-2xl border border-dashed border-white/10 text-xs text-slate-500">No poster yet</div>
                    )}
                  </div>
                  <div className="flex-1 space-y-6">
                    <div className="grid gap-4 lg:grid-cols-12">
                      <div className="space-y-4 lg:col-span-7">
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">Title</label>
                          <input className={`${inputClass} mt-2`} value={m.title} onChange={e=>setMoviePatch(m.id,{title:e.target.value})} />
                        </div>
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">Overview</label>
                          <textarea className={`${textareaClass} mt-2`} value={m.overview || ""} onChange={e=>setMoviePatch(m.id,{overview:e.target.value})} />
                        </div>
                      </div>
                      <div className="space-y-4 lg:col-span-5">
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">Playlist group</label>
                          <input className={`${inputClass} mt-2`} placeholder="Defaults to Movies" value={m.group || ""} onChange={e=>setMoviePatch(m.id,{group:e.target.value})} />
                        </div>
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">Poster URL</label>
                          <input className={`${inputClass} mt-2`} placeholder="https://…" value={m.poster || ""} onChange={e=>setMoviePatch(m.id,{poster:e.target.value})} />
                        </div>
                        <div>
                          <label className="block text-xs uppercase tracking-wide text-slate-400">TMDB ID</label>
                          <div className="mt-2 rounded-2xl border border-white/5 bg-slate-950/60 px-4 py-3 text-sm text-slate-400">{m.tmdbId}</div>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                      <div className="md:flex-1">
                        <label className="block text-xs uppercase tracking-wide text-slate-400">Stream URL</label>
                        <input className={`${inputClass} mt-2`} placeholder="https://your-cdn/movie-title/stream.m3u8" value={m.url || ""} onChange={e=>setMoviePatch(m.id,{url:e.target.value})} />
                      </div>
                      <div className="flex gap-3 md:w-auto">
                        <button className={`${dangerButton} w-full md:w-auto`} onClick={()=>setMovies(ms=>ms.filter(x=>x.id!==m.id))}>Remove movie</button>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
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
            <textarea className={`${inputClass} h-96 font-mono text-sm`} value={m3u} onChange={()=>{}} />
            <p className="text-xs text-slate-400 mt-3">Entries use #EXTINF with tvg-id, tvg-logo, group-title, and tvg-chno when provided.</p>
          </Card>
        )}
      </main>

      <footer className="py-12 text-center text-xs text-slate-500/80">Built with ❤️ – Local-only demo. Add auth & backend before shipping.</footer>
    </div>
  );
}
