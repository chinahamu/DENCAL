"""Persist one versioned clinical-note draft per outpatient visit."""

from hmac import compare_digest
from typing import NamedTuple
from unicodedata import category

from outpatient import form_signature


MAX_DRAFT_LENGTH = 2000
ACTION = "clinical-note-draft-save"
REVIEW_ACTION = "clinical-note-finalize-review"
FINALIZE_ACTION = "clinical-note-finalize"


class Draft(NamedTuple):
    body: str
    version: int
    saved_by: str
    created_at: str
    created_at_estimated: bool
    finalized_by: str | None
    finalized_at: str | None


def initialize_drafts(connection):
    connection.execute(
        """
        CREATE TABLE clinical_note_drafts (
            visit_id INTEGER PRIMARY KEY REFERENCES outpatient_visits(id),
            body TEXT NOT NULL,
            version INTEGER NOT NULL CHECK (version > 0),
            saved_by TEXT NOT NULL,
            saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
        """
    )


def initialize_finalization(connection):
    connection.execute("ALTER TABLE clinical_note_drafts ADD COLUMN created_at TEXT")
    connection.execute(
        "ALTER TABLE clinical_note_drafts ADD COLUMN created_at_estimated INTEGER NOT NULL DEFAULT 0"
    )
    connection.execute("UPDATE clinical_note_drafts SET created_at = saved_at, created_at_estimated = 1")
    connection.execute("ALTER TABLE clinical_note_drafts ADD COLUMN finalized_by TEXT")
    connection.execute("ALTER TABLE clinical_note_drafts ADD COLUMN finalized_at TEXT")


def read_draft(connection, visit_id):
    row = connection.execute(
        """SELECT body, version, saved_by, created_at, created_at_estimated, finalized_by, finalized_at
        FROM clinical_note_drafts WHERE visit_id = ?""",
        (visit_id,),
    ).fetchone()
    return Draft(*row) if row is not None else None


def draft_key(connection, visit_id, patient_id, version, actor_id, *, finalize=False):
    scope = "clinical-note-finalize" if finalize else "clinical-note"
    return form_signature(connection, f"{scope}:{visit_id}:{version}", patient_id, actor_id)


def valid_key(connection, key, visit_id, patient_id, version, actor_id, *, finalize=False):
    return len(key) == 64 and key.isascii() and compare_digest(
        key, draft_key(connection, visit_id, patient_id, version, actor_id, finalize=finalize)
    )


def validate_body(body):
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    if not body.strip() or len(body) > MAX_DRAFT_LENGTH:
        raise ValueError(f"下書きの本文を1〜{MAX_DRAFT_LENGTH}文字で入力してください。")
    if any(category(char) == "Cc" and char not in "\n\t" for char in body):
        raise ValueError("本文に使用できない制御文字が含まれています。")
    return body


def save_draft(connection, visit_id, body, version, actor_id):
    if version == 0:
        result = connection.execute(
            """INSERT INTO clinical_note_drafts (visit_id, body, version, saved_by, created_at)
            VALUES (?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(visit_id) DO NOTHING""",
            (visit_id, body, actor_id),
        )
    else:
        result = connection.execute(
            """UPDATE clinical_note_drafts
            SET body = ?, version = version + 1, saved_by = ?,
                saved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE visit_id = ? AND version = ? AND finalized_at IS NULL""",
            (body, actor_id, visit_id, version),
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
