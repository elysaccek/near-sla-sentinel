const byId = id => document.getElementById(id);
const utc = new Intl.DateTimeFormat(undefined, {
  timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});
const number = new Intl.NumberFormat("en-US");
const outcomes = {
  breach: ["Customer compensation", "good"], healthy: ["Provider refund · Healthy", ""],
  inconclusive: ["Provider refund · Inconclusive", "warn"], unaccepted: ["Provider refund · Unaccepted", "warn"],
};
const phases = {
  offline: ["Runner offline", "warn"], unavailable: ["Feed unavailable", "warn"], stale: ["Runner offline", "warn"],
  waiting: ["Runner online", "good"], funding: ["Runner online", "good"], scheduled: ["Runner online", "good"], observing: ["Runner online", "good"],
  reporting: ["Runner online", "good"], settling: ["Runner online", "good"], "funding-required": ["Funding required", "warn"],
  retrying: ["Runner retrying", "warn"], paused: ["Runner paused", "warn"],
};
const phaseLabels = {
  offline: "Offline", unavailable: "Unavailable", stale: "Offline", waiting: "Waiting for window", funding: "Preparing agreement",
  scheduled: "Waiting for start", observing: "Observing", reporting: "Waiting for votes", settling: "Finalizing payment",
  "funding-required": "Awaiting funding", retrying: "Retrying", paused: "Paused for reconciliation",
};
const scenarios = {
  "oracle-a": "Oracle A · controlled 503", "oracle-b": "Oracle B · controlled 503",
  "oracle-pair": "Oracles A + B · overlapping 503", target: "Target API · shared 503",
};
let rows = [];
let limit = 8;
let pending = false;
let snapshot;

function amount(value, fractionDigits = 2) {
  const precision = 10n ** BigInt(24 - fractionDigits);
  const digits = ((BigInt(value) + precision / 2n) / precision).toString().padStart(fractionDigits + 1, "0");
  const whole = BigInt(digits.slice(0, -fractionDigits));
  const fraction = digits.slice(-fractionDigits).replace(/0+$/, "");
  return number.format(whole) + (fraction ? "." + fraction : "");
}

function append(tag, parent, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  parent.append(element);
  return element;
}

function renderHistory() {
  const expanded = new Set([...document.querySelectorAll("#live-history details[open]")].map(details => details.dataset.detail));
  byId("live-history").replaceChildren(...rows.slice(0, limit).map(row => {
    const tr = document.createElement("tr");
    tr.setAttribute("role", "row");
    const when = append("td", tr, row.start ? utc.format(row.start) : "Verified Testnet pilot");
    const source = row.source === "commissioning" ? "Commissioning run" : row.source === "scheduled" ? "Scheduled run" : "Pilot";
    append("small", when, "SLA " + row.sla + " · " + source);
    const scenario = append("td", tr, scenarios[row.scenario] ?? row.label);
    if (row.observations) {
      const { confirmed, possible, required, oracles } = row.observations;
      const details = append("details", scenario, "");
      details.dataset.detail = row.tx + "/observations";
      details.open = expanded.has(details.dataset.detail);
      append("summary", details, "Oracle observations");
      const streak = row.outcome === "unaccepted" ? "The offer was not accepted."
        : `${confirmed} confirmed / ${possible} possible consecutive slots · ${required} required`;
      append("small", details, streak);
      for (const report of oracles) {
        const label = "Oracle " + report.id.at(-1).toUpperCase() + " · ";
        append("small", details, label + (report.submitted
          ? `${report.up} Up · ${report.down} Down · ${report.unknown} Unknown`
          : `${report.unknown} Unknown · no vote`));
      }
    }
    const outcome = append("td", tr, "");
    const [label, tone] = outcomes[row.outcome];
    const status = append("span", outcome, label);
    status.className = "state";
    status.dataset.tone = tone;
    append("td", tr, amount(row.amount) + " NEAR");
    const links = append("td", tr, "");
    const explorer = append("a", links, row.tx.slice(0, 7) + "…" + row.tx.slice(-4) + " ↗");
    explorer.href = "https://testnet.nearblocks.io/txns/" + encodeURIComponent(row.tx);
    explorer.target = "_blank";
    explorer.rel = "noopener";
    explorer.setAttribute("aria-label", "Open Testnet transaction " + row.tx);
    if (row.transfer && row.callback) {
      const details = append("details", links, "");
      details.dataset.detail = row.tx + "/receipts";
      details.open = expanded.has(details.dataset.detail);
      append("summary", details, "Settlement receipts");
      for (const [label, id] of [["Native transfer", row.transfer], ["Payment callback", row.callback]]) {
        const receipt = append("small", details, label + " ");
        receipt.className = "receipt-label";
        append("code", receipt, id);
      }
    }
    for (const cell of tr.cells) cell.setAttribute("role", "cell");
    return tr;
  }));
  byId("history-more").hidden = rows.length <= limit;
  byId("history-empty").hidden = rows.length > 0;
  byId("history-empty").textContent = "No verified Testnet settlements are available.";
}

async function refresh() {
  if (pending) return;
  pending = true;
  byId("refresh-live").disabled = true;
  try {
    const response = await fetch("/api/testnet/activity", { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("Testnet feed unavailable");
    const { live, pilot } = await response.json();
    const badge = byId("feed-status");
    [badge.textContent, badge.dataset.tone] = phases[live.phase] ?? phases.unavailable;
    byId("live-phase").textContent = phaseLabels[live.phase] ?? "Unavailable";
    byId("live-payout").textContent = amount(live.policy.payout);
    byId("sample-plan").textContent = `Each agreement sets its own sampling policy. This demo takes ${live.policy.slots} samples per oracle, one every ${live.policy.slotMs / 1000} seconds. The times below show when simulated 503 responses begin.`;
    byId("live-reserve").textContent = live.reserve === undefined ? "—" : amount(live.reserve) + " NEAR";
    byId("live-funding").textContent = live.reserve === undefined ? "1,000 Testnet NEAR starting target"
      : "1,000 NEAR target · " + (BigInt(live.reserve) >= 10n ** 27n ? "Funded" : "Below target");
    byId("live-window").textContent = live.run ? (scenarios[live.run.scenario] + " · " + utc.format(live.run.start))
      : live.phase === "offline" ? "Waiting for a funded runner" : "Scheduled UTC windows";
    const escrow = byId("live-contract");
    escrow.hidden = !live.contract;
    if (live.contract) {
      escrow.href = "https://testnet.nearblocks.io/address/" + encodeURIComponent(live.contract);
      escrow.target = "_blank";
      escrow.rel = "noopener";
    }
    byId("feed-updated").textContent = live.updatedAt ? "Runner update " + utc.format(live.updatedAt) : "";
    for (const item of document.querySelectorAll("[data-health]")) {
      const observer = live.observers?.find(node => node.id === item.dataset.health);
      item.hidden = !observer || live.phase === "stale";
      if (observer) {
        item.textContent = observer.state === "online" ? "Online" : "Offline";
        item.dataset.tone = observer.state === "online" ? "good" : "warn";
      }
    }
    for (const entry of live.schedule) {
      const item = document.querySelector('[data-next="' + entry.id + '"]');
      if (!item) continue;
      item.textContent = ["offline", "unavailable", "stale", "funding-required", "paused"].includes(live.phase)
        ? "Nominal slot " + utc.format(entry.availableAt)
        : (entry.active ? "Window ends " : "Next window ") + utc.format(entry.availableAt);
    }
    byId("history-summary").textContent = live.history.length
      ? live.history.length + " recent demo settlements and " + pilot.length + " pilot transactions"
      : "Verified pilot transactions. Scheduled settlements will appear after finality.";
    const next = JSON.stringify([live.history, pilot]);
    if (next !== snapshot) {
      snapshot = next;
      rows = [...live.history.toReversed(), ...pilot];
      renderHistory();
    }
  } catch {
    byId("feed-status").textContent = "Feed unavailable";
    byId("feed-status").dataset.tone = "warn";
    byId("live-phase").textContent = "Unavailable";
    byId("history-summary").textContent = rows.length ? "Showing last loaded settlements." : "Try refreshing Testnet activity.";
    if (!snapshot) renderHistory();
  } finally {
    pending = false;
    byId("refresh-live").disabled = false;
  }
}
byId("refresh-live").addEventListener("click", refresh);
byId("history-more").addEventListener("click", () => { limit += 8; renderHistory(); });
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
