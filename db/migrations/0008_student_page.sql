-- AD-02 (change 2): public student page — teacher intro/photo and a share link per enrollment.

ALTER TABLE teachers ADD COLUMN about TEXT;
ALTER TABLE teachers ADD COLUMN photo BYTEA;
ALTER TABLE teachers ADD COLUMN photo_mime TEXT CHECK (photo_mime IS NULL OR photo_mime IN ('image/jpeg', 'image/png', 'image/webp'));

-- Random code in the parent's link (/s/<code>); a new code makes the old link stop working.
ALTER TABLE enrollments ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX ux_enrollment_share_token ON enrollments(share_token) WHERE share_token IS NOT NULL;
