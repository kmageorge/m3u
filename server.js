const path = require("path");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_TIMEOUT = Number(process.env.PROXY_TIMEOUT || 15000);
const BING_IMAGE_API_KEY = process.env.BING_IMAGE_API_KEY || "";
let latestPlaylist = "#EXTM3U";
let latestEpg = '<?xml version="1.0" encoding="UTF-8"?>\n<tv></tv>';

// Initialize SQLite database
const db = new sqlite3.Database('./m3u_studio.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

// Create tables if they don't exist
function initializeDatabase() {
  db.serialize(() => {
    // Settings table for key-value storage
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Channels table
    db.run(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Shows table
    db.run(`
      CREATE TABLE IF NOT EXISTS shows (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Movies table
    db.run(`
      CREATE TABLE IF NOT EXISTS movies (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database tables initialized');
  });
}

app.use(express.static(path.resolve(__dirname)));
app.use(express.json({ limit: "10mb" }));

// Database API endpoints

// Get a setting by key
app.get("/api/db/settings/:key", (req, res) => {
  db.get("SELECT value FROM settings WHERE key = ?", [req.params.key], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ value: row ? row.value : null });
  });
});

// Set a setting
app.post("/api/db/settings/:key", (req, res) => {
  const { value } = req.body;
  db.run(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    [req.params.key, JSON.stringify(value)],
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
    }
  );
});

// Get all items from a table (channels, shows, or movies)
app.get("/api/db/:table", (req, res) => {
  const table = req.params.table;
  if (!['channels', 'shows', 'movies'].includes(table)) {
    return res.status(400).json({ error: "Invalid table" });
  }
  
  db.all(`SELECT id, data FROM ${table}`, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const items = rows.map(row => JSON.parse(row.data));
    res.json({ items });
  });
});

// Save all items to a table (replaces all data)
app.post("/api/db/:table", (req, res) => {
  const table = req.params.table;
  if (!['channels', 'shows', 'movies'].includes(table)) {
    return res.status(400).json({ error: "Invalid table" });
  }
  
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Items must be an array" });
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    db.run(`DELETE FROM ${table}`);
    
    const stmt = db.prepare(`INSERT INTO ${table} (id, data, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    items.forEach(item => {
      stmt.run([item.id, JSON.stringify(item)]);
    });
    stmt.finalize();
    
    db.run("COMMIT", (err) => {
      if (err) {
        db.run("ROLLBACK");
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true, count: items.length });
    });
  });
});

// Add a single item
app.post("/api/db/:table/add", (req, res) => {
  const table = req.params.table;
  if (!['channels', 'shows', 'movies'].includes(table)) {
    return res.status(400).json({ error: "Invalid table" });
  }
  
  const { item } = req.body;
  if (!item || !item.id) {
    return res.status(400).json({ error: "Item with id required" });
  }

  db.run(
    `INSERT OR REPLACE INTO ${table} (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [item.id, JSON.stringify(item)],
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
    }
  );
});

// Delete an item
app.delete("/api/db/:table/:id", (req, res) => {
  const table = req.params.table;
  if (!['channels', 'shows', 'movies'].includes(table)) {
    return res.status(400).json({ error: "Invalid table" });
  }
  
  db.run(`DELETE FROM ${table} WHERE id = ?`, [req.params.id], (err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true });
  });
});

app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).send("Missing url parameter");
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).send("Invalid URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).send("Unsupported protocol");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT);

  try {
    const upstream = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: {
        "user-agent": "m3u-studio-proxy/1.0"
      }
    });

    const body = await upstream.text();
    res.status(upstream.status);

    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      res.set("Content-Type", contentType);
    }

    res.send(body);
  } catch (err) {
    if (err.name === "AbortError") {
      res.status(504).send("Upstream request timed out");
    } else {
      res.status(502).send(err.message || "Upstream fetch failed");
    }
  } finally {
    clearTimeout(timeout);
  }
});

app.get("/api/logos", async (req, res) => {
  const query = (req.query.query || "").toString().trim();
  const top = Math.min(Math.max(parseInt(req.query.top, 10) || 8, 1), 10);
  if (!query) {
    return res.json({ results: [] });
  }
  if (!BING_IMAGE_API_KEY) {
    return res.json({ results: [] });
  }
  try {
    const searchUrl = new URL("https://api.bing.microsoft.com/v7.0/images/search");
    searchUrl.searchParams.set("q", `${query} channel logo`);
    searchUrl.searchParams.set("count", String(top));
    searchUrl.searchParams.set("safeSearch", "Strict");
    searchUrl.searchParams.set("aspect", "wide");
    const logoRes = await fetch(searchUrl, {
      headers: {
        "Ocp-Apim-Subscription-Key": BING_IMAGE_API_KEY
      }
    });
    if (!logoRes.ok) {
      const text = await logoRes.text();
      return res.status(502).json({ results: [], error: text });
    }
    const data = await logoRes.json();
    const results = Array.isArray(data?.value)
      ? data.value
          .map(item => ({
            url: item.thumbnailUrl || item.contentUrl || "",
            title: item.name || query,
            source: item.hostPageDisplayUrl || item.hostPageUrl || ""
          }))
          .filter(item => item.url)
      : [];
    res.json({ results });
  } catch (err) {
    res.status(500).json({ results: [], error: err.message });
  }
});

app.post("/api/playlist", express.text({ type: "*/*", limit: "10mb" }), (req, res) => {
  const body = req.body ?? "";
  if (!body.trim()) {
    return res.status(400).json({ ok: false, message: "Playlist body required" });
  }
  latestPlaylist = body;
  res.json({ ok: true });
});

app.get("/playlist.m3u", (req, res) => {
  res.setHeader("Content-Type", "audio/x-mpegurl; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(latestPlaylist);
});

app.post("/api/epg", express.text({ type: "*/*", limit: "10mb" }), (req, res) => {
  const body = req.body ?? "";
  if (!body.trim()) {
    return res.status(400).json({ ok: false, message: "EPG body required" });
  }
  latestEpg = body;
  res.json({ ok: true });
});

app.get("/epg.xml", (req, res) => {
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(latestEpg);
});

app.listen(PORT, () => {
  console.log(`M3U Studio available on http://localhost:${PORT}`);
});
