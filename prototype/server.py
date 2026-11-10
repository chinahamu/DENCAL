"""Start the local DENCAL prototype and initialize its SQLite database."""

import argparse
from contextlib import closing
from html import escape
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sqlite3


HOST = "127.0.0.1"
SCHEMA_VERSION = 1


def database_metadata(connection):
    row = connection.execute(
        "SELECT schema_version, initialized_at FROM prototype_metadata WHERE id = 1"
    ).fetchone()
    if row is None:
        raise ValueError("初期化情報が見つかりません。")
    version, initialized_at = row
    if version != SCHEMA_VERSION:
        raise ValueError(f"対応していないスキーマ版です（検出値 {version}）。")
    return version, initialized_at


def initialize_database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS prototype_metadata (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                schema_version INTEGER NOT NULL,
                initialized_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT INTO prototype_metadata (id, schema_version, initialized_at)
            VALUES (1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(id) DO NOTHING
            """,
            (SCHEMA_VERSION,),
        )
        database_metadata(connection)


class PrototypeServer(ThreadingHTTPServer):
    def __init__(self, address, database):
        self.database = database
        self.page = Path(__file__).with_name("index.html").read_text(encoding="utf-8")
        super().__init__(address, PrototypeHandler)


class PrototypeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        try:
            uri = self.server.database.as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as connection:
                version, initialized_at = database_metadata(connection)
        except (sqlite3.Error, ValueError) as error:
            self.log_error("データベース読み取りエラー: %s", error)
            self.send_page(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "データベースを読み取れません。起動端末のログを確認してください。",
            )
            return

        self.send_page(
            HTTPStatus.OK,
            f"利用可能（スキーマ版 {version}、初期化日時 {initialized_at}）",
        )

    def send_page(self, status, database_status):
        body = self.server.page.replace("{{database_status}}", escape(database_status))
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser(description="DENCALの単体PC向け試作を起動します。")
    parser.add_argument("--db", type=Path, default=Path("data/dencal.sqlite3"))
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port は 0〜65535 を指定してください。")

    try:
        database = args.db.resolve()
        initialize_database(database)
    except (OSError, RuntimeError, sqlite3.Error, ValueError) as error:
        parser.exit(1, f"データベース初期化エラー（{args.db}）: {error}\n")

    try:
        server = PrototypeServer((HOST, args.port), database)
    except OSError as error:
        parser.exit(1, f"試作サーバー起動エラー（{HOST}:{args.port}）: {error}\n")

    with server:
        print(f"DENCAL 試作版: http://{HOST}:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nDENCALを停止しました。")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
