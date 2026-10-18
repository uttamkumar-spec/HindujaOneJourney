"""Authentication for the two deployment options.

- supabase: the browser signs in with Supabase (email + password) and sends
  the access token as `Authorization: Bearer`. The backend verifies the JWT
  (JWKS for asymmetric keys, or the legacy HS256 secret). Admin = the user's
  `app_metadata.role` equals SUPABASE_ADMIN_ROLE (only settable server-side,
  e.g. from the Supabase dashboard / service role — users cannot edit it).
- ad: the browser posts username + password to this backend, which binds to
  Active Directory over LDAPS. Admin = member (incl. nested) of
  LDAP_ADMIN_GROUP_DN. A signed, HttpOnly session cookie follows.
- dev: like `ad`, but against DEV_USERS from the env file. Refused unless
  APP_ENV=development.

Portal and admin are separate scopes with separate sessions: signing in to
the portal never grants the admin console.
"""
import hmac
import re
import ssl
from functools import wraps

import jwt
from flask import current_app, g, jsonify, request, session

SCOPES = ("portal", "admin")
_USERNAME = re.compile(r"^[A-Za-z0-9._@-]{1,128}$")


class AuthError(Exception):
    def __init__(self, message, status=401):
        super().__init__(message)
        self.status = status


# ------------------------------------------------------------ supabase
class SupabaseAuth:
    uses_session = False

    def __init__(self, settings):
        self.s = settings
        self.issuer = f"{settings.supabase_url}/auth/v1"
        self._jwks = jwt.PyJWKClient(f"{self.issuer}/.well-known/jwks.json", cache_keys=True, lifespan=600)

    def verify(self, token):
        try:
            alg = jwt.get_unverified_header(token).get("alg")
            if alg == "HS256":
                if not self.s.supabase_jwt_secret:
                    raise AuthError("HS256 token but SUPABASE_JWT_SECRET is not configured")
                key, algs = self.s.supabase_jwt_secret, ["HS256"]
            else:
                key, algs = self._jwks.get_signing_key_from_jwt(token).key, ["ES256", "RS256"]
            return jwt.decode(token, key, algorithms=algs, audience="authenticated", issuer=self.issuer,
                              options={"require": ["exp", "sub", "aud", "iss"]})
        except AuthError:
            raise
        except jwt.PyJWTError as e:
            raise AuthError(f"Invalid session: {e.__class__.__name__}") from e

    def current_user(self, scope):
        h = request.headers.get("Authorization", "")
        if not h.startswith("Bearer "):
            return None
        c = self.verify(h[7:].strip())
        meta, umeta = c.get("app_metadata") or {}, c.get("user_metadata") or {}
        return {"id": c["sub"], "email": c.get("email"), "name": umeta.get("full_name") or umeta.get("name") or c.get("email"),
                "isAdmin": meta.get("role") == self.s.supabase_admin_role, "provider": "supabase"}


# ---------------------------------------------- session (ad + dev)
class SessionAuth:
    uses_session = True

    def __init__(self, settings):
        self.s = settings

    def current_user(self, scope):
        return session.get(f"{scope}_user")

    def login(self, scope, username, password):
        if not username or not password:          # an empty password is an *anonymous* LDAP bind — never allow it
            raise AuthError("Enter your username and password")
        if not _USERNAME.match(username):
            raise AuthError("Invalid username or password")
        user = self._authenticate(username, password, scope)
        if scope == "admin" and not user["isAdmin"]:
            raise AuthError("You are not authorised for the admin console", 403)
        session.permanent = True
        session[f"{scope}_user"] = user
        return user

    def logout(self, scope):
        session.pop(f"{scope}_user", None)

    def _authenticate(self, username, password, scope):
        if self.s.auth_mode == "dev":
            return self._dev(username, password)
        return self._ldap(username, password, scope)

    def _dev(self, username, password):
        for entry in self.s.dev_users:
            u, _, rest = entry.partition(":")
            pw, _, role = rest.rpartition(":")
            if hmac.compare_digest(u, username) and hmac.compare_digest(pw, password):
                return {"id": f"dev:{u}", "email": f"{u}@example.invalid", "name": u.title(), "isAdmin": role == "admin", "provider": "dev"}
        raise AuthError("Invalid username or password")

    def _ldap(self, username, password, scope):
        from ldap3 import NONE, Connection, Server, Tls
        from ldap3.core.exceptions import LDAPBindError, LDAPException
        from ldap3.utils.conv import escape_filter_chars

        s = self.s
        tls = Tls(validate=ssl.CERT_REQUIRED, ca_certs_file=s.ldap_ca_cert_file or None)
        server = Server(s.ldap_url, use_ssl=s.ldap_url.lower().startswith("ldaps://"), tls=tls,
                        get_info=NONE, connect_timeout=s.ldap_timeout)
        upn = username if "@" in username else f"{username}{s.ldap_upn_suffix}"
        try:
            conn = Connection(server, user=upn, password=password, auto_bind=True, receive_timeout=s.ldap_timeout)
        except LDAPBindError as e:
            raise AuthError("Invalid username or password") from e
        except LDAPException as e:
            current_app.logger.warning("LDAP unavailable: %s", e)
            raise AuthError("Directory service unavailable, please try again", 503) from e
        try:
            who = (f"(userPrincipalName={escape_filter_chars(upn)})" if "@" in username
                   else f"(sAMAccountName={escape_filter_chars(username)})")
            conn.search(s.ldap_base_dn, f"(&(objectClass=user){who})", attributes=["displayName", "mail", "objectGUID"])
            if not conn.entries:
                raise AuthError("Invalid username or password")
            entry = conn.entries[0]
            attrs = entry.entry_attributes_as_dict

            def member_of(group_dn):   # 1.2.840.113556.1.4.1941 = LDAP_MATCHING_RULE_IN_CHAIN (nested groups)
                conn.search(s.ldap_base_dn, f"(&{who}(memberOf:1.2.840.113556.1.4.1941:={escape_filter_chars(group_dn)}))",
                            attributes=["cn"])
                return bool(conn.entries)

            if scope == "portal" and s.ldap_portal_group_dn and not member_of(s.ldap_portal_group_dn):
                raise AuthError("You are not authorised for this portal", 403)
            raw_guid = (entry.entry_raw_attributes.get("objectGUID") or [b""])[0]
            uid = raw_guid.hex() if raw_guid else entry.entry_dn
            return {"id": f"ad:{uid}","email": (attrs.get("mail") or [upn])[0],
                    "name": (attrs.get("displayName") or [username])[0],
                    "isAdmin": member_of(s.ldap_admin_group_dn), "provider": "ad"}
        finally:
            conn.unbind()


def build_auth(settings):
    return SupabaseAuth(settings) if settings.auth_mode == "supabase" else SessionAuth(settings)


# ------------------------------------------------------------ guards
def require(scope):
    """Route decorator: 401 if not signed in to `scope`, 403 if admin scope without admin rights."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            try:
                user = current_app.extensions["hoj.auth"].current_user(scope)
            except AuthError as e:
                return jsonify(error=str(e)), e.status
            if not user:
                return jsonify(error="Sign in required"), 401
            if scope == "admin" and not user.get("isAdmin"):
                return jsonify(error="You are not authorised for the admin console"), 403
            g.user = user
            return fn(*a, **kw)
        return wrapper
    return deco
