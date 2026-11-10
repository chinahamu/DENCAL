"""Persist one versioned clinical-note draft per outpatient visit."""

from hmac import compare_digest
from unicodedata import category

from outpatient import form_signature


MAX_DRAFT_LENGTH = 2000
ACTION = "clinical-note-draft-save"


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


def read_draft(connection, visit_id):
    row = connection.execute(
        "SELECT body, version FROM clinical_note_drafts WHERE visit_id = ?", (visit_id,)
    ).fetchone()
    return row if row is not None else ("", 0)


def draft_key(connection, visit_id, patient_id, version, actor_id):
    # The prefix separates draft signatures from outpatient check-in nonces.
    return form_signature(connection, f"clinical-note:{visit_id}:{version}", patient_id, actor_id)


def valid_key(connection, key, visit_id, patient_id, version, actor_id):
    return len(key) == 64 and key.isascii() and compare_digest(
        key, draft_key(connection, visit_id, patient_id, version, actor_id)
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
            """INSERT INTO clinical_note_drafts (visit_id, body, version, saved_by)
            VALUES (?, ?, 1, ?) ON CONFLICT(visit_id) DO NOTHING""",
            (visit_id, body, actor_id),
        )
    else:
        result = connection.execute(
            """UPDATE clinical_note_drafts
            SET body = ?, version = version + 1, saved_by = ?,
                saved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE visit_id = ? AND version = ?""",
            (body, actor_id, visit_id, version),
        )
    return result.rowcount == 1
