-- Applied together with the initial demo chart import.
CREATE TABLE clinical_workspaces (
    encounter_id INTEGER PRIMARY KEY REFERENCES encounters(id),
    data_json TEXT NOT NULL CHECK (json_valid(data_json) AND json_type(data_json) = 'object')
);

ALTER TABLE clinical_note_drafts ADD COLUMN finalized_revision INTEGER NOT NULL DEFAULT 0 CHECK (finalized_revision >= 0);
ALTER TABLE clinical_note_drafts ADD COLUMN is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1));
ALTER TABLE clinical_note_drafts ADD COLUMN correction_reason TEXT;
ALTER TABLE clinical_note_drafts ADD COLUMN correction_started_by INTEGER REFERENCES staff(id);
ALTER TABLE clinical_note_drafts ADD COLUMN correction_started_at TEXT;

ALTER TABLE clinical_note_revisions ADD COLUMN content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json));

ALTER TABLE audit_events ADD COLUMN clinical_summary TEXT;

CREATE TRIGGER clinical_revision_no_update
BEFORE UPDATE ON clinical_note_revisions
BEGIN
    SELECT RAISE(ABORT, 'finalized clinical revision is immutable');
END;

CREATE TRIGGER clinical_revision_no_delete
BEFORE DELETE ON clinical_note_revisions
BEGIN
    SELECT RAISE(ABORT, 'finalized clinical revision is immutable');
END;

CREATE TRIGGER clinical_revision_no_replace
BEFORE INSERT ON clinical_note_revisions
WHEN EXISTS (
    SELECT 1 FROM clinical_note_revisions
    WHERE encounter_id = NEW.encounter_id AND revision = NEW.revision
)
BEGIN
    SELECT RAISE(ABORT, 'finalized clinical revision already exists');
END;
