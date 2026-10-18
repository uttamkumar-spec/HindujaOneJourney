"""Runtime settings, read once from the environment.

Values come from the process environment, optionally loaded from an env file
(default: backend/.env.dev, override with ENV_FILE). Secrets live only there —
never in the frontend or in this repository.
"""
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent

AUTH_MODES = ("supabase", "ad", "dev")


def _bool(name, default=False):
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


def _list(name, default=""):
    return [x.strip() for x in os.getenv(name, default).split(",") if x.strip()]


@dataclass
class Settings:
    app_env: str = "production"
    secret_key: str = ""
    auth_mode: str = "dev"
    surfaces: list = field(default_factory=lambda: ["portal", "admin"])
    database_path: str = str(BACKEND_DIR / "instance" / "hoj.sqlite3")
    cookie_secure: bool = True

    # Supabase
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_jwt_secret: str = ""          # only for legacy HS256 projects
    supabase_admin_role: str = "admin"     # value of app_metadata.role that grants admin

    # Active Directory (LDAP)
    ldap_url: str = ""
    ldap_upn_suffix: str = ""              # e.g. @corp.example.com
    ldap_base_dn: str = ""
    ldap_admin_group_dn: str = ""
    ldap_portal_group_dn: str = ""         # optional: restrict portal to a group
    ldap_ca_cert_file: str = ""
    ldap_timeout: int = 5

    # Dev mode only
    dev_users: list = field(default_factory=list)

    @property
    def is_dev(self):
        return self.app_env == "development"

    @property
    def frontend_variant(self):
        return "supabase" if self.auth_mode == "supabase" else "ad"


def load_settings(**overrides):
    env_file = os.getenv("ENV_FILE", str(BACKEND_DIR / ".env.dev"))
    if Path(env_file).exists():
        load_dotenv(env_file, override=False)

    s = Settings(
        app_env=os.getenv("APP_ENV", "production"),
        secret_key=os.getenv("SECRET_KEY", ""),
        auth_mode=os.getenv("AUTH_MODE", "dev").strip().lower(),
        surfaces=_list("SERVE_SURFACES", "portal,admin"),
        database_path=os.getenv("DATABASE_PATH", str(BACKEND_DIR / "instance" / "hoj.sqlite3")),
        cookie_secure=_bool("COOKIE_SECURE", True),
        supabase_url=os.getenv("SUPABASE_URL", "").rstrip("/"),
        supabase_anon_key=os.getenv("SUPABASE_ANON_KEY", ""),
        supabase_jwt_secret=os.getenv("SUPABASE_JWT_SECRET", ""),
        supabase_admin_role=os.getenv("SUPABASE_ADMIN_ROLE", "admin"),
        ldap_url=os.getenv("LDAP_URL", ""),
        ldap_upn_suffix=os.getenv("LDAP_UPN_SUFFIX", ""),
        ldap_base_dn=os.getenv("LDAP_BASE_DN", ""),
        ldap_admin_group_dn=os.getenv("LDAP_ADMIN_GROUP_DN", ""),
        ldap_portal_group_dn=os.getenv("LDAP_PORTAL_GROUP_DN", ""),
        ldap_ca_cert_file=os.getenv("LDAP_CA_CERT_FILE", ""),
        ldap_timeout=int(os.getenv("LDAP_TIMEOUT", "5")),
        dev_users=_list("DEV_USERS"),
    )
    for k, v in overrides.items():
        setattr(s, k, v)
    _validate(s)
    return s


def _validate(s):
    if s.auth_mode not in AUTH_MODES:
        raise RuntimeError(f"AUTH_MODE must be one of {AUTH_MODES}, got {s.auth_mode!r}")
    if not s.secret_key or len(s.secret_key) < 32:
        raise RuntimeError("SECRET_KEY must be set (at least 32 random characters)")
    bad = set(s.surfaces) - {"portal", "admin"}
    if bad or not s.surfaces:
        raise RuntimeError("SERVE_SURFACES must contain 'portal' and/or 'admin'")
    if s.auth_mode == "dev" and not s.is_dev:
        raise RuntimeError("AUTH_MODE=dev is only allowed with APP_ENV=development")
    if s.auth_mode == "supabase" and not (s.supabase_url and s.supabase_anon_key):
        raise RuntimeError("AUTH_MODE=supabase needs SUPABASE_URL and SUPABASE_ANON_KEY")
    if s.auth_mode == "ad" and not (s.ldap_url and s.ldap_base_dn and s.ldap_admin_group_dn):
        raise RuntimeError("AUTH_MODE=ad needs LDAP_URL, LDAP_BASE_DN and LDAP_ADMIN_GROUP_DN")
