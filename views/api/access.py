"""Dashboard capabilities derived from the effective Linux identity."""
import grp
import os
import pwd

from flask import current_app, jsonify
from . import api
from .announcement import _can_manage


def viewer_identity():
    user = pwd.getpwuid(os.geteuid())
    gids = set(os.getgroups()) | {os.getegid(), user.pw_gid}
    groups = set()
    for gid in gids:
        try:
            groups.add(grp.getgrgid(gid).gr_name)
        except KeyError:
            pass
    return user.pw_name, groups


def eligible_groups(groups):
    configured = current_app.config.get("group_usage_groups", "all")
    if configured == "all":
        return sorted(groups)
    return sorted(groups.intersection(configured if isinstance(configured, list) else []))


def card_access(groups):
    rules = current_app.config.get("card_access", {})
    if not isinstance(rules, dict):
        return {}
    return {name: isinstance(allowed, list) and bool(groups.intersection(allowed))
            for name, allowed in rules.items()}


@api.route("/dashboard-access", methods=["GET"])
def dashboard_access():
    _user, groups = viewer_identity()
    eligible = eligible_groups(groups)
    return jsonify(capabilities={"manage_announcements": _can_manage(),
                                 "group_usage": bool(eligible)},
                   card_access=card_access(groups), eligible_groups=eligible)
