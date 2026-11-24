CREATE TABLE clinical_image_blobs (
    image_id TEXT PRIMARY KEY,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    image_blob BLOB NOT NULL CHECK (length(image_blob) = byte_size),
    uploaded_by INTEGER NOT NULL REFERENCES staff(id),
    uploaded_at TEXT NOT NULL
);

CREATE INDEX clinical_image_blobs_encounter_idx ON clinical_image_blobs(encounter_id, uploaded_at);

CREATE TRIGGER clinical_image_blob_no_update
BEFORE UPDATE ON clinical_image_blobs
BEGIN
    SELECT RAISE(ABORT, 'clinical image blob is immutable');
END;

CREATE TRIGGER clinical_image_blob_no_delete
BEFORE DELETE ON clinical_image_blobs
BEGIN
    SELECT RAISE(ABORT, 'clinical image blob is immutable');
END;

CREATE TRIGGER clinical_image_blob_no_replace
BEFORE INSERT ON clinical_image_blobs
WHEN EXISTS (
    SELECT 1 FROM clinical_image_blobs
    WHERE image_id = NEW.image_id
)
BEGIN
    SELECT RAISE(ABORT, 'clinical image blob already exists');
END;

