-- Supabase automatically exposes tables in the public schema through its REST/GraphQL Data API.
-- This app never uses that API: it connects to Postgres directly as the table owner.
-- Enabling row-level security with no policies makes every table unreadable and unwritable through
-- the Data API, while the app's own connection (the table owner) is unaffected.
ALTER TABLE teachers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_hours    ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_slots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_failures   ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pretest_results  ENABLE ROW LEVEL SECURITY;
ALTER TABLE students         ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
