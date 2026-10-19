-- AD-02: student ID, Aadhaar (last 4 digits only), student photo / ID proof, preferred time slot and end date.

CREATE SEQUENCE student_code_seq;
-- Every student (existing ones too) gets an ID like NMS-00001; the Manager can change it at admission.
ALTER TABLE students ADD COLUMN student_code TEXT NOT NULL
  DEFAULT ('NMS-' || lpad(nextval('student_code_seq')::text, 5, '0'));
CREATE UNIQUE INDEX ux_student_code ON students (lower(student_code));
-- Only the last four digits are ever stored; the full Aadhaar number is never saved.
ALTER TABLE students ADD COLUMN aadhaar_last4 TEXT CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$');

-- Student photo and ID proof live with the other uploaded files.
ALTER TABLE pretest_files ADD COLUMN kind TEXT NOT NULL DEFAULT 'test_paper'
  CHECK (kind IN ('test_paper', 'student_photo', 'id_proof'));

-- Preferred weekly slot (weekdays 0=Sun..6=Sat, comma separated) and the projected last class date.
ALTER TABLE enrollments ADD COLUMN slot_days TEXT CHECK (slot_days IS NULL OR slot_days ~ '^[0-6](,[0-6])*$');
ALTER TABLE enrollments ADD COLUMN slot_time TEXT;
ALTER TABLE enrollments ADD COLUMN end_date TEXT;
