const path = require("path");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_TIMEOUT = Number(process.env.PROXY_TIMEOUT || 15000);
const BING_IMAGE_API_KEY = process.env.BING_IMAGE_API_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "m3u-studio-secret-change-in-production";
const SALT_ROUNDS = 10;

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

// Migrate old database schema to new user-scoped schema
function migrateOldSchema() {
  db.serialize(() => {
    console.log("Starting database migration...");
    
    // First, ensure admin user exists
    db.get("SELECT id FROM users WHERE role = 'admin'", [], (err, adminUser) => {
      if (err) {
        console.error('Error checking for admin user:', err);
        return;
      }
      
      let adminId = adminUser?.id;
      
      const completeMigration = (userId) => {
        db.run("BEGIN TRANSACTION");
        
        // Backup old tables
        db.run("ALTER TABLE settings RENAME TO settings_old");
        db.run("ALTER TABLE channels RENAME TO channels_old");
        db.run("ALTER TABLE shows RENAME TO shows_old");
        db.run("ALTER TABLE movies RENAME TO movies_old");
        
        // Create new tables with user_id
        db.run(`
          CREATE TABLE settings (
            key TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (key, user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        
        db.run(`
          CREATE TABLE channels (
            id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            data TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id, user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        
        db.run(`
          CREATE TABLE shows (
            id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            data TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id, user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        
        db.run(`
          CREATE TABLE movies (
            id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            data TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id, user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        
        // Migrate data to admin user
        db.run(`INSERT INTO settings (key, user_id, value, updated_at) 
                SELECT key, ${userId}, value, updated_at FROM settings_old`);
        
        db.run(`INSERT INTO channels (id, user_id, data, created_at, updated_at) 
                SELECT id, ${userId}, data, created_at, updated_at FROM channels_old`);
        
        db.run(`INSERT INTO shows (id, user_id, data, created_at, updated_at) 
                SELECT id, ${userId}, data, created_at, updated_at FROM shows_old`);
        
        db.run(`INSERT INTO movies (id, user_id, data, created_at, updated_at) 
                SELECT id, ${userId}, data, created_at, updated_at FROM movies_old`);
        
        // Drop old tables
        db.run("DROP TABLE settings_old");
        db.run("DROP TABLE channels_old");
        db.run("DROP TABLE shows_old");
        db.run("DROP TABLE movies_old");
        
        db.run("COMMIT", (err) => {
          if (err) {
            console.error('Migration failed, rolling back:', err);
            db.run("ROLLBACK");
          } else {
            console.log('✓ Database migration completed successfully!');
            console.log(`  All existing data migrated to admin user (ID: ${userId})`);
          }
        });
      };
      
      // If no admin exists, create one first
      if (!adminId) {
        bcrypt.hash("admin123", SALT_ROUNDS, (err, hash) => {
          if (err) {
            console.error('Error hashing admin password:', err);
            return;
          }
          db.run(
            "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
            ["admin", "admin@m3u.studio", hash, "admin"],
            function(err) {
              if (err) {
                console.error('Error creating admin user:', err);
              } else {
                console.log('Created admin user for migration');
                completeMigration(this.lastID);
              }
            }
          );
        });
      } else {
        completeMigration(adminId);
      }
    });
  });
}

// Create tables if they don't exist
function initializeDatabase() {
  db.serialize(() => {
    // Users table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      )
    `);

    // Check if we need to migrate from old schema to new schema
    db.get("PRAGMA table_info(settings)", [], (err, row) => {
      if (!err && row) {
        // Table exists, check if it has user_id column
        db.all("PRAGMA table_info(settings)", [], (err, columns) => {
          const hasUserId = columns && columns.some(col => col.name === 'user_id');
          
          if (!hasUserId) {
            console.log("Migrating database schema to add user_id columns...");
            migrateOldSchema();
            return;
          }
        });
      }
    });

    // Settings table for key-value storage (now user-scoped)
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (key, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Channels table (user-scoped)
    db.run(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Shows table (user-scoped)
    db.run(`
      CREATE TABLE IF NOT EXISTS shows (
        id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Movies table (user-scoped)
    db.run(`
      CREATE TABLE IF NOT EXISTS movies (
        id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create default admin user if none exists
    db.get("SELECT id FROM users WHERE role = 'admin'", [], (err, row) => {
      if (err) {
        console.error('Error checking for admin user:', err);
        return;
      }
      if (!row) {
        bcrypt.hash("admin123", SALT_ROUNDS, (err, hash) => {
          if (err) {
            console.error('Error hashing admin password:', err);
            return;
          }
          db.run(
            "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
            ["admin", "admin@m3u.studio", hash, "admin"],
            (err) => {
              if (err) {
                console.error('Error creating admin user:', err);
              } else {
                console.log('Default admin user created (username: admin, password: admin123)');
              }
            }
          );
        });
      }
    });

    console.log('Database tables initialized');
  });
}

app.use(express.static(path.resolve(__dirname)));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired token" });
    }
    req.user = user;
    next();
  });
}

// Middleware to check admin role
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// Authentication endpoints

// Register new user
app.post("/api/auth/register", async (req, res) => {
  const { username, email, password } = req.body;
  
  if (!username || !email || !password) {
    return res.status(400).json({ error: "Username, email, and password required" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    
    db.run(
      "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
      [username, email, passwordHash],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: "Username or email already exists" });
          }
          return res.status(500).json({ error: err.message });
        }
        
        const userId = this.lastID;
        const token = jwt.sign({ id: userId, username, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
        
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ 
          ok: true, 
          user: { id: userId, username, email, role: 'user' },
          token 
        });
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  db.get(
    "SELECT * FROM users WHERE username = ? OR email = ?",
    [username, username],
    async (err, user) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      try {
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        if (!validPassword) {
          return res.status(401).json({ error: "Invalid credentials" });
        }

        // Update last login
        db.run("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);

        const token = jwt.sign(
          { id: user.id, username: user.username, role: user.role },
          JWT_SECRET,
          { expiresIn: '7d' }
        );
        
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({
          ok: true,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
          },
          token
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  );
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// Get current user
app.get("/api/auth/me", authenticateToken, (req, res) => {
  db.get(
    "SELECT id, username, email, role, created_at, last_login FROM users WHERE id = ?",
    [req.user.id],
    (err, user) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ user });
    }
  );
});

// Change password
app.post("/api/auth/change-password", authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password required" });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }

  db.get("SELECT password_hash FROM users WHERE id = ?", [req.user.id], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    try {
      const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }

      const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
      db.run("UPDATE users SET password_hash = ? WHERE id = ?", [newHash, req.user.id], (err) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ ok: true });
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// Admin: Get all users
app.get("/api/admin/users", authenticateToken, requireAdmin, (req, res) => {
  db.all(
    "SELECT id, username, email, role, created_at, last_login FROM users ORDER BY created_at DESC",
    [],
    (err, users) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ users });
    }
  );
});

// Admin: Update user role
app.post("/api/admin/users/:id/role", authenticateToken, requireAdmin, (req, res) => {
  const { role } = req.body;
  
  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  db.run(
    "UPDATE users SET role = ? WHERE id = ?",
    [role, req.params.id],
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
    }
  );
});

// Admin: Delete user
app.delete("/api/admin/users/:id", authenticateToken, requireAdmin, (req, res) => {
  // Prevent deleting yourself
  if (req.user.id === parseInt(req.params.id)) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }

  db.run("DELETE FROM users WHERE id = ?", [req.params.id], (err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true });
  });
});

// Database API endpoints (now require authentication and are user-scoped)

// Get a setting by key
app.get("/api/db/settings/:key", authenticateToken, (req, res) => {
  db.get(
    "SELECT value FROM settings WHERE key = ? AND user_id = ?",
    [req.params.key, req.user.id],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ value: row ? row.value : null });
    }
  );
});

// Set a setting
app.post("/api/db/settings/:key", authenticateToken, (req, res) => {
  const { value } = req.body;
  db.run(
    "INSERT OR REPLACE INTO settings (key, user_id, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
    [req.params.key, req.user.id, JSON.stringify(value)],
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
    }
  );
});

// Get all items from a table (channels, shows, or movies)
app.get("/api/db/:table", authenticateToken, (req, res) => {
  const table = req.params.table;
  if (!['channels', 'shows', 'movies'].includes(table)) {
    return res.status(400).json({ error: "Invalid table" });
  }
  
  db.all(
    `SELECT id, data FROM ${table} WHERE user_id = ?`,
    [req.user.id],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      const items = rows.map(row => JSON.parse(row.data));
      res.json({ items });
    }
  );
});

// Save all items to a table (replaces all data)
app.post("/api/db/:table", authenticateToken, (req, res) => {
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
    db.run(`DELETE FROM ${table} WHERE user_id = ?`, [req.user.id]);
    
    const stmt = db.prepare(
      `INSERT INTO ${table} (id, user_id, data, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    items.forEach(item => {
      stmt.run([item.id, req.user.id, JSON.stringify(item)]);
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
app.post("/api/db/:table/add", authenticateToken, (req, res) => {
  const table = req.params.table;
  if (!['channels', 'shows', 'movies'].includes(table)) {
    return res.status(400).json({ error: "Invalid table" });
  }
  
  const { item } = req.body;
  if (!item || !item.id) {
    return res.status(400).json({ error: "Item with id required" });
  }

  db.run(
    `INSERT OR REPLACE INTO ${table} (id, user_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    [item.id, req.user.id, JSON.stringify(item)],
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
    }
  );
});

// Delete an item
app.delete("/api/db/:table/:id", authenticateToken, (req, res) => {
  const table = req.params.table;
  if (!['channels', 'shows', 'movies'].includes(table)) {
    return res.status(400).json({ error: "Invalid table" });
  }
  
  db.run(
    `DELETE FROM ${table} WHERE id = ? AND user_id = ?`,
    [req.params.id, req.user.id],
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
    }
  );
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
