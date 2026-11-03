-- ============================================================================================
-- Nalla Malayalam — CLEAN ALL DATA (keep only Manager logins)
--
-- Run ONCE in Supabase → SQL Editor on the database you want to empty. It CANNOT be undone.
-- Deletes: candidates, pre-test results and files, students, enrollments, payments, classes,
--          feedback, notifications, change history, teachers (with hours/slots), Sales and Teacher logins.
-- Keeps:   Manager logins (same email and password), Settings (Google connection, feedback frequency),
--          and the tables themselves.
-- Numbering restarts: Lead IDs NM-00001, Student IDs NMS-00001, Class IDs CL-000001.
-- Everyone is signed out; Managers sign in again.
-- ============================================================================================
BEGIN;

-- Safety: stop if there is no active Manager to keep.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'manager' AND active = 1) THEN
    RAISE EXCEPTION 'No active Manager login found — nothing was deleted.';
  END IF;
END $$;

-- All school records (and their numbering).
TRUNCATE TABLE feedback, notifications, pretest_files, payments, classes, enrollments, students,
               pretest_results, candidates, teacher_slots, teacher_hours, sessions, login_failures, audit_events
  RESTART IDENTITY;

-- Logins: keep Managers only.
UPDATE app_settings SET updated_by = NULL WHERE updated_by IN (SELECT id FROM users WHERE role <> 'manager');
UPDATE users SET teacher_id = NULL WHERE role = 'manager';
DELETE FROM users WHERE role <> 'manager';

-- Teachers.
DELETE FROM teachers;
SELECT setval(pg_get_serial_sequence('teachers', 'id'), 1, false);

-- Human-readable numbers start again from 1.
ALTER SEQUENCE lead_number_seq RESTART WITH 1;
ALTER SEQUENCE class_number_seq RESTART WITH 1;
ALTER SEQUENCE student_code_seq RESTART WITH 1;

COMMIT;

-- What is left (should show only your Manager logins and zeros):
SELECT 'managers' AS what, COUNT(*) AS n FROM users
UNION ALL SELECT 'teachers', COUNT(*) FROM teachers
UNION ALL SELECT 'candidates', COUNT(*) FROM candidates
UNION ALL SELECT 'students', COUNT(*) FROM students
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'classes', COUNT(*) FROM classes;
