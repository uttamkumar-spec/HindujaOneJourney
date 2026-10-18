"""Journey rules engine: conditions, recommendations, selections, config checks.

This is the single authority for recommendation rules — the portal never
receives the rules, it sends the confirmed profile and gets the result back.
The frontend re-implements only `test()` (for "show only if" on fields), with
the same semantics as here.
"""
import re

OPS = ("==", "!=", "<", "<=", ">", ">=")
STEP_TYPES = ("intro", "profile", "recommend", "customise", "review", "checkout", "done")
CORE_STEPS = ("profile", "recommend", "review", "checkout", "done")
FIELD_TYPES = ("text", "number", "toggle", "select")
DERIVED = ("family_count", "vehicle_count")


def coerce(v):
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return v
    s = str(v)
    if s == "true":
        return True
    if s == "false":
        return False
    try:
        return float(s) if s.strip() != "" else s
    except ValueError:
        return s


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def test(cond, ctx):
    a, b = coerce(ctx.get(cond.get("field"))), coerce(cond.get("value"))
    op = cond.get("op")
    if op == "==":
        if isinstance(a, bool) or isinstance(b, bool):   # never let True == 1
            return isinstance(a, bool) and isinstance(b, bool) and a == b
        return a == b
    if op == "!=":
        return not test({**cond, "op": "=="}, ctx)
    x, y = _num(a), _num(b)
    return {"<": x < y, "<=": x <= y, ">": x > y, ">=": x >= y}.get(op, False)


def _int(v):
    n = _num(v)
    return int(n) if n == n and n > 0 else 0


def ages(s):
    out = []
    for part in str(s or "").split(","):
        try:
            n = float(part.strip())
            if n > 0:
                out.append(int(n))
        except ValueError:
            pass
    return out


def context(profile):
    p = profile or {}
    n_child = _int(p.get("children_count"))
    parents = (len(ages(p.get("parent_ages"))) or 2) if p.get("has_parents") is True else 0
    return {
        **p,
        "family_count": 1 + (1 if p.get("has_spouse") is True else 0) + n_child + parents,
        "vehicle_count": (1 if p.get("own_2w") is True else 0) + (1 if p.get("own_4w") is True else 0),
    }


def family_members(profile):
    p = profile or {}
    out = [{"key": "self", "relation": "Self", "label": "Self", "age": _int(p.get("emp_age"))}]
    if p.get("has_spouse") is True:
        out.append({"key": "spouse", "relation": "Spouse", "label": "Spouse", "age": _int(p.get("spouse_age"))})
    ca = ages(p.get("child_ages"))
    for i in range(_int(p.get("children_count"))):
        out.append({"key": f"child{i}", "relation": "Child", "label": f"Child {i + 1}", "age": ca[i] if i < len(ca) else 0})
    if p.get("has_parents") is True:
        pa = ages(p.get("parent_ages")) or [0, 0]
        for i, a in enumerate(pa):
            out.append({"key": f"parent{i}", "relation": "Parent", "label": f"Parent {i + 1}", "age": a})
    return out


def tpl(text, ctx):
    def rep(m):
        v = ctx.get(m.group(1))
        if v is None or v == "":
            return "—"
        if v is True:
            return "Yes"
        if v is False:
            return "No"
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        return str(v)
    return re.sub(r"\{(\w+)\}", rep, str(text or ""))


def product(config, pid):
    return next((p for p in config["catalogue"] if p["id"] == pid), None)


def recommend(config, profile):
    """Return the product cards for a confirmed profile, in rule-priority order."""
    ctx, out, seen = context(profile), [], set()
    for r in config["rules"]:
        if not r.get("enabled", True):
            continue
        prod = product(config, r.get("product"))
        if not prod or not prod.get("enabled", True) or prod["id"] in seen:
            continue
        res = [test(c, ctx) for c in r.get("when", [])]
        if res and not (any(res) if r.get("match") == "any" else all(res)):
            continue
        seen.add(prod["id"])
        out.append({"productId": prod["id"], "tag": r["tag"], "ruleId": r["id"],
                    "headline": tpl(r.get("headline"), ctx), "reasons": [tpl(x, ctx) for x in r.get("reasons", [])]})
    if config.get("showUnmatched", True):
        for p in config["catalogue"]:
            if p.get("enabled", True) and p["id"] not in seen:
                out.append({"productId": p["id"], "tag": "Optional", "ruleId": None, "headline": "Available to you",
                            "reasons": ["Not triggered by your profile — available if you want it"]})
    return out


def visible_components(prod, profile):
    ctx = context(profile)
    return [c for c in prod["components"] if not c.get("showIf") or test(c["showIf"], ctx)]


def resolve_selection(config, pid, selection, profile):
    """Validate a customer's selection against the catalogue. Returns (covers, members) or raises ValueError.

    The browser's selection is never trusted: every component, amount and
    option must exist in the published catalogue.
    """
    prod = product(config, pid)
    if not prod or not prod.get("enabled", True):
        raise ValueError("Unknown product")
    sel = selection or {}
    comps = sel.get("comps") or {}
    covers = []
    for c in visible_components(prod, profile):
        cs = comps.get(c["id"]) or {}
        included = bool(cs.get("included", c.get("included"))) if c.get("optional") else True
        if not included:
            continue
        si = cs.get("si", (c.get("si") or {}).get("default"))
        opt = cs.get("opt", (c.get("opt") or {}).get("default"))
        if c.get("si") and str(si) not in [str(o) for o in c["si"]["options"]]:
            raise ValueError(f"Invalid amount for {c['name']}")
        if c.get("opt") and opt not in c["opt"]["options"]:
            raise ValueError(f"Invalid option for {c['name']}")
        covers.append({"code": c.get("code") or c["id"], "name": c["name"], "rateKey": c.get("rate"),
                       "sumInsured": coerce(si) if c.get("si") else None, "option": opt if c.get("opt") else None})
    members = []
    if prod.get("usesMembers"):
        fam = {m["key"]: m for m in family_members(profile)}
        keys = sel.get("members") or list(fam)
        if "self" not in keys:
            keys = ["self", *keys]
        unknown = [k for k in keys if k not in fam]
        if unknown:
            raise ValueError("Unknown member")
        members = [{"relation": fam[k]["relation"], "age": fam[k]["age"]} for k in keys]
    return prod, covers, members


def validate_config(cfg):
    """Structural checks before a config can be saved or published. Returns a list of error strings."""
    errs = []
    for key in ("brand", "tags", "steps", "sections", "fields", "catalogue", "rules"):
        if key not in cfg:
            errs.append(f"Missing '{key}'")
    if errs:
        return errs
    fields, prods = cfg["fields"], {p.get("id") for p in cfg["catalogue"]}
    types = [s.get("type") for s in cfg["steps"] if s.get("enabled", True)]
    for s in cfg["steps"]:
        if s.get("type") not in STEP_TYPES:
            errs.append(f"Step '{s.get('id')}' has unknown type '{s.get('type')}'")
    for t in CORE_STEPS:
        if t not in types:
            errs.append(f"Required step '{t}' is missing or disabled")
    order = [("profile", "recommend"), ("recommend", "customise"), ("recommend", "review"), ("customise", "review"),
             ("review", "checkout"), ("checkout", "done")]
    for a, b in order:
        if a in types and b in types and types.index(a) > types.index(b):
            errs.append(f"Step '{a}' must come before '{b}'")
    for sec in cfg["sections"]:
        for fid in sec.get("fields", []):
            if fid not in fields:
                errs.append(f"Section '{sec.get('title')}' references missing field '{fid}'")
    for fid, f in fields.items():
        if f.get("type") not in FIELD_TYPES:
            errs.append(f"Field '{fid}' has unknown type '{f.get('type')}'")
        si = f.get("showIf")
        if si and (si.get("field") not in fields and si.get("field") not in DERIVED or si.get("op") not in OPS):
            errs.append(f"Field '{fid}' has an invalid 'show only if' condition")
    for r in cfg["rules"]:
        if r.get("product") not in prods:
            errs.append(f"Rule '{r.get('name')}' recommends unknown product '{r.get('product')}'")
        if r.get("tag") not in cfg["tags"]:
            errs.append(f"Rule '{r.get('name')}' uses unknown tag '{r.get('tag')}'")
        for c in r.get("when", []):
            if c.get("field") not in fields and c.get("field") not in DERIVED:
                errs.append(f"Rule '{r.get('name')}' uses unknown field '{c.get('field')}'")
            if c.get("op") not in OPS:
                errs.append(f"Rule '{r.get('name')}' has an invalid operator")
    for p in cfg["catalogue"]:
        if not p.get("components"):
            errs.append(f"Product '{p.get('name')}' has no covers")
        for c in p.get("components", []):
            for k in ("si", "opt"):
                spec = c.get(k)
                if spec and (not spec.get("options") or str(spec.get("default")) not in [str(o) for o in spec["options"]]):
                    errs.append(f"Cover '{c.get('name')}' in '{p.get('name')}' has a default that isn't one of its options")
    return errs


def public_view(cfg):
    """What the customer portal may see: everything needed to render, but not the rules."""
    return {k: v for k, v in cfg.items() if k != "rules"}
