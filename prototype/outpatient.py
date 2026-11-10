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


PAGE_SIZE = 50
_VISIT_PATIENTS = """
    SELECT outpatient_visits.id, patients.id, patients.name, patients.birth_date
    FROM outpatient_visits JOIN patients ON patients.id = outpatient_visits.patient_id
    WHERE outpatient_visits.department = ? AND outpatient_visits.visit_date = ?
"""


def parse_visit_id(value):
    if not (1 <= len(value) <= 19 and value.isascii() and value.isdecimal()):
        raise ValueError("受診IDの形式が正しくありません。")
    visit_id = int(value)
    if not 1 <= visit_id <= 2**63 - 1:
        raise ValueError("受診IDの形式が正しくありません。")
    return visit_id


def list_visits(connection, department, visit_date, after_id):
    return connection.execute(
        _VISIT_PATIENTS + " AND outpatient_visits.id > ? ORDER BY outpatient_visits.id LIMIT ?",
        (department, visit_date, after_id, PAGE_SIZE + 1),
    ).fetchall()


def find_visit(connection, department, visit_date, visit_id):
    return connection.execute(
        _VISIT_PATIENTS + " AND outpatient_visits.id = ?",
        (department, visit_date, visit_id),
    ).fetchone()
