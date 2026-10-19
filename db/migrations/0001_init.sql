-- Nalla Malayalam school management: initial schema (PostgreSQL / Netlify Database).
-- Netlify applies files in this folder automatically on every deploy, in name order.
-- Never edit an applied migration; add a new numbered file instead.

-- UTC timestamp as ISO-8601 text, the format the app uses everywhere.
CREATE FUNCTION now_iso() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

CREATE SEQUENCE lead_number_seq;
CREATE SEQUENCE class_number_seq;

CREATE TABLE teachers (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  phone            TEXT,
  email            TEXT,
  employment_type  TEXT NOT NULL DEFAULT 'Regular' CHECK (employment_type IN ('Regular','Freelance')),
  supports_1to1    INTEGER NOT NULL DEFAULT 1 CHECK (supports_1to1 IN (0,1)),
  supports_3to1    INTEGER NOT NULL DEFAULT 0 CHECK (supports_3to1 IN (0,1)),
  monthly_capacity INTEGER CHECK (monthly_capacity IS NULL OR monthly_capacity >= 0),
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT now_iso(),
  updated_at       TEXT NOT NULL DEFAULT now_iso()
);

-- Working hours: when the teacher is on duty. weekday 0 = Sunday.
CREATE TABLE teacher_hours (
  id         SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX ix_teacher_hours_t ON teacher_hours(teacher_id, weekday);

-- Availability slots: windows inside working hours that are open for booking.
CREATE TABLE teacher_slots (
  id         SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  format     TEXT NOT NULL DEFAULT 'Any' CHECK (format IN ('Any','1:1','3:1')),
  CHECK (start_time < end_time)
);
CREATE INDEX ix_teacher_slots_t ON teacher_slots(teacher_id, weekday);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('manager','sales','teacher')),
  teacher_id    INTEGER UNIQUE REFERENCES teachers(id),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT now_iso(),
  CHECK (role <> 'teacher' OR teacher_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_users_email ON users (lower(email));

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_iso()
);
CREATE INDEX ix_sessions_user ON sessions(user_id);

-- Failed sign-in attempts (shared across serverless instances).
CREATE TABLE login_failures (
  key        TEXT PRIMARY KEY,
  first_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  count      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE candidates (
  id                 SERIAL PRIMARY KEY,
  lead_id            TEXT NOT NULL,
  student_name       TEXT NOT NULL,
  parent_name        TEXT,
  phone              TEXT NOT NULL,
  phone_norm         TEXT NOT NULL,
  location           TEXT,
  age                INTEGER CHECK (age IS NULL OR (age BETWEEN 2 AND 99)),
  sales_rep_id       INTEGER NOT NULL REFERENCES users(id),
  pretest_at         TEXT,                    -- school-local 'YYYY-MM-DDTHH:MM'
  time_confirmation  TEXT NOT NULL DEFAULT 'Not Confirmed'
                     CHECK (time_confirmation IN ('Not Confirmed','Confirmed','Reschedule Requested')),
  pretest_teacher_id INTEGER REFERENCES teachers(id),
  status             TEXT NOT NULL CHECK (status IN ('Scheduled','Time Required','Needs Review','Completed','Cancelled','Follow-up')),
  notes              TEXT,
  idempotency_key    TEXT UNIQUE,
  created_by         INTEGER NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT now_iso(),
  updated_at         TEXT NOT NULL DEFAULT now_iso()
);
CREATE UNIQUE INDEX ux_cand_lead ON candidates (lower(lead_id));
CREATE INDEX ix_cand_phone ON candidates(phone_norm);
CREATE INDEX ix_cand_status ON candidates(status);
CREATE INDEX ix_cand_teacher ON candidates(pretest_teacher_id);
CREATE INDEX ix_cand_pretest ON candidates(pretest_at);
CREATE INDEX ix_cand_rep ON candidates(sales_rep_id);

CREATE TABLE pretest_results (
  id                 SERIAL PRIMARY KEY,
  candidate_id       INTEGER NOT NULL UNIQUE REFERENCES candidates(id),
  teacher_id         INTEGER NOT NULL REFERENCES teachers(id),
  recommended_course TEXT NOT NULL CHECK (recommended_course IN ('Starter','Reader','Writer','Malayalam Master')),
  assessment         TEXT NOT NULL,
  admission_status   TEXT NOT NULL CHECK (admission_status IN ('Confirmed','Follow-up','Not Interested')),
  objection          TEXT,
  recommendation     TEXT,
  notes              TEXT,
  submitted_by       INTEGER NOT NULL REFERENCES users(id),
  submitted_at       TEXT NOT NULL DEFAULT now_iso(),
  reviewed_by        INTEGER REFERENCES users(id),
  reviewed_at        TEXT,
  updated_at         TEXT NOT NULL DEFAULT now_iso()
);

CREATE TABLE students (
  id           SERIAL PRIMARY KEY,
  candidate_id INTEGER NOT NULL UNIQUE REFERENCES candidates(id),
  created_at   TEXT NOT NULL DEFAULT now_iso()
);

CREATE TABLE enrollments (
  id                SERIAL PRIMARY KEY,
  student_id        INTEGER NOT NULL REFERENCES students(id),
  course            TEXT NOT NULL CHECK (course IN ('Starter','Reader','Writer','Malayalam Master')),
  class_mode        TEXT NOT NULL CHECK (class_mode IN ('1:1','3:1')),
  total_classes     INTEGER NOT NULL CHECK (total_classes > 0),
  completed_classes INTEGER NOT NULL DEFAULT 0 CHECK (completed_classes >= 0),
  teacher_id        INTEGER NOT NULL REFERENCES teachers(id),
  start_date        TEXT NOT NULL,
  admission_date    TEXT NOT NULL,             -- school-local date the admission was saved
  total_fee         INTEGER NOT NULL CHECK (total_fee >= 0),  -- whole rupees
  status            TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Completed','Paused','Cancelled')),
  lead_id           TEXT NOT NULL,             -- attribution snapshot
  sales_rep_id      INTEGER NOT NULL REFERENCES users(id),
  notes             TEXT,
  idempotency_key   TEXT UNIQUE,
  created_by        INTEGER NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT now_iso(),
  updated_at        TEXT NOT NULL DEFAULT now_iso(),
  CHECK (completed_classes <= total_classes)
);
-- At most one Active enrollment per student (prevents duplicate admissions).
CREATE UNIQUE INDEX ux_enroll_active ON enrollments(student_id) WHERE status = 'Active';
CREATE INDEX ix_enroll_teacher ON enrollments(teacher_id);
CREATE INDEX ix_enroll_rep ON enrollments(sales_rep_id);

CREATE TABLE payments (
  id            SERIAL PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  stage         TEXT NOT NULL CHECK (stage IN ('Advance','Final')),
  amount        INTEGER NOT NULL CHECK (amount >= 0),
  status        TEXT NOT NULL CHECK (status IN ('Paid','Pending')),
  date          TEXT NOT NULL,       -- Paid: received date; Pending: due date
  method        TEXT CHECK (method IS NULL OR method IN ('UPI','Bank Transfer','Cash','Card','Other')),
  reference     TEXT,
  updated_at    TEXT NOT NULL DEFAULT now_iso(),
  UNIQUE (enrollment_id, stage)
);
CREATE INDEX ix_pay_status_date ON payments(status, date);

-- One row per student per class (a 3:1 group session = up to 3 rows sharing teacher + time).
CREATE TABLE classes (
  id              SERIAL PRIMARY KEY,
  class_code      TEXT NOT NULL UNIQUE DEFAULT ('CL-' || lpad(nextval('class_number_seq')::text, 6, '0')),
  enrollment_id   INTEGER NOT NULL REFERENCES enrollments(id),
  teacher_id      INTEGER NOT NULL REFERENCES teachers(id),
  format          TEXT NOT NULL CHECK (format IN ('1:1','3:1')),
  scheduled_at    TEXT NOT NULL,                  -- school-local 'YYYY-MM-DDTHH:MM'
  duration_min    INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 240),
  status          TEXT NOT NULL DEFAULT 'Scheduled'
                  CHECK (status IN ('Scheduled','Completed','Cancelled','Student Absent','Teacher Absent','Rescheduled')),
  attendance      TEXT CHECK (attendance IS NULL OR attendance IN ('Present','Late','Absent')),
  topics          TEXT,
  homework        TEXT,
  notes           TEXT,
  progress        TEXT,
  next_class_date TEXT,
  counted         INTEGER NOT NULL DEFAULT 0 CHECK (counted IN (0,1)),  -- has incremented completed_classes
  recorded_by     INTEGER REFERENCES users(id),
  recorded_at     TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT now_iso(),
  updated_at      TEXT NOT NULL DEFAULT now_iso()
);
CREATE INDEX ix_class_teacher_time ON classes(teacher_id, scheduled_at);
CREATE INDEX ix_class_enroll ON classes(enrollment_id);
CREATE INDEX ix_class_time ON classes(scheduled_at);

CREATE TABLE audit_events (
  id          SERIAL PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT now_iso(),
  user_id     INTEGER REFERENCES users(id),
  entity      TEXT NOT NULL,
  entity_id   INTEGER,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  reason      TEXT
);
CREATE INDEX ix_audit_entity ON audit_events(entity, entity_id);
