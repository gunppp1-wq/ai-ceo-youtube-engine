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

CREATE TABLE IF NOT EXISTS daily_usage (
  usage_date TEXT NOT NULL,
  op_type TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (usage_date, op_type)
);

CREATE TABLE IF NOT EXISTS system_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Extended tables (created automatically via self-healing migrations in scheduled())

CREATE TABLE IF NOT EXISTS video_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER UNIQUE,
  views INTEGER DEFAULT 0,
  watch_time_minutes REAL DEFAULT 0,
  average_view_duration REAL DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  post_mortem TEXT,
  collected_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE TABLE IF NOT EXISTS channel_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_count INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  video_count INTEGER DEFAULT 0,
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS removed_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_video_id INTEGER,
  content_plan_id INTEGER,
  title TEXT,
  script TEXT,
  youtube_video_id TEXT,
  removal_reason TEXT,
  views_at_removal INTEGER DEFAULT 0,
  removed_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publish_hour_rotation (
  hour INTEGER PRIMARY KEY,
  last_used_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_setup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  completed_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_setup_attempts (
  id INTEGER PRIMARY KEY DEFAULT 1,
  attempts INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS keywords_backfill (
  id INTEGER PRIMARY KEY DEFAULT 1,
  completed_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_playlist (
  id INTEGER PRIMARY KEY DEFAULT 1,
  playlist_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  purpose TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS competitor_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  video_title TEXT,
  view_count INTEGER DEFAULT 0,
  channel_title TEXT,
  collected_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thumbnail_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_title TEXT,
  channel_title TEXT,
  view_count INTEGER DEFAULT 0,
  thumbnail_url TEXT,
  analysis TEXT,
  collected_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS title_pattern_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  analysis TEXT,
  sample_size INTEGER,
  collected_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analyzer_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  b2_file_name TEXT NOT NULL,
  b2_file_id TEXT,
  niche_tag TEXT,
  status TEXT DEFAULT 'uploaded',
  mode TEXT DEFAULT 'analyze',
  duration_seconds REAL,
  attempt_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analyzer_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analyzer_input_id INTEGER,
  pattern TEXT,
  timing_seconds REAL,
  observed_effect TEXT,
  niche TEXT,
  confidence REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (analyzer_input_id) REFERENCES analyzer_inputs(id)
);

CREATE TABLE IF NOT EXISTS user_instructions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT,
  instruction_text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reasoning_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id INTEGER,
  decision_type TEXT NOT NULL,
  chosen_value TEXT,
  reasoning TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS self_mod_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  what_changed TEXT NOT NULL,
  why TEXT,
  metric_name TEXT NOT NULL,
  deadline_at INTEGER NOT NULL,
  opened_at INTEGER DEFAULT (strftime('%s','now')),
  closed_at INTEGER,
  status TEXT DEFAULT 'open',
  extension_count INTEGER DEFAULT 0,
  rollback_data TEXT
);

CREATE TABLE IF NOT EXISTS payment_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  cost_summary TEXT,
  payment_url TEXT,
  danger_level TEXT DEFAULT 'low',
  proposal_type TEXT DEFAULT 'upgrade',
  config_key TEXT,
  config_new_value TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  decided_at INTEGER,
  paid_confirmed_at INTEGER
);

CREATE TABLE IF NOT EXISTS notification_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS taught_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_type TEXT NOT NULL,
  variant_text TEXT NOT NULL,
  content_plan_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS video_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  youtube_video_id TEXT NOT NULL,
  comment_id TEXT UNIQUE,
  author TEXT,
  text TEXT,
  like_count INTEGER DEFAULT 0,
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_type TEXT,
  summary TEXT,
  supporting_data TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS code_self_mod_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  self_mod_entry_id INTEGER,
  target_file TEXT,
  diff_applied TEXT
);

CREATE TABLE IF NOT EXISTS code_file_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  self_mod_entry_id INTEGER,
  file_path TEXT,
  content TEXT,
  backed_up_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS backlog_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unused_plans INTEGER DEFAULT 0,
  ready_videos INTEGER DEFAULT 0,
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scheduler_state (
  task_name TEXT PRIMARY KEY,
  last_run_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS production_halt (
  id INTEGER PRIMARY KEY DEFAULT 1,
  active INTEGER DEFAULT 0,
  reason TEXT,
  halted_at TEXT,
  resumed_at TEXT
);
