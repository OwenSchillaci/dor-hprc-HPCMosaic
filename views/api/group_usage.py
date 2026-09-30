"""Read-only, member-authorized compute summaries for configured Linux groups."""
import grp
import pwd
import re
from datetime import datetime, timedelta

from flask import current_app, jsonify, request
from . import api
from .access import viewer_identity, eligible_groups, card_access
from .cache import TTLCache
from .utils import run_process_output

_cache = TTLCache()
_WINDOWS = {"24h": 1, "7d": 7, "30d": 30}
_SAFE_USER = re.compile(r"^[A-Za-z0-9_.-]+$")
_METRICS = ("running_jobs", "pending_jobs", "allocated_cpus", "allocated_gpus",
            "cpu_hours", "gpu_hours")


def group_roster(name):
    group = grp.getgrnam(name)
    members = set(group.gr_mem)
    members.update(user.pw_name for user in pwd.getpwall() if user.pw_gid == group.gr_gid)
    if any(not _SAFE_USER.fullmatch(user) or user.startswith("-") for user in members):
        raise ValueError("Group contains an unsupported username")
    return tuple(sorted(members))


def gpu_count(tres):
    values = dict(token.split("=", 1) for token in tres.split(",") if "=" in token)
    if "gres/gpu" in values:
        return int(values["gres/gpu"])
    typed = [int(value) for key, value in values.items() if key.startswith("gres/gpu:")]
    # A complete allocation TRES list without GPUs describes a CPU-only job.
    # Empty/N/A allocation data does not establish a zero GPU allocation.
    return sum(typed) if typed else (0 if "cpu" in values else None)


def _timestamp(value):
    if value in ("", "Unknown", "None", "N/A"):
        return None
    return datetime.fromisoformat(value)


def parse_current(output, members):
    rows = {user: dict.fromkeys(_METRICS[:4], 0) for user in members}
    seen = set()
    for line in output.splitlines():
        if not line.strip():
            continue
        job, user, state, cpus, tres = [field.strip() for field in line.split("|", 4)]
        if user not in rows or job in seen:
            continue
        seen.add(job)
        row = rows[user]
        if state == "RUNNING":
            row["running_jobs"] += 1
            row["allocated_cpus"] += int(cpus)
            count = gpu_count(tres)
            row["allocated_gpus"] = (row["allocated_gpus"] + count
                                     if count is not None and row["allocated_gpus"] is not None else None)
        elif state == "PENDING":
            row["pending_jobs"] += 1
    return rows


def parse_history(output, members, start, end):
    rows = {user: {"cpu_hours": 0.0, "gpu_hours": 0.0} for user in members}
    seen = set()
    for line in output.splitlines():
        if not line.strip():
            continue
        job, user, cpus, tres, began, ended = line.split("|")
        if user not in rows or "." in job or "[" in job or job in seen:
            continue
        seen.add(job)
        began = _timestamp(began)
        if began is None:
            continue
        ended = _timestamp(ended) or end
        hours = max(0, (min(ended, end) - max(began, start)).total_seconds()) / 3600
        row = rows[user]
        row["cpu_hours"] += int(cpus) * hours
        count = gpu_count(tres)
        row["gpu_hours"] = (row["gpu_hours"] + count * hours
                            if count is not None and row["gpu_hours"] is not None else None)
    return rows


def _query(members, historical=False, start=None, end=None):
    output = []
    for offset in range(0, len(members), 100):
        users = ",".join(members[offset:offset + 100])
        if historical:
            command = ["sacct", "--local", "--noheader", "--parsable2", "--allocations",
                       "--array", "--user", users, "--starttime", start.isoformat(),
                       "--endtime", end.isoformat(),
                       "--format=JobIDRaw%64,User%128,AllocCPUS,AllocTRES%2048,Start,End"]
        else:
            command = ["squeue", "--local", "--noheader", "--array", "--user", users,
                       "--states=RUNNING,PENDING",
                       "--Format=JobID:64|,UserName:128|,State:32|,NumCPUs:32|,tres-alloc:1024"]
        output.append(run_process_output(command, timeout=30 if historical else 20))
    return "\n".join(output)


@api.route("/group-usage", methods=["GET"])
def group_usage():
    viewer, groups = viewer_identity()
    group = request.args.get("group", "")
    window = request.args.get("window", "7d")
    if group not in eligible_groups(groups) or card_access(groups).get("Group Usage") is False:
        return jsonify(error="Group usage is not authorized"), 403
    if window not in _WINDOWS:
        return jsonify(error="Window must be 24h, 7d, or 30d"), 400
    try:
        members = group_roster(group)
        if viewer not in members:
            raise ValueError("Directory roster omits the authorized viewer")
    except (KeyError, ValueError, OSError):
        return jsonify(error="Unable to resolve the complete group roster"), 503
    now = datetime.now().replace(microsecond=0)
    # Report exact five-minute boundaries, including for cached historical results.
    end = now.replace(minute=now.minute // 5 * 5, second=0)
    start = end - timedelta(days=_WINDOWS[window])
    key = (viewer, group, members)
    data = {user: {"user": user, **dict.fromkeys(_METRICS, None)} for user in members}
    availability = {}
    updated = {}
    for source, ttl in (("current", 10), ("history", 300)):
        try:
            def load():
                historical = source == "history"
                raw = _query(members, historical, start, end)
                parsed = (parse_history(raw, members, start, end) if historical
                          else parse_current(raw, members))
                return parsed, now.isoformat(), start, end
            cache_key = key + (source,) + ((window,) if source == "history" else ())
            parsed, timestamp, cached_start, cached_end = _cache.get_or_set(cache_key, ttl, load)
            if source == "history":
                start, end = cached_start, cached_end
            for user, metrics in parsed.items():
                data[user].update(metrics)
            availability[source] = True
            updated[source] = timestamp
        except Exception as exc:
            current_app.logger.warning("Group usage %s failed for %s: %s", source, group, exc)
            availability[source] = False
    totals = {metric: (sum(row[metric] for row in data.values())
                       if all(row[metric] is not None for row in data.values()) else None)
              for metric in _METRICS}
    return jsonify(group=group, window=window, start=start.isoformat(), end=end.isoformat(),
                   members=list(data.values()), totals=totals, availability=availability,
                   updated_at=updated)
