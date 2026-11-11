ALTER TABLE master_item_catalog_details ADD COLUMN performance_selectable INTEGER
    CHECK (performance_selectable IN (0, 1));

ALTER TABLE procedure_performances RENAME TO procedure_performances_legacy;

CREATE TABLE procedure_performances (
    id INTEGER PRIMARY KEY,
    source_id TEXT NOT NULL UNIQUE,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    procedure_order_id INTEGER REFERENCES procedure_orders(id),
    master_item_id INTEGER NOT NULL,
    master_kind TEXT GENERATED ALWAYS AS ('procedure') VIRTUAL,
    performed_by INTEGER NOT NULL REFERENCES staff(id),
    performed_at TEXT NOT NULL,
    service_date TEXT,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit TEXT,
    cancelled_by INTEGER REFERENCES staff(id),
    cancelled_at TEXT,
    cancellation_reason TEXT,
    FOREIGN KEY (master_kind, master_item_id) REFERENCES master_items(kind, id),
    CHECK ((cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL)
        OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL))
);

INSERT INTO procedure_performances (id, source_id, encounter_id, procedure_order_id, master_item_id,
    performed_by, performed_at, quantity)
SELECT p.id, 'legacy-' || p.id, o.encounter_id, o.id, o.master_item_id, p.performed_by, p.performed_at, p.quantity
FROM procedure_performances_legacy p JOIN procedure_orders o ON o.id = p.procedure_order_id;

DROP TABLE procedure_performances_legacy;

CREATE INDEX procedure_performances_encounter_idx ON procedure_performances(encounter_id, id);

CREATE TABLE recept_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sender_id TEXT NOT NULL UNIQUE
);

INSERT INTO recept_identity VALUES (1, 'dencal-' || lower(hex(randomblob(16))));

CREATE TABLE recept_outbox (
    integration_id TEXT PRIMARY KEY,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    chart_revision INTEGER NOT NULL,
    transfer_revision INTEGER NOT NULL CHECK (transfer_revision > 0),
    event TEXT NOT NULL CHECK (event IN ('initial', 'correction', 'cancel')),
    payload BLOB NOT NULL CHECK (length(payload) BETWEEN 1 AND 131072),
    body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
    queued_by INTEGER NOT NULL REFERENCES staff(id),
    queued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_until INTEGER,
    receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
    last_error TEXT,
    UNIQUE (encounter_id, transfer_revision),
    FOREIGN KEY (encounter_id, chart_revision) REFERENCES clinical_note_revisions(encounter_id, revision)
);

CREATE TRIGGER recept_outbox_payload_immutable
BEFORE UPDATE OF integration_id, encounter_id, chart_revision, transfer_revision, event, payload, body_sha256, queued_by, queued_at
ON recept_outbox
BEGIN
    SELECT RAISE(ABORT, 'recept outbox payload is immutable');
END;

CREATE TRIGGER recept_outbox_no_delete BEFORE DELETE ON recept_outbox
BEGIN
    SELECT RAISE(ABORT, 'recept outbox is append-only');
END;

CREATE TRIGGER recept_outbox_no_replace BEFORE INSERT ON recept_outbox
WHEN EXISTS (SELECT 1 FROM recept_outbox WHERE integration_id = NEW.integration_id
    OR (encounter_id = NEW.encounter_id AND transfer_revision = NEW.transfer_revision))
BEGIN
    SELECT RAISE(ABORT, 'recept outbox record already exists');
END;
