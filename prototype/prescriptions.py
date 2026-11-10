"""Store prescription instructions separately from administration records."""

from hmac import compare_digest
import re
import secrets
from unicodedata import category

from outpatient import form_signature
from patients import REQUEST_KEY


ACTION = "prescription-order"
FIELD_NAMES = ("drug", "dose", "unit", "directions", "days")


class OrderConflict(Exception):
    """A submitted form was reused with different prescription data."""


def initialize_orders(connection):
    connection.execute(
        """
        CREATE TABLE prescription_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            visit_id INTEGER NOT NULL REFERENCES outpatient_visits(id),
            drug TEXT NOT NULL CHECK (length(trim(drug)) > 0),
            dose TEXT NOT NULL,
            unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
            directions TEXT NOT NULL CHECK (length(trim(directions)) > 0),
            days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 9999),
            ordered_by TEXT NOT NULL,
            ordered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            request_key TEXT NOT NULL UNIQUE
        )
        """
    )
    connection.execute("CREATE INDEX prescription_orders_visit ON prescription_orders (visit_id, id)")


def order_signature(connection, nonce, visit_id, patient_id, actor_id):
    return form_signature(connection, f"prescription:{nonce}:{visit_id}", patient_id, actor_id)


def new_key(connection, visit_id, patient_id, actor_id):
    nonce = secrets.token_urlsafe(32)
    return f"{nonce}.{order_signature(connection, nonce, visit_id, patient_id, actor_id)}"


def valid_key(connection, key, visit_id, patient_id, actor_id):
    nonce, _, signature = key.partition(".")
    return (
        REQUEST_KEY.fullmatch(nonce) is not None
        and len(signature) == 64
        and signature.isascii()
        and compare_digest(signature, order_signature(connection, nonce, visit_id, patient_id, actor_id))
    )


def validate_order(drug, dose, unit, directions, days):
    drug, dose, unit, directions, days = (value.strip() for value in (drug, dose, unit, directions, days))
    for value, label, limit in (
        (drug, "薬剤名", 100), (unit, "単位", 30), (directions, "用法", 200),
    ):
        if not 1 <= len(value) <= limit or any(category(char) == "Cc" for char in value):
            raise ValueError(f"{label}を1〜{limit}文字で入力してください。")
    if not re.fullmatch(r"[0-9]{1,9}(?:\.[0-9]{1,6})?", dose) or not dose.strip("0."):
        raise ValueError("用量は正の数で入力してください（整数9桁、小数6桁まで）。")
    if not re.fullmatch(r"[0-9]{1,4}", days) or int(days) == 0:
        raise ValueError("日数は1〜9999の整数で入力してください。")
    return drug, dose, unit, directions, int(days)


def register_order(connection, visit_id, order, actor_id, key):
    existing = connection.execute(
        """SELECT visit_id, drug, dose, unit, directions, days, ordered_by
        FROM prescription_orders WHERE request_key = ?""",
        (key,),
    ).fetchone()
    if existing is not None:
        if existing != (visit_id, *order, actor_id):
            raise OrderConflict
        return False
    connection.execute(
        """INSERT INTO prescription_orders
        (visit_id, drug, dose, unit, directions, days, ordered_by, request_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (visit_id, *order, actor_id, key),
    )
    return True


def list_orders(connection, visit_id):
    return connection.execute(
        """SELECT drug, dose, unit, directions, days, ordered_by, ordered_at
        FROM prescription_orders WHERE visit_id = ? ORDER BY id""",
        (visit_id,),
    ).fetchall()
