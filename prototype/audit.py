"""Store operation metadata without copying patient data or credentials."""

import sqlite3


RECENT_LIMIT = 100


def initialize_audit_log(connection):
    connection.execute(
        """
        CREATE TABLE audit_events (
            id INTEGER PRIMARY KEY,
            occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            actor_id TEXT,
            target_id TEXT NOT NULL,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failed'))
        )
        """
    )


def record_event(connection, *, actor_id, target_id, action, outcome):
    """Append an event in the caller's transaction, using only stable identifiers."""
    connection.execute(
        "INSERT INTO audit_events (actor_id, target_id, action, outcome) VALUES (?, ?, ?, ?)",
        (actor_id, target_id, action, outcome),
    )


def recent_events(connection):
    cursor = connection.execute(
        """
        SELECT id, occurred_at, actor_id, target_id, action, outcome
        FROM audit_events ORDER BY id DESC LIMIT ?
        """,
        (RECENT_LIMIT,),
    )
    cursor.row_factory = sqlite3.Row
    return [dict(row) for row in cursor]
