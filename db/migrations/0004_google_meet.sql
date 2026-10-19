-- Google Meet links for pre-tests (created in the Google account the Manager connects in Settings).

-- Small key/value store for app-wide settings (Google connection details).
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT now_iso()
);
-- Same lock-down as every other table: unreachable through Supabase's Data API.
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE candidates ADD COLUMN meet_link TEXT;
ALTER TABLE candidates ADD COLUMN meet_event_id TEXT;
