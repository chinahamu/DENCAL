"""Start the local DENCAL prototype and initialize its SQLite database."""

import argparse
from contextlib import closing
from datetime import date
from getpass import GetPassWarning
from html import escape
from http.cookies import CookieError, SimpleCookie
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import sqlite3
from threading import Lock
from time import monotonic
from urllib.parse import parse_qs

import audit
import auth
import clinical_notes
import outpatient
import patients
import prescriptions


HOST = "127.0.0.1"
SCHEMA_VERSION = 11
CLINICAL_NOTE_ACTIONS = {
    "/outpatient/draft": clinical_notes.ACTION,
    "/outpatient/draft-review": clinical_notes.REVIEW_ACTION,
    "/outpatient/finalize": clinical_notes.FINALIZE_ACTION,
    "/outpatient/correct": clinical_notes.CORRECTION_ACTION,
}
PATIENT_REGISTRATION_ROLE = "reception"
PATIENT_SEARCH_ROLE = "reception"
OUTPATIENT_VIEW_ROLES = {"reception", "physician"}
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
        raise ValueError(f"対応していないスキーマ版です（検出値 {version}）。--db で新しいファイルを指定してください。")
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
        initialized = connection.execute(
            """
            INSERT INTO prototype_metadata (id, schema_version, initialized_at)
            VALUES (1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(id) DO NOTHING
            """,
            (SCHEMA_VERSION,),
        )
        if initialized.rowcount == 1:
            auth.initialize_auth(connection)
            auth.initialize_staff_roles(connection)
            audit.initialize_audit_log(connection)
            patients.initialize_patients(connection)
            outpatient.initialize_outpatient(connection)
            clinical_notes.initialize_notes(connection)
            prescriptions.initialize_orders(connection)
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
        if self.path == "/outpatient/list":
            self.show_outpatient_list()
            return
        if self.path == "/patients/search":
            self.show_patient_search()
            return
        if self.path == "/patients/new":
            self.show_patient_registration()
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
        if role == PATIENT_REGISTRATION_ROLE:
            links += '<li><a href="/patients/new">患者登録</a></li>'
        if role == PATIENT_SEARCH_ROLE:
            links += '<li><a href="/patients/search">患者検索</a></li>'
        if role in OUTPATIENT_VIEW_ROLES:
            links += '<li><a href="/outpatient/list">外来受付一覧</a></li>'
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

    def show_patient_registration(self):
        try:
            with closing(self.open_readonly_database()) as connection:
                staff = self.current_staff(connection)
        except sqlite3.Error as error:
            self.database_error(error)
            return
        if staff is None:
            self.redirect("/login")
        elif staff[1] != PATIENT_REGISTRATION_ROLE:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>患者を登録する権限がありません。</p>")
        else:
            self.send_patient_form()

    def send_patient_form(self, status=HTTPStatus.OK, *, message="", name="", birth_date="", key=""):
        if not patients.REQUEST_KEY.fullmatch(key):
            key = secrets.token_urlsafe(32)
        self.send_page(status, f"""
            <section aria-labelledby="registration-heading">
              <h2 id="registration-heading">患者登録</h2>
              <p role="status">{escape(message)}</p>
              <form action="/patients/new" method="post" autocomplete="off">
                <input type="hidden" name="registration_key" value="{key}">
                <label>氏名 <input name="name" required maxlength="100" value="{escape(name)}"></label>
                <label>生年月日 <input type="date" name="birth_date" required value="{escape(birth_date)}"></label>
                <button>登録する</button>
              </form>
              <p><a href="/">職員画面に戻る</a></p>
            </section>
        """)

    def submit_patient_registration(self):
        name, birth_date, key = "", "", ""
        try:
            fields = self.read_form(max_fields=3)
            name, = fields["name"]
            birth_date, = fields["birth_date"]
            key, = fields["registration_key"]
        except (KeyError, ValueError):
            error_message = "氏名と生年月日を入力してください。"
        else:
            try:
                name, birth_date = patients.validate_registration(name, birth_date, key)
                error_message = ""
            except ValueError as error:
                error_message = str(error)

        status = HTTPStatus.BAD_REQUEST
        patient_number = None
        try:
            with closing(auth.connect(self.server.database)) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                staff = self.current_staff(connection)
                if staff is None or staff[1] != PATIENT_REGISTRATION_ROLE:
                    self.record_patient_registration(connection, staff, "denied")
                elif error_message:
                    self.record_patient_registration(connection, staff, "failed")
                else:
                    try:
                        patient_number, created = patients.register(
                            connection, name=name, birth_date=birth_date,
                            actor_id=staff[0], registration_key=key,
                        )
                    except patients.RegistrationConflict:
                        self.record_patient_registration(connection, staff, "failed")
                        status = HTTPStatus.CONFLICT
                        key = ""
                        error_message = "送信済みの登録内容と一致しません。新しい登録として入力内容を確認してください。"
                    else:
                        if created:
                            self.record_patient_registration(connection, staff, "success", patient_number)
                        status = HTTPStatus.CREATED if created else HTTPStatus.OK
        except sqlite3.Error as error:
            self.database_error(error)
            return

        if staff is None:
            self.redirect("/login")
        elif staff[1] != PATIENT_REGISTRATION_ROLE:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>患者を登録する権限がありません。</p>")
        elif error_message:
            self.send_patient_form(status, message=error_message, name=name, birth_date=birth_date, key=key)
        else:
            self.send_page(status, f"""
                <section aria-labelledby="registered-heading">
                  <h2 id="registered-heading">患者登録済み</h2>
                  <p>患者番号　{patient_number}</p>
                  <p>氏名　{escape(name)}</p>
                  <p>生年月日　{birth_date}</p>
                  <p><a href="/patients/new">別の患者を登録する</a></p>
                  <p><a href="/">職員画面に戻る</a></p>
                </section>
            """)

    def record_patient_registration(self, connection, staff, outcome, target_id="patient-registration"):
        audit.record_event(
            connection, actor_id=staff[0] if staff else None,
            target_id=target_id, action="patient-register", outcome=outcome,
        )

    def show_patient_search(self):
        try:
            with closing(self.open_readonly_database()) as connection:
                staff = self.current_staff(connection)
        except sqlite3.Error as error:
            self.database_error(error)
            return

        if staff is None:
            self.redirect("/login")
        elif staff[1] != PATIENT_SEARCH_ROLE:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>患者情報を閲覧する権限がありません。</p>")
        else:
            self.send_patient_search()

    def send_patient_search(
        self, status=HTTPStatus.OK, *, message="", matches=(), truncated=False,
        filters=("", "", ""),
    ):
        number_filter, name_filter, date_filter = map(escape, filters)
        rows = []
        for patient_id, name, birth_date in matches:
            number = patients.patient_number(patient_id)
            rows.append(f"""
                <tr><td>{number}</td><td>{escape(name)}</td><td>{escape(birth_date)}</td>
                <td><form action="/patients/confirm" method="post">
                  <button name="patient_number" value="{number}" aria-label="患者番号 {number} を確認">確認</button>
                </form></td></tr>
            """)
        results = ""
        if rows:
            notice = (
                f"<p>先頭{patients.SEARCH_LIMIT}件を表示しています。検索条件を絞り込んでください。</p>"
                if truncated else ""
            )
            results = f"""
                {notice}
                <div class="table-scroll"><table>
                  <caption>検索結果</caption>
                  <thead><tr><th scope="col">患者番号</th><th scope="col">氏名</th>
                    <th scope="col">生年月日</th><th scope="col">確認</th></tr></thead>
                  <tbody>{"".join(rows)}</tbody>
                </table></div>
            """
        self.send_page(status, f"""
            <section aria-labelledby="search-heading">
              <h2 id="search-heading">患者検索</h2>
              <p>患者番号・氏名・生年月日のうち1項目以上を入力してください。</p>
              <form action="/patients/search" method="post" autocomplete="off">
                <label>患者番号 <input name="patient_number" maxlength="20" placeholder="P00000001" value="{number_filter}"></label>
                <label>氏名（部分一致） <input name="name" maxlength="100" value="{name_filter}"></label>
                <label>生年月日 <input type="date" name="birth_date" value="{date_filter}"></label>
                <button>検索する</button>
              </form>
              <p role="status">{escape(message)}</p>
              {results}
              <p><a href="/">職員画面に戻る</a></p>
            </section>
        """)

    def handle_patient_lookup(self, *, confirm):
        action = "patient-view" if confirm else "patient-search"
        try:
            fields = self.read_form(max_fields=1 if confirm else 3)
            number, = fields.get("patient_number", [""])
            name, = fields.get("name", [""])
            birth_date, = fields.get("birth_date", [""])
            if confirm and not number.strip():
                raise ValueError
            criteria = patients.search_criteria(number, name, birth_date)
            message = ""
        except (KeyError, ValueError):
            criteria = None
            message = "患者番号・氏名・生年月日を確認してください。"

        matches = []
        truncated = False
        try:
            with closing(auth.connect(self.server.database)) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                staff = self.current_staff(connection)
                allowed = staff is not None and staff[1] == PATIENT_SEARCH_ROLE
                if allowed and criteria is not None:
                    matches = patients.search(connection, *criteria)
                    truncated = len(matches) > patients.SEARCH_LIMIT
                    matches = matches[:patients.SEARCH_LIMIT]

                if matches:
                    if confirm:
                        check_in_key = outpatient.new_form_key(connection, matches[0][0], staff[0])
                    for patient_id, _, _ in matches:
                        audit.record_event(
                            connection, actor_id=staff[0], target_id=patients.patient_number(patient_id),
                            action=action, outcome="success",
                        )
                else:
                    audit.record_event(
                        connection, actor_id=staff[0] if staff else None, target_id=action,
                        action=action, outcome="failed" if allowed else "denied",
                    )
        except sqlite3.Error as error:
            self.database_error(error)
            return

        if staff is None:
            self.redirect("/login")
        elif not allowed:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>患者情報を閲覧する権限がありません。</p>")
        elif message:
            self.send_patient_search(HTTPStatus.BAD_REQUEST, message=message)
        elif not matches:
            status = HTTPStatus.NOT_FOUND if confirm else HTTPStatus.OK
            self.send_patient_search(
                status, message="該当する患者が見つかりません。",
                filters=(number, name, birth_date),
            )
        elif confirm:
            self.send_patient_confirmation(matches[0], check_in_key, visit_date=date.today().isoformat())
        else:
            self.send_patient_search(
                matches=matches, truncated=truncated, filters=(number, name, birth_date)
            )

    def send_patient_confirmation(
        self, patient, key, *, status=HTTPStatus.OK, message="", department="", visit_date="",
    ):
        patient_id, name, birth_date = patient
        number = patients.patient_number(patient_id)
        options = []
        for code, label in outpatient.DEPARTMENTS.items():
            selected = " selected" if code == department else ""
            options.append(f'<option value="{code}"{selected}>{label}</option>')
        self.send_page(status, f"""
            <section aria-labelledby="patient-heading">
              <h2 id="patient-heading">患者情報の確認</h2>
              <dl>
                <dt>患者番号</dt><dd>{number}</dd>
                <dt>氏名</dt><dd>{escape(name)}</dd>
                <dt>生年月日</dt><dd>{escape(birth_date)}</dd>
              </dl>
              <h3>外来受付</h3>
              <p role="status">{escape(message)}</p>
              <form action="/outpatient/check-in" method="post">
                <input type="hidden" name="patient_number" value="{number}">
                <input type="hidden" name="request_key" value="{escape(key)}">
                <label>診療科 <select name="department" required>
                  <option value="">選択してください</option>{"".join(options)}
                </select></label>
                <label>来院日 <input type="date" name="visit_date" value="{escape(visit_date)}" required></label>
                <button>外来受付を登録する</button>
              </form>
              <p><a href="/patients/search">患者検索に戻る</a></p>
            </section>
        """)

    def submit_outpatient_check_in(self):
        patient_id, department, visit_date, key = None, "", "", ""
        try:
            fields = self.read_form(max_fields=4)
            number, = fields["patient_number"]
            department, = fields["department"]
            visit_date, = fields["visit_date"]
            key, = fields["request_key"]
            patient_id, _, _ = patients.search_criteria(number, "", "")
            if patient_id is None:
                raise ValueError
            outpatient.validate_visit(department, visit_date)
            message = ""
        except (KeyError, ValueError):
            message = "患者番号・診療科・来院日を確認してください。"

        status = HTTPStatus.BAD_REQUEST
        visit_id = None
        patient = None
        target_id = outpatient.ACTION
        try:
            with closing(auth.connect(self.server.database)) as connection, connection:
                connection.execute("PRAGMA foreign_keys = ON")
                connection.execute("BEGIN IMMEDIATE")
                staff = self.current_staff(connection)
                allowed = staff is not None and staff[1] == PATIENT_SEARCH_ROLE
                outcome = "denied"
                if allowed:
                    outcome = "failed"
                    if patient_id and outpatient.is_valid_form_key(connection, key, patient_id, staff[0]):
                        matches = patients.search(connection, patient_id, "", "")
                        if matches:
                            patient = matches[0]
                            target_id = patients.patient_number(patient_id)
                        else:
                            status = HTTPStatus.NOT_FOUND
                            message = "対象の患者が見つかりません。"
                    else:
                        message = "患者検索から対象の患者を選び直してください。"

                    if patient is not None and not message:
                        try:
                            visit_id, created = outpatient.check_in(
                                connection, patient_id=patient_id, department=department,
                                visit_date=visit_date, actor_id=staff[0], key=key,
                            )
                        except outpatient.CheckInConflict:
                            status = HTTPStatus.CONFLICT
                            message = "登録済みの受付内容と一致しません。患者検索から確認し直してください。"
                        else:
                            status = HTTPStatus.CREATED if created else HTTPStatus.OK
                            outcome = "success" if created else None

                if outcome is not None:
                    audit.record_event(
                        connection, actor_id=staff[0] if staff else None,
                        target_id=target_id, action=outpatient.ACTION, outcome=outcome,
                    )
        except sqlite3.Error as error:
            self.database_error(error)
            return

        if staff is None:
            self.redirect("/login")
        elif not allowed:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>外来受付を登録する権限がありません。</p>")
        elif visit_id is not None:
            self.send_page(status, f"""
                <section aria-labelledby="checked-in-heading">
                  <h2 id="checked-in-heading">外来受付登録済み</h2>
                  <p>受付番号　{visit_id}</p>
                  <p>患者番号　{target_id}</p>
                  <p>氏名　{escape(patient[1])}</p>
                  <p>生年月日　{escape(patient[2])}</p>
                  <p>診療科　{outpatient.DEPARTMENTS[department]}</p>
                  <p>来院日　{visit_date}</p>
                  <p><a href="/patients/search">患者検索に戻る</a></p>
                </section>
            """)
        elif patient is not None and status == HTTPStatus.BAD_REQUEST:
            self.send_patient_confirmation(
                patient, key, status=status, message=message, department=department, visit_date=visit_date,
            )
        else:
            self.send_patient_search(status, message=message)

    def show_outpatient_list(self):
        try:
            with closing(self.open_readonly_database()) as connection:
                staff = self.current_staff(connection)
        except sqlite3.Error as error:
            self.database_error(error)
            return
        if staff is None:
            self.redirect("/login")
        elif staff[1] not in OUTPATIENT_VIEW_ROLES:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>外来受付を閲覧する権限がありません。</p>")
        else:
            self.send_outpatient_list(date.today().isoformat())

    def send_outpatient_list(
        self, visit_date, *, department="", visits=(), has_next=False,
        message="", status=HTTPStatus.OK,
    ):
        options = []
        for code, label in outpatient.DEPARTMENTS.items():
            selected = " selected" if code == department else ""
            options.append(f'<option value="{code}"{selected}>{label}</option>')
        rows = []
        for visit_id, patient_id, name, birth_date in visits:
            number = patients.patient_number(patient_id)
            rows.append(f"""
                <tr><td>{visit_id}</td><td>{number}</td><td>{escape(name)}</td>
                <td>{escape(birth_date)}</td><td>
                  <form action="/outpatient/visit" method="post">
                    <input type="hidden" name="department" value="{department}">
                    <input type="hidden" name="visit_date" value="{visit_date}">
                    <button name="visit_id" value="{visit_id}" aria-label="受診ID {visit_id} を開く">開く</button>
                  </form>
                </td></tr>
            """)
        table = ""
        if rows:
            table = f"""
                <div class="table-scroll"><table>
                  <caption>{outpatient.DEPARTMENTS[department]}の受付</caption>
                  <thead><tr><th scope="col">受診ID</th><th scope="col">患者番号</th>
                    <th scope="col">氏名</th><th scope="col">生年月日</th><th scope="col">受診</th></tr></thead>
                  <tbody>{"".join(rows)}</tbody>
                </table></div>
            """
        next_page = ""
        if has_next:
            next_page = f"""
                <form action="/outpatient/list" method="post">
                  <input type="hidden" name="department" value="{department}">
                  <input type="hidden" name="visit_date" value="{visit_date}">
                  <button name="after_id" value="{visits[-1][0]}">次の{outpatient.PAGE_SIZE}件</button>
                </form>
            """
        self.send_page(status, f"""
            <section aria-labelledby="outpatient-list-heading">
              <h2 id="outpatient-list-heading">当日の外来受付一覧</h2>
              <p>来院日　{visit_date}</p>
              <form action="/outpatient/list" method="post">
                <label>診療科 <select name="department" required>
                  <option value="">選択してください</option>{"".join(options)}
                </select></label>
                <button>表示する</button>
              </form>
              <p role="status">{escape(message)}</p>
              {table}
              {next_page}
              <p><a href="/">職員画面に戻る</a></p>
            </section>
        """)

    def submit_outpatient_lookup(self, *, detail):
        today = date.today().isoformat()
        action = "outpatient-visit-view" if detail else "outpatient-list"
        department, cursor = "", 0
        try:
            fields = self.read_form(max_fields=3)
            department, = fields["department"]
            if department not in outpatient.DEPARTMENTS:
                raise ValueError
            cursor_field = "visit_id" if detail else "after_id"
            if detail or cursor_field in fields:
                visit_date, = fields["visit_date"]
                cursor_text, = fields[cursor_field]
                if fields.keys() != {"department", "visit_date", cursor_field} or visit_date != today:
                    raise ValueError
                cursor = outpatient.parse_visit_id(cursor_text)
            elif fields.keys() != {"department"}:
                raise ValueError
            valid = True
        except (KeyError, ValueError):
            valid = False

        visits = []
        has_next = False
        editor = ""
        try:
            with closing(auth.connect(self.server.database)) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                staff = self.current_staff(connection)
                allowed = staff is not None and staff[1] in OUTPATIENT_VIEW_ROLES
                if allowed and valid:
                    if detail:
                        visit = outpatient.find_visit(connection, department, today, cursor)
                        visits = [visit] if visit else []
                        if visit and staff[1] == "physician":
                            editor = self.current_note_editor(connection, today, department, visit, staff[0])
                            editor += self.prescription_panel(connection, today, department, visit, staff[0])
                    else:
                        visits = outpatient.list_visits(connection, department, today, cursor)
                        has_next = len(visits) > outpatient.PAGE_SIZE
                        visits = visits[:outpatient.PAGE_SIZE]
                if visits:
                    for visit_id, _, _, _ in visits:
                        audit.record_event(
                            connection, actor_id=staff[0], target_id=f"visit:{visit_id}",
                            action=action, outcome="success",
                        )
                else:
                    outcome = "denied" if not allowed else "success" if valid and not detail else "failed"
                    audit.record_event(
                        connection, actor_id=staff[0] if staff else None,
                        target_id=action, action=action, outcome=outcome,
                    )
        except sqlite3.Error as error:
            self.database_error(error)
            return

        if staff is None:
            self.redirect("/login")
        elif not allowed:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>外来受付を閲覧する権限がありません。</p>")
        elif not valid:
            self.send_outpatient_list(
                today, message="診療科と当日の受付を選び直してください。", status=HTTPStatus.BAD_REQUEST,
            )
        elif detail and visits:
            self.send_outpatient_visit(today, department, visits[0], editor=editor)
        else:
            self.send_outpatient_list(
                today, department=department, visits=visits, has_next=has_next,
                message="" if visits else "該当する外来受付がありません。",
                status=HTTPStatus.NOT_FOUND if detail else HTTPStatus.OK,
            )

    def send_outpatient_visit(self, visit_date, department, visit, *, editor="", status=HTTPStatus.OK):
        visit_id, patient_id, name, birth_date = visit
        self.send_page(status, f"""
            <section class="clinical-workbench" aria-labelledby="outpatient-visit-heading">
              <header class="chart-context">
                <h2 id="outpatient-visit-heading">外来診療録</h2>
                <p class="chart-name">{escape(name)}</p>
                <dl>
                <dt>受診ID</dt><dd>{visit_id}</dd>
                <dt>患者番号</dt><dd>{patients.patient_number(patient_id)}</dd>
                <dt>生年月日</dt><dd>{escape(birth_date)}</dd>
                <dt>診療科</dt><dd>{outpatient.DEPARTMENTS[department]}</dd>
                <dt>来院日</dt><dd>{visit_date}</dd>
                </dl>
              </header>
              {editor}
              <form action="/outpatient/list" method="post">
                <button name="department" value="{department}">同じ診療科の一覧に戻る</button>
              </form>
            </section>
        """)

    def note_fields(self, visit_date, department, visit, version, key):
        visit_id, patient_id, _, _ = visit
        return f"""
            <input type="hidden" name="visit_id" value="{visit_id}">
            <input type="hidden" name="patient_number" value="{patients.patient_number(patient_id)}">
            <input type="hidden" name="department" value="{department}">
            <input type="hidden" name="visit_date" value="{visit_date}">
            <input type="hidden" name="version" value="{version}">
            <input type="hidden" name="draft_key" value="{key}">
        """

    def soap_fields(self, soap, *, editable=False):
        controls = []
        for (field, label), value in zip(clinical_notes.SOAP_LABELS.items(), soap):
            attributes = f'name="{field}" maxlength="{clinical_notes.MAX_SECTION_LENGTH}"' if editable else "readonly"
            controls.append(f"""
                <label class="soap-field">{label}
                  <textarea {attributes} rows="5">
{escape(value)}</textarea>
                </label>
            """)
        return f'<div class="soap-grid">{"".join(controls)}</div>'

    def draft_form(self, visit_date, department, visit, soap, version, key, message=""):
        fields = self.note_fields(visit_date, department, visit, version, key)
        review_button = ""
        if version:
            review_button = f"""
                <form action="/outpatient/draft-review" method="post">
                  {fields}
                  <button>保存済みの下書きを確定前に確認する</button>
                </form>
            """
        return f"""
            <h3>診療録の下書き</h3>
            <p role="status">{escape(message)}</p>
            <form action="/outpatient/draft" method="post" autocomplete="off">
              {fields}
              {self.soap_fields(soap, editable=True)}
              <button>下書きを保存する</button>
            </form>
            {review_button}
        """

    def readonly_note(self, note, heading):
        finalized = ""
        if note.finalized_at:
            finalized = f"""
                <dt>確定者ID</dt><dd>{escape(note.finalized_by)}</dd>
                <dt>確定日時（UTC）</dt><dd>{escape(note.finalized_at)}</dd>
            """
        return f"""
            <h3>{heading}</h3>
            <dl>
              <dt>入力者ID</dt><dd>{escape(note.saved_by)}</dd>
              <dt>作成日時（UTC）</dt><dd>{escape(note.created_at)}</dd>
              {finalized}
            </dl>
            <p>保存済み本文（SOAP）</p>
            {self.soap_fields(note.soap)}
        """

    def current_note_editor(self, connection, visit_date, department, visit, staff_id):
        note = clinical_notes.read_draft(connection, visit[0])
        if note and note.finalized_at:
            return self.finalized_note_editor(connection, visit_date, department, visit, note, staff_id)
        soap, version = (note.soap, note.version) if note else (clinical_notes.Soap(), 0)
        key = clinical_notes.draft_key(connection, visit[0], visit[1], version, staff_id)
        return self.draft_form(visit_date, department, visit, soap, version, key)

    def note_conflict(self, visit_date, department, visit_id, message, submitted_soap):
        submitted = ""
        if submitted_soap is not None:
            submitted = f"<h4>保存されなかった入力</h4>{self.soap_fields(submitted_soap)}"
        return f"""
            <p role="alert">{escape(message)}</p>
            {submitted}
            <form action="/outpatient/visit" method="post">
              <input type="hidden" name="department" value="{department}">
              <input type="hidden" name="visit_date" value="{visit_date}">
              <button name="visit_id" value="{visit_id}">最新の診療録を開く</button>
            </form>
        """

    def corrected_note(self, correction):
        return f"""
            <dl>
              <dt>訂正者ID</dt><dd>{escape(correction.corrected_by)}</dd>
              <dt>訂正日時（UTC）</dt><dd>{escape(correction.corrected_at)}</dd>
              <dt>訂正理由</dt><dd>{escape(correction.reason)}</dd>
            </dl>
            {self.soap_fields(correction.soap)}
        """

    def finalized_note_editor(
        self, connection, visit_date, department, visit, note, staff_id,
        *, corrections=None, submitted_soap=None, reason="", message="",
    ):
        visit_id, patient_id, _, _ = visit
        if corrections is None:
            corrections = clinical_notes.read_corrections(connection, visit_id)

        revision, current_soap = 0, note.soap
        display = self.readonly_note(note, "確定済み診療録")
        if corrections:
            current = corrections[0]
            revision, current_soap = current.revision, current.soap
            history = "".join(
                f"<details><summary>訂正第{item.revision}版</summary>{self.corrected_note(item)}</details>"
                for item in corrections[1:]
            )
            display = f"""
                <h3>確定済み診療録（現行・訂正第{revision}版）</h3>
                {self.corrected_note(current)}
                <h3>訂正履歴</h3>
                {history}
                <details><summary>確定時の元版</summary>{display}</details>
            """

        key = clinical_notes.draft_key(
            connection, visit_id, patient_id, revision, staff_id, action=clinical_notes.CORRECTION_ACTION,
        )
        fields = self.note_fields(visit_date, department, visit, revision, key)
        soap = current_soap if submitted_soap is None else submitted_soap
        return display + f"""
            <h3>確定済み診療録の訂正</h3>
            <p role="status">{escape(message)}</p>
            <form action="/outpatient/correct" method="post" autocomplete="off">
              {fields}
              {self.soap_fields(soap, editable=True)}
              <label>訂正理由 <input name="reason" required maxlength="{clinical_notes.MAX_REASON_LENGTH}" value="{escape(reason)}"></label>
              <button>理由を記録して訂正する</button>
            </form>
        """

    def apply_note_correction(self, connection, visit_date, department, visit, note, revision, soap, reason, staff_id):
        visit_id = visit[0]
        if note is None or not note.finalized_at:
            message = "確定済みの診療録だけを訂正できます。"
            return HTTPStatus.CONFLICT, self.note_conflict(visit_date, department, visit_id, message, soap)

        corrections = clinical_notes.read_corrections(connection, visit_id)
        current_revision = corrections[0].revision if corrections else 0
        if current_revision != revision:
            message = "別の画面で訂正が保存されました。最新の診療録を開いてください。"
            return HTTPStatus.CONFLICT, self.note_conflict(visit_date, department, visit_id, message, soap)
        try:
            reason = clinical_notes.validate_reason(reason)
            soap = clinical_notes.validate_soap(soap)
        except ValueError as error:
            return HTTPStatus.BAD_REQUEST, self.finalized_note_editor(
                connection, visit_date, department, visit, note, staff_id,
                corrections=corrections, submitted_soap=soap, reason=reason, message=str(error),
            )
        clinical_notes.append_correction(connection, visit_id, revision + 1, soap, reason, staff_id)
        return HTTPStatus.OK, self.finalized_note_editor(
            connection, visit_date, department, visit, note, staff_id, message="訂正を保存しました。",
        )

    def apply_note_action(self, connection, action, visit_date, department, visit, version, key, soap, reason, staff_id):
        visit_id, patient_id, _, _ = visit
        note = clinical_notes.read_draft(connection, visit_id)
        if action == clinical_notes.CORRECTION_ACTION:
            return self.apply_note_correction(
                connection, visit_date, department, visit, note, version, soap, reason, staff_id,
            )
        if note and note.finalized_at:
            message = "この診療録は確定済みです。"
            return HTTPStatus.CONFLICT, self.note_conflict(visit_date, department, visit_id, message, soap)
        if version != (note.version if note else 0) or (action != clinical_notes.ACTION and note is None):
            message = "下書きの版が変わったか、下書きがまだありません。最新の診療録を開いてください。"
            return HTTPStatus.CONFLICT, self.note_conflict(visit_date, department, visit_id, message, soap)

        if action == clinical_notes.REVIEW_ACTION:
            final_key = clinical_notes.draft_key(connection, visit_id, patient_id, version, staff_id, action=clinical_notes.FINALIZE_ACTION)
            fields = self.note_fields(visit_date, department, visit, version, final_key)
            editor = self.readonly_note(note, "診療録の確定前確認") + f"""
                <p>保存済みの本文を確認してください。確定後は通常の編集画面から変更できません。</p>
                <form action="/outpatient/finalize" method="post">
                  {fields}
                  <button>この内容で確定する</button>
                </form>
            """
            return HTTPStatus.OK, editor

        if action == clinical_notes.FINALIZE_ACTION:
            if not clinical_notes.finalize_draft(connection, visit_id, version, staff_id):
                raise sqlite3.IntegrityError("確定対象の版を更新できませんでした。")
            finalized = clinical_notes.read_draft(connection, visit_id)
            return HTTPStatus.OK, self.finalized_note_editor(connection, visit_date, department, visit, finalized, staff_id)

        try:
            soap = clinical_notes.validate_soap(soap)
        except ValueError as error:
            return HTTPStatus.BAD_REQUEST, self.draft_form(visit_date, department, visit, soap, version, key, str(error))
        if not clinical_notes.save_draft(connection, visit_id, soap, version, staff_id):
            raise sqlite3.IntegrityError("下書きの版を更新できませんでした。")
        next_key = clinical_notes.draft_key(connection, visit_id, patient_id, version + 1, staff_id)
        return HTTPStatus.OK, self.draft_form(
            visit_date, department, visit, soap, version + 1, next_key, "下書きを保存しました。",
        )

    def submit_clinical_note(self, action):
        correcting = action == clinical_notes.CORRECTION_ACTION
        saving = correcting or action == clinical_notes.ACTION
        today = date.today().isoformat()
        soap = None
        reason = ""
        try:
            fields = self.read_form(max_fields=11, max_bytes=110000, keep_blank_values=True)
            expected = {"department", "visit_date", "patient_number", "visit_id", "version", "draft_key"}
            if saving:
                expected.update(clinical_notes.SOAP_LABELS)
            if correcting:
                expected.add("reason")
            if fields.keys() != expected or any(len(value) != 1 for value in fields.values()):
                raise ValueError
            department, = fields["department"]
            visit_date, = fields["visit_date"]
            number, = fields["patient_number"]
            visit_text, = fields["visit_id"]
            version_text, = fields["version"]
            key, = fields["draft_key"]
            if saving:
                soap = clinical_notes.Soap(*(fields[field][0] for field in clinical_notes.SOAP_LABELS))
            if correcting:
                reason, = fields["reason"]
            visit_id = outpatient.parse_visit_id(visit_text)
            patient_id, _, _ = patients.search_criteria(number, "", "")
            version = 0 if version_text == "0" else outpatient.parse_visit_id(version_text)
            valid = patient_id is not None and department in outpatient.DEPARTMENTS and visit_date == today
        except (KeyError, ValueError):
            valid = False

        status = HTTPStatus.BAD_REQUEST
        confirmed_visit = None
        try:
            with closing(auth.connect(self.server.database)) as connection, connection:
                connection.execute("PRAGMA foreign_keys = ON")
                connection.execute("BEGIN IMMEDIATE")
                staff = self.current_staff(connection)
                allowed = staff is not None and staff[1] == "physician"
                if allowed and valid:
                    visit = outpatient.find_visit(connection, department, today, visit_id)
                    if visit and visit[1] == patient_id and clinical_notes.valid_key(
                        connection, key, visit_id, patient_id, version, staff[0],
                        action=action,
                    ):
                        confirmed_visit = visit
                        status, editor = self.apply_note_action(
                            connection, action, today, department, visit, version, key, soap, reason, staff[0],
                        )

                outcome = "denied" if not allowed else "success" if status == HTTPStatus.OK else "failed"
                audit.record_event(
                    connection, actor_id=staff[0] if staff else None,
                    target_id=f"visit:{visit_id}" if confirmed_visit else action,
                    action=action, outcome=outcome,
                )
        except sqlite3.Error as error:
            self.database_error(error)
            return

        if staff is None:
            self.redirect("/login")
        elif not allowed:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>診療録を操作する権限がありません。</p>")
        elif confirmed_visit is None:
            self.send_outpatient_list(today, status=status, message="患者と受診を選び直してください。")
        else:
            self.send_outpatient_visit(today, department, confirmed_visit, editor=editor, status=status)

    def prescription_panel(self, connection, visit_date, department, visit, actor_id, *, values=(), key="", message=""):
        visit_id, patient_id, _, _ = visit
        if not key:
            key = prescriptions.new_key(connection, visit_id, patient_id, actor_id)
        drug, dose, unit, directions, days = map(escape, values or ("", "", "", "", ""))
        rows = []
        for drug_name, amount, dose_unit, usage, duration, ordered_by, ordered_at in prescriptions.list_orders(
            connection, visit_id,
        ):
            cells = (drug_name, amount, dose_unit, usage, str(duration), ordered_by, ordered_at)
            rows.append("<tr>" + "".join(f"<td>{escape(cell)}</td>" for cell in cells) + "<td>指示済み・実施未記録</td></tr>")
        listing = "<p>処方指示はまだありません。</p>"
        if rows:
            listing = f"""
                <div class="table-scroll"><table>
                  <caption>登録済みの処方指示</caption>
                  <thead><tr><th scope="col">薬剤</th><th scope="col">用量</th><th scope="col">単位</th>
                    <th scope="col">用法</th><th scope="col">日数</th><th scope="col">指示者ID</th>
                    <th scope="col">指示日時（UTC）</th><th scope="col">状態</th></tr></thead>
                  <tbody>{"".join(rows)}</tbody>
                </table></div>
            """
        return f"""
            <h3>処方指示</h3>
            <p>マスター未接続の試作入力です。架空の薬剤で処方指示を確認してください。</p>
            {listing}
            <p role="status">{escape(message)}</p>
            <form action="/outpatient/prescription" method="post" autocomplete="off">
              <input type="hidden" name="visit_id" value="{visit_id}">
              <input type="hidden" name="patient_number" value="{patients.patient_number(patient_id)}">
              <input type="hidden" name="department" value="{department}">
              <input type="hidden" name="visit_date" value="{visit_date}">
              <input type="hidden" name="request_key" value="{key}">
              <label>薬剤名 <input name="drug" required maxlength="100" value="{drug}"></label>
              <label>用量 <input name="dose" required inputmode="decimal" maxlength="16" value="{dose}"></label>
              <label>単位 <input name="unit" required maxlength="30" value="{unit}"></label>
              <label>用法 <input name="directions" required maxlength="200" value="{directions}"></label>
              <label>日数 <input name="days" type="number" required min="1" max="9999" value="{days}"></label>
              <button>処方指示を登録する</button>
            </form>
        """

    def submit_prescription_order(self):
        today = date.today().isoformat()
        try:
            fields = self.read_form(max_fields=10, max_bytes=8192, keep_blank_values=True)
            visit_text, = fields["visit_id"]
            number, = fields["patient_number"]
            department, = fields["department"]
            visit_date, = fields["visit_date"]
            key, = fields["request_key"]
            visit_id = outpatient.parse_visit_id(visit_text)
            patient_id, _, _ = patients.search_criteria(number, "", "")
            valid = patient_id is not None and department in outpatient.DEPARTMENTS and visit_date == today
        except (KeyError, ValueError):
            valid = False

        status = HTTPStatus.BAD_REQUEST
        confirmed_visit = None
        action = prescriptions.ACTION
        try:
            with closing(auth.connect(self.server.database)) as connection, connection:
                connection.execute("PRAGMA foreign_keys = ON")
                connection.execute("BEGIN IMMEDIATE")
                staff = self.current_staff(connection)
                allowed = staff is not None and staff[1] == "physician"
                outcome = "failed" if allowed else "denied"
                if allowed and valid:
                    visit = outpatient.find_visit(connection, department, today, visit_id)
                    if visit and visit[1] == patient_id and prescriptions.valid_key(
                        connection, key, visit_id, patient_id, staff[0],
                    ):
                        confirmed_visit = visit
                        status, outcome, panel = self.apply_prescription_order(
                            connection, today, department, visit, staff[0], key, fields,
                        )

                if outcome is not None:
                    audit.record_event(
                        connection, actor_id=staff[0] if staff else None,
                        target_id=f"visit:{visit_id}" if confirmed_visit else action,
                        action=action, outcome=outcome,
                    )
        except sqlite3.Error as error:
            self.database_error(error)
            return

        if staff is None:
            self.redirect("/login")
        elif not allowed:
            self.send_page(HTTPStatus.FORBIDDEN, "<p>処方指示を登録する権限がありません。</p>")
        elif confirmed_visit is None:
            self.send_outpatient_list(today, status=status, message="患者と受診を選び直してください。")
        else:
            self.send_outpatient_visit(today, department, confirmed_visit, editor=panel, status=status)

    def apply_prescription_order(self, connection, today, department, visit, actor_id, key, fields):
        values = [fields.get(field, [""]) for field in prescriptions.FIELD_NAMES]
        if any(len(value) != 1 for value in values):
            return HTTPStatus.BAD_REQUEST, "failed", self.prescription_panel(
                connection, today, department, visit, actor_id, key=key, message="各項目を1つずつ入力してください。",
            )
        values = [value[0] for value in values]
        try:
            order = prescriptions.validate_order(*values)
        except ValueError as error:
            return HTTPStatus.BAD_REQUEST, "failed", self.prescription_panel(
                connection, today, department, visit, actor_id, values=values, key=key, message=str(error),
            )
        try:
            created = prescriptions.register_order(connection, visit[0], order, actor_id, key)
        except prescriptions.OrderConflict:
            return HTTPStatus.CONFLICT, "failed", self.prescription_panel(
                connection, today, department, visit, actor_id, values=values,
                message="送信済みの処方指示と一致しません。別の指示として入力内容を確認してください。",
            )
        status = HTTPStatus.CREATED if created else HTTPStatus.OK
        return status, "success" if created else None, self.prescription_panel(
            connection, today, department, visit, actor_id, message="処方指示を登録しました。",
        )

    def do_POST(self):
        if not self.is_local_request():
            return
        prefix, _, operation = self.path.rpartition("/")
        is_trial = prefix == "/api/trial" and operation in TRIAL_OPERATIONS
        is_patient_lookup = self.path in ("/patients/search", "/patients/confirm")
        is_outpatient_lookup = self.path in ("/outpatient/list", "/outpatient/visit")
        note_action = CLINICAL_NOTE_ACTIONS.get(self.path)
        if self.path not in (
            "/login", "/logout", "/patients/new", "/outpatient/check-in", "/outpatient/prescription",
        ) and not (
            is_trial or is_patient_lookup or is_outpatient_lookup or note_action
        ):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if self.headers.get_all("Origin") != [self.server.origin]:
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        if self.path == "/outpatient/prescription":
            self.submit_prescription_order()
            return
        if note_action:
            self.submit_clinical_note(note_action)
            return
        if is_outpatient_lookup:
            self.submit_outpatient_lookup(detail=self.path == "/outpatient/visit")
            return
        if self.path == "/outpatient/check-in":
            self.submit_outpatient_check_in()
            return
        if is_patient_lookup:
            self.handle_patient_lookup(confirm=self.path == "/patients/confirm")
            return
        if self.path == "/patients/new":
            self.submit_patient_registration()
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

    def read_form(self, *, max_fields, max_bytes=4096, keep_blank_values=False):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= max_bytes:
            raise ValueError
        if self.headers.get_content_type() != "application/x-www-form-urlencoded":
            raise ValueError
        return parse_qs(
            self.rfile.read(length).decode("ascii"), errors="strict", max_num_fields=max_fields,
            keep_blank_values=keep_blank_values,
        )

    def login(self):
        try:
            fields = self.read_form(max_fields=2)
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
