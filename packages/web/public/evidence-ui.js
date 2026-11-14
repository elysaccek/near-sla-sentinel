const controlStatus = new Map([
  ["reachable", ["Reachable", "good"]], ["unavailable", ["Unavailable", "warn"]],
  ["checking", ["Checking", "muted"]], ["not configured", ["Not configured", "muted"]],
]);
const voteStatus = { up: ["Up", "good"], down: ["Down", "bad"], unknown: ["Unknown", "warn"] };
const probeReasons = {
  missing: "No usable measurement", late: "Outside the slot deadline", transport: "Transport error",
  other_status: "HTTP status outside policy",
};
const evidenceMessages = {
  unavailable: "The vote is finalized. The evidence file is unavailable.",
  invalid: "The local evidence file did not match the finalized vote.",
  unreported: "This oracle has no finalized report yet.",
};

export function evidenceUi({ api, badge, date, row }) {
  const select = document.getElementById("evidence-oracle");
  const download = document.getElementById("evidence-download");
  const status = document.getElementById("evidence-status");
  const table = document.getElementById("evidence-table");
  const rows = document.getElementById("evidence-rows");
  let agreement;
  let request = 0;
  let activeKey;
  let displayed;
  let pending = false;

  function clear(message = "") {
    displayed = undefined;
    download.hidden = true;
    table.hidden = true;
    rows.replaceChildren();
    status.textContent = message;
    status.removeAttribute("title");
  }

  function render(bundle, hash) {
    const { evidence } = bundle;
    const historical = evidence.domain === "sla-sentinel/evidence/v1";
    status.textContent = historical
      ? "Matches the finalized vote. This evidence format predates control diagnostics."
      : "Matches the finalized vote and its evidence hash.";
    status.title = "SHA-256 " + hash;
    rows.replaceChildren(...evidence.observations.map((slot) => {
      const start = Number(evidence.starts_at_ms) + slot.slot * evidence.slot_ms;
      const target = historical ? slot.http_status : slot.observed_http_status;
      const control = controlStatus.get(slot.control_state) ?? ["Not recorded", "muted"];
      return row([
        (slot.slot + 1) + " · " + date(start), target === null ? "—" : "HTTP " + target,
        badge(...voteStatus[slot.result]), badge(...control),
        slot.diagnostic ?? probeReasons[slot.reason],
      ]);
    }));
    table.hidden = false;
    download.hidden = false;
  }

  async function load() {
    if (!agreement) return;
    const { genesis, sla_id, oracles, votes } = agreement;
    const oracle = select.value;
    const vote = votes[oracles.indexOf(oracle)];
    if (!vote) return;
    const hash = vote.submitted ? vote.evidence_hash.map((byte) => byte.toString(16).padStart(2, "0")).join("") : null;
    const key = JSON.stringify([genesis, sla_id, oracle, hash]);
    if (activeKey === key && (displayed || pending || !hash)) return;
    const changed = activeKey !== key;
    const current = ++request;
    activeKey = key;
    pending = Boolean(hash);
    if (changed) clear(hash ? "Checking the finalized evidence…" : evidenceMessages.unreported);
    if (!hash) return;
    try {
      const result = await api("agreements/" + encodeURIComponent(sla_id) + "/evidence/" + encodeURIComponent(oracle), { authenticated: false });
      if (current !== request) return;
      if (result.genesis !== genesis || result.hash !== hash) throw new Error("The finalized agreement has changed.");
      if (result.status === "verified") {
        render(result.bundle, hash);
        displayed = result.bundle;
      } else clear(evidenceMessages[result.status] ?? "Unable to verify this evidence.");
    } catch {
      if (current === request) clear("Unable to verify this evidence. The finalized reports remain visible above.");
    } finally {
      if (current === request) pending = false;
    }
  }

  select.addEventListener("change", load);
  download.addEventListener("click", () => {
    if (!displayed) return;
    const { sla_id, oracle } = displayed.evidence;
    const url = URL.createObjectURL(new Blob([JSON.stringify(displayed, null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `sla-${sla_id}-${oracle}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return {
    show(value) {
      if (!value) {
        ++request;
        activeKey = undefined;
        pending = false;
        select.replaceChildren();
        agreement = undefined;
        clear();
        return;
      }
      if (value.genesis !== agreement?.genesis || value.sla_id !== agreement?.sla_id) {
        select.replaceChildren(...value.oracles.map((oracle) => new Option(oracle, oracle)));
        const reported = value.votes.findIndex((vote) => vote.submitted);
        if (reported >= 0) select.selectedIndex = reported;
      }
      agreement = value;
      void load();
    },
  };
}
