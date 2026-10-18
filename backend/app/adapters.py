"""Integration adapters — one class per upstream system.

Every class here is a MOCK. IT replaces the body of each `Mock*` class (or
adds a real class and selects it in `build_adapters`) with the real call:
HR/GMC profile source, the SOAP rating service, KYC, payment gateway and the
policy admin system. Routes and screens do not change.

All rates and numbers produced here are illustrative, not real tariffs.
"""
import re
import secrets
import time
from collections import deque
from datetime import date, datetime, timedelta, timezone


def _ref(prefix):
    return f"{prefix}-{secrets.token_hex(3).upper()}"


# --------------------------------------------------------------- call log
_PAN = re.compile(r"\b([A-Z]{3})[A-Z]{2}\d{4}[A-Z]\b")
_EMAIL = re.compile(r"\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@")
_PHONE = re.compile(r"\b(\d{2})\d{6}(\d{2})\b")


def mask(obj):
    """Mask PAN / e-mail / mobile numbers before anything is shown in the admin console."""
    if isinstance(obj, dict):
        return {k: mask(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [mask(v) for v in obj]
    if isinstance(obj, str):
        s = _PAN.sub(r"\1•••••••", obj)
        s = _EMAIL.sub(r"\1•••@", s)
        return _PHONE.sub(r"\1••••••\2", s)
    return obj


class CallLog:
    def __init__(self, size=200):
        self._items = deque(maxlen=size)

    def record(self, system, operation, request, response=None, error=None, ms=0, extra=None):
        self._items.appendleft({
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "system": system, "operation": operation, "ms": ms,
            "request": mask(request), "response": mask(response), "error": error, **(extra or {}),
        })

    def recent(self, limit=100):
        return list(self._items)[:limit]


def _timed(log, system, operation, request, fn, extra=None):
    t0 = time.perf_counter()
    try:
        res = fn()
        log.record(system, operation, request, res, ms=round((time.perf_counter() - t0) * 1000),
                   extra=extra(res) if extra else None)
        return res
    except Exception as e:  # noqa: BLE001 — logged and re-raised
        log.record(system, operation, request, error=str(e), ms=round((time.perf_counter() - t0) * 1000))
        raise


# ------------------------------------------------------------ profile
class MockProfileSource:
    """Pre-filled employee data. Real source: HRMS / group GMC policy system (to be confirmed).

    Must return flat key -> value pairs. Field `prefill` keys in the journey
    config map onto these keys.
    """
    SAMPLE = {
        "employee.age": 37, "spouse.covered": True, "spouse.age": 35, "children.count": 1, "children.ages": "8",
        "parents.covered": False, "gmc.sumInsuredLakh": 5, "gmc.members": "Self + spouse + child",
        "personalHealth.status": "None declared", "address.pincode": "400001",
        "vehicles.twoWheeler.owned": True, "vehicles.twoWheeler.reg": "MH 01 AB 1234",
        "vehicles.fourWheeler.owned": True, "vehicles.fourWheeler.reg": "MH 02 CD 5678",
        "travel.international": True, "travel.tripsPerYear": 2, "home.owned": True, "home.pincode": "400001",
        "kyc.pan": "ABCDE1234F", "kyc.mobile": "9800000210", "kyc.address": "Use profile address",
    }

    def get(self, user):
        return {**self.SAMPLE, "employee.name": user.get("name") or user.get("email") or "Employee",
                "kyc.email": user.get("email") or ""}


# ------------------------------------------------------------- rating
def _member_factor(n):
    return [1, 1, 1.6, 1.9, 2.3][n] if n < 5 else 2.3 + 0.35 * (n - 4)


def _age_factor(members):
    a = max([m.get("age") or 0 for m in members] or [0])
    return 1 if a < 36 else 1.25 if a < 46 else 1.7 if a < 56 else 2.4


def _n(v):
    try:
        return float(re.sub(r"[^\d.]", "", str(v)) or 0)
    except ValueError:
        return 0.0


MOCK_RATES = {
    "health_base": lambda c, r: _n(c["sumInsured"]) * 900 * _member_factor(len(r["members"])) * _age_factor(r["members"])
    * {"Essential": 0.85, "Premier": 1.3}.get(c.get("option"), 1),
    "health_topup": lambda c, r: _n(c["sumInsured"]) * 110 * _member_factor(len(r["members"])) * _age_factor(r["members"])
    * (5 / max(_n(c.get("option")) or 5, 1)),
    "pa": lambda c, r: _n(c["sumInsured"]) * 320,
    "hospicash": lambda c, r: _n(c["sumInsured"]) * 1.1 * max(len(r["members"]), 1),
    "travel": lambda c, r: {"Standard": 1200, "Plus": 1800, "Max": 2600}.get(c.get("sumInsured"), 1500)
    * max(r.get("travellers") or 1, 1) * (2.8 if c.get("option") == "Annual multi-trip" else 1),
    "motor_2w": lambda c, r: 720 if c.get("option") == "Third-party only" else 1850,
    "motor_4w": lambda c, r: 3420 if c.get("option") == "Third-party only" else 14500,
    "home_building": lambda c, r: _n(c["sumInsured"]) * 95,
    "home_contents": lambda c, r: _n(c["sumInsured"]) * 160,
}


def _xml(name, v, ind="      "):
    if isinstance(v, list):
        return "\n".join(_xml(name, x, ind) for x in v)
    if isinstance(v, dict):
        inner = "\n".join(_xml(k, x, ind + "  ") for k, x in v.items())
        return f"{ind}<rat:{name}>\n{inner}\n{ind}</rat:{name}>"
    s = "" if v is None else str(v).replace("&", "&amp;").replace("<", "&lt;")
    return f"{ind}<rat:{name}>{s}</rat:{name}>"


def illustrative_envelope(op, body):
    """Shape only — the real envelope, namespace and auth header come from the rating service's WSDL."""
    inner = "\n".join(_xml(k, v) for k, v in body.items())
    return ('<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" '
            'xmlns:rat="urn:PLACEHOLDER:rating">\n  <soapenv:Header><!-- WS-Security as required --></soapenv:Header>\n'
            f'  <soapenv:Body>\n    <rat:{op}>\n{inner}\n    </rat:{op}>\n  </soapenv:Body>\n</soapenv:Envelope>')


class MockRatingService:
    """Premium calculation. Real source: the core rating SOAP service.

    To integrate: generate a client from the WSDL (e.g. with `zeep` in Python,
    or keep this as the contract if IT implements it in Spring Boot), map
    request['covers'][*]['code'] to the service's cover codes, add WS-Security,
    and return the same dict shape as below.
    """

    def quote(self, req):
        lines = [{"code": c["code"], "name": c["name"],
                  "premium": round(MOCK_RATES.get(c.get("rateKey"), lambda *_: 1000)(c, req))} for c in req["covers"]]
        return {"lines": lines, "premium": sum(x["premium"] for x in lines), "mock": True}

    def envelope(self, req):
        return illustrative_envelope("GetQuote", {
            "ProductCode": req["productCode"], "Pincode": req["proposer"].get("pincode"),
            "Member": [{"Relation": m["relation"], "Age": m["age"]} for m in req["members"]],
            "Travellers": req.get("travellers") or 0,
            "Cover": [{"CoverCode": c["code"], "SumInsured": c.get("sumInsured"), "Option": c.get("option")} for c in req["covers"]],
        })


# ---------------------------------------------------- kyc / pay / policy
class MockKyc:
    """Real source: CKYC / in-house KYC service (to be confirmed)."""

    def verify(self, req):
        return {"status": "VERIFIED", "kycRef": _ref("KYC")}


class MockPayments:
    """Real source: payment gateway (to be confirmed). Production: create order -> redirect -> callback."""

    def charge(self, req):
        return {"status": "SUCCESS", "txnId": _ref("TXN"), "amount": req["amount"]}


class MockPolicyAdmin:
    """Real source: policy admin system (to be confirmed). One call per product."""

    def issue(self, req):
        processing = req["productCode"] == "MOTOR"   # demo of the non-instant path
        return {"status": "Processing" if processing else "Issued", "policyNo": None if processing else _ref("POL")}


# ---------------------------------------------------------- facade
class Adapters:
    def __init__(self, profile=None, rating=None, kyc=None, payments=None, policy=None):
        self.log = CallLog()
        self.profile_src = profile or MockProfileSource()
        self.rating_svc = rating or MockRatingService()
        self.kyc_svc = kyc or MockKyc()
        self.pay_svc = payments or MockPayments()
        self.policy_svc = policy or MockPolicyAdmin()

    def profile(self, user):
        return _timed(self.log, "Employee profile", "GET profile", {"user": user.get("email") or user.get("id")},
                      lambda: self.profile_src.get(user))

    def rate(self, req):
        return _timed(self.log, "Rating (SOAP)", "GetQuote", req, lambda: self.rating_svc.quote(req),
                      extra=lambda res: {"soapRequest": mask(self.rating_svc.envelope(req))}
                      if hasattr(self.rating_svc, "envelope") else None)

    def kyc(self, req):
        return _timed(self.log, "KYC", "verify", req, lambda: self.kyc_svc.verify(req))

    def charge(self, req):
        return _timed(self.log, "Payment", "charge", req, lambda: self.pay_svc.charge(req))

    def issue(self, req):
        return _timed(self.log, "Policy admin", "issue", req, lambda: self.policy_svc.issue(req))


def quote_valid_till():
    return (date.today() + timedelta(days=1)).isoformat()
