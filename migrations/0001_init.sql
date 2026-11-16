CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  category TEXT NOT NULL DEFAULT 'geral',
  status TEXT NOT NULL DEFAULT 'pending',
  due_at TEXT,
  recurrence TEXT,
  template_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  postponed_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_reminders_owner_status_due
  ON reminders(owner_id, status, due_at);

CREATE TABLE IF NOT EXISTS drafts (
  owner_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  reminder_id INTEGER,
  step TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'geral',
  recurrence TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE IF NOT EXISTS water_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  amount_ml INTEGER NOT NULL,
  logged_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_water_logs_owner_logged
  ON water_logs(owner_id, logged_at);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

