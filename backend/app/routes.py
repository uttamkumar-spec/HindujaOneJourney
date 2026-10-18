"""HTTP routes: pages, portal API (/api) and admin API (/admin/api)."""
import secrets

from flask import Blueprint, abort, current_app, g, jsonify, request, send_from_directory

from . import engine
from .adapters import quote_valid_till
from .auth import AuthError, require
from .settings import REPO_DIR

FRONTEND = REPO_DIR / "frontend"
PORTAL_ASSETS = {"app.css", "core.js", "journey.js"}
ADMIN_ASSETS = PORTAL_ASSETS | {"builder.js"}


def _ext(name):
    return current_app.extensions[f"hoj.{name}"]


def _body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400)
    return data


def _err(msg, status=400, **extra):
    return jsonify(error=msg, **extra), status


def register(app, settings):
    variant = settings.frontend_variant
    surfaces = set(settings.surfaces)
    allowed = ADMIN_ASSETS if "admin" in surfaces else PORTAL_ASSETS

    @app.get("/assets/shared/<path:name>")
    def shared_asset(name):
        if name not in allowed:
            abort(404)
        return send_from_directory(FRONTEND / "shared", name)

    @app.get("/assets/auth.js")
    def auth_asset():
        return send_from_directory(FRONTEND / variant, "auth.js")

    @app.get("/api/public-config")
    def public_config():
        # Only values that are safe in a browser. The Supabase anon key is designed to be public.
        out = {"authMode": settings.auth_mode, "surfaces": sorted(surfaces)}
        if settings.auth_mode == "supabase":
            out |= {"supabaseUrl": settings.supabase_url, "supabaseAnonKey": settings.supabase_anon_key}
        return jsonify(out)

    if "portal" in surfaces:
        app.add_url_rule("/", "portal_page", lambda: send_from_directory(FRONTEND / variant, "portal.html"))
        app.register_blueprint(_session_auth_bp("portal", "/api/auth"))
        app.register_blueprint(portal_bp)
    if "admin" in surfaces:
        app.add_url_rule("/admin", "admin_page", lambda: send_from_directory(FRONTEND / variant, "admin.html"))
        app.register_blueprint(_session_auth_bp("admin", "/admin/api/auth"))
        app.register_blueprint(admin_bp)


def _session_auth_bp(scope, prefix):
    """Username/password login for the ad and dev modes (Supabase logs in from the browser instead)."""
    bp = Blueprint(f"{scope}_auth", __name__, url_prefix=prefix)

    @bp.post("/login")
    def login():
        auth = _ext("auth")
        if not auth.uses_session:
            return _err("This deployment signs in with Supabase", 404)
        data = _body()
        try:
            user = auth.login(scope, str(data.get("username", "")).strip(), str(data.get("password", "")))
        except AuthError as e:
            return _err(str(e), e.status)
        return jsonify(user=user)

    @bp.post("/logout")
    def logout():
        auth = _ext("auth")
        if auth.uses_session:
            auth.logout(scope)
        return jsonify(ok=True)

    return bp


# ===================================================================== portal
portal_bp = Blueprint("portal_api", __name__, url_prefix="/api")


def _published():
    return _ext("store").published()


@portal_bp.get("/me")
@require("portal")
def me():
    return jsonify(user=g.user)


@portal_bp.get("/journey-config")
@require("portal")
def journey_config():
    pub = _published()
    return jsonify(config=engine.public_view(pub["body"]), version=pub["version"])


@portal_bp.get("/profile/me")
@require("portal")
def profile_me():
    return jsonify(values=_ext("adapters").profile(g.user))


def _clean_profile(cfg, raw):
    """Keep only configured fields, with the value type each field expects."""
    out = {}
    for fid, f in cfg["fields"].items():
        v = raw.get(fid)
        if f["type"] == "toggle":
            out[fid] = v is True
        elif f["type"] == "number":
            try:
                out[fid] = float(v) if v not in (None, "") else ""
                if out[fid] != "" and out[fid].is_integer():
                    out[fid] = int(out[fid])
            except (TypeError, ValueError):
                out[fid] = ""
        else:
            out[fid] = "" if v is None else str(v)[:200]
    return out


@portal_bp.post("/recommendations")
@require("portal")
def recommendations():
    pub = _published()
    cfg = pub["body"]
    profile = _clean_profile(cfg, _body().get("profile") or {})
    ctx = engine.context(profile)
    missing = [f["label"] for sec in cfg["sections"] for fid in sec["fields"]
               if (f := cfg["fields"].get(fid)) and f.get("required") and (not f.get("showIf") or engine.test(f["showIf"], ctx))
               and profile.get(fid) in ("", None)]
    if missing:
        return _err("Please complete: " + ", ".join(missing))
    recs = engine.recommend(cfg, profile)
    _ext("store").add_lead(g.user, pub["version"], profile, recs)
    return jsonify(recommendations=recs, members=engine.family_members(profile), derived={k: ctx[k] for k in engine.DERIVED},
                   version=pub["version"])


def build_quote(cfg, pid, selection, profile, persist_for=None):
    prod, covers, members = engine.resolve_selection(cfg, pid, selection, profile)
    if not covers:
        return {"quoteId": None, "productId": pid, "lines": [], "premium": 0, "gst": 0, "total": 0}
    ctx = engine.context(profile)
    req = {
        "productCode": prod.get("code") or prod["id"],
        "proposer": {"name": profile.get("emp_name"), "age": profile.get("emp_age"), "pincode": profile.get("pincode")},
        "members": members,
        "travellers": ctx["family_count"] if prod.get("usesTravellers") else None,
        "vehicles": [v for v in ({"type": "2W", "reg": profile.get("reg_2w")} if profile.get("own_2w") else None,
                                 {"type": "4W", "reg": profile.get("reg_4w")} if profile.get("own_4w") else None) if v]
        if prod.get("usesVehicles") else None,
        "covers": covers,
    }
    rated = _ext("adapters").rate(req)
    gst = round(rated["premium"] * float(prod.get("gstPct") or 0) / 100)
    res = {"quoteId": f"QT-{secrets.token_hex(6).upper()}", "productId": pid, "productCode": req["productCode"],
           "lines": rated["lines"], "premium": rated["premium"], "gst": gst, "total": rated["premium"] + gst,
           "currency": "INR", "validTill": quote_valid_till(), "mock": rated.get("mock", False)}
    if persist_for:
        _ext("store").add_quote(res["quoteId"], persist_for, pid, req, res)
    return res


@portal_bp.post("/quotes")
@require("portal")
def quotes():
    data = _body()
    profile = _ext("store").last_profile(g.user["id"])
    if profile is None:
        return _err("Confirm your profile first")
    try:
        return jsonify(build_quote(_published()["body"], data.get("productId"), data.get("selection"), profile, g.user["id"]))
    except ValueError as e:
        return _err(str(e))
    except Exception:  # noqa: BLE001 — upstream rating failure
        current_app.logger.exception("Rating failed")
        return _err("Rating service unavailable — please retry", 502)


def _consent_count(cfg):
    for st in cfg["steps"]:
        if st.get("enabled", True) and st["type"] == "checkout":
            return sum(len(b.get("items") or []) for b in st["blocks"] if b["type"] == "consents")
    return 0


@portal_bp.post("/checkout")
@require("portal")
def checkout():
    data, store, ad = _body(), _ext("store"), _ext("adapters")
    cfg = _published()["body"]
    consents = data.get("consents") or []
    if len(consents) < _consent_count(cfg) or not all(c is True for c in consents):
        return _err("Please accept all declarations to continue")
    qids = data.get("quoteIds") or []
    if not qids or len(set(qids)) != len(qids):
        return _err("Select at least one product")
    quotes_ = []
    for qid in qids:
        q = store.get_quote(str(qid), g.user["id"])
        if not q or q["used"]:
            return _err("A quote has expired — please review your selection again", 409)
        quotes_.append(q)
    amount = sum(q["total"] for q in quotes_)    # recomputed from stored quotes, never taken from the browser
    kyc_in = data.get("kyc") or {}
    try:
        ad.kyc({"pan": str(kyc_in.get("pan", ""))[:20], "mobile": str(kyc_in.get("mobile", ""))[:20], "email": str(kyc_in.get("email", ""))[:200]})
        pay = ad.charge({"amount": amount, "currency": "INR", "quoteIds": qids})
        if pay.get("status") != "SUCCESS":
            return _err("Payment was not completed", 402)
        out = []
        for q in quotes_:
            prod = engine.product(cfg, q["product_id"]) or {"name": q["product_id"], "code": q["product_id"]}
            r = ad.issue({"productCode": prod.get("code") or q["product_id"], "quoteId": q["id"], "paymentTxn": pay["txnId"]})
            store.mark_quote_used(q["id"])
            store.add_policy(g.user["id"], q["product_id"], prod["name"], q["id"], r.get("policyNo"), r["status"], pay["txnId"], q["total"])
            out.append({"productId": q["product_id"], "productName": prod["name"], **r})
    except Exception:  # noqa: BLE001
        current_app.logger.exception("Checkout failed")
        return _err("Checkout could not be completed — please try again", 502)
    return jsonify(payment={"txnId": pay["txnId"], "amount": amount}, policies=out)


@portal_bp.get("/policies/me")
@require("portal")
def my_policies():
    return jsonify(policies=_ext("store").policies(g.user["id"]))


# ====================================================================== admin
admin_bp = Blueprint("admin_api", __name__, url_prefix="/admin/api")


@admin_bp.get("/me")
@require("admin")
def admin_me():
    return jsonify(user=g.user)


@admin_bp.get("/config")
@require("admin")
def admin_config():
    store = _ext("store")
    pub, draft = store.published(), store.draft()
    return jsonify(draft=draft, published={k: pub[k] for k in ("version", "publishedBy", "publishedAt", "note")},
                   hasUnpublishedChanges=draft["updatedAt"] is not None)


@admin_bp.put("/config/draft")
@require("admin")
def save_draft():
    data = _body()
    cfg = data.get("config")
    if not isinstance(cfg, dict):
        return _err("Missing config")
    errors = engine.validate_config(cfg)
    _ext("store").save_draft(cfg, g.user["email"] or g.user["id"], data.get("basedOn"))
    return jsonify(saved=True, errors=errors)


@admin_bp.delete("/config/draft")
@require("admin")
def discard_draft():
    _ext("store").discard_draft()
    return jsonify(discarded=True)


@admin_bp.post("/config/publish")
@require("admin")
def publish():
    store = _ext("store")
    draft = store.draft()
    if draft["updatedAt"] is None:
        return _err("Nothing to publish — the draft matches the live version")
    errors = engine.validate_config(draft["body"])
    if errors:
        return _err("Fix these before publishing", errors=errors)
    pub = store.published()
    if draft["basedOn"] is not None and draft["basedOn"] != pub["version"]:
        return _err(f"Version {pub['version']} was published after you started editing. Reload to merge.", 409)
    v = store.publish_body(draft["body"], g.user["email"] or g.user["id"], str(_body().get("note", ""))[:300])
    return jsonify(version=v)


@admin_bp.get("/config/versions")
@require("admin")
def versions():
    return jsonify(versions=_ext("store").versions())


@admin_bp.get("/config/versions/<int:v>")
@require("admin")
def version_body(v):
    body = _ext("store").version(v)
    return jsonify(config=body) if body else _err("No such version", 404)


@admin_bp.post("/config/rollback")
@require("admin")
def rollback():
    store = _ext("store")
    v = _body().get("version")
    body = store.version(v) if isinstance(v, int) else None
    if not body:
        return _err("No such version", 404)
    nv = store.publish_body(body, g.user["email"] or g.user["id"], f"Rollback to version {v}")
    return jsonify(version=nv)


@admin_bp.get("/sample-profile")
@require("admin")
def sample_profile():
    return jsonify(values=_ext("adapters").profile_src.get({"name": "Sample Employee", "email": "sample@example.invalid"}))


@admin_bp.post("/preview/recommendations")
@require("admin")
def preview_recommendations():
    data = _body()
    cfg = data.get("config")
    if not isinstance(cfg, dict) or engine.validate_config(cfg):
        return _err("The draft has errors — fix them to preview")
    profile = _clean_profile(cfg, data.get("profile") or {})
    ctx = engine.context(profile)
    return jsonify(recommendations=engine.recommend(cfg, profile), members=engine.family_members(profile),
                   derived={k: ctx[k] for k in engine.DERIVED})


@admin_bp.post("/preview/quote")
@require("admin")
def preview_quote():
    data = _body()
    cfg = data.get("config")
    if not isinstance(cfg, dict) or engine.validate_config(cfg):
        return _err("The draft has errors — fix them to preview")
    try:
        return jsonify(build_quote(cfg, data.get("productId"), data.get("selection"), _clean_profile(cfg, data.get("profile") or {})))
    except ValueError as e:
        return _err(str(e))


@admin_bp.get("/activity")
@require("admin")
def activity():
    return jsonify(_ext("store").activity())


@admin_bp.get("/logs")
@require("admin")
def logs():
    return jsonify(calls=_ext("adapters").log.recent())
