import json
import time

import jwt
import pytest

from app import create_app
from app.settings import BACKEND_DIR, REPO_DIR, Settings, _validate

def needs_pages(variant):
    """Skip when this package ships only the other option's HTML pages."""
    return pytest.mark.skipif(not (REPO_DIR / "frontend" / variant).is_dir(), reason=f"frontend/{variant} not in this package")

SECRET = "x" * 40
H = {"X-HOJ-Request": "1"}
DEFAULT = json.loads((BACKEND_DIR / "app" / "default_config.json").read_text())


def make_app(tmp_path, **kw):
    s = Settings(app_env="development", secret_key=SECRET, auth_mode="dev", cookie_secure=False,
                 database_path=str(tmp_path / "t.sqlite3"),
                 dev_users=["employee:pw-employee:user", "admin:pw-admin:admin"])
    for k, v in kw.items():
        setattr(s, k, v)
    _validate(s)
    return create_app(s)


@pytest.fixture
def app(tmp_path):
    return make_app(tmp_path)


def login(client, scope, user, pw):
    url = "/admin/api/auth/login" if scope == "admin" else "/api/auth/login"
    return client.post(url, json={"username": user, "password": pw}, headers=H)


def sample_profile(client):
    vals = client.get("/api/profile/me").get_json()["values"]
    cfg = client.get("/api/journey-config").get_json()["config"]
    return {fid: vals.get(f["prefill"], False if f["type"] == "toggle" else "") if f.get("prefill") else (False if f["type"] == "toggle" else "")
            for fid, f in cfg["fields"].items()}


# ------------------------------------------------------------------ auth
def test_requires_sign_in(app):
    c = app.test_client()
    assert c.get("/api/journey-config").status_code == 401
    assert c.get("/admin/api/config").status_code == 401


def test_csrf_header_required(app):
    c = app.test_client()
    assert c.post("/api/auth/login", json={"username": "employee", "password": "pw-employee"}).status_code == 403


def test_wrong_and_empty_password_rejected(app):
    c = app.test_client()
    assert login(c, "portal", "employee", "nope").status_code == 401
    assert login(c, "portal", "employee", "").status_code == 401


def test_employee_cannot_open_admin(app):
    c = app.test_client()
    assert login(c, "admin", "employee", "pw-employee").status_code == 403
    assert login(c, "portal", "employee", "pw-employee").status_code == 200
    assert c.get("/admin/api/config").status_code == 401        # portal session does not grant admin


def test_dev_mode_refused_outside_development():
    with pytest.raises(RuntimeError):
        _validate(Settings(app_env="production", secret_key=SECRET, auth_mode="dev"))


# --------------------------------------------------------------- journey
def test_portal_config_hides_rules(app):
    c = app.test_client(); login(c, "portal", "employee", "pw-employee")
    body = c.get("/api/journey-config").get_json()
    assert "rules" not in body["config"] and body["version"] == 1


def test_full_journey(app):
    c = app.test_client(); login(c, "portal", "employee", "pw-employee")
    profile = sample_profile(c)
    recs = c.post("/api/recommendations", json={"profile": profile}, headers=H).get_json()
    tags = {r["productId"]: r["tag"] for r in recs["recommendations"]}
    assert tags == {"health": "Recommended", "travel": "Relevant", "motor": "Relevant", "home": "Optional"}
    assert recs["derived"] == {"family_count": 3, "vehicle_count": 2}

    q = c.post("/api/quotes", json={"productId": "health", "selection": {}}, headers=H).get_json()
    assert q["total"] == q["premium"] + q["gst"] and q["quoteId"]
    q2 = c.post("/api/quotes", json={"productId": "motor", "selection": {}}, headers=H).get_json()

    bad = c.post("/api/checkout", json={"quoteIds": [q["quoteId"]], "consents": [True, False, True]}, headers=H)
    assert bad.status_code == 400
    ok = c.post("/api/checkout", json={"quoteIds": [q["quoteId"], q2["quoteId"]], "consents": [True] * 3, "kyc": {"pan": "ABCDE1234F"}}, headers=H)
    assert ok.status_code == 200
    body = ok.get_json()
    assert body["payment"]["amount"] == q["total"] + q2["total"]
    assert [p["status"] for p in body["policies"]] == ["Issued", "Processing"]
    again = c.post("/api/checkout", json={"quoteIds": [q["quoteId"]], "consents": [True] * 3}, headers=H)
    assert again.status_code == 409                               # a quote can be paid only once
    assert len(c.get("/api/policies/me").get_json()["policies"]) == 2


def test_required_fields_enforced_server_side(app):
    c = app.test_client(); login(c, "portal", "employee", "pw-employee")
    p = sample_profile(c); p["pincode"] = ""
    r = c.post("/api/recommendations", json={"profile": p}, headers=H)
    assert r.status_code == 400 and "Residential pincode" in r.get_json()["error"]


def test_tampered_selection_rejected(app):
    c = app.test_client(); login(c, "portal", "employee", "pw-employee")
    c.post("/api/recommendations", json={"profile": sample_profile(c)}, headers=H)
    r = c.post("/api/quotes", json={"productId": "health", "selection": {"comps": {"retail": {"included": True, "si": 999}}}}, headers=H)
    assert r.status_code == 400
    r = c.post("/api/quotes", json={"productId": "health", "selection": {"members": ["self", "stranger"]}}, headers=H)
    assert r.status_code == 400


def test_other_users_quote_not_usable(app):
    a, b = app.test_client(), app.test_client()
    login(a, "portal", "employee", "pw-employee"); login(b, "portal", "admin", "pw-admin")
    a.post("/api/recommendations", json={"profile": sample_profile(a)}, headers=H)
    qid = a.post("/api/quotes", json={"productId": "health", "selection": {}}, headers=H).get_json()["quoteId"]
    assert b.post("/api/checkout", json={"quoteIds": [qid], "consents": [True] * 3}, headers=H).status_code == 409


# ------------------------------------------------- admin: draft → publish
def test_publish_reaches_portal_without_redeploy(app):
    adm, emp = app.test_client(), app.test_client()
    login(adm, "admin", "admin", "pw-admin"); login(emp, "portal", "employee", "pw-employee")
    draft = adm.get("/admin/api/config").get_json()["draft"]
    cfg = draft["body"]
    cfg["steps"][1]["title"] = "Tell us about you"
    for r in cfg["rules"]:
        if r["product"] == "home":
            r["tag"] = "Recommended"
    saved = adm.put("/admin/api/config/draft", json={"config": cfg, "basedOn": draft["basedOn"]}, headers=H).get_json()
    assert saved["errors"] == []
    # not live until published
    assert emp.get("/api/journey-config").get_json()["config"]["steps"][1]["title"] == "My Protection Profile"
    v = adm.post("/admin/api/config/publish", json={"note": "test"}, headers=H).get_json()["version"]
    assert v == 2
    live = emp.get("/api/journey-config").get_json()
    assert live["version"] == 2 and live["config"]["steps"][1]["title"] == "Tell us about you"
    recs = emp.post("/api/recommendations", json={"profile": sample_profile(emp)}, headers=H).get_json()["recommendations"]
    assert {r["productId"]: r["tag"] for r in recs}["home"] == "Recommended"
    # rollback
    assert adm.post("/admin/api/config/rollback", json={"version": 1}, headers=H).get_json()["version"] == 3
    assert emp.get("/api/journey-config").get_json()["config"]["steps"][1]["title"] == "My Protection Profile"


def test_invalid_draft_cannot_publish(app):
    adm = app.test_client(); login(adm, "admin", "admin", "pw-admin")
    cfg = adm.get("/admin/api/config").get_json()["draft"]["body"]
    cfg["rules"][0]["when"][0]["field"] = "does_not_exist"
    errs = adm.put("/admin/api/config/draft", json={"config": cfg}, headers=H).get_json()["errors"]
    assert errs
    r = adm.post("/admin/api/config/publish", json={}, headers=H)
    assert r.status_code == 400 and r.get_json()["errors"]


def test_stale_draft_conflict(app):
    a1, a2 = app.test_client(), app.test_client()
    login(a1, "admin", "admin", "pw-admin"); login(a2, "admin", "admin", "pw-admin")
    d = a1.get("/admin/api/config").get_json()["draft"]
    a1.put("/admin/api/config/draft", json={"config": d["body"], "basedOn": d["basedOn"]}, headers=H)
    assert a1.post("/admin/api/config/publish", json={}, headers=H).status_code == 200
    a2.put("/admin/api/config/draft", json={"config": d["body"], "basedOn": d["basedOn"]}, headers=H)
    assert a2.post("/admin/api/config/publish", json={}, headers=H).status_code == 409


def test_logs_are_masked(app):
    c = app.test_client(); login(c, "portal", "employee", "pw-employee")
    c.post("/api/recommendations", json={"profile": sample_profile(c)}, headers=H)
    q = c.post("/api/quotes", json={"productId": "home", "selection": {}}, headers=H).get_json()
    c.post("/api/checkout", json={"quoteIds": [q["quoteId"]], "consents": [True] * 3, "kyc": {"pan": "ABCDE1234F", "mobile": "9800000210"}}, headers=H)
    adm = app.test_client(); login(adm, "admin", "admin", "pw-admin")
    dump = json.dumps(adm.get("/admin/api/logs").get_json())
    assert "ABCDE1234F" not in dump and "9800000210" not in dump


# ------------------------------------------------------ deployment shape
@needs_pages("ad")
def test_portal_only_instance_has_no_admin(tmp_path):
    c = make_app(tmp_path, surfaces=["portal"]).test_client()
    assert c.get("/admin").status_code == 404
    assert c.get("/admin/api/config").status_code == 404
    assert c.get("/assets/shared/builder.js").status_code == 404
    assert c.get("/").status_code == 200


@needs_pages("ad")
def test_admin_only_instance_has_no_portal(tmp_path):
    c = make_app(tmp_path, surfaces=["admin"]).test_client()
    assert c.get("/").status_code == 404 and c.get("/admin").status_code == 200


# ------------------------------------------------------------- supabase
def supa_app(tmp_path):
    return make_app(tmp_path, auth_mode="supabase", supabase_url="https://proj.supabase.co", supabase_anon_key="anon",
                    supabase_jwt_secret=SECRET)


def token(sub="u1", role=None, **over):
    claims = {"sub": sub, "email": f"{sub}@corp.test", "aud": "authenticated", "iss": "https://proj.supabase.co/auth/v1",
              "exp": int(time.time()) + 300, "app_metadata": {"role": role} if role else {}, **over}
    return {"Authorization": "Bearer " + jwt.encode(claims, SECRET, algorithm="HS256"), **H}


def test_supabase_tokens(tmp_path):
    c = supa_app(tmp_path).test_client()
    assert c.get("/api/me", headers=token()).status_code == 200
    assert c.get("/admin/api/me", headers=token()).status_code == 403
    assert c.get("/admin/api/me", headers=token(role="admin")).status_code == 200
    assert c.get("/api/me", headers=token(exp=int(time.time()) - 10)).status_code == 401
    assert c.get("/api/me", headers=token(aud="anon")).status_code == 401
    assert c.get("/api/me", headers=token(iss="https://evil.example/auth/v1")).status_code == 401
    forged = {"Authorization": "Bearer " + jwt.encode({"sub": "x", "aud": "authenticated", "iss": "https://proj.supabase.co/auth/v1",
                                                       "exp": int(time.time()) + 60}, "y" * 40, algorithm="HS256")}
    assert c.get("/api/me", headers=forged).status_code == 401
    assert c.post("/api/auth/login", json={"username": "a", "password": "b"}, headers=H).status_code == 404
    pub = c.get("/api/public-config").get_json()
    assert pub["supabaseUrl"] == "https://proj.supabase.co" and "supabaseJwtSecret" not in json.dumps(pub)


@needs_pages("supabase")
def test_supabase_serves_supabase_pages(tmp_path):
    c = supa_app(tmp_path).test_client()
    assert b"supabase-js" in c.get("/").data and b"supabase-js" in c.get("/admin").data
    assert b"signInWithPassword" in c.get("/assets/auth.js").data
