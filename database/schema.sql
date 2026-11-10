PRAGMA foreign_keys = ON;
BEGIN;

CREATE TABLE departments (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
);

CREATE TABLE staff (
    id INTEGER PRIMARY KEY,
    staff_code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    department_id INTEGER REFERENCES departments(id),
    role TEXT NOT NULL CHECK (role IN ('reception', 'nurse', 'physician', 'admin')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE patients (
    id INTEGER PRIMARY KEY,
    patient_number TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    name_kana TEXT,
    sex TEXT CHECK (sex IN ('male', 'female', 'other', 'unknown')),
    birth_date TEXT NOT NULL,
    blood_type TEXT,
    phone TEXT,
    address TEXT
);
CREATE INDEX patients_name_idx ON patients(name, name_kana);

CREATE TABLE patient_insurances (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES patients(id),
    insurance_type TEXT NOT NULL,
    insurer_number TEXT,
    copay_percent INTEGER CHECK (copay_percent BETWEEN 0 AND 100),
    valid_from TEXT NOT NULL,
    valid_until TEXT CHECK (valid_until IS NULL OR valid_until >= valid_from),
    UNIQUE (patient_id, id)
);

CREATE TABLE encounters (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES patients(id),
    department_id INTEGER NOT NULL REFERENCES departments(id),
    insurance_id INTEGER,
    reception_date TEXT NOT NULL,
    reception_number TEXT NOT NULL,
    checked_in_at TEXT NOT NULL,
    checked_in_by INTEGER NOT NULL REFERENCES staff(id),
    visit_type TEXT NOT NULL CHECK (visit_type IN ('first', 'follow_up')),
    status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'in_consultation', 'billing', 'completed')),
    chief_complaint TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (patient_id, insurance_id) REFERENCES patient_insurances(patient_id, id),
    UNIQUE (department_id, reception_date, reception_number),
    UNIQUE (patient_id, id)
);
CREATE INDEX encounters_queue_idx ON encounters(reception_date, department_id, status, checked_in_at);
CREATE INDEX encounters_patient_idx ON encounters(patient_id, reception_date);

CREATE TABLE eligibility_checks (
    id INTEGER PRIMARY KEY,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    checked_at TEXT NOT NULL,
    checked_by INTEGER NOT NULL REFERENCES staff(id),
    result TEXT NOT NULL CHECK (result IN ('verified', 'unverified', 'error')),
    source_reference TEXT
);

CREATE TABLE master_releases (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('drug', 'diagnosis', 'procedure', 'lab')),
    source TEXT NOT NULL,
    release_code TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    effective_until TEXT CHECK (effective_until IS NULL OR effective_until >= effective_from),
    imported_at TEXT NOT NULL,
    file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
    UNIQUE (kind, source, release_code),
    UNIQUE (kind, id)
);

CREATE TABLE master_items (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    release_id INTEGER NOT NULL,
    code_system TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    effective_until TEXT CHECK (effective_until IS NULL OR effective_until >= effective_from),
    FOREIGN KEY (kind, release_id) REFERENCES master_releases(kind, id),
    UNIQUE (release_id, code_system, code, effective_from),
    UNIQUE (kind, id)
);
CREATE INDEX master_items_lookup_idx ON master_items(kind, code, name);

CREATE TABLE patient_alerts (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES patients(id),
    encounter_id INTEGER,
    recorded_by INTEGER NOT NULL REFERENCES staff(id),
    recorded_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('allergy', 'contraindication')),
    category TEXT NOT NULL CHECK (category IN ('drug', 'food', 'other')),
    substance TEXT NOT NULL,
    severity TEXT CHECK (severity IN ('moderate', 'severe')),
    reaction TEXT,
    FOREIGN KEY (patient_id, encounter_id) REFERENCES encounters(patient_id, id)
);

CREATE TABLE patient_diagnoses (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES patients(id),
    encounter_id INTEGER NOT NULL,
    master_kind TEXT GENERATED ALWAYS AS ('diagnosis') VIRTUAL,
    master_item_id INTEGER NOT NULL,
    code_system_snapshot TEXT NOT NULL,
    code_snapshot TEXT NOT NULL,
    name_snapshot TEXT NOT NULL,
    is_main INTEGER NOT NULL CHECK (is_main IN (0, 1)),
    start_date TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ongoing', 'cured', 'suspected')),
    outcome_date TEXT CHECK (outcome_date IS NULL OR outcome_date >= start_date),
    recorded_by INTEGER NOT NULL REFERENCES staff(id),
    FOREIGN KEY (patient_id, encounter_id) REFERENCES encounters(patient_id, id),
    FOREIGN KEY (master_kind, master_item_id) REFERENCES master_items(kind, id)
);

CREATE TABLE vital_signs (
    id INTEGER PRIMARY KEY,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    measured_at TEXT NOT NULL,
    recorded_by INTEGER NOT NULL REFERENCES staff(id),
    systolic_bp INTEGER CHECK (systolic_bp > 0),
    diastolic_bp INTEGER CHECK (diastolic_bp > 0),
    pulse INTEGER CHECK (pulse > 0),
    temperature_c REAL,
    spo2_percent REAL CHECK (spo2_percent BETWEEN 0 AND 100),
    height_cm REAL CHECK (height_cm > 0),
    weight_kg REAL CHECK (weight_kg > 0)
);
CREATE INDEX vital_signs_history_idx ON vital_signs(encounter_id, measured_at);

CREATE TABLE lab_panels (
    id INTEGER PRIMARY KEY,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    sampled_at TEXT NOT NULL,
    ordered_by INTEGER REFERENCES staff(id),
    source_reference TEXT
);

CREATE TABLE lab_results (
    id INTEGER PRIMARY KEY,
    panel_id INTEGER NOT NULL REFERENCES lab_panels(id),
    master_kind TEXT GENERATED ALWAYS AS ('lab') VIRTUAL,
    master_item_id INTEGER,
    code_snapshot TEXT,
    name_snapshot TEXT NOT NULL,
    category TEXT,
    numeric_value REAL,
    text_value TEXT,
    unit TEXT,
    reference_min REAL,
    reference_max REAL,
    CHECK (numeric_value IS NOT NULL OR text_value IS NOT NULL),
    CHECK (reference_min <= reference_max),
    FOREIGN KEY (master_kind, master_item_id) REFERENCES master_items(kind, id)
);

CREATE TABLE clinical_note_drafts (
    encounter_id INTEGER PRIMARY KEY REFERENCES encounters(id),
    version INTEGER NOT NULL CHECK (version > 0),
    subjective TEXT NOT NULL DEFAULT '',
    objective TEXT NOT NULL DEFAULT '',
    assessment TEXT NOT NULL DEFAULT '',
    plan TEXT NOT NULL DEFAULT '',
    saved_by INTEGER NOT NULL REFERENCES staff(id),
    saved_at TEXT NOT NULL
);

CREATE TABLE clinical_note_revisions (
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    previous_revision INTEGER,
    subjective TEXT NOT NULL,
    objective TEXT NOT NULL,
    assessment TEXT NOT NULL,
    plan TEXT NOT NULL,
    finalized_by INTEGER NOT NULL REFERENCES staff(id),
    finalized_at TEXT NOT NULL,
    correction_reason TEXT,
    signature_reference TEXT,
    content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
    CHECK (
        (revision = 1 AND previous_revision IS NULL)
        OR (revision > 1 AND previous_revision IS NOT NULL AND previous_revision = revision - 1
            AND correction_reason IS NOT NULL AND length(trim(correction_reason)) > 0)
    ),
    PRIMARY KEY (encounter_id, revision),
    FOREIGN KEY (encounter_id, previous_revision) REFERENCES clinical_note_revisions(encounter_id, revision)
);

CREATE TABLE prescription_orders (
    id INTEGER PRIMARY KEY,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    master_kind TEXT GENERATED ALWAYS AS ('drug') VIRTUAL,
    master_item_id INTEGER NOT NULL,
    code_system_snapshot TEXT NOT NULL,
    code_snapshot TEXT NOT NULL,
    name_snapshot TEXT NOT NULL,
    ordered_by INTEGER NOT NULL REFERENCES staff(id),
    ordered_at TEXT NOT NULL,
    dosage_per_day TEXT NOT NULL,
    usage TEXT NOT NULL,
    days INTEGER NOT NULL CHECK (days > 0),
    category TEXT NOT NULL CHECK (category IN ('internal', 'external', 'as_needed')),
    generic_allowed INTEGER NOT NULL CHECK (generic_allowed IN (0, 1)),
    FOREIGN KEY (master_kind, master_item_id) REFERENCES master_items(kind, id)
);

CREATE TABLE procedure_orders (
    id INTEGER PRIMARY KEY,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    master_kind TEXT GENERATED ALWAYS AS ('procedure') VIRTUAL,
    master_item_id INTEGER NOT NULL,
    code_system_snapshot TEXT NOT NULL,
    code_snapshot TEXT NOT NULL,
    name_snapshot TEXT NOT NULL,
    ordered_by INTEGER NOT NULL REFERENCES staff(id),
    ordered_at TEXT NOT NULL,
    FOREIGN KEY (master_kind, master_item_id) REFERENCES master_items(kind, id)
);

CREATE TABLE procedure_performances (
    id INTEGER PRIMARY KEY,
    procedure_order_id INTEGER NOT NULL REFERENCES procedure_orders(id),
    performed_by INTEGER NOT NULL REFERENCES staff(id),
    performed_at TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0)
);

CREATE TABLE note_order_snapshots (
    encounter_id INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    line_number INTEGER NOT NULL CHECK (line_number > 0),
    kind TEXT NOT NULL CHECK (kind IN ('drug', 'procedure')),
    code_system_snapshot TEXT NOT NULL,
    code_snapshot TEXT NOT NULL,
    name_snapshot TEXT NOT NULL,
    instruction_snapshot TEXT,
    PRIMARY KEY (encounter_id, revision, line_number),
    FOREIGN KEY (encounter_id, revision) REFERENCES clinical_note_revisions(encounter_id, revision)
);

CREATE TABLE billing_records (
    id INTEGER PRIMARY KEY,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    calculation_reference TEXT,
    calculated_at TEXT NOT NULL,
    copay_percent INTEGER CHECK (copay_percent BETWEEN 0 AND 100),
    copay_yen INTEGER CHECK (copay_yen >= 0),
    settled_at TEXT,
    settled_by INTEGER REFERENCES staff(id),
    CHECK ((settled_at IS NULL) = (settled_by IS NULL))
);

CREATE TABLE billing_lines (
    billing_id INTEGER NOT NULL REFERENCES billing_records(id),
    line_number INTEGER NOT NULL CHECK (line_number > 0),
    category TEXT NOT NULL,
    code_snapshot TEXT,
    name_snapshot TEXT NOT NULL,
    points INTEGER NOT NULL,
    PRIMARY KEY (billing_id, line_number)
);

CREATE TABLE receipts (
    id INTEGER PRIMARY KEY,
    billing_id INTEGER NOT NULL UNIQUE REFERENCES billing_records(id),
    receipt_number TEXT NOT NULL UNIQUE,
    issued_at TEXT NOT NULL,
    issued_by INTEGER NOT NULL REFERENCES staff(id)
);

CREATE TABLE referral_documents (
    id INTEGER PRIMARY KEY,
    encounter_id INTEGER NOT NULL,
    source_revision INTEGER NOT NULL,
    destination TEXT NOT NULL,
    reason TEXT NOT NULL,
    clinical_summary TEXT NOT NULL,
    issued_at TEXT,
    issued_by INTEGER REFERENCES staff(id),
    CHECK ((issued_at IS NULL) = (issued_by IS NULL)),
    FOREIGN KEY (encounter_id, source_revision) REFERENCES clinical_note_revisions(encounter_id, revision)
);

CREATE TABLE backup_snapshots (
    id INTEGER PRIMARY KEY,
    snapshot_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    created_by INTEGER REFERENCES staff(id),
    storage_tier TEXT NOT NULL CHECK (storage_tier IN ('primary', 'isolated', 'offline')),
    snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('hourly', 'daily', 'manual')),
    object_reference TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    cipher_spec TEXT,
    sha256_checksum TEXT NOT NULL CHECK (length(sha256_checksum) = 64),
    patient_count INTEGER NOT NULL CHECK (patient_count >= 0),
    revision_count INTEGER NOT NULL CHECK (revision_count >= 0),
    audit_log_count INTEGER NOT NULL CHECK (audit_log_count >= 0)
);

CREATE TABLE backup_checks (
    id INTEGER PRIMARY KEY,
    snapshot_id INTEGER NOT NULL REFERENCES backup_snapshots(id),
    checked_at TEXT NOT NULL,
    checked_by INTEGER REFERENCES staff(id),
    check_type TEXT NOT NULL CHECK (check_type IN ('integrity', 'restore_test')),
    outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed'))
);

CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    actor_id INTEGER REFERENCES staff(id),
    actor_role TEXT CHECK (actor_role IN ('reception', 'nurse', 'physician', 'admin')),
    action TEXT NOT NULL,
    patient_id INTEGER REFERENCES patients(id),
    encounter_id INTEGER REFERENCES encounters(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
    terminal_reference TEXT,
    integrity_sha256 TEXT CHECK (integrity_sha256 IS NULL OR length(integrity_sha256) = 64),
    FOREIGN KEY (patient_id, encounter_id) REFERENCES encounters(patient_id, id)
);
CREATE INDEX audit_events_time_idx ON audit_events(occurred_at, id);

PRAGMA user_version = 1;
COMMIT;
