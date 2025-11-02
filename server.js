const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Readable } = require("stream");
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
const TV_LOGOS_DIR = process.env.TV_LOGOS_DIR || path.join(__dirname, 'assets', 'tv-logos');

let latestPlaylist = "#EXTM3U";
let latestEpg = '<?xml version="1.0" encoding="UTF-8"?>\n<tv></tv>';
const XTREAM_USER = process.env.XTREAM_USERNAME || 'user';
const XTREAM_PASS = process.env.XTREAM_PASSWORD || 'pass';

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

    // Helper: check if table exists
    const tableExists = (name, cb) => {
      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [name], (err, row) => cb(!err && !!row));
    };

    // Ensure admin user exists (for ownership of migrated rows)
    db.get("SELECT id FROM users WHERE role = 'admin'", [], (err, adminUser) => {
      if (err) {
        console.error('Error checking for admin user:', err);
        return;
      }

      const createAdminAndContinue = (next) => {
        bcrypt.hash("admin123", SALT_ROUNDS, (err, hash) => {
          if (err) {
            console.error('Error hashing admin password:', err);
            return;
          }
          db.run(
            "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
            ["admin", "admin@m3u.studio", hash, "admin"],
            function (err) {
              if (err) {
                console.error('Error creating admin user:', err);
              } else {
                console.log('Created admin user for migration');
                next(this.lastID);
              }
            }
          );
        });
      };

      const proceed = (userId) => {
        db.run("BEGIN TRANSACTION");

        // Safely rename legacy tables if they exist
        const safeRename = (oldName, newName, cb) => {
          tableExists(oldName, (exists) => {
            if (!exists) return cb();
            db.run(`ALTER TABLE ${oldName} RENAME TO ${newName}`, (err) => {
              if (err) console.warn(`Skipping rename ${oldName} -> ${newName}:`, err.message);
              cb();
            });
          });
        };

        const createIfNotExists = (sql, cb) => db.run(sql, cb);

        // Chain operations
        safeRename('settings', 'settings_old', () => {
          safeRename('channels', 'channels_old', () => {
            safeRename('shows', 'shows_old', () => {
              safeRename('movies', 'movies_old', () => {
                // Create new tables with user_id (use IF NOT EXISTS to avoid errors)
                createIfNotExists(`
                  CREATE TABLE IF NOT EXISTS settings (
                    key TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    value TEXT,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (key, user_id),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                  )
                `, () => {
                  createIfNotExists(`
                    CREATE TABLE IF NOT EXISTS channels (
                      id TEXT NOT NULL,
                      user_id INTEGER NOT NULL,
                      data TEXT NOT NULL,
                      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                      PRIMARY KEY (id, user_id),
                      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                    )
                  `, () => {
                    createIfNotExists(`
                      CREATE TABLE IF NOT EXISTS shows (
                        id TEXT NOT NULL,
                        user_id INTEGER NOT NULL,
                        data TEXT NOT NULL,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id, user_id),
                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                      )
                    `, () => {
                      createIfNotExists(`
                        CREATE TABLE IF NOT EXISTS movies (
                          id TEXT NOT NULL,
                          user_id INTEGER NOT NULL,
                          data TEXT NOT NULL,
                          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                          PRIMARY KEY (id, user_id),
                          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                        )
                      `, () => {
                        // Migrate data if legacy *_old tables exist
                        const migrateFromOld = (oldTable, insertSQL, cb) => {
                          tableExists(oldTable, (exists) => {
                            if (!exists) return cb();
                            db.run(insertSQL, (err) => {
                              if (err) console.warn(`Skipping data migration from ${oldTable}:`, err.message);
                              // Drop old table regardless to avoid re-running
                              db.run(`DROP TABLE IF EXISTS ${oldTable}`, cb);
                            });
                          });
                        };

                        migrateFromOld(
                          'settings_old',
                          `INSERT INTO settings (key, user_id, value, updated_at) SELECT key, ${userId}, value, updated_at FROM settings_old`,
                          () => {
                            migrateFromOld(
                              'channels_old',
                              `INSERT INTO channels (id, user_id, data, created_at, updated_at) SELECT id, ${userId}, data, created_at, updated_at FROM channels_old`,
                              () => {
                                migrateFromOld(
                                  'shows_old',
                                  `INSERT INTO shows (id, user_id, data, created_at, updated_at) SELECT id, ${userId}, data, created_at, updated_at FROM shows_old`,
                                  () => {
                                    migrateFromOld(
                                      'movies_old',
                                      `INSERT INTO movies (id, user_id, data, created_at, updated_at) SELECT id, ${userId}, data, created_at, updated_at FROM movies_old`,
                                      () => {
                                        db.run("COMMIT", (err) => {
                                          if (err) {
                                            console.error('Migration failed, rolling back:', err);
                                            db.run("ROLLBACK");
                                          } else {
                                            console.log('✓ Database migration completed successfully!');
                                            console.log(`  All existing data migrated to admin user (ID: ${userId})`);
                                          }
                                        });
                                      }
                                    );
                                  }
                                );
                              }
                            );
                          }
                        );
                      });
                    });
                  });
                });
              });
            });
          });
        });
      };

      if (adminUser && adminUser.id) {
        proceed(adminUser.id);
      } else {
        createAdminAndContinue(proceed);
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

    // Create providers & sources tables if not exist (Phase 1 foundations)
    db.run(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL, -- 'm3u' | 'xtream' | 'dir'
        url TEXT,
        refresh_cron TEXT,
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL, -- 'channel' | 'movie' | 'episode'
        item_key TEXT NOT NULL,
        provider_id TEXT,
        url TEXT NOT NULL,
        quality TEXT, -- JSON string {height,codec,audio}
        lang TEXT,
        tags TEXT, -- JSON array
        priority INTEGER DEFAULT 100,
        enabled INTEGER DEFAULT 1,
        health_status TEXT, -- 'ok' | 'fail' | 'unstable'
        last_checked_at DATETIME,
        last_error TEXT,
        avg_startup_ms INTEGER,
        success_rate REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Best-effort seed: create a default provider and initial sources if empty
    const seed = () => {
      db.get("SELECT COUNT(*) as c FROM providers", [], (err, row) => {
        const hasProviders = !err && row && row.c > 0;
        if (!hasProviders) {
          db.get("SELECT id FROM users ORDER BY id ASC LIMIT 1", [], (e2, urow) => {
            const uid = urow?.id || 1;
            const provId = 'provider-default';
            db.run(
              "INSERT OR REPLACE INTO providers (id, user_id, name, type, enabled) VALUES (?, ?, ?, ?, 1)",
              [provId, uid, 'Default', 'm3u']
            );
            // Seed sources for channels and movies from existing data
            db.all("SELECT id, data FROM channels WHERE user_id = ?", [uid], (e3, chRows) => {
              (chRows || []).forEach(r => {
                try {
                  const obj = JSON.parse(r.data || '{}');
                  if (!obj?.url) return;
                  const sid = `src-ch-${obj.id || r.id}`;
                  db.run(
                    "INSERT OR IGNORE INTO sources (id, user_id, kind, item_key, provider_id, url, priority, enabled) VALUES (?, ?, 'channel', ?, ?, ?, 100, 1)",
                    [sid, uid, obj.id || r.id, provId, obj.url]
                  );
                } catch {}
              });
            });
            db.all("SELECT id, data FROM movies WHERE user_id = ?", [uid], (e4, mvRows) => {
              (mvRows || []).forEach(r => {
                try {
                  const obj = JSON.parse(r.data || '{}');
                  if (!obj?.url) return;
                  const sid = `src-mv-${obj.id || r.id}`;
                  db.run(
                    "INSERT OR IGNORE INTO sources (id, user_id, kind, item_key, provider_id, url, priority, enabled) VALUES (?, ?, 'movie', ?, ?, ?, 100, 1)",
                    [sid, uid, obj.id || r.id, provId, obj.url]
                  );
                } catch {}
              });
            });
          });
        }
      });
    };
    seed();
  });
}

// Serve local tv logos (if present) under /logos (register early)
try {
  if (fs.existsSync(TV_LOGOS_DIR)) {
    app.use('/logos', express.static(TV_LOGOS_DIR, { maxAge: '30d', setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }}));
    console.log(`Serving local TV logos from ${TV_LOGOS_DIR} at /logos`);
    // Simple health check route for debugging logos serving
    app.get('/logos-test', (req, res) => {
      const testFile = path.join(TV_LOGOS_DIR, 'countries', 'united-kingdom', 'bbc-one-uk.png');
      if (!fs.existsSync(testFile)) return res.status(404).send('test file missing');
      res.sendFile(testFile);
    });
  }
} catch {}

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
// Providers API (Phase 1)
app.get('/api/providers', authenticateToken, (req, res) => {
  db.all("SELECT id, name, type, url, refresh_cron as refreshCron, enabled, created_at as createdAt, updated_at as updatedAt FROM providers WHERE user_id = ? ORDER BY created_at DESC", [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ items: rows || [] });
  });
});

app.post('/api/providers', authenticateToken, (req, res) => {
  const { id, name, type, url, refreshCron, enabled = true } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  const pid = id || `provider-${crypto.randomBytes(6).toString('hex')}`;
  db.run(
    "INSERT OR REPLACE INTO providers (id, user_id, name, type, url, refresh_cron, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    [pid, req.user.id, name, type, url || '', refreshCron || '', enabled ? 1 : 0],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: pid });
    }
  );
});

app.delete('/api/providers/:id', authenticateToken, (req, res) => {
  db.run("DELETE FROM providers WHERE id = ? AND user_id = ?", [req.params.id, req.user.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post('/api/providers/:id/refresh', authenticateToken, (req, res) => {
  // Placeholder: in future, fetch from provider.url by provider.type and update tables
  res.json({ ok: true, message: 'Refresh scheduled' });
});

// Sources API (Phase 1)
app.get('/api/sources', authenticateToken, (req, res) => {
  const { kind, itemKey } = req.query;
  let sql = "SELECT id, kind, item_key as itemKey, provider_id as providerId, url, quality, lang, tags, priority, enabled, health_status as healthStatus, last_checked_at as lastCheckedAt, last_error as lastError, avg_startup_ms as avgStartupMs, success_rate as successRate FROM sources WHERE user_id = ?";
  const args = [req.user.id];
  if (kind) { sql += " AND kind = ?"; args.push(kind); }
  if (itemKey) { sql += " AND item_key = ?"; args.push(itemKey); }
  sql += " ORDER BY priority ASC, created_at ASC";
  db.all(sql, args, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // parse JSON fields
    const items = (rows || []).map(r => ({
      ...r,
      quality: r.quality ? JSON.parse(r.quality) : null,
      tags: r.tags ? JSON.parse(r.tags) : []
    }));
    res.json({ items });
  });
});

app.post('/api/sources', authenticateToken, (req, res) => {
  const { id, kind, itemKey, providerId, url, quality, lang, tags, priority = 100, enabled = true } = req.body || {};
  if (!kind || !itemKey || !url) return res.status(400).json({ error: 'kind, itemKey and url required' });
  const sid = id || `src-${crypto.randomBytes(6).toString('hex')}`;
  db.run(
    "INSERT OR REPLACE INTO sources (id, user_id, kind, item_key, provider_id, url, quality, lang, tags, priority, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    [sid, req.user.id, kind, itemKey, providerId || null, url, quality ? JSON.stringify(quality) : null, lang || null, Array.isArray(tags) ? JSON.stringify(tags) : null, priority, enabled ? 1 : 0],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: sid });
    }
  );
});

app.delete('/api/sources/:id', authenticateToken, (req, res) => {
  db.run("DELETE FROM sources WHERE id = ? AND user_id = ?", [req.params.id, req.user.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

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
    const forwardHeaders = {
      "user-agent": req.headers["user-agent"] || "m3u-studio-proxy/1.0",
      "range": req.headers["range"] || undefined,
      "accept": req.headers["accept"] || undefined,
      "accept-encoding": req.headers["accept-encoding"] || undefined,
      "referer": req.headers["referer"] || undefined,
      "origin": req.headers["origin"] || undefined
    };

    const upstream = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: Object.fromEntries(Object.entries(forwardHeaders).filter(([,v]) => !!v))
    });

    // Propagate status and key headers
    res.status(upstream.status);
    const headersToCopy = [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "cache-control",
      "expires",
      "pragma"
    ];
    headersToCopy.forEach(h => {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    });
    // Allow use by the browser
    res.set("Access-Control-Allow-Origin", "*");

    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("error", () => res.destroy());
      nodeStream.pipe(res);
    } else {
      res.end();
    }
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
  // Helper: local search in tv-logos dataset
  const resultsLocal = [];
  try {
    if (fs.existsSync(TV_LOGOS_DIR)) {
      if (!global.__tvLogosIndex) {
        const exts = new Set(['.png', '.svg', '.webp', '.jpg', '.jpeg']);
        const items = [];
        const walk = (dir, rel = '') => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const abs = path.join(dir, e.name);
            const r = path.join(rel, e.name);
            if (e.isDirectory()) walk(abs, r);
            else {
              const ext = path.extname(e.name).toLowerCase();
              if (!exts.has(ext)) continue;
              const base = path.basename(e.name, ext);
              const norm = base.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
              items.push({ base, rel: r, norm });
            }
          }
        };
        walk(TV_LOGOS_DIR);
        global.__tvLogosIndex = items;
        console.log(`Indexed ${items.length} tv-logo files`);
      }
      const normQ = query.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      // Score: exact norm match first, then prefix, then jaccard tokens
      const tokens = new Set(normQ.split(' ').filter(Boolean));
      const score = (item) => {
        if (item.norm === normQ) return 1.0;
        if (item.norm.startsWith(normQ) || normQ.startsWith(item.norm)) return 0.92;
        const tb = new Set(item.norm.split(' ').filter(Boolean));
        let inter = 0; tokens.forEach(t => { if (tb.has(t)) inter++; });
        const uni = new Set([...tokens, ...tb]).size || 1;
        return inter / uni;
      };
      const ranked = [...global.__tvLogosIndex]
        .map(it => ({ it, s: score(it) }))
        .filter(x => x.s >= 0.4)
        .sort((a,b) => b.s - a.s)
        .slice(0, top)
        .map(({ it, s }) => ({ url: `/logos/${it.rel.replace(/\\/g,'/')}`, title: it.base, source: 'local', score: s }));
      resultsLocal.push(...ranked);
    }
  } catch {}

  // Remote Bing fallback/merge
  let resultsBing = [];
  if (BING_IMAGE_API_KEY) {
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
      if (logoRes.ok) {
        const data = await logoRes.json();
        resultsBing = Array.isArray(data?.value)
          ? data.value
              .map(item => ({
                url: item.thumbnailUrl || item.contentUrl || "",
                title: item.name || query,
                source: item.hostPageDisplayUrl || item.hostPageUrl || ""
              }))
              .filter(item => item.url)
          : [];
      }
    } catch {}
  }
  // Combine, preferring local exact matches first
  const seen = new Set();
  const combined = [];
  const pushUnique = (arr) => arr.forEach(r => { const k = r.url; if (k && !seen.has(k)) { seen.add(k); combined.push(r); } });
  // local already ranked; keep order
  pushUnique(resultsLocal);
  pushUnique(resultsBing);
  const final = combined.slice(0, top);
  return res.json({ results: final });
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

// Generate an Xtream Codes style M3U that points back to this server
app.get("/playlist_xtream.m3u", (req, res) => {
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const lines = (latestPlaylist || '').split(/\r?\n/);
    const out = [];
    out.push('#EXTM3U');
    let index = 1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (line.startsWith('#EXTINF')) {
        // Keep info line as-is
        out.push(line);
        // Next non-comment line is the media URL
        let j = i + 1;
        let src = '';
        while (j < lines.length) {
          const candidate = (lines[j] || '').trim();
          if (candidate && !candidate.startsWith('#')) { src = candidate; break; }
          j++;
        }
        // Build an xtream-like URL that redirects to the real source
        const id = index++;
        const ext = src.includes('.m3u8') ? 'm3u8' : src.includes('.mpd') ? 'mpd' : (src.split('?')[0].split('.').pop() || 'ts');
        const xtreamUrl = `${base}/xtream/live/${encodeURIComponent(XTREAM_USER)}/${encodeURIComponent(XTREAM_PASS)}/${id}.${ext}?src=${encodeURIComponent(src)}`;
        out.push(xtreamUrl);
        // Skip to j for next iteration
        i = j;
      }
    }
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(out.join('\n'));
  } catch (err) {
    res.status(500).send(`#EXTM3U\n# Error generating Xtream M3U: ${err.message}`);
  }
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

// Serve player page
app.get("/player", (req, res) => {
  res.sendFile(path.join(__dirname, "player.html"));
});

// Minimal Xtream-style stream endpoints: redirect to original source URL
app.get(['/xtream/live/:user/:pass/:id', '/xtream/live/:user/:pass/:id.:ext'], (req, res) => {
  const { user, pass } = req.params;
  const src = req.query.src;
  if (!src) return res.status(400).send('Missing src');
  // Optionally validate credentials (no-op if not set)
  if ((XTREAM_USER && user !== XTREAM_USER) || (XTREAM_PASS && pass !== XTREAM_PASS)) {
    return res.status(401).send('Unauthorized');
  }
  // Redirect to the real media URL so native players fetch it directly
  res.redirect(302, src);
});

// ---------------- Transcode Service (FFmpeg) ----------------
// In-memory registry for active transcode sessions
const TRANSCODE_ROOT = path.join(os.tmpdir(), "m3u-transcode");
try { fs.mkdirSync(TRANSCODE_ROOT, { recursive: true }); } catch {}
const transcodeSessions = new Map(); // id -> { dir, proc, startedAt, lastAccess }

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

function cleanupSession(id) {
  const sess = transcodeSessions.get(id);
  if (!sess) return;
  try { if (sess.proc && !sess.proc.killed) sess.proc.kill("SIGKILL"); } catch {}
  try {
    // best-effort delete directory
    fs.rmSync(sess.dir, { recursive: true, force: true });
  } catch {}
  transcodeSessions.delete(id);
}

// Periodic idle cleanup (older than 7 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of transcodeSessions.entries()) {
    if ((now - (sess.lastAccess || sess.startedAt)) > 7 * 60 * 1000) {
      cleanupSession(id);
    }
  }
}, 60 * 1000).unref();

// Wait until a file exists (best-effort) before responding
function waitForFile(p, timeoutMs = 8000, intervalMs = 250) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      try {
        if (fs.existsSync(p)) return resolve(true);
      } catch {}
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(check, intervalMs);
    };
    check();
  });
}

app.post("/api/transcode/start", express.json(), async (req, res) => {
  const src = (req.body && req.body.src) || "";
  if (!src) return res.status(400).json({ error: "src required" });

  const id = makeId();
  const outDir = path.join(TRANSCODE_ROOT, id);
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

  // Build ffmpeg args for HLS with safe codecs
  const args = [
    "-y",
    "-fflags", "+genpts",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "2",
    "-i", src,
    // Video
    "-map", "0:v:0?",
    "-c:v", process.env.TRANSCODE_COPY_VIDEO ? "copy" : "libx264",
    "-preset", process.env.FFMPEG_PRESET || "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    // Audio (AAC stereo)
    "-map", "0:a:0?",
    "-c:a", process.env.TRANSCODE_COPY_AUDIO ? "copy" : "aac",
    "-b:a", "128k",
    "-ac", "2",
    // HLS muxer
    "-f", "hls",
    "-hls_time", process.env.HLS_TIME || "4",
    "-hls_list_size", process.env.HLS_LIST_SIZE || "6",
    "-hls_flags", "delete_segments+omit_endlist+independent_segments",
    "-hls_segment_filename", path.join(outDir, "seg_%05d.ts"),
    path.join(outDir, "index.m3u8")
  ];

  let proc;
  try {
    proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
  } catch (err) {
    cleanupSession(id);
    return res.status(500).json({ error: "ffmpeg not available", details: err.message });
  }

  const session = { id, dir: outDir, proc, startedAt: Date.now(), lastAccess: Date.now() };
  transcodeSessions.set(id, session);

  // Handle spawn errors (e.g., ffmpeg missing) without crashing the server
  let failed = false;
  proc.on("error", (err) => {
    failed = true;
    cleanupSession(id);
    if (!res.headersSent) {
      try { return res.status(500).json({ error: "ffmpeg not available", details: err.message }); } catch {}
    }
  });

  proc.on("exit", () => {
    // keep files for a short while for clients to finish
    setTimeout(() => cleanupSession(id), 2 * 60 * 1000).unref();
  });

  const indexPath = path.join(outDir, "index.m3u8");
  const ready = await waitForFile(indexPath, Number(process.env.TRANSCODE_READY_TIMEOUT || 8000));
  if (failed) return; // response already sent by error handler
  if (!ready) {
    cleanupSession(id);
    return res.status(500).json({ error: "Transcode did not start in time" });
  }
  res.json({ id, playlistUrl: `/transcode/${id}/index.m3u8` });
});

app.post("/api/transcode/stop", express.json(), (req, res) => {
  const id = req.body && req.body.id;
  if (!id || !transcodeSessions.has(id)) return res.json({ ok: true });
  cleanupSession(id);
  res.json({ ok: true });
});

// Serve generated HLS playlists and segments
app.get("/transcode/:id/:file", (req, res) => {
  const { id, file } = req.params;
  const sess = transcodeSessions.get(id);
  if (!sess) return res.status(404).end();
  sess.lastAccess = Date.now();
  const p = path.join(sess.dir, file);
  if (!fs.existsSync(p)) return res.status(404).end();
  // Set appropriate content type
  if (p.endsWith(".m3u8")) res.type("application/vnd.apple.mpegurl");
  else if (p.endsWith(".ts")) res.type("video/mp2t");
  res.sendFile(p);
});

app.listen(PORT, () => {
  console.log(`M3U Studio available on http://localhost:${PORT}`);
});

// ---------------- Xtream Codes compatible API (minimal) ----------------
// Helpers to access DB without JWT for Xtream endpoints (guarded by credentials)
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

async function getXtreamUserId() {
  // Optionally select a specific user via env var
  const envId = process.env.XTREAM_USER_ID && parseInt(process.env.XTREAM_USER_ID, 10);
  if (envId) return envId;
  const admin = await dbGet("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1", []);
  if (admin?.id) return admin.id;
  const any = await dbGet("SELECT id FROM users ORDER BY id ASC LIMIT 1", []);
  return any?.id || 1;
}

function genId(s) {
  try {
    const h = crypto.createHash('md5').update(String(s)).digest('hex');
    return parseInt(h.slice(0, 8), 16);
  } catch {
    return Math.abs((String(s).length * 2654435761) >>> 0);
  }
}

async function loadAllDataForXtream() {
  const userId = await getXtreamUserId();
  const channelsRows = await dbAll("SELECT data FROM channels WHERE user_id = ?", [userId]);
  const showsRows = await dbAll("SELECT data FROM shows WHERE user_id = ?", [userId]);
  const moviesRows = await dbAll("SELECT data FROM movies WHERE user_id = ?", [userId]);
  const channels = channelsRows.map(r => JSON.parse(r.data || '{}'));
  const shows = showsRows.map(r => JSON.parse(r.data || '{}'));
  const movies = moviesRows.map(r => JSON.parse(r.data || '{}'));
  return { channels, shows, movies };
}

function requireXtreamAuth(req, res) {
  const u = req.query.username || req.params.username || req.params.user;
  const p = req.query.password || req.params.password || req.params.pass;
  if ((XTREAM_USER && u !== XTREAM_USER) || (XTREAM_PASS && p !== XTREAM_PASS)) {
    res.status(401).json({ user_info: { auth: 0, status: 'Expired' }, server_info: {} });
    return false;
  }
  return true;
}

function makeServerInfo(req) {
  const base = `${req.protocol}://${req.get('host')}`;
  return {
    url: base,
    port: req.get('host')?.split(':')[1] || String(PORT),
    https_port: "443",
    server_protocol: req.protocol,
    rtmp_port: "0",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  };
}

function makeUserInfo() {
  const now = Math.floor(Date.now() / 1000);
  return {
    username: XTREAM_USER,
    password: XTREAM_PASS,
    message: '',
    auth: 1,
    status: 'Active',
    exp_date: (now + 365 * 24 * 3600).toString(),
    is_trial: '0',
    active_cons: '1',
    created_at: now.toString(),
    max_connections: '1',
  };
}

app.get('/player_api.php', async (req, res) => {
  if (!requireXtreamAuth(req, res)) return;
  const action = (req.query.action || '').toString();
  const base = `${req.protocol}://${req.get('host')}`;
  try {
    const { channels, shows, movies } = await loadAllDataForXtream();

    if (!action) {
      // Portal root – return minimal user/server info
      return res.json({ user_info: makeUserInfo(), server_info: makeServerInfo(req) });
    }

    if (action === 'get_live_categories') {
      const groups = Array.from(new Set(channels.map(c => c.group || 'Live')));
      const cats = groups.map((g) => ({ category_id: genId('live:' + g), category_name: g, parent_id: 0 }));
      return res.json(cats);
    }
    if (action === 'get_vod_categories') {
      const groups = Array.from(new Set(movies.map(m => m.group || 'Movies')));
      const cats = groups.map((g) => ({ category_id: genId('vod:' + g), category_name: g, parent_id: 0 }));
      return res.json(cats);
    }
    if (action === 'get_series_categories') {
      const groups = Array.from(new Set(shows.map(s => s.group || 'TV Shows')));
      const cats = groups.map((g) => ({ category_id: genId('series:' + g), category_name: g, parent_id: 0 }));
      return res.json(cats);
    }

    if (action === 'get_live_streams') {
      const byCat = new Map();
      channels.forEach(c => {
        const catId = genId('live:' + (c.group || 'Live'));
        const stream_id = genId('ch:' + (c.url || c.id || c.name));
        const item = {
          num: 1,
          name: c.name || 'Channel',
          stream_type: 'live',
          stream_id,
          stream_icon: c.logo || '',
          epg_channel_id: c.id || '',
          added: '',
          category_id: catId,
          tvg_id: c.id || '',
          direct_source: c.url || '',
          tv_archive: 0,
          tv_archive_duration: 0
        };
        if (!byCat.has(catId)) byCat.set(catId, []);
        byCat.get(catId).push(item);
      });
      return res.json(Array.from(byCat.values()).flat());
    }

    if (action === 'get_vod_streams') {
      const out = movies.map(m => ({
        name: m.title || 'Movie',
        stream_id: genId('vod:' + (m.url || m.tmdbId || m.title)),
        stream_icon: m.poster || '',
        rating: String(m.rating || ''),
        added: '',
        category_id: genId('vod:' + (m.group || 'Movies')),
        container_extension: (m.url || '').split('?')[0].split('.').pop() || 'mp4',
        plot: m.overview || '',
        direct_source: m.url || ''
      }));
      return res.json(out);
    }

    if (action === 'get_series') {
      const out = shows.map(s => ({
        series_id: genId('series:' + (s.tmdbId || s.title)),
        name: s.title || s.name || 'Series',
        cover: s.poster || '',
        plot: s.overview || '',
        rating: String(s.rating || ''),
        category_id: genId('series:' + (s.group || 'TV Shows')),
      }));
      return res.json(out);
    }

    if (action === 'get_series_info') {
      const series_id = parseInt(req.query.series_id, 10);
      const series = shows.find(s => genId('series:' + (s.tmdbId || s.title)) === series_id);
      if (!series) return res.json({ episodes: {}, info: {}, seasons: [] });
      const info = {
        name: series.title || 'Series',
        plot: series.overview || '',
        cover: series.poster || '',
        rating: String(series.rating || ''),
        genres: series.genres || ''
      };
      const episodes = {};
      (series.seasons || []).forEach(sea => {
        const key = String(sea.season);
        episodes[key] = (sea.episodes || []).filter(ep => ep.url).map(ep => ({
          id: genId('ep:' + (ep.url || `${series.title}:${sea.season}:${ep.episode}`)),
          episode_num: ep.episode,
          title: ep.title || `E${ep.episode}`,
          container_extension: 'mp4',
          info: { duration: 0 }
        }));
      });
      const seasons = (series.seasons || []).map(sea => ({ season_number: sea.season }));
      return res.json({ episodes, info, seasons });
    }

    if (action === 'get_vod_info') {
      const vod_id = parseInt(req.query.vod_id, 10);
      const m = movies.find(mm => genId('vod:' + (mm.url || mm.tmdbId || mm.title)) === vod_id);
      if (!m) return res.json({ info: {}, movie_data: {} });
      const info = {
        movie_image: m.poster || '',
        cover_big: m.backdrop || m.poster || '',
        plot: m.overview || '',
        releasedate: m.releaseDate || (m.year ? String(m.year) : ''),
        genre: m.genres || '',
        duration_secs: m.runtime ? m.runtime * 60 : 0,
        duration: m.runtime ? `${m.runtime} min` : '',
        cast: m.cast || '',
        director: m.director || '',
        country: m.country || '',
        youtube_trailer: m.trailerUrl || ''
      };
      const movie_data = {
        stream_id: vod_id,
        name: m.title || 'Movie',
        added: '',
        category_id: genId('vod:' + (m.group || 'Movies')),
        container_extension: (m.url || '').split('?')[0].split('.').pop() || 'mp4',
        direct_source: m.url || ''
      };
      return res.json({ info, movie_data });
    }

    if (action === 'get_short_epg') {
      // Basic placeholder EPG: current 24h window
      const stream_id = parseInt(req.query.stream_id, 10);
      const now = Math.floor(Date.now() / 1000);
      const end = now + 24 * 3600;
      return res.json([
        {
          id: stream_id,
          title: 'Live Stream',
          start: now,
          end,
          description: 'Currently airing',
        }
      ]);
    }

    // Fallback unknown action
    return res.json([]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// XMLTV passthrough for Xtream clients
app.get('/xmltv.php', (req, res) => {
  if (!requireXtreamAuth(req, res)) return;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(latestEpg || '');
});

// M3U generator alias used by some Xtream clients
app.get('/get.php', (req, res) => {
  if (!requireXtreamAuth(req, res)) return;
  // type=m3u or m3u_plus, output=ts|m3u8 ignored – reuse our Xtream M3U
  res.redirect(302, '/playlist_xtream.m3u');
});

// Standard Xtream stream endpoints: redirect to real sources based on our DB
async function findStreamSourceById(kind, id) {
  const { channels, shows, movies } = await loadAllDataForXtream();
  if (kind === 'live') {
    for (const c of channels) {
      const sid = genId('ch:' + (c.url || c.id || c.name));
      if (sid === id) return c.url;
    }
    return null;
  }
  if (kind === 'movie') {
    for (const m of movies) {
      const sid = genId('vod:' + (m.url || m.tmdbId || m.title));
      if (sid === id) return m.url;
    }
    return null;
  }
  if (kind === 'series') {
    // series endpoint usually uses series_id + episode_id; we accept episode_id only
    for (const s of shows) {
      for (const sea of (s.seasons || [])) {
        for (const ep of (sea.episodes || [])) {
          const eid = genId('ep:' + (ep.url || `${s.title}:${sea.season}:${ep.episode}`));
          if (eid === id) return ep.url;
        }
      }
    }
    return null;
  }
  return null;
}

app.get(['/live/:username/:password/:id', '/live/:username/:password/:id.:ext'], async (req, res) => {
  if (!requireXtreamAuth(req, res)) return;
  const streamId = parseInt(req.params.id, 10);
  const src = await findStreamSourceById('live', streamId);
  if (!src) return res.status(404).send('Stream not found');
  res.redirect(302, src);
});

app.get(['/movie/:username/:password/:id', '/movie/:username/:password/:id.:ext'], async (req, res) => {
  if (!requireXtreamAuth(req, res)) return;
  const streamId = parseInt(req.params.id, 10);
  const src = await findStreamSourceById('movie', streamId);
  if (!src) return res.status(404).send('Stream not found');
  res.redirect(302, src);
});

app.get(['/series/:username/:password/:seriesId/:episodeId', '/series/:username/:password/:seriesId/:episodeId.:ext'], async (req, res) => {
  if (!requireXtreamAuth(req, res)) return;
  const epId = parseInt(req.params.episodeId, 10);
  const src = await findStreamSourceById('series', epId);
  if (!src) return res.status(404).send('Episode not found');
  res.redirect(302, src);
});
