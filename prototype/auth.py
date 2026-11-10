"""SQLite-backed staff accounts and sessions for the local prototype."""

from contextlib import closing
from getpass import GetPassWarning, getpass
from hashlib import scrypt, sha256
from hmac import compare_digest
import re
import secrets
import sqlite3
from time import time
import warnings


SESSION_SECONDS = 30 * 60
MAX_PASSWORD_BYTES = 256
STAFF_ID = re.compile(r"[A-Za-z0-9_-]{1,40}")


def initialize_auth(connection):
    connection.execute(
        """CREATE TABLE staff (
            id TEXT PRIMARY KEY,
            salt BLOB NOT NULL,
            password_hash BLOB NOT NULL,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        )"""
    )
    connection.execute(
        """CREATE TABLE staff_sessions (
            token_hash BLOB PRIMARY KEY,
            staff_id TEXT NOT NULL REFERENCES staff(id),
            expires_at INTEGER NOT NULL
        )"""
    )
    connection.execute("CREATE INDEX staff_sessions_staff_id ON staff_sessions(staff_id)")


def connect(database):
    return sqlite3.connect(database.as_uri() + "?mode=rw", uri=True)


def password_hash(password, salt):
    return scrypt(
        password, salt=salt, n=2**17, r=8, p=1, dklen=32, maxmem=256 * 1024**2
    )


def add_staff(database, staff_id):
    if not STAFF_ID.fullmatch(staff_id):
        raise ValueError("職員IDは半角英数字・ハイフン・下線の1〜40文字を指定してください。")
    with warnings.catch_warnings():
        warnings.simplefilter("error", GetPassWarning)
        password = getpass("架空職員のパスワード: ")
        confirmation = getpass("パスワード（確認）: ")
    encoded = password.encode("utf-8")
    if len(password) < 15 or len(encoded) > MAX_PASSWORD_BYTES:
        raise ValueError("パスワードは15文字以上、UTF-8で256バイト以下にしてください。")
    if password != confirmation:
        raise ValueError("確認用パスワードが一致しません。")
    salt = secrets.token_bytes(16)
    digest = password_hash(encoded, salt)
    with closing(connect(database)) as connection, connection:
        cursor = connection.execute(
            """INSERT INTO staff (id, salt, password_hash) VALUES (?, ?, ?)
            ON CONFLICT(id) DO NOTHING""",
            (staff_id, salt, digest),
        )
        if cursor.rowcount != 1:
            raise ValueError("その職員IDは既に登録されています。")


def disable_staff(database, staff_id):
    with closing(connect(database)) as connection, connection:
        cursor = connection.execute("UPDATE staff SET active = 0 WHERE id = ?", (staff_id,))
        if cursor.rowcount != 1:
            raise ValueError("指定した職員IDが見つかりません。")
        connection.execute("DELETE FROM staff_sessions WHERE staff_id = ?", (staff_id,))


def start_session(database, staff_id, password):
    encoded = password.encode("utf-8")
    if not STAFF_ID.fullmatch(staff_id) or not 0 < len(encoded) <= MAX_PASSWORD_BYTES:
        return None
    with closing(connect(database)) as connection, connection:
        row = connection.execute(
            "SELECT salt, password_hash, active FROM staff WHERE id = ?", (staff_id,)
        ).fetchone()
        # Unknown and disabled IDs still perform the same password derivation.
        salt, expected, active = row if row else (bytes(16), bytes(32), 0)
        if not compare_digest(password_hash(encoded, salt), expected) or not active:
            return None

        token = secrets.token_urlsafe(32)
        now = int(time())
        connection.execute("DELETE FROM staff_sessions WHERE expires_at <= ?", (now,))
        # Recheck active status while writing to serialize against account disablement.
        cursor = connection.execute(
            """INSERT INTO staff_sessions (token_hash, staff_id, expires_at)
            SELECT ?, id, ? FROM staff WHERE id = ? AND active = 1""",
            (sha256(token.encode("ascii")).digest(), now + SESSION_SECONDS, staff_id),
        )
        return token if cursor.rowcount == 1 else None


def session_staff(connection, token):
    row = connection.execute(
        """SELECT staff.id FROM staff_sessions JOIN staff ON staff.id = staff_sessions.staff_id
        WHERE token_hash = ? AND expires_at > ? AND staff.active = 1""",
        (sha256(token.encode("ascii")).digest(), int(time())),
    ).fetchone()
    return row[0] if row else None


def end_session(database, token):
    with closing(connect(database)) as connection, connection:
        connection.execute(
            "DELETE FROM staff_sessions WHERE token_hash = ?",
            (sha256(token.encode("ascii")).digest(),),
        )
