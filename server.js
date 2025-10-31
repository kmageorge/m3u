const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_TIMEOUT = Number(process.env.PROXY_TIMEOUT || 15000);
let latestPlaylist = "#EXTM3U";

app.use(express.static(path.resolve(__dirname)));

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

app.listen(PORT, () => {
  console.log(`M3U Studio available on http://localhost:${PORT}`);
});
