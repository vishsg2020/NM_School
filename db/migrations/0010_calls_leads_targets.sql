-- Tele team call tracking: leads (one per enquiry / phone), every call logged against a lead, and monthly rep targets.
-- A lead's queue (Call later / Reconnect / Interested) and status (Open / Closed Won / Closed Lost) are worked out
-- from its latest call and its linked candidate; they are not stored.

CREATE SEQUENCE call_lead_seq;

CREATE TABLE leads (
  id              SERIAL PRIMARY KEY,
  lead_code       TEXT NOT NULL UNIQUE DEFAULT ('LD-' || lpad(nextval('call_lead_seq')::text, 5, '0')),
  phone           TEXT,
  phone_norm      TEXT,
  name            TEXT,
  location        TEXT,
  gender          TEXT CHECK (gender IS NULL OR gender IN ('Male', 'Female', 'Other')),
  age             INTEGER CHECK (age IS NULL OR age BETWEEN 1 AND 120),
  category        TEXT NOT NULL,
  assigned_rep_id INTEGER REFERENCES users(id),      -- NULL = unassigned (any Sales Team member may take it)
  candidate_id    INTEGER UNIQUE REFERENCES candidates(id),
  source          TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'import')),
  idempotency_key TEXT UNIQUE,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT now_iso(),
  updated_at      TEXT NOT NULL DEFAULT now_iso()
);
CREATE INDEX ix_leads_phone ON leads(phone_norm);
CREATE INDEX ix_leads_rep ON leads(assigned_rep_id);
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE TABLE lead_calls (
  id              SERIAL PRIMARY KEY,
  lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  called_at       TEXT NOT NULL DEFAULT now_iso(),     -- UTC timestamp
  action          TEXT NOT NULL DEFAULT 'Called' CHECK (action IN ('Called', 'No Action')),
  response        TEXT,
  notes           TEXT,
  callback_at     TEXT,                                -- 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' (IST) for Call Later
  rep_id          INTEGER REFERENCES users(id),        -- who made / logged the call
  source          TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'import')),
  ext_id          TEXT UNIQUE,                         -- Activity ID from the imported sheet
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL DEFAULT now_iso()
);
CREATE INDEX ix_lead_calls_lead ON lead_calls(lead_id, called_at DESC, id DESC);
CREATE INDEX ix_lead_calls_rep ON lead_calls(rep_id, called_at);
ALTER TABLE lead_calls ENABLE ROW LEVEL SECURITY;

CREATE TABLE rep_targets (
  id             SERIAL PRIMARY KEY,
  month          TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  target_count   INTEGER NOT NULL CHECK (target_count >= 0),
  min_conversion NUMERIC(5,2) CHECK (min_conversion IS NULL OR (min_conversion >= 0 AND min_conversion <= 100)),  -- percent
  notes          TEXT,
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT NOT NULL DEFAULT now_iso(),
  UNIQUE (month, user_id)
);
ALTER TABLE rep_targets ENABLE ROW LEVEL SECURITY;
