CREATE TABLE IF NOT EXISTS trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  source TEXT,
  score REAL,
  collected_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trend_id INTEGER,
  title TEXT NOT NULL,
  profit_score REAL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trend_id) REFERENCES trends(id)
);

CREATE TABLE IF NOT EXISTS content_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id INTEGER,
  title TEXT,
  script TEXT,
  thumbnail_concept TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id)
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_plan_id INTEGER,
  youtube_video_id TEXT,
  status TEXT DEFAULT 'draft',
  published_at TEXT,
  FOREIGN KEY (content_plan_id) REFERENCES content_plans(id)
);

CREATE TABLE IF NOT EXISTS performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER,
  views INTEGER,
  revenue REAL,
  watch_time_minutes REAL,
  recorded_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (video_id) REFERENCES videos(id)
);
