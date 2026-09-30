import React, { useEffect, useRef, useState } from "react";
import { get_base_url } from "../utils/api_config";
import { sharedGet } from "../utils/sharedGet";
import { AiOutlineUsergroupAdd } from "react-icons/ai";
import { MdArrowDownward, MdArrowUpward, MdRefresh, MdSearch } from "react-icons/md";
import { cardClasses, cx, refreshEventName } from "./dashboardUtils";
import {
  formatUsage, groupUsageSize,
  hasCurrentActivity, hasHistoricalActivity, memberMetric, selectMembers, usageBreakdown,
} from "./groupUsagePresentation";

const columns = [
  ["user", "User"], ["running_jobs", "Running"], ["pending_jobs", "Pending"],
  ["cpu_hours", "CPU-hours"], ["gpu_hours", "GPU-hours"],
];
const periods = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" };
const controlClass = "non-draggable min-h-7 min-w-0 rounded-[5px] border border-mosaic-border bg-mosaic-surface px-2 py-1 text-card-13 text-mosaic-secondary focus:outline-none focus:ring-1 focus:ring-mosaic-focus";

const MetricValue = ({ member, metric, total = false }) => {
  const value = member[metric];
  const label = total ? formatUsage(value) : memberMetric(member, metric);
  const badge = value > 0 && (metric === "running_jobs" || metric === "pending_jobs");
  return <span title={value == null ? "Unavailable" : undefined}
    aria-label={value == null ? "Unavailable" : label === "—" ? "0" : undefined}
    className={cx("tabular-nums", (value == null || value === 0) && !total && "text-mosaic-muted",
      badge && "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-card-12-5 font-bold",
      badge && (metric === "running_jobs" ? "bg-mosaic-success-bg text-mosaic-success" : "bg-mosaic-caution-bg text-mosaic-caution"))}>
    {label}
  </span>;
};

const MemberUsageBars = ({ members, metric, label, totals }) => {
  const { rows, knownTotal, incomplete } = usageBreakdown(members, metric);
  const unavailable = totals[metric] == null;
  const denominator = unavailable ? knownTotal : totals[metric];
  return <div className="min-w-0 rounded-[5px] border border-mosaic-border bg-mosaic-surface p-2.5">
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <h4 className="m-0 text-card-13 font-bold text-mosaic-secondary">{label}</h4>
      <strong className="text-card-22 tabular-nums text-mosaic-primary"><MetricValue member={totals} metric={metric} total /></strong>
    </div>
    {rows.length ? <ol className="m-0 grid list-none gap-1.5 p-0" aria-label={`${label} by member`}>
      {rows.map((row, index) => <li key={row.other ? "other-members" : `member-${row.user}`}>
        <div className="mb-0.5 flex min-w-0 items-center justify-between gap-2 text-card-12-5">
          <span className={cx("min-w-0 truncate", row.other ? "text-mosaic-muted" : "text-mosaic-secondary")} title={row.user}>{row.user}</span>
          <span className="shrink-0 font-semibold tabular-nums text-mosaic-primary">{formatUsage(row.value)}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-mosaic-border" role="img"
          aria-label={`${row.user}: ${formatUsage(row.value)} ${label}`}>
          <span className={cx("block h-full rounded-full", row.other ? "bg-mosaic-muted" : metric === "cpu_hours" ? "bg-mosaic-accent" : "bg-mosaic-success")}
            style={{ width: `${denominator > 0 ? Math.min(100, row.value / denominator * 100) : 0}%`, opacity: row.other ? 0.6 : Math.max(0.55, 1 - index * 0.09) }} />
        </div>
      </li>)}
    </ol> : <p className="m-0 py-3 text-card-13 text-mosaic-muted">{unavailable ? "Usage unavailable" : "No usage in this period"}</p>}
    {(incomplete || unavailable) && rows.length > 0 && <p className="mb-0 mt-2 text-card-11 text-mosaic-muted">Known member usage; some data is unavailable.</p>}
  </div>;
};

export default function GroupUsage() {
  const [groups, setGroups] = useState([]);
  const [group, setGroup] = useState("");
  const [window, setWindow] = useState("7d");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ key: "activity", ascending: false });
  const rootRef = useRef(null);
  const [width, setWidth] = useState(800);
  const size = groupUsageSize(width);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => { setShowAll(false); }, [group]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return undefined;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") {
      globalThis.addEventListener("resize", measure);
      return () => globalThis.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setRefresh(value => value + 1);
    globalThis.addEventListener(refreshEventName, update);
    return () => globalThis.removeEventListener(refreshEventName, update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    sharedGet(`${get_base_url()}/api/dashboard-access`, { refresh: true })
      .then(async response => {
        if (!response.ok) throw new Error("Unable to check group access");
        return response.json();
      }).then(access => {
        if (cancelled) return;
        const eligible = access.eligible_groups || [];
        setGroups(eligible);
        setGroup(current => eligible.includes(current) ? current : eligible[0] || "");
        if (!eligible.length) { setData(null); setError("No Linux groups are available for your account."); setLoading(false); }
      }).catch(err => { if (!cancelled) { setData(null); setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [refresh]);

  useEffect(() => {
    if (!group) return;
    let cancelled = false;
    setLoading(true); setError(""); setData(null);
    sharedGet(`${get_base_url()}/api/group-usage?group=${encodeURIComponent(group)}&window=${window}`, { refresh: true })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load group usage");
        return body;
      }).then(body => { if (!cancelled) setData(body); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [group, window, refresh]);

  const members = data?.members || [];
  const rows = selectMembers(members, { search, showAll, sort });
  const summary = data ? [
    ["Running Jobs", data.totals.running_jobs],
    ["Pending Jobs", data.totals.pending_jobs],
    ["CPUs Allocated", data.totals.allocated_cpus],
    ["GPUs Allocated", data.totals.allocated_gpus],
  ] : [];
  const gpuUnavailable = data && (data.totals.allocated_gpus == null || data.totals.gpu_hours == null);
  const visibleColumns = columns;
  const columnCount = columns.length;
  const changeSort = key => setSort(current => ({ key, ascending: current.key === key ? !current.ascending : key === "user" }));
  const sortButton = (key, label) => <button type="button" onClick={() => changeSort(key)}
    className={cx("non-draggable inline-flex max-w-full items-center gap-0.5 rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-mosaic-focus", key !== "user" && "justify-end")}
    aria-label={`Sort by ${label}${sort.key === key ? (sort.ascending ? ", currently ascending" : ", currently descending") : ""}`}>
    <span>{label}</span>{sort.key === key && (sort.ascending ? <MdArrowUpward className="shrink-0" /> : <MdArrowDownward className="shrink-0" />)}
  </button>;

  return <section ref={rootRef} data-card-size={size}
    className={cx(cardClasses.shellPadded, "box-border flex min-h-0 min-w-0 flex-col overflow-y-auto")}>
    <header className={cx(cardClasses.title, "shrink-0 flex-wrap pr-8")}>
      <span className={cardClasses.icon}><AiOutlineUsergroupAdd /></span>
      <h3 className={cx(cardClasses.titleText, "!text-card-18")}>GROUP USAGE</h3>
      <select aria-label="Linux group" className={cx(controlClass, "max-w-full flex-1")}
        value={group} onChange={event => setGroup(event.target.value)}>
        {groups.map(name => <option key={name}>{name}</option>)}
      </select>
    </header>
    <div className="non-draggable mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
      <select aria-label="Usage period" className={controlClass} value={window} onChange={event => setWindow(event.target.value)}>
        {Object.entries(periods).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label className="relative min-w-0 flex-1 basis-24">
        <MdSearch className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-mosaic-muted" />
        <input aria-label="Search members" className={cx(controlClass, "w-full pl-6")} placeholder="Search members"
          value={search} onChange={event => setSearch(event.target.value)} />
      </label>
      <button type="button" className={cx(controlClass, "inline-flex items-center gap-1")} onClick={() => setRefresh(value => value + 1)} aria-label="Refresh group usage">
        <MdRefresh /><span className={size === "small" ? "sr-only" : ""}>Refresh</span>
      </button>
    </div>
    {loading && <p role="status" className={cardClasses.loading}>Loading group usage…</p>}
    {error && <p role="alert" className={cx(cardClasses.empty, "text-mosaic-danger")}>{error}</p>}
    {data && <>
      <section aria-label="Current group activity" className="shrink-0">
      <h4 className="mb-2 mt-0 text-card-12 font-bold uppercase text-mosaic-muted">Current group activity</h4>
      <dl className={cx("mb-2 grid shrink-0 gap-x-3 gap-y-2 border-b border-mosaic-border pb-2", size === "small" ? "grid-cols-2" : "grid-cols-4")}>
        {summary.map(([label, value]) => <div key={label} className="min-w-0">
          <dt className="text-card-12-5 text-mosaic-muted">{label}</dt>
          <dd className="m-0 mt-1 break-words text-card-26 font-extrabold tabular-nums text-mosaic-primary"
            title={value == null ? "Unavailable" : undefined} aria-label={value == null ? "Unavailable" : undefined}>{formatUsage(value)}</dd>
        </div>)}
      </dl>
      </section>
      <section aria-label={`Usage · ${periods[window]}`} className="mb-3 shrink-0 border-b border-mosaic-border pb-3">
        <h4 className="mb-2 mt-0 text-card-12 font-bold uppercase text-mosaic-muted">Usage · {periods[window]}</h4>
        <div className={cx("grid gap-2", size === "large" ? "grid-cols-2" : "grid-cols-1")}>
          <MemberUsageBars members={members} metric="cpu_hours" label="CPU-hours" totals={data.totals} />
          <MemberUsageBars members={members} metric="gpu_hours" label="GPU-hours" totals={data.totals} />
        </div>
      </section>
      {Object.entries(data.availability).filter(([, available]) => !available).map(([source]) =>
        <p key={source} role="status" className="mb-1 shrink-0 text-card-13 text-mosaic-caution">{source === "current" ? "Current job" : "Historical"} usage is unavailable. The cluster may restrict access.</p>)}
      {gpuUnavailable && <p role="status" className="mb-2 shrink-0 text-card-12-5 text-mosaic-muted">Some GPU allocation data is unavailable.</p>}
      <h4 className="mb-2 mt-0 shrink-0 text-card-12 font-bold uppercase text-mosaic-muted">Group members</h4>
      <div className="non-draggable mb-1 flex shrink-0 flex-wrap items-center justify-between gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-card-12-5 text-mosaic-muted">{rows.length} of {members.length} members{search.trim() ? " match" : " shown"}</span>
          <button type="button" className={cx(controlClass, "text-mosaic-link")} aria-pressed={showAll}
            onClick={() => setShowAll(value => !value)}>
            {showAll ? "Show activity only" : `Show all ${members.length} members`}
          </button>
        </div>
        <select aria-label="Member sort order" className={cx(controlClass, "max-w-full")}
          value={sort.key} onChange={event => setSort({ key: event.target.value, ascending: event.target.value === "user" })}>
          <option value="activity">Current activity first</option>
          {columns.map(([key, label]) => <option key={key} value={key}>{label}{key === "user" ? (sort.key === key && !sort.ascending ? " (Z–A)" : " (A–Z)") : (sort.key === key && sort.ascending ? " (lowest first)" : " (highest first)")}</option>)}
        </select>
      </div>
      <div className="non-draggable relative min-h-[96px] min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-[5px] border border-mosaic-border [scrollbar-gutter:stable]">
        <table className="w-full table-fixed border-separate border-spacing-0 text-card-13">
          <caption className="sr-only">Member activity for {group}, {periods[window]}. Hours are allocated resource-hours.</caption>
          <colgroup>
            <col style={{ width: size === "large" ? "22%" : "25%" }} />
            {Array.from({ length: columnCount - 1 }, (_, index) => <col key={index} />)}
          </colgroup>
          <thead><tr>
            {visibleColumns.map(([key, title]) => <th key={key} scope="col"
              aria-sort={sort.key === key ? (sort.ascending ? "ascending" : "descending") : "none"}
              className={cx("sticky top-0 z-10 border-b border-mosaic-border bg-mosaic-table px-1.5 py-2 text-card-12 font-bold text-mosaic-secondary [overflow-wrap:anywhere]", key === "user" ? "text-left" : "text-right")}>
              {sortButton(key, title)}
            </th>)}

          </tr></thead>
          <tbody>{rows.map(member => {
            const active = hasCurrentActivity(member);
            const inactive = !active && !hasHistoricalActivity(member);
            return <tr key={member.user} className={cx("hover:bg-mosaic-surface-hover", active && "bg-mosaic-selected", inactive && "text-mosaic-muted")}>
              <th scope="row" className={cx("border-b border-mosaic-border px-1.5 py-2 text-left align-top font-normal [overflow-wrap:anywhere]", active && "border-l-2 border-l-mosaic-success")}>
                <span className={cx(active ? "font-bold text-mosaic-primary" : !inactive && "text-mosaic-secondary")}>
                  {member.user}<span className="sr-only">{active ? ", currently active" : inactive ? ", inactive" : ", recent usage"}</span>
                </span>

              </th>
              {visibleColumns.slice(1).map(([key]) => <td key={key} className="border-b border-mosaic-border px-1.5 py-2 text-right align-top [overflow-wrap:anywhere]">
                <MetricValue member={member} metric={key} />
              </td>)}
            </tr>;
          })}
          {!rows.length && <tr><td colSpan={columnCount} className="px-2 py-6 text-center text-mosaic-muted">{!members.length ? "No group members found." : search.trim() ? "No matching members." : "No current or recent activity. Show all members to see the group roster."}</td></tr>}
          </tbody>
          <tfoot><tr>
            {visibleColumns.map(([key]) => <td key={key} className={cx("sticky bottom-0 z-10 border-t-2 border-mosaic-border-strong bg-mosaic-surface px-1.5 py-2 font-bold [overflow-wrap:anywhere]", key === "user" ? "text-left" : "text-right")}>
              {key === "user" ? "Group total" : <MetricValue member={data.totals} metric={key} total />}
            </td>)}
          </tr></tfoot>
        </table>
      </div>
    </>}
  </section>;
}
