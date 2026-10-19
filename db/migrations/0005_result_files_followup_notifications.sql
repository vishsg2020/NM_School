-- AS-01: test paper uploads, preferred follow-up time, in-app notifications.

-- Test paper / worksheet files for a pre-test (photos are shrunk in the browser before upload).
CREATE TABLE pretest_files (
  id           SERIAL PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf')),
  size_bytes   INTEGER NOT NULL,
  data         BYTEA NOT NULL,
  uploaded_by  INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT now_iso()
);
CREATE INDEX ix_pretest_files_cand ON pretest_files(candidate_id);
ALTER TABLE pretest_files ENABLE ROW LEVEL SECURITY;

-- When the parent prefers to be contacted again (only for admission status Follow-up).
ALTER TABLE pretest_results ADD COLUMN followup_date TEXT;      -- 'YYYY-MM-DD'
ALTER TABLE pretest_results ADD COLUMN followup_time TEXT;      -- 'HH:MM' IST, optional
ALTER TABLE pretest_results ADD COLUMN followup_channel TEXT
  CHECK (followup_channel IS NULL OR followup_channel IN ('WhatsApp','Call','Email'));
ALTER TABLE pretest_results ADD COLUMN followup_note TEXT;

-- In-app notifications (the bell).
CREATE TABLE notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT now_iso()
);
CREATE INDEX ix_notifications_user ON notifications(user_id, read_at);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
