"""Persist the four SOAP fields and version history for an outpatient visit."""

from hmac import compare_digest
from typing import NamedTuple
from unicodedata import category

from outpatient import form_signature


MAX_SECTION_LENGTH = 2000
MAX_REASON_LENGTH = 500
ACTION = "clinical-note-draft-save"
REVIEW_ACTION = "clinical-note-finalize-review"
FINALIZE_ACTION = "clinical-note-finalize"
CORRECTION_ACTION = "clinical-note-correct"
SOAP_LABELS = {
    "subjective": "S　主観的情報・患者の訴え",
    "objective": "O　客観的所見・診察・検査",
    "assessment": "A　評価",
    "plan": "P　治療方針・患者指導",
}


class Soap(NamedTuple):
    subjective: str = ""
    objective: str = ""
    assessment: str = ""
    plan: str = ""


class Draft(NamedTuple):
    soap: Soap
    version: int
    saved_by: str
    created_at: str
    finalized_by: str | None
    finalized_at: str | None


class Correction(NamedTuple):
    revision: int
    soap: Soap
    reason: str
    corrected_by: str
    corrected_at: str


def initialize_notes(connection):
    connection.execute(
        """
        CREATE TABLE clinical_note_drafts (
            visit_id INTEGER PRIMARY KEY REFERENCES outpatient_visits(id),
            subjective TEXT NOT NULL,
            objective TEXT NOT NULL,
            assessment TEXT NOT NULL,
            plan TEXT NOT NULL,
            version INTEGER NOT NULL CHECK (version > 0),
            saved_by TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            finalized_by TEXT,
            finalized_at TEXT,
            CHECK ((finalized_by IS NULL) = (finalized_at IS NULL))
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE clinical_note_corrections (
            visit_id INTEGER NOT NULL REFERENCES clinical_note_drafts(visit_id),
            revision INTEGER NOT NULL CHECK (revision > 0),
            subjective TEXT NOT NULL,
            objective TEXT NOT NULL,
            assessment TEXT NOT NULL,
            plan TEXT NOT NULL,
            reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
            corrected_by TEXT NOT NULL,
            corrected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY (visit_id, revision)
        )
        """
    )


def read_draft(connection, visit_id):
    row = connection.execute(
        """SELECT subjective, objective, assessment, plan, version, saved_by,
                  created_at, finalized_by, finalized_at
        FROM clinical_note_drafts WHERE visit_id = ?""",
        (visit_id,),
    ).fetchone()
    return Draft(Soap(*row[:4]), *row[4:]) if row is not None else None


def draft_key(connection, visit_id, patient_id, version, actor_id, *, action=ACTION):
    scope = action if action in (FINALIZE_ACTION, CORRECTION_ACTION) else "clinical-note"
    return form_signature(connection, f"{scope}:{visit_id}:{version}", patient_id, actor_id)


def valid_key(connection, key, visit_id, patient_id, version, actor_id, *, action=ACTION):
    return len(key) == 64 and key.isascii() and compare_digest(
        key, draft_key(connection, visit_id, patient_id, version, actor_id, action=action)
    )


def validate_soap(soap):
    sections = Soap(*(value.replace("\r\n", "\n").replace("\r", "\n") for value in soap))
    if not any(value.strip() for value in sections):
        raise ValueError("SOAPのいずれかの欄に入力してください。")
    for label, value in zip(SOAP_LABELS.values(), sections):
        if len(value) > MAX_SECTION_LENGTH:
            raise ValueError(f"{label}は{MAX_SECTION_LENGTH}文字以下で入力してください。")
        if any(category(char) == "Cc" and char not in "\n\t" for char in value):
            raise ValueError(f"{label}に使用できない制御文字が含まれています。")
    return sections


def save_draft(connection, visit_id, soap, version, actor_id):
    if version == 0:
        result = connection.execute(
            """INSERT INTO clinical_note_drafts
            (visit_id, subjective, objective, assessment, plan, version, saved_by)
            VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(visit_id) DO NOTHING""",
            (visit_id, *soap, actor_id),
        )
    else:
        result = connection.execute(
            """UPDATE clinical_note_drafts
            SET subjective = ?, objective = ?, assessment = ?, plan = ?,
                version = version + 1, saved_by = ?,
                saved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE visit_id = ? AND version = ? AND finalized_at IS NULL""",
            (*soap, actor_id, visit_id, version),
        )
    return result.rowcount == 1


def finalize_draft(connection, visit_id, version, actor_id):
    result = connection.execute(
        """UPDATE clinical_note_drafts
        SET finalized_by = ?, finalized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE visit_id = ? AND version = ? AND finalized_at IS NULL""",
        (actor_id, visit_id, version),
    )
    return result.rowcount == 1


def read_corrections(connection, visit_id):
    return [
        Correction(row[0], Soap(*row[1:5]), *row[5:])
        for row in connection.execute(
            """SELECT revision, subjective, objective, assessment, plan,
                      reason, corrected_by, corrected_at
            FROM clinical_note_corrections WHERE visit_id = ? ORDER BY revision DESC""",
            (visit_id,),
        )
    ]


def validate_reason(reason):
    reason = reason.strip()
    if not 1 <= len(reason) <= MAX_REASON_LENGTH:
        raise ValueError(f"訂正理由を1〜{MAX_REASON_LENGTH}文字で入力してください。")
    if any(category(char) == "Cc" for char in reason):
        raise ValueError("訂正理由に使用できない制御文字が含まれています。")
    return reason


def append_correction(connection, visit_id, revision, soap, reason, actor_id):
    connection.execute(
        """INSERT INTO clinical_note_corrections
        (visit_id, revision, subjective, objective, assessment, plan, reason, corrected_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (visit_id, revision, *soap, reason, actor_id),
    )
