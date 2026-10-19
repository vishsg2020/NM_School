-- Class and course feedback.

-- Teacher's quick rating of the student in each class (1–5) and a note the parent sees on the feedback page.
ALTER TABLE classes ADD COLUMN rating_participation SMALLINT CHECK (rating_participation BETWEEN 1 AND 5);
ALTER TABLE classes ADD COLUMN rating_homework      SMALLINT CHECK (rating_homework BETWEEN 1 AND 5);
ALTER TABLE classes ADD COLUMN rating_progress      SMALLINT CHECK (rating_progress BETWEEN 1 AND 5);
ALTER TABLE classes ADD COLUMN parent_note          TEXT;

-- Teacher's end-of-course report on the student.
ALTER TABLE enrollments ADD COLUMN final_report     TEXT;
ALTER TABLE enrollments ADD COLUMN next_level       TEXT;
ALTER TABLE enrollments ADD COLUMN final_report_by  INTEGER REFERENCES users(id);
ALTER TABLE enrollments ADD COLUMN final_report_at  TEXT;

-- One feedback link (no login) per class or per completed course, and the parent's answer.
CREATE TABLE feedback (
  id               SERIAL PRIMARY KEY,
  token            TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('class', 'course')),
  class_id         INTEGER REFERENCES classes(id),
  enrollment_id    INTEGER NOT NULL REFERENCES enrollments(id),
  teacher_id       INTEGER NOT NULL REFERENCES teachers(id),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT now_iso(),
  expires_at       TEXT NOT NULL,
  submitted_at     TEXT,
  rating           SMALLINT CHECK (rating BETWEEN 1 AND 5),           -- class: overall
  teacher_rating   SMALLINT CHECK (teacher_rating BETWEEN 1 AND 5),   -- course
  content_rating   SMALLINT CHECK (content_rating BETWEEN 1 AND 5),   -- course
  progress_rating  SMALLINT CHECK (progress_rating BETWEEN 1 AND 5),  -- course
  nps              SMALLINT CHECK (nps BETWEEN 0 AND 10),             -- course: how likely to recommend
  continue_choice  TEXT CHECK (continue_choice IS NULL OR continue_choice IN ('Yes', 'Maybe', 'No')),
  tags             TEXT,
  comment          TEXT,
  CHECK ((kind = 'class') = (class_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_feedback_class ON feedback(class_id) WHERE kind = 'class';
CREATE UNIQUE INDEX ux_feedback_course ON feedback(enrollment_id) WHERE kind = 'course';
CREATE INDEX ix_feedback_teacher ON feedback(teacher_id, submitted_at);
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
