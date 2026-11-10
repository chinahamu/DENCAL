"""Initialize a fresh DENCAL SQLite database without overwriting an existing file."""

import argparse
from contextlib import closing
from hashlib import scrypt
import os
from pathlib import Path
import secrets
import sqlite3


DEMO_STAFF = (
    ("demo-admin", "デモ管理者", "admin"),
    ("demo-physician", "デモ医師", "physician"),
    ("demo-nurse", "デモ看護師", "nurse"),
    ("demo-reception", "デモ受付", "reception"),
)


def seed_demo_staff(connection):
    credentials = []
    with connection:
        for code, name, role in DEMO_STAFF:
            password = secrets.token_urlsafe(18)
            salt = secrets.token_bytes(16)
            digest = scrypt(password.encode(), salt=salt, n=32768, r=8, p=3, dklen=32, maxmem=64 * 1024 * 1024)
            cursor = connection.execute(
                "INSERT INTO staff(staff_code, display_name, role) VALUES (?, ?, ?)", (code, name, role)
            )
            connection.execute(
                "INSERT INTO staff_credentials(staff_id, salt, password_hash) VALUES (?, ?, ?)",
                (cursor.lastrowid, salt, digest),
            )
            credentials.append((code, password))
    return credentials


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, nargs="?", default=Path("data/dencal.sqlite3"))
    path = parser.parse_args().database
    if path.suffix != ".sqlite3":
        parser.error("DBファイルの拡張子には .sqlite3 を指定してください。")
    schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    except FileExistsError:
        parser.exit(1, f"既存DBの上書きを拒否しました。別のファイル名を指定してください。\n")
    try:
        with closing(sqlite3.connect(path)) as connection:
            connection.executescript(schema)
            credentials = seed_demo_staff(connection)
    except Exception:
        path.unlink()
        raise
    print(f"SQLite DBを初期化しました。 {path}")
    print("デモ用の職員IDとパスワード（この初期化時のみ表示）")
    for code, password in credentials:
        print(f"{code} {password}")


if __name__ == "__main__":
    main()
