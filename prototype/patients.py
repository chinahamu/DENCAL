"""Register and find prototype patients by stable patient numbers."""

from datetime import date
import re
from unicodedata import category


SEARCH_LIMIT = 50
PATIENT_NUMBER = re.compile(r"P[0-9]{8,19}", re.IGNORECASE | re.ASCII)
REQUEST_KEY = re.compile(r"[A-Za-z0-9_-]{43}")


class RegistrationConflict(Exception):
    """A registration key was already used by a different submission."""


def initialize_patients(connection):
    connection.execute(
        """
        CREATE TABLE patients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            birth_date TEXT NOT NULL,
            registered_by TEXT NOT NULL,
            registration_key TEXT NOT NULL UNIQUE
        )
        """
    )


def validate_registration(name, birth_date, registration_key):
    if not REQUEST_KEY.fullmatch(registration_key):
        raise ValueError("登録画面を開き直してから送信してください。")
    if not 1 <= len(name.strip()) <= 100 or any(category(char) == "Cc" for char in name):
        raise ValueError("氏名は制御文字を含まない1〜100文字で入力してください。")
    validate_birth_date(birth_date)
    return name.strip(), birth_date


def validate_birth_date(birth_date):
    try:
        birthday = date.fromisoformat(birth_date)
    except ValueError:
        raise ValueError("有効な生年月日を入力してください。") from None
    if birthday.isoformat() != birth_date or birthday > date.today():
        raise ValueError("有効な生年月日を入力してください。")


def patient_number(patient_id):
    return f"P{patient_id:08d}"


def register(connection, *, name, birth_date, actor_id, registration_key):
    """Return the patient number and whether this transaction created it."""
    existing = connection.execute(
        """SELECT id, name, birth_date, registered_by
        FROM patients WHERE registration_key = ?""",
        (registration_key,),
    ).fetchone()
    if existing is not None:
        patient_id, *original = existing
        if tuple(original) != (name, birth_date, actor_id):
            raise RegistrationConflict
        return patient_number(patient_id), False

    cursor = connection.execute(
        """INSERT INTO patients (name, birth_date, registered_by, registration_key)
        VALUES (?, ?, ?, ?)""",
        (name, birth_date, actor_id, registration_key),
    )
    return patient_number(cursor.lastrowid), True


def search_criteria(number, name, birth_date):
    number, name, birth_date = number.strip(), name.strip(), birth_date.strip()
    if not (number or name or birth_date):
        raise ValueError("検索条件がありません。")
    patient_id = None
    if number:
        if not PATIENT_NUMBER.fullmatch(number):
            raise ValueError("患者番号の形式が正しくありません。")
        patient_id = int(number[1:])
        if not 1 <= patient_id <= 2**63 - 1 or patient_number(patient_id) != number.upper():
            raise ValueError("患者番号の形式が正しくありません。")
    if len(name) > 100 or any(category(char) == "Cc" for char in name):
        raise ValueError("氏名の形式が正しくありません。")
    if birth_date:
        validate_birth_date(birth_date)
    return patient_id, name, birth_date


def search(connection, patient_id, name, birth_date):
    conditions, parameters = [], []
    for value, condition in (
        (patient_id, "id = ?"),
        (name, "instr(name, ?) > 0"),
        (birth_date, "birth_date = ?"),
    ):
        if value:
            conditions.append(condition)
            parameters.append(value)
    if not conditions:
        raise ValueError("検索条件がありません。")
    where = " AND ".join(conditions)
    return connection.execute(
        f"SELECT id, name, birth_date FROM patients WHERE {where} ORDER BY id LIMIT ?",
        (*parameters, SEARCH_LIMIT + 1),
    ).fetchall()
