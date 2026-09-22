import type { ControlUiPanel, ControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import type { ExplorerRepairPlan, ExplorerRepairResult } from "../src/context-explorer-repair.js";
import type { ExplorerSnapshot, ExplorerSummary, ExplorerDetail, ExplorerHealth } from "../src/context-explorer.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "./context-explorer.css";

// Derive the session context from the SDK panel contract without runtime imports.
type Context = Parameters<ControlUiPanel["mount"]>[1];
const number = (value: number) => value.toLocaleString();
const tokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : number(value);
function summaryTitle(preview: string | undefined): string {
  return (preview ?? "").split("\n").find(line => line.trim())?.replace(/^\s*#{1,6}\s*/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim() || "Earlier discussion";
}
function qualityLabel(quality: ExplorerSummary["quality"]): string {
  return quality === "new" ? "Shortened summary" : quality === "emergency" ? "Emergency summary" : "Fallback summary";
}
function qualityDescription(quality: ExplorerSummary["quality"]): string {
  return quality === "new"
    ? "This summary was truncated and may omit detail."
    : "This summary used a fallback instead of a complete model-generated summary and may omit detail.";
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function parsedDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function date(value: string | null): string {
  return parsedDate(value)?.toLocaleString() ?? "Unknown date";
}
function age(value: string | null): string {
  const parsed = parsedDate(value);
  if (!parsed) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function mount(container: HTMLElement, initial: Context) {
  let context = initial, disposed = false, generation = 0, loading = false;
  let checking = false, repairing = false;
  const loaders = new WeakMap<HTMLDetailsElement, () => Promise<void>>();
  let nextOffset: number | null = null, lastSignature = "", queued = false;
  const previewObservers = new Map<ResizeObserver, HTMLElement>();
  const root = el("section", "", "lcm-explorer");
  const header = el("header", "", "lcm-explorer__header");
  const heading = el("div");
  heading.append(el("h2", "Conversation memory"));
  header.append(heading);
  const overview = el("div", "", "lcm-explorer__overview");
  const stats = el("div", "", "lcm-explorer__stats");
  const status = el("p", "Loading context…", "lcm-explorer__status"); status.setAttribute("role", "status");
  const list = el("div", "", "lcm-explorer__list");
  const more = el("button", "Load more summaries", "lcm-explorer__button"); more.type = "button"; more.hidden = true;
  const tail = el("p", "", "lcm-explorer__tail");
  header.append(status);
  const health = el("div", "", "lcm-explorer__health");
  const check = el("button", "Check summaries", "lcm-explorer__button");
  check.type = "button"; check.disabled = true;
  const report = el("p", "", "lcm-explorer__health-report"); report.setAttribute("role", "status");
  const repair = el("button", "Repair…", "lcm-explorer__button"); repair.type = "button"; repair.hidden = true;
  const earlier = el("div", "", "lcm-explorer__earlier");
  health.append(check, repair, report);
  root.append(header, overview, stats, health, list, more, earlier, tail); container.append(root);

  function alive(epoch: number) { return !disposed && !context.signal.aborted && epoch === generation; }
  async function request<T>(payload: Record<string, unknown>, actionId = "context-explorer"): Promise<T> {
    const active = context;
    const response = await active.host.request<{ ok: boolean; result?: T; error?: string }>("plugins.sessionAction", {
      pluginId: "lossless-claw", actionId, payload,
      sessionKey: active.props.sessionKey, agentId: active.props.agentId,
    });
    if (!response.ok || !response.result) throw new Error(response.error || "Context unavailable");
    return response.result;
  }

  function summaryCard(summary: ExplorerSummary, ancestry = new Set([summary.summaryId]), nested = false): HTMLDetailsElement {
    const card = el("details", "", nested ? "lcm-explorer__card lcm-explorer__branch" : "lcm-explorer__card"); card.dataset.summaryId = summary.summaryId;
    const top = el("summary");
    const labels = el("div", "", "lcm-explorer__row");
    labels.append(el("span", `D${summary.depth}`, "lcm-explorer__kind"),
      el("span", summary.tokenCount == null ? "" : `${tokens(summary.tokenCount)} tokens`, "lcm-explorer__tokens"));
    const relativeAge = el("time", "", "lcm-explorer__age");
    relativeAge.dataset.timestamp = summary.latestAt || summary.createdAt || "";
    relativeAge.title = summary.latestAt
      ? `Latest covered content: ${date(summary.latestAt)}. Coverage: ${date(summary.earliestAt)} — ${date(summary.latestAt)}`
      : `Coverage unknown. Summary created: ${date(summary.createdAt)}`;
    relativeAge.textContent = age(relativeAge.dataset.timestamp);
    relativeAge.setAttribute("aria-label", `${relativeAge.textContent} ago. ${relativeAge.title}`);
    const badge = el("span", "", "lcm-explorer__warning-badge");
    badge.hidden = !summary.quality;
    if (summary.quality) badge.textContent = `⚠ ${qualityLabel(summary.quality)}`;
    labels.append(badge, relativeAge);
    const title = summaryTitle(summary.preview);
    top.append(el("div", title, "lcm-explorer__title"), labels);
    card.dataset.signature = JSON.stringify(summary);
    const body = el("div", "", "lcm-explorer__body");
    const metadata = el("div", "", "lcm-explorer__metadata");
    if (summary.earliestAt && summary.latestAt) {
      const format = (value: string) => parsedDate(value)?.toLocaleDateString(undefined, { month: "short", day: "numeric" }) ?? "";
      const start = format(summary.earliestAt), end = format(summary.latestAt);
      const coverage = el("span", start === end ? `From ${start}` : `${start} – ${end}`);
      coverage.title = `Coverage: ${date(summary.earliestAt)} — ${date(summary.latestAt)}`;
      metadata.append(coverage);
    }
    if (summary.sourceMessageTokenCount > 0) metadata.append(el("span", `Distilled from ${tokens(summary.sourceMessageTokenCount)} tokens`));
    const warning = el("p", "", "lcm-explorer__warning");
    warning.hidden = !summary.quality;
    if (summary.quality) warning.textContent = qualityDescription(summary.quality);
    body.append(warning, metadata); card.append(top, body);
    let loaded = false, pending: Promise<void> | undefined;
    const load = () => {
      if (loaded) return Promise.resolve();
      return pending ??= loadDetail(summary, body, ancestry).then(ok => { loaded = ok; pending = undefined; });
    };
    loaders.set(card, load);
    card.addEventListener("toggle", () => { if (card.open) void load(); });
    return card;
  }

  function renderMarkdown(target: HTMLElement, source: string) {
    // Narrow HTML allowlist: no images, embedded content, styles, or remote loads.
    target.replaceChildren(DOMPurify.sanitize(marked.parse(source, { async: false }), {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
        "strong", "em", "del", "blockquote", "pre", "code", "a", "table", "thead", "tbody", "tr", "th", "td"],
      ALLOWED_ATTR: ["href", "title", "start"],
      ALLOW_DATA_ATTR: false,
    }));
    for (const link of Array.from(target.querySelectorAll("a"))) {
      const href = link.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:)/i.test(href)) link.removeAttribute("href");
      link.setAttribute("target", "_blank"); link.setAttribute("rel", "noopener noreferrer");
    }
  }

  async function loadDetail(summary: ExplorerSummary, target: HTMLElement, ancestry: Set<string>): Promise<boolean> {
    const summaryId = summary.summaryId;
    const epoch = generation;
    target.querySelector(".lcm-explorer__detail-error")?.remove();
    const message = el("p", "Loading summary…", "lcm-explorer__muted"); target.append(message);
    try {
      const detail = await request<ExplorerDetail>({ summaryId });
      if (!alive(epoch) || !target.isConnected) return false;
      message.remove();
      // A manual check/detail read can observe a repair before the next snapshot poll.
      if (detail.quality !== undefined) {
        const card = target.parentElement!;
        const badge = card.querySelector<HTMLElement>(":scope > summary .lcm-explorer__warning-badge")!;
        const warning = target.querySelector<HTMLElement>(":scope > .lcm-explorer__warning")!;
        badge.hidden = warning.hidden = !detail.quality;
        badge.textContent = detail.quality ? `⚠ ${qualityLabel(detail.quality)}` : "";
        warning.textContent = detail.quality ? qualityDescription(detail.quality) : "";
      }
      if (summary.kind === "leaf") target.append(el("p", `From ${number(detail.sourceMessages)} message${detail.sourceMessages === 1 ? "" : "s"}`, "lcm-explorer__muted lcm-explorer__sources"));
      const preview = el("div", "", "lcm-explorer__preview");
      const text = el("div", "", "lcm-explorer__content"); preview.append(text); target.append(preview);
      let source = detail.content, offset = detail.nextOffset, expanded = false;
      renderMarkdown(text, source);
      const toggle = el("button", "Show full summary", "lcm-explorer__button lcm-explorer__expand");
      toggle.type = "button"; toggle.setAttribute("aria-expanded", "false"); target.append(toggle);
      const measure = () => {
        if (!alive(epoch) || !target.isConnected || text.getBoundingClientRect().width === 0) return;
        const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
        const paragraph = text.querySelector("p");
        const paragraphBottom = paragraph ? paragraph.getBoundingClientRect().bottom - text.getBoundingClientRect().top : 0;
        const previewHeight = Math.ceil(Math.max(lineHeight * 5, paragraphBottom));
        const truncated = text.scrollHeight > previewHeight + 1 || offset !== null;
        preview.style.maxHeight = expanded ? "none" : `${previewHeight}px`;
        toggle.hidden = !expanded && !truncated;
        for (const link of Array.from(text.querySelectorAll("a"))) {
          if (expanded) link.removeAttribute("tabindex"); else link.setAttribute("tabindex", "-1");
        }
      };
      const observer = new ResizeObserver(measure); observer.observe(text); previewObservers.set(observer, text);
      measure();
      toggle.onclick = async () => {
        expanded = !expanded;
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.textContent = expanded ? "Show less" : "Show full summary";
        measure();
        if (!expanded || offset === null) return;
        toggle.disabled = true;
        try {
          // Fetch remaining bounded pages only when the reader requests full text.
          while (offset !== null && alive(epoch) && target.isConnected) {
            const chunk: ExplorerDetail = await request<ExplorerDetail>({ summaryId, offset });
            if (!alive(epoch) || !target.isConnected) return;
            if (chunk.nextOffset !== null && chunk.nextOffset <= offset) throw new Error("Invalid continuation");
            source += chunk.content; offset = chunk.nextOffset;
          }
          renderMarkdown(text, source);
        } catch {
          expanded = false;
          toggle.setAttribute("aria-expanded", "false");
          toggle.textContent = "Retry full summary";
        } finally { toggle.disabled = false; measure(); }
      };
      if (detail.children.length) {
        const children = el("div", "", "lcm-explorer__children");
        children.append(el("p", `Built from ${number(detail.children.length)} earlier ${detail.children.length === 1 ? "summary" : "summaries"}`, "lcm-explorer__muted lcm-explorer__children-label")); target.append(children);
        for (const child of detail.children) {
          if (ancestry.has(child.summaryId)) continue; // Guard corrupt cycles, not legitimate DAG depth.
          children.append(summaryCard(child, new Set([...ancestry, child.summaryId]), true));
        }
      }
      if (detail.childrenTruncated) target.append(el("p", "Showing the first 100 source summaries. More are available in lcm-tui.", "lcm-explorer__muted"));
      return true;
    } catch {
      if (alive(epoch)) { message.classList.add("lcm-explorer__detail-error"); message.textContent = "Could not read this summary. Close and reopen to retry."; }
      return false;
    }
  }

  async function reload(append = false) {
    for (const [observer, node] of previewObservers) {
      if (!node.isConnected) { observer.disconnect(); previewObservers.delete(observer); }
    }
    if (disposed || context.signal.aborted || !context.presented || document.visibilityState === "hidden") return;
    for (const node of Array.from(list.querySelectorAll<HTMLElement>("[data-timestamp]"))) {
      node.textContent = age(node.dataset.timestamp ?? null);
      node.setAttribute("aria-label", `${node.textContent} ago. ${node.title}`);
    }
    if (checking || repairing) return;
    if (loading) { queued = true; return; }
    if (!context.props.sessionKey) { status.textContent = "Select a session to explore its context."; return; }
    if (!context.host.connection.connected) { status.textContent = "Disconnected · displayed context may be stale."; return; }
    loading = true; more.disabled = true;
    const epoch = generation;
    try {
      const snapshot = await request<ExplorerSnapshot>({ offset: append ? nextOffset ?? 0 : 0 });
      if (!alive(epoch)) return;
      check.disabled = checking || snapshot.conversationId === null;
      // Refresh pages already opened by the user, retaining their reading position.
      const visibleCount = list.children.length;
      while (!append && snapshot.nextOffset !== null && snapshot.summaries.length < visibleCount) {
        const page = await request<ExplorerSnapshot>({ offset: snapshot.nextOffset });
        if (!alive(epoch)) return;
        if (page.conversationId !== snapshot.conversationId) { queued = true; return; }
        snapshot.summaries.push(...page.summaries);
        snapshot.nextOffset = page.nextOffset;
      }
      const signature = JSON.stringify({ ...snapshot, capturedAt: undefined });
      if (append || signature !== lastSignature) {
        if (!append) {
          // Reuse unchanged rows so live tail updates do not close an open summary.
          const previous = new Map(Array.from(list.children, node => [(node as HTMLElement).dataset.summaryId, node as HTMLElement]));
          const rows = snapshot.summaries.map(summary => {
            const existing = previous.get(summary.summaryId);
            return existing?.dataset.signature === JSON.stringify(summary) ? existing : summaryCard(summary);
          });
          list.replaceChildren(...rows); lastSignature = signature;
        } else {
          for (const summary of snapshot.summaries) list.append(summaryCard(summary));
        }
        nextOffset = snapshot.nextOffset; more.hidden = nextOffset === null;
        overview.replaceChildren();
        if (typeof snapshot.conversationTokens === "number" && snapshot.conversationId !== null) {
          const total = el("div", "", "lcm-explorer__total");
          total.append(el("strong", tokens(snapshot.conversationTokens)), el("span", "tokens in this conversation"));
          total.title = `${number(snapshot.conversationTokens)} stored message tokens across this conversation`;
          const compact = el("div", "", "lcm-explorer__compact");
          compact.append(el("span", `${tokens(snapshot.summaryTokens + snapshot.messageTokens)} in context`));
          compact.title = "Stored active summaries + recent messages; not the exact model prompt.";
          if (typeof snapshot.compressionRatio === "number") {
            const ratio = el("span", `1:${number(snapshot.compressionRatio)} compression`, "lcm-explorer__compression");
            ratio.title = "Same ratio as /lcm doctor: source-message + descendant-summary tokens represented by active summaries, divided by all active context tokens, rounded (minimum 1:1). Not a token-savings or billing estimate.";
            compact.append(ratio);
          }
          overview.append(total, compact);
        }
        stats.replaceChildren();
        for (const [value, label] of [[number(snapshot.summaryCount), "summaries"], [number(snapshot.messageCount), "recent messages"]]) {
          const stat = el("div"); stat.append(el("strong", value), el("span", ` ${label}`)); stats.append(stat);
        }
        tail.textContent = snapshot.version ? `Lossless v${snapshot.version} · ${
          snapshot.databaseBytes >= 1024 ** 3 ? (snapshot.databaseBytes / 1024 ** 3).toFixed(1) + " GB" :
          (snapshot.databaseBytes / 1024 ** 2).toFixed(1) + " MB"}` : "";
      }
      status.textContent = snapshot.conversationId === null ? "Lossless has not recorded context for this session yet." :
        snapshot.summaryCount === 0 ? "No summaries yet. This session is still using recent messages." :
        "";
    } catch {
      if (alive(epoch)) status.textContent = "Temporarily unavailable · retrying automatically.";
    } finally {
      loading = false; more.disabled = false;
      if (queued) { queued = false; void reload(); }
    }
  }
  async function checkSummaries() {
    const epoch = generation;
    checking = true; check.disabled = true; repair.hidden = true; report.textContent = "Checking…";
    earlier.replaceChildren();
    try {
      const result = await request<ExplorerHealth>({ check: true });
      if (!alive(epoch)) return;
      while (result.nextOffset != null) {
        const page = await request<ExplorerHealth>({ check: true, offset: result.nextOffset });
        if (!alive(epoch)) return;
        if (page.nextOffset != null && page.nextOffset <= result.nextOffset) throw new Error("Invalid page");
        result.summaries.push(...page.summaries); result.revealIds.push(...page.revealIds); result.nextOffset = page.nextOffset;
      }
      // Open only the affected paths; healthy branches remain compact.
      const reveal = new Set(result.revealIds);
      const visited = new Set<HTMLDetailsElement>();
      for (;;) {
        const cards = Array.from(list.querySelectorAll<HTMLDetailsElement>("details"))
          .filter(card => reveal.has(card.dataset.summaryId!) && !visited.has(card));
        if (!cards.length) break;
        for (const card of cards) {
          visited.add(card); card.open = true; await loaders.get(card)?.();
          if (!alive(epoch)) return;
        }
      }
      // Flagged sources outside the visible frontier (or child/page limit) are
      // still reachable, without fetching unrelated healthy branches.
      const shown = new Set(Array.from(list.querySelectorAll<HTMLElement>("[data-summary-id]"), n => n.dataset.summaryId));
      for (const summary of result.summaries ?? []) {
        if (shown.has(summary.summaryId)) continue;
        if (!earlier.childElementCount) earlier.append(el("p", "Earlier summaries", "lcm-explorer__muted"));
        const card = summaryCard(summary); earlier.append(card); card.open = true;
        await loaders.get(card)?.(); if (!alive(epoch)) return;
      }
      report.textContent = result.total ? `${number(result.total)} to repair` : "All summaries look good";
      repair.hidden = result.total === 0;
    } catch {
      if (alive(epoch)) report.textContent = "Could not check summaries. Try again.";
    } finally {
      if (alive(epoch)) { checking = false; check.disabled = false; }
    }
  }
  check.onclick = () => void checkSummaries();

  const dialog = el("dialog", "", "lcm-explorer__dialog");
  const dialogHeading = el("h2", "Repair summaries"); dialogHeading.id = `lcm-repair-${crypto.randomUUID()}`;
  dialog.setAttribute("aria-labelledby", dialogHeading.id);
  const dialogText = el("p");
  const offline = el("label", "", "lcm-explorer__offline");
  const offlineCheck = el("input"); offlineCheck.type = "checkbox";
  offline.append(offlineCheck, el("span", "I’ve paused active delivery to this conversation."));
  const dialogStatus = el("p", "", "lcm-explorer__muted"); dialogStatus.setAttribute("role", "status");
  const cancel = el("button", "Cancel", "lcm-explorer__button"); cancel.type = "button";
  const confirm = el("button", "Repair", "lcm-explorer__button lcm-explorer__primary"); confirm.type = "button";
  const actions = el("div", "", "lcm-explorer__dialog-actions"); actions.append(cancel, confirm);
  dialog.append(dialogHeading, dialogText, offline, dialogStatus, actions); root.append(dialog);
  let plan: ExplorerRepairPlan | undefined, dialogGeneration = 0;
  const setRepairBusy = (busy: boolean) => {
    confirm.setAttribute("aria-busy", String(busy));
    confirm.textContent = busy ? "Repairing…" : "Repair";
  };
  const updateConfirm = () => { confirm.disabled = !plan || !plan.count || repairing || (plan.requiresOffline && !offlineCheck.checked); };
  offlineCheck.onchange = updateConfirm;
  cancel.onclick = () => dialog.close();
  dialog.addEventListener("cancel", event => { if (repairing) event.preventDefault(); });
  dialog.addEventListener("close", () => { plan = undefined; dialogGeneration++; });
  repair.onclick = async () => {
    const epoch = generation, revision = ++dialogGeneration;
    plan = undefined; confirm.hidden = false; offline.hidden = true; offlineCheck.checked = false;
    dialogStatus.textContent = ""; dialogText.textContent = "Checking repair scope…"; confirm.disabled = true;
    cancel.disabled = false; cancel.textContent = "Cancel"; setRepairBusy(false);
    dialog.showModal(); cancel.focus();
    try {
      const preview = await request<ExplorerRepairPlan>({ mode: "preview" }, "context-explorer-repair");
      if (!alive(epoch) || !dialog.open || revision !== dialogGeneration) return;
      plan = preview;
      dialogHeading.textContent = `Repair ${number(plan.count)} ${plan.count === 1 ? "summary" : "summaries"}?`;
      dialogText.textContent = plan.count ? "Rebuild these summaries from saved sources using your configured model. A backup is saved before changes."
        : "No summaries need repair.";
      offline.hidden = !plan.requiresOffline;
      if (plan.requiresOffline) dialogStatus.textContent = "Offline maintenance required: " + plan.reasons.join("; ") + ".";
      updateConfirm();
    } catch (error) {
      if (alive(epoch) && dialog.open && revision === dialogGeneration) dialogText.textContent = error instanceof Error ? error.message : "Repair unavailable.";
    }
  };
  confirm.onclick = async () => {
    if (!plan || confirm.disabled) return;
    const epoch = generation;
    repairing = true; setRepairBusy(true); confirm.disabled = cancel.disabled = offlineCheck.disabled = true;
    check.disabled = repair.disabled = true; dialogStatus.textContent = "Repairing… This can take a few minutes.";
    try {
      const result = await request<ExplorerRepairResult>({ mode: "apply", token: plan.token, confirm: true,
        confirmOffline: offlineCheck.checked }, "context-explorer-repair");
      if (!alive(epoch)) return;
      dialogHeading.textContent = "Repair complete";
      dialogStatus.textContent = `${number(result.repaired)} repaired` + (result.skipped ? ` · ${number(result.skipped)} skipped` : "")
        + (result.unchanged ? ` · ${number(result.unchanged)} unchanged` : "");
      dialogText.textContent = result.skipped ? "Some summaries could not be rebuilt. Check summaries again to review them." : "Your conversation memory is up to date.";
      offline.hidden = true; confirm.hidden = true; plan = undefined;
      earlier.replaceChildren(); list.replaceChildren(); lastSignature = "";
      repair.hidden = true; report.textContent = dialogStatus.textContent;
    } catch (error) {
      if (alive(epoch)) { dialogStatus.textContent = error instanceof Error ? error.message : "Repair failed. Try again."; plan = undefined; }
    } finally {
      if (alive(epoch)) {
        repairing = false; setRepairBusy(false); cancel.disabled = offlineCheck.disabled = check.disabled = repair.disabled = false;
        cancel.textContent = "Close"; confirm.disabled = true; void reload();
      }
    }
  };
  more.onclick = () => void reload(true);
  const resume = () => { void reload(); };
  const timer = setInterval(resume, 10000);
  document.addEventListener("visibilitychange", resume);
  void reload();
  const dispose = () => { disposed = true; generation++; clearInterval(timer); document.removeEventListener("visibilitychange", resume); initial.signal.removeEventListener("abort", dispose); for (const observer of previewObservers.keys()) observer.disconnect(); previewObservers.clear(); dialog.close(); root.remove(); };
  initial.signal.addEventListener("abort", dispose, { once: true });
  return {
    update(next: Context) {
      const changed = next.props.sessionKey !== context.props.sessionKey || next.props.agentId !== context.props.agentId;
      context = next;
      if (changed) { for (const observer of previewObservers.keys()) observer.disconnect(); previewObservers.clear(); generation++; checking = false; repairing = false; setRepairBusy(false); dialog.close(); earlier.replaceChildren(); repair.hidden = true; repair.disabled = false; offlineCheck.disabled = false; report.textContent = ""; report.title = ""; check.disabled = true; lastSignature = ""; nextOffset = null; list.replaceChildren(); overview.replaceChildren(); stats.replaceChildren(); tail.textContent = ""; more.hidden = true; status.textContent = "Loading context…"; }
      void reload();
    },
    dispose,
  };
}

export default { id: "lossless-claw", activate(host) {
  return host.ui.registerPanel({ id: "context-explorer", label: "LCM", mount });
} } satisfies ControlUiPlugin;
