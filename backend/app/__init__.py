"""HindujaOneJourney backend (Flask).

Serves the customer portal (`/`) and the admin console (`/admin`) and their
APIs. Which login the HTML uses is decided by AUTH_MODE (supabase | ad | dev);
which surfaces this instance exposes is decided by SERVE_SURFACES, so the
admin console can run on a separate, internal-only deployment.
"""
import json
import logging
from datetime import timedelta

from flask import Flask, jsonify, request

from . import routes
from .adapters import Adapters
from .auth import build_auth
from .settings import BACKEND_DIR, load_settings
from .store import Store

STATE_CHANGING = {"POST", "PUT", "PATCH", "DELETE"}


def create_app(settings=None, adapters=None):
    settings = settings or load_settings()
    app = Flask(__name__, static_folder=None)
    app.config.update(
        SECRET_KEY=settings.secret_key,
        SESSION_COOKIE_NAME="hoj_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=settings.cookie_secure,
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        MAX_CONTENT_LENGTH=512 * 1024,
    )
    logging.basicConfig(level=logging.INFO)

    store = Store(settings.database_path)
    store.seed(json.loads((BACKEND_DIR / "app" / "default_config.json").read_text()))
    app.extensions["hoj.settings"] = settings
    app.extensions["hoj.store"] = store
    app.extensions["hoj.auth"] = build_auth(settings)
    app.extensions["hoj.adapters"] = adapters or Adapters()

    routes.register(app, settings)

    @app.before_request
    def csrf_guard():
        # Cookie sessions (ad/dev) need CSRF protection: browsers won't send this custom
        # header cross-site without a CORS preflight, which this app never allows.
        if request.method in STATE_CHANGING and "/api/" in request.path and request.headers.get("X-HOJ-Request") != "1":
            return jsonify(error="Missing request header"), 403

    @app.after_request
    def security_headers(resp):
        connect = "'self'" + (f" {settings.supabase_url}" if settings.auth_mode == "supabase" else "")
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; "
            f"img-src 'self' data:; connect-src {connect}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        if request.path.startswith(("/api/", "/admin/api/")):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.errorhandler(404)
    def not_found(_):
        return jsonify(error="Not found"), 404

    @app.errorhandler(413)
    def too_large(_):
        return jsonify(error="Request too large"), 413

    @app.errorhandler(500)
    def server_error(_):
        return jsonify(error="Something went wrong"), 500

    return app
