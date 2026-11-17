-- Round 4: fee reminders and follow-up notes, course renewals, teacher pay statement, missed classes and extra charges.

-- 1. Fee follow-up: each WhatsApp reminder sent and each note, per payment.
CREATE TABLE payment_followups (
  id         SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('reminder', 'note')),
  note       TEXT,
  next_date  TEXT,                                   -- promised / next follow-up date (YYYY-MM-DD)
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_iso()
);
CREATE INDEX ix_payment_followups ON payment_followups(payment_id, id);
ALTER TABLE payment_followups ENABLE ROW LEVEL SECURITY;

-- 2. Extra-class charges are payments too (stage 'Extra', several per enrollment, one per missed class).
ALTER TABLE payments DROP CONSTRAINT payments_stage_check;
ALTER TABLE payments ADD CONSTRAINT payments_stage_check CHECK (stage IN ('Advance', 'Final', 'Extra'));
ALTER TABLE payments DROP CONSTRAINT payments_enrollment_id_stage_key;
CREATE UNIQUE INDEX ux_payments_plan_stage ON payments(enrollment_id, stage) WHERE stage IN ('Advance', 'Final');
ALTER TABLE payments ADD COLUMN class_id INTEGER REFERENCES classes(id);
CREATE UNIQUE INDEX ux_payments_extra_class ON payments(class_id) WHERE class_id IS NOT NULL;

-- 3. Renewals: the next course is saved as 'Upcoming' and starts when the current one finishes.
ALTER TABLE enrollments DROP CONSTRAINT enrollments_status_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check CHECK (status IN ('Active', 'Upcoming', 'Completed', 'Paused', 'Cancelled'));
ALTER TABLE enrollments ADD COLUMN renewal_of INTEGER REFERENCES enrollments(id);
CREATE UNIQUE INDEX ux_enrollments_renewal_of ON enrollments(renewal_of) WHERE renewal_of IS NOT NULL;

-- 4. Missed classes: did the family (Student Absent) or the teacher (Teacher Absent) give notice?
--    NULL = not recorded (classes marked before this change).
ALTER TABLE classes ADD COLUMN absence_notice TEXT CHECK (absence_notice IS NULL OR absence_notice IN ('Yes', 'No'));

-- 5. Teacher pay: monthly salary for Regular teachers (NULL = the default rate in Settings).
ALTER TABLE teachers ADD COLUMN monthly_salary INTEGER CHECK (monthly_salary IS NULL OR monthly_salary >= 0);
