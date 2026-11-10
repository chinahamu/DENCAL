"""Register prototype patients and assign stable patient numbers."""

from datetime import date
import re
from unicodedata import category


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
    try:
        birthday = date.fromisoformat(birth_date)
    except ValueError:
        raise ValueError("有効な生年月日を入力してください。") from None
    if birthday.isoformat() != birth_date or birthday > date.today():
        raise ValueError("有効な生年月日を入力してください。")
    return name.strip(), birth_date


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
        return f"P{patient_id:08d}", False

    cursor = connection.execute(
        """INSERT INTO patients (name, birth_date, registered_by, registration_key)
        VALUES (?, ?, ?, ?)""",
        (name, birth_date, actor_id, registration_key),
    )
    return f"P{cursor.lastrowid:08d}", True
