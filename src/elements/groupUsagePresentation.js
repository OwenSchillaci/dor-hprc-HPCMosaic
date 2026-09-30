export const hasCurrentActivity = member =>
  ["running_jobs", "pending_jobs", "allocated_cpus", "allocated_gpus"].some(key => member[key] > 0);

export const hasHistoricalActivity = member => member.cpu_hours > 0 || member.gpu_hours > 0;

const activityRank = member => {
  if (member.running_jobs > 0) return 0;
  if (member.pending_jobs > 0) return 1;
  if (member.allocated_cpus > 0 || member.allocated_gpus > 0) return 2;
  return hasHistoricalActivity(member) ? 3 : 4;
};

const compareValue = (a, b, key, ascending) => {
  const left = a[key], right = b[key];
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  const result = typeof left === "string" ? left.localeCompare(right) : left - right;
  return ascending ? result : -result;
};

export const compareMembers = (a, b, sort) => {
  if (sort.key !== "activity") {
    return compareValue(a, b, sort.key, sort.ascending) || a.user.localeCompare(b.user);
  }
  const rank = activityRank(a) - activityRank(b);
  if (rank) return rank;
  for (const key of ["running_jobs", "pending_jobs", "allocated_cpus", "allocated_gpus", "cpu_hours", "gpu_hours"]) {
    const order = compareValue(a, b, key, false);
    if (order) return order;
  }
  return a.user.localeCompare(b.user);
};

export const activeUserCount = (members, availability) =>
  availability?.current === false ? null : members.filter(hasCurrentActivity).length;

export const formatUsage = value => value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export const memberMetric = (member, key) => {
  const value = member[key];
  return value === 0 ? "—" : formatUsage(value);
};

export const groupUsageSize = width => width < 480 ? "small" : width < 760 ? "medium" : "large";

export const selectMembers = (members, { search = "", showAll = false, sort }) => {
  const query = search.trim().toLowerCase();
  return members.filter(member => query ? member.user.toLowerCase().includes(query)
    : showAll || hasCurrentActivity(member) || hasHistoricalActivity(member))
    .sort((a, b) => compareMembers(a, b, sort));
};

export const usageBreakdown = (members, metric, limit = 5) => {
  const used = members.filter(member => Number.isFinite(member[metric]) && member[metric] > 0)
    .sort((a, b) => b[metric] - a[metric] || a.user.localeCompare(b.user));
  const rows = used.slice(0, limit).map(member => ({ user: member.user, value: member[metric] }));
  if (used.length > limit) rows.push({ user: "Other", value: used.slice(limit).reduce((sum, member) => sum + member[metric], 0), other: true });
  return { rows, knownTotal: used.reduce((sum, member) => sum + member[metric], 0),
    incomplete: members.some(member => member[metric] == null) };
};
