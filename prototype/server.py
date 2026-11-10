"""Start the local DENCAL prototype and initialize its SQLite database."""

import argparse
from contextlib import closing
from getpass import GetPassWarning
from html import escape
from http.cookies import CookieError, SimpleCookie
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sqlite3
from threading import Lock
from time import monotonic
from urllib.parse import parse_qs

import audit
import auth


HOST = "127.0.0.1"
SCHEMA_VERSION = 4
TRIAL_TARGET_ID = "demo-patient-001"
AUDIT_OUTCOMES = {"success": "成功", "denied": "拒否", "failed": "失敗"}
TRIAL_OPERATIONS = {
    "reception-preview": ("reception", "受付の試行"),
    "consultation-preview": ("physician", "診察の試行"),
    "nursing-preview": ("nurse", "看護の試行"),
    "administration-preview": ("admin", "管理の試行"),
}
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
            version = 2
        if version == 2:
            auth.initialize_staff_roles(connection)
            version = 3
        if version == 3:
            audit.initialize_audit_log(connection)
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
        if self.path in ("/audit", "/api/audit"):
            self.show_audit_log(api=self.path == "/api/audit")
            return
        if self.path != "/":
            prefix, _, operation = self.path.rpartition("/")
            if prefix == "/trial" and operation in TRIAL_OPERATIONS:
                self.handle_trial(operation)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
            return

        try:
            with closing(self.open_readonly_database()) as connection:
                staff = self.current_staff(connection)
                if staff is None:
                    self.redirect("/login")
                    return
                version, initialized_at = database_metadata(connection)
        except (sqlite3.Error, ValueError) as error:
            self.database_error(error)
            return

        staff_id, role = staff
        role_label = auth.ROLE_LABELS.get(role, "未割当")
        links = "".join(
            f'<li><a href="/trial/{name}">{title}</a></li>'
            for name, (allowed_role, title) in TRIAL_OPERATIONS.items()
            if allowed_role == role
        )
        if role == "admin":
            links += '<li><a href="/audit">監査ログ</a></li>'
        trial_menu = f"<ul>{links}</ul>" if links else "<p>利用できる試作用操作はありません。</p>"
        self.send_page(HTTPStatus.OK, f"""
            <section aria-labelledby="database-heading">
              <h2 id="database-heading">データベースの状態</h2>
              <p>利用可能（スキーマ版 {version}、初期化日時 {escape(initialized_at)}）</p>
              <p>ログイン中の職員ID　{escape(staff_id)}</p>
              <p>職種　{role_label}</p>
              {trial_menu}
              <form action="/logout" method="post"><button>ログアウト</button></form>
            </section>
        """)

    def open_readonly_database(self):
        uri = self.server.database.as_uri() + "?mode=ro"
        return sqlite3.connect(uri, uri=True)

    def current_staff(self, connection):
        token = self.session_token()
        return auth.session_staff(connection, token) if token else None

    def handle_trial(self, operation):
        required_role, title = TRIAL_OPERATIONS[operation]
        try:
            with closing(self.open_readonly_database()) as connection:
                staff = self.current_staff(connection)
        except sqlite3.Error as error:
            self.database_error(error)
            return

        if staff is None:
            self.redirect("/login")
            return
        if staff[1] != required_role:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>この操作を行う権限がありません。</p>")
            return

        self.send_page(HTTPStatus.OK, f"""
            <section>
              <h2>{title}</h2>
              <p>架空の対象ID　{TRIAL_TARGET_ID}</p>
              <form action="/api/trial/{operation}" method="post"><button>試行する</button></form>
              <p><a href="/">職員画面に戻る</a></p>
            </section>
        """)

    def execute_trial(self, operation):
        required_role, _ = TRIAL_OPERATIONS[operation]
        try:
            with closing(auth.connect(self.server.database)) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                staff = self.current_staff(connection)
                allowed = staff is not None and staff[1] == required_role
                audit.record_event(
                    connection,
                    actor_id=staff[0] if staff else None,
                    target_id=TRIAL_TARGET_ID,
                    action=operation,
                    outcome="success" if allowed else "denied",
                )
        except sqlite3.Error as error:
            self.log_error("監査イベント記録エラー: %s", error)
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "database_unavailable"})
            return

        if staff is None:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "login_required"})
        elif not allowed:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
        else:
            self.send_json(HTTPStatus.OK, {"operation": operation, "result": "allowed"})

    def show_audit_log(self, *, api):
        try:
            with closing(self.open_readonly_database()) as connection:
                connection.execute("BEGIN")
                staff = self.current_staff(connection)
                events = audit.recent_events(connection) if staff and staff[1] == "admin" else None
        except sqlite3.Error as error:
            if api:
                self.log_error("監査ログ読み取りエラー: %s", error)
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "database_unavailable"})
            else:
                self.database_error(error)
            return

        if staff is None:
            if api:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "login_required"})
            else:
                self.redirect("/login")
            return
        if events is None:
            if api:
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
            else:
                self.send_page(HTTPStatus.FORBIDDEN, "<p>監査ログを閲覧する権限がありません。</p>")
            return

        if api:
            self.send_json(HTTPStatus.OK, {"events": events})
            return
        rows = []
        for event in events:
            values = (
                event["occurred_at"], event["actor_id"] or "未認証", event["target_id"],
                event["action"], AUDIT_OUTCOMES[event["outcome"]],
            )
            cells = "".join(f"<td>{escape(value)}</td>" for value in values)
            rows.append(f"<tr>{cells}</tr>")
        if not rows:
            rows.append('<tr><td colspan="5">監査イベントはまだありません。</td></tr>')
        self.send_page(HTTPStatus.OK, f"""
            <section aria-labelledby="audit-heading">
              <h2 id="audit-heading">監査ログ</h2>
              <p>新しい順に最大{audit.RECENT_LIMIT}件を表示します。</p>
              <div class="table-scroll">
                <table>
                  <thead><tr>
                    <th scope="col">時刻（UTC）</th><th scope="col">操作者ID</th><th scope="col">対象ID</th>
                    <th scope="col">操作</th><th scope="col">結果</th>
                  </tr></thead>
                  <tbody>{"".join(rows)}</tbody>
                </table>
              </div>
              <p><a href="/">職員画面に戻る</a></p>
            </section>
        """)

    def do_POST(self):
        if not self.is_local_request():
            return
        prefix, _, operation = self.path.rpartition("/")
        is_trial = prefix == "/api/trial" and operation in TRIAL_OPERATIONS
        if self.path not in ("/login", "/logout") and not is_trial:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if self.headers.get_all("Origin") != [self.server.origin]:
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        if is_trial:
            self.execute_trial(operation)
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
        self.send_content(status, self.server.page.replace("{{content}}", content), "text/html")

    def send_json(self, status, content):
        self.send_content(status, json.dumps(content), "application/json")

    def send_content(self, status, content, content_type):
        payload = content.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
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
    staff_commands.add_argument("--set-staff-role", metavar="ID", help="既存の職員に職種を割り当てる")
    parser.add_argument("--role", choices=auth.ROLE_LABELS, help="職員の登録・職種割当に使う職種")
    args = parser.parse_args()
    if args.set_staff_role is not None and args.role is None:
        parser.error("--set-staff-role には --role が必要です。")
    if args.role is not None and args.add_staff is None and args.set_staff_role is None:
        parser.error("--role は --add-staff または --set-staff-role と併用してください。")
    if not 0 <= args.port <= 65535:
        parser.error("--port は 0〜65535 を指定してください。")

    try:
        database = args.db.resolve()
        initialize_database(database)
    except (OSError, RuntimeError, sqlite3.Error, ValueError) as error:
        parser.exit(1, f"データベース初期化エラー（{args.db}）: {error}\n")

    if any(value is not None for value in (args.add_staff, args.disable_staff, args.set_staff_role)):
        try:
            if args.add_staff is not None:
                auth.add_staff(database, args.add_staff, args.role)
                print("架空の職員を登録しました。")
            elif args.set_staff_role is not None:
                auth.set_staff_role(database, args.set_staff_role, args.role)
                print("職員の職種を設定しました。")
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
