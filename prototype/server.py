"""Start the local DENCAL prototype and initialize its SQLite database."""

import argparse
from contextlib import closing
from getpass import GetPassWarning
from html import escape
from http.cookies import CookieError, SimpleCookie
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sqlite3
from threading import Lock
from time import monotonic
from urllib.parse import parse_qs

import auth


HOST = "127.0.0.1"
SCHEMA_VERSION = 2
SESSION_COOKIE = "dencal_session"
COOKIE_OPTIONS = "Path=/; HttpOnly; SameSite=Strict"
SESSION_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
LOGIN_FORM = """
    <section aria-labelledby="login-heading">
      <h2 id="login-heading">職員ログイン</h2>
      <p>{{message}}</p>
      <form action="/login" method="post">
        <label>職員ID <input name="staff_id" autocomplete="username" required maxlength="40"></label>
        <label>パスワード <input type="password" name="password" autocomplete="current-password"
                                required maxlength="256"></label>
        <button>ログイン</button>
      </form>
    </section>
"""


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
            VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(id) DO NOTHING
            """
        )
        version = connection.execute(
            "SELECT schema_version FROM prototype_metadata WHERE id = 1"
        ).fetchone()[0]
        if version == 1:
            auth.initialize_auth(connection)
            connection.execute(
                "UPDATE prototype_metadata SET schema_version = ? WHERE id = 1",
                (SCHEMA_VERSION,),
            )
        database_metadata(connection)


class PrototypeServer(ThreadingHTTPServer):
    def __init__(self, address, database):
        self.database = database
        self.login_lock = Lock()
        self.login_failures = 0
        self.login_window_until = 0
        self.page = Path(__file__).with_name("index.html").read_text(encoding="utf-8")
        super().__init__(address, PrototypeHandler)
        self.authority = HOST if self.server_port == 80 else f"{HOST}:{self.server_port}"
        self.origin = f"http://{self.authority}"


class PrototypeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not self.is_local_request():
            return
        if self.path == "/login":
            self.send_login()
            return
        if self.path != "/":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        token = self.session_token()
        if token is None:
            self.redirect("/login")
            return
        try:
            uri = self.server.database.as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as connection:
                staff_id = auth.session_staff(connection, token)
                if staff_id is None:
                    self.redirect("/login")
                    return
                version, initialized_at = database_metadata(connection)
        except (sqlite3.Error, ValueError) as error:
            self.database_error(error)
            return

        self.send_page(HTTPStatus.OK, f"""
            <section aria-labelledby="database-heading">
              <h2 id="database-heading">データベースの状態</h2>
              <p>利用可能（スキーマ版 {version}、初期化日時 {escape(initialized_at)}）</p>
              <p>ログイン中の職員ID　{escape(staff_id)}</p>
              <form action="/logout" method="post"><button>ログアウト</button></form>
            </section>
        """)

    def do_POST(self):
        if not self.is_local_request():
            return
        if self.path not in ("/login", "/logout"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if self.headers.get_all("Origin") != [self.server.origin]:
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        try:
            if self.path == "/logout":
                token = self.session_token()
                if token:
                    auth.end_session(self.server.database, token)
                self.redirect("/login", f"{SESSION_COOKIE}=; Max-Age=0; {COOKIE_OPTIONS}")
                return
            self.login()
        except (sqlite3.Error, ValueError) as error:
            self.database_error(error)

    def is_local_request(self):
        if self.headers.get_all("Host") == [self.server.authority]:
            return True
        self.send_error(HTTPStatus.FORBIDDEN)
        return False

    def session_token(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
        except CookieError:
            return None
        token = cookie[SESSION_COOKIE].value if SESSION_COOKIE in cookie else ""
        return token if SESSION_TOKEN.fullmatch(token) else None

    def login(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError
            if self.headers.get_content_type() != "application/x-www-form-urlencoded":
                raise ValueError
            fields = parse_qs(
                self.rfile.read(length).decode("ascii"), errors="strict", max_num_fields=2
            )
            staff_id, = fields["staff_id"]
            password, = fields["password"]
        except (KeyError, ValueError):
            self.send_login(HTTPStatus.BAD_REQUEST, "職員IDとパスワードを入力してください。")
            return

        server = self.server
        if not server.login_lock.acquire(blocking=False):
            self.send_login(HTTPStatus.TOO_MANY_REQUESTS, "少し待ってからログインしてください。")
            return
        try:
            now = monotonic()
            if now >= server.login_window_until:
                server.login_window_until = now + 60
                server.login_failures = 0
            if server.login_failures >= 10:
                self.send_login(HTTPStatus.TOO_MANY_REQUESTS, "時間をおいて再度ログインしてください。")
                return
            token = auth.start_session(server.database, staff_id, password)
            if token is None:
                server.login_failures += 1
        finally:
            server.login_lock.release()

        if token is None:
            self.send_login(HTTPStatus.UNAUTHORIZED, "職員IDまたはパスワードを確認してください。")
            return
        self.redirect("/", f"{SESSION_COOKIE}={token}; Max-Age={auth.SESSION_SECONDS}; {COOKIE_OPTIONS}")

    def database_error(self, error):
        self.log_error("データベースエラー: %s", error)
        self.send_page(
            HTTPStatus.SERVICE_UNAVAILABLE,
            "<p>データベースを利用できません。起動端末のログを確認してください。</p>",
        )

    def send_login(self, status=HTTPStatus.OK, message=""):
        self.send_page(status, LOGIN_FORM.replace("{{message}}", escape(message)))

    def redirect(self, location, cookie=None):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def send_page(self, status, content):
        payload = self.server.page.replace("{{content}}", content).encode("utf-8")
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
    staff_commands = parser.add_mutually_exclusive_group()
    staff_commands.add_argument("--add-staff", metavar="ID", help="架空の職員を登録する")
    staff_commands.add_argument("--disable-staff", metavar="ID", help="職員を無効化して全セッションを失効する")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port は 0〜65535 を指定してください。")

    try:
        database = args.db.resolve()
        initialize_database(database)
    except (OSError, RuntimeError, sqlite3.Error, ValueError) as error:
        parser.exit(1, f"データベース初期化エラー（{args.db}）: {error}\n")

    if args.add_staff is not None or args.disable_staff is not None:
        try:
            if args.add_staff is not None:
                auth.add_staff(database, args.add_staff)
                print("架空の職員を登録しました。")
            else:
                auth.disable_staff(database, args.disable_staff)
                print("職員を無効化し、セッションを失効しました。")
        except (GetPassWarning, EOFError, KeyboardInterrupt):
            parser.exit(1, "職員登録を中止しました。パスワードは対話端末から入力してください。\n")
        except (sqlite3.Error, ValueError) as error:
            parser.exit(1, f"職員設定エラー: {error}\n")
        return 0

    try:
        server = PrototypeServer((HOST, args.port), database)
    except OSError as error:
        parser.exit(1, f"試作サーバー起動エラー（{HOST}:{args.port}）: {error}\n")

    with server:
        print(f"DENCAL 試作版: {server.origin}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nDENCALを停止しました。")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
