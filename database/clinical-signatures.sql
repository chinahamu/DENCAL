CREATE TABLE clinical_revision_signatures (
    encounter_id INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    cms_der BLOB NOT NULL CHECK (length(cms_der) BETWEEN 1 AND 262144),
    request_der BLOB NOT NULL CHECK (length(request_der) BETWEEN 1 AND 262144),
    response_der BLOB NOT NULL CHECK (length(response_der) BETWEEN 1 AND 262144),
    signer_fingerprint TEXT NOT NULL CHECK (length(signer_fingerprint) = 64),
    timestamp_utc TEXT NOT NULL,
    PRIMARY KEY (encounter_id, revision),
    FOREIGN KEY (encounter_id, revision) REFERENCES clinical_note_revisions(encounter_id, revision)
);

CREATE TRIGGER clinical_signature_no_update
BEFORE UPDATE ON clinical_revision_signatures
BEGIN
    SELECT RAISE(ABORT, 'clinical signature is immutable');
END;

CREATE TRIGGER clinical_signature_no_delete
BEFORE DELETE ON clinical_revision_signatures
BEGIN
    SELECT RAISE(ABORT, 'clinical signature is immutable');
END;

CREATE TRIGGER clinical_signature_no_replace
BEFORE INSERT ON clinical_revision_signatures
WHEN EXISTS (
    SELECT 1 FROM clinical_revision_signatures
    WHERE encounter_id = NEW.encounter_id AND revision = NEW.revision
)
BEGIN
    SELECT RAISE(ABORT, 'clinical signature already exists');
END;
