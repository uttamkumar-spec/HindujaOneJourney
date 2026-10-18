"""Persistence (SQLite) for journey config versions, leads, quotes and policies.

Config lifecycle: one editable draft -> publish creates a new immutable
version -> the portal always reads the latest published version. Rollback
re-publishes an older version's body as a new version, so history is linear.

SQLite keeps the reference implementation dependency-free. For production,
move these tables to the group's database (Postgres — including Supabase's —
works with the same schema).
"""
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS config_version (
  version     INTEGER PRIMARY KEY AUTOINCREMENT,
  body        TEXT NOT NULL,
  note        TEXT,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_draft (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  body        TEXT NOT NULL,
  based_on    INTEGER,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lead (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  user_email  TEXT,
  config_version INTEGER NOT NULL,
  profile     TEXT NOT NULL,
  recommendations TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quote (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  request     TEXT NOT NULL,
  response    TEXT NOT NULL,
  total       INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS policy (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quote_id    TEXT NOT NULL,
  policy_no   TEXT,
  status      TEXT NOT NULL,
  txn_id      TEXT NOT NULL,
  total       INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)

    def _q(self, sql, args=(), one=False):
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            rows = cur.fetchall()
            return (rows[0] if rows else None) if one else rows

    # ----------------------------------------------------- config
    def seed(self, default_cfg):
        if not self.published():
            self.publish_body(default_cfg, "system", "Initial version from UI deck")

    def published(self):
        r = self._q("SELECT * FROM config_version ORDER BY version DESC LIMIT 1", one=True)
        return {"version": r["version"], "body": json.loads(r["body"]), "publishedBy": r["published_by"],
                "publishedAt": r["published_at"], "note": r["note"]} if r else None

    def version(self, v):
        r = self._q("SELECT * FROM config_version WHERE version = ?", (v,), one=True)
        return json.loads(r["body"]) if r else None

    def versions(self):
        return [{"version": r["version"], "note": r["note"], "publishedBy": r["published_by"], "publishedAt": r["published_at"]}
                for r in self._q("SELECT version, note, published_by, published_at FROM config_version ORDER BY version DESC")]

    def draft(self):
        r = self._q("SELECT * FROM config_draft WHERE id = 1", one=True)
        if r:
            return {"body": json.loads(r["body"]), "basedOn": r["based_on"], "updatedBy": r["updated_by"], "updatedAt": r["updated_at"]}
        pub = self.published()
        return {"body": pub["body"], "basedOn": pub["version"], "updatedBy": None, "updatedAt": None}

    def save_draft(self, body, user, based_on):
        self._q("INSERT INTO config_draft (id, body, based_on, updated_by, updated_at) VALUES (1, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET body=excluded.body, based_on=excluded.based_on, "
                "updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                (json.dumps(body), based_on, user, now()))

    def discard_draft(self):
        self._q("DELETE FROM config_draft WHERE id = 1")

    def publish_body(self, body, user, note):
        body = {**body}
        with self._lock:
            cur = self._db.execute("INSERT INTO config_version (body, note, published_by, published_at) VALUES ('{}', ?, ?, ?)",
                                   (note, user, now()))
            v = cur.lastrowid
            body["version"] = v
            self._db.execute("UPDATE config_version SET body = ? WHERE version = ?", (json.dumps(body), v))
            self._db.execute("DELETE FROM config_draft WHERE id = 1")
            self._db.commit()
        return v

    # ------------------------------------------------- journey data
    def add_lead(self, user, version, profile, recs):
        self._q("INSERT INTO lead (user_id, user_email, config_version, profile, recommendations, created_at) VALUES (?,?,?,?,?,?)",
                (user["id"], user.get("email"), version, json.dumps(profile), json.dumps(recs), now()))

    def last_profile(self, user_id):
        r = self._q("SELECT profile FROM lead WHERE user_id = ? ORDER BY id DESC LIMIT 1", (user_id,), one=True)
        return json.loads(r["profile"]) if r else None

    def add_quote(self, qid, user_id, pid, req, res):
        self._q("INSERT INTO quote (id, user_id, product_id, request, response, total, created_at) VALUES (?,?,?,?,?,?,?)",
                (qid, user_id, pid, json.dumps(req), json.dumps(res), res["total"], now()))

    def get_quote(self, qid, user_id):
        r = self._q("SELECT * FROM quote WHERE id = ? AND user_id = ?", (qid, user_id), one=True)
        return {**dict(r), "response": json.loads(r["response"])} if r else None

    def mark_quote_used(self, qid):
        self._q("UPDATE quote SET used = 1 WHERE id = ?", (qid,))

    def add_policy(self, user_id, pid, pname, quote_id, policy_no, status, txn, total):
        self._q("INSERT INTO policy (user_id, product_id, product_name, quote_id, policy_no, status, txn_id, total, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)", (user_id, pid, pname, quote_id, policy_no, status, txn, total, now()))

    def policies(self, user_id):
        return [dict(r) for r in self._q("SELECT product_id, product_name, policy_no, status, total, created_at FROM policy "
                                         "WHERE user_id = ? ORDER BY id", (user_id,))]

    def activity(self, limit=50):
        leads = [{"user": r["user_email"] or r["user_id"], "configVersion": r["config_version"], "at": r["created_at"],
                  "recommended": [x["productId"] + ":" + x["tag"] for x in json.loads(r["recommendations"])]}
                 for r in self._q("SELECT * FROM lead ORDER BY id DESC LIMIT ?", (limit,))]
        pols = [dict(r) for r in self._q("SELECT user_id, product_name, policy_no, status, total, created_at FROM policy "
                                         "ORDER BY id DESC LIMIT ?", (limit,))]
        return {"leads": leads, "policies": pols}
