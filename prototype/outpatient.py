"""Store outpatient check-ins and bind each submission to its selected patient."""

from datetime import date
from hashlib import sha256
from hmac import compare_digest, digest
import secrets

from patients import REQUEST_KEY


DEPARTMENTS = {"internal-medicine": "内科", "surgery": "外科"}
ACTION = "outpatient-check-in"


class CheckInConflict(Exception):
    """A previously saved form was submitted with different visit data."""


def initialize_outpatient(connection):
    connection.execute("ALTER TABLE prototype_metadata ADD COLUMN outpatient_form_secret BLOB")
    connection.execute(
        "UPDATE prototype_metadata SET outpatient_form_secret = ? WHERE id = 1",
        (secrets.token_bytes(32),),
    )
    connection.execute(
        """
        CREATE TABLE outpatient_visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id INTEGER NOT NULL REFERENCES patients(id),
            department TEXT NOT NULL CHECK (department IN ('internal-medicine', 'surgery')),
            visit_date TEXT NOT NULL,
            checked_in_by TEXT NOT NULL,
            request_key TEXT NOT NULL UNIQUE
        )
        """
    )


def form_signature(connection, nonce, patient_id, actor_id):
    secret, = connection.execute(
        "SELECT outpatient_form_secret FROM prototype_metadata WHERE id = 1"
    ).fetchone()
    message = f"{nonce}:{patient_id}:{actor_id}".encode("ascii")
    return digest(secret, message, sha256).hex()


def new_form_key(connection, patient_id, actor_id):
    nonce = secrets.token_urlsafe(32)
    return f"{nonce}.{form_signature(connection, nonce, patient_id, actor_id)}"


def is_valid_form_key(connection, key, patient_id, actor_id):
    nonce, separator, signature = key.partition(".")
    return (
        bool(separator)
        and REQUEST_KEY.fullmatch(nonce) is not None
        and signature.isascii()
        and compare_digest(signature, form_signature(connection, nonce, patient_id, actor_id))
    )


def validate_visit(department, visit_date):
    if department not in DEPARTMENTS:
        raise ValueError("診療科を選択してください。")
    try:
        day = date.fromisoformat(visit_date)
    except ValueError:
        raise ValueError("有効な来院日を入力してください。") from None
    if day.isoformat() != visit_date:
        raise ValueError("有効な来院日を入力してください。")


def check_in(connection, *, patient_id, department, visit_date, actor_id, key):
    existing = connection.execute(
        "SELECT id, department, visit_date FROM outpatient_visits WHERE request_key = ?", (key,)
    ).fetchone()
    if existing is not None:
        visit_id, original_department, original_date = existing
        if (original_department, original_date) != (department, visit_date):
            raise CheckInConflict
        return visit_id, False

    cursor = connection.execute(
        """INSERT INTO outpatient_visits (patient_id, department, visit_date, checked_in_by, request_key)
        VALUES (?, ?, ?, ?, ?)""",
        (patient_id, department, visit_date, actor_id, key),
    )
    return cursor.lastrowid, True
