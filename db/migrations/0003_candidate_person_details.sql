-- Richer candidate details (feature PT-03):
--   first/last name (student_name stays as the full name used everywhere else),
--   gender, the parent's relationship, and an optional student phone.
-- `phone` remains the main contact number: the parent's phone for a student under 18, the student's own otherwise.

ALTER TABLE candidates ADD COLUMN first_name TEXT;
ALTER TABLE candidates ADD COLUMN last_name TEXT;
ALTER TABLE candidates ADD COLUMN gender TEXT
  CHECK (gender IS NULL OR gender IN ('Male', 'Female', 'Prefer not to say'));
ALTER TABLE candidates ADD COLUMN parent_relationship TEXT
  CHECK (parent_relationship IS NULL OR parent_relationship IN ('Mother', 'Father', 'Guardian', 'Other'));
ALTER TABLE candidates ADD COLUMN student_phone TEXT;

-- Existing candidates: first word -> first name, the rest -> last name.
UPDATE candidates SET
  first_name = split_part(btrim(student_name), ' ', 1),
  last_name  = NULLIF(btrim(substr(btrim(student_name), length(split_part(btrim(student_name), ' ', 1)) + 1)), '');
