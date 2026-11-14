import { agreementUi } from "/agreement-ui.js";
import { evidenceUi } from "/evidence-ui.js";

const $ = (id) => document.getElementById(id);
const state = {
  token: "", session: 0, view: "network", healthRequest: 0, nodeRequest: 0, inviteRequest: 0, detailRequest: 0,
  agreementRequest: 0, agreementId: "", agreementGenesis: null, escrow: null,
  settlement: null, settlementRequest: 0,
  nodes: { items: [], cursors: [null], next: null }, invites: { items: [], cursors: [null], next: null },
  node: null, mutation: false,
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(label, handler, className) {
  const node = element("button", label, className);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}

const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
function date(value) {
  const parsed = value == null ? null : new Date(value);
  return parsed && Number.isFinite(parsed.getTime()) ? time.format(parsed) : "—";
}

function row(cells) {
  const tr = element("tr");
  for (const value of cells) {
    const cell = element("td");
    cell.append(value ?? "—");
    tr.append(cell);
  }
  return tr;
}

function empty(target, columns, message) {
  const tr = row([message]);
  tr.firstChild.colSpan = columns;
  tr.firstChild.className = "empty";
  target.replaceChildren(tr);
}

function badge(text, tone) {
  const node = element("span", text, "badge");
  node.dataset.tone = tone;
  return node;
}

const statuses = {
  ACTIVE: ["Active", "good"], PENDING_APPROVAL: ["Pending approval", "warn"],
  DISABLED: ["Disabled", "muted"], REJECTED: ["Rejected", "muted"], REVOKED: ["Revoked", "bad"],
};
const connectivity = (node) => {
  if (node.connectivity === "ONLINE") return ["Online", "good"];
  return node.status === "ACTIVE" ? ["Offline", "warn"] : ["—", "muted"];
};

async function api(path, { method = "GET", body, after, authenticated = true } = {}) {
  const headers = {};
  if (authenticated && state.token) headers.Authorization = "Bearer " + state.token;
  if (method === "POST") headers["Content-Type"] = "application/json";
  const response = await fetch("/api/" + path + (after ? "?after=" + encodeURIComponent(after) : ""), {
    method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    cache: "no-store", signal: AbortSignal.timeout(9000),
  });
  const value = response.status === 204 ? null : await response.json();
  if (response.ok) return value;
  const error = new Error(value?.error ?? "Request failed");
  error.status = response.status;
  throw error;
}

let notificationTimer;
function notify(message) {
  clearTimeout(notificationTimer);
  $("notification").textContent = message;
  $("notification").hidden = false;
  notificationTimer = setTimeout(() => { $("notification").hidden = true; }, 4500);
}

async function health() {
  const current = ++state.healthRequest;
  let value;
  try { value = await api("health"); }
  catch { value = {}; }
  if (current !== state.healthRequest) return;
  for (const service of ["master", "sandbox", "target", "control"]) {
    const label = $(service + "-status");
    label.textContent = value[service] ? "Online" : "Unavailable";
    label.dataset.tone = value[service] ? "good" : "bad";
  }
  $("contract-label").textContent = value.contract ?? "Escrow unavailable";
  state.escrow = value.contract ? { network: value.network, contract: value.contract, genesis: value.genesis } : null;
  void agreementControls.network(value);
}

function resetPage(page) {
  page.items = [];
  page.cursors = [null];
  page.next = null;
}

function setAccess(open) {
  $("access").hidden = open || state.view !== "network";
  $("management").hidden = !open;
  $("lock").hidden = !open;
  for (const button of document.querySelectorAll(".requires-access, [data-view=invitations]")) button.disabled = !open;
  void agreementControls.access();
}

function lock(message = "") {
  ++state.session;
  ++state.nodeRequest;
  ++state.inviteRequest;
  ++state.detailRequest;
  ++state.agreementRequest;
  state.token = "";
  state.mutation = false;
  state.node = null;
  resetPage(state.nodes);
  resetPage(state.invites);
  for (const id of ["nodes", "invite-list", "heartbeats", "assignments", "node-metrics", "node-actions"]) $(id).replaceChildren();
  for (const id of ["registered", "online", "pending"]) $(id).textContent = "–";
  $("filter").value = "all";
  $("access-error").textContent = message;
  $("token").value = "";
  $("invitation-code").value = "";
  $("invitation-result").hidden = true;
  $("sla-id").value = state.agreementId = "";
  state.agreementGenesis = null;
  resetSettlement();
  const url = new URL(location.href);
  url.searchParams.delete("sla");
  url.searchParams.delete("genesis");
  url.searchParams.delete("claim");
  history.replaceState(null, "", url);
  $("agreement-details").hidden = true;
  $("agreement-error").textContent = "";
  agreementControls.show(null);
  evidenceControls.show(null);
  for (const id of ["agreement-terms", "votes", "slots", "agreement-heading", "agreement-block", "agreement-phase"]) $(id).replaceChildren();
  $("notification").hidden = true;
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  setAccess(false);
  navigate("network");
}

function failed(error, target) {
  if (error.status === 401) lock("Operator authentication failed. Check the token.");
  else $(target).textContent = error.message;
}

function navigate(view) {
  state.view = view;
  for (const name of ["network", "invitations", "agreements"]) {
    $(name).hidden = name !== view;
    const button = document.querySelector(`[data-view="${name}"]`);
    if (name === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $("access").hidden = Boolean(state.token) || view !== "network";
  if (state.token && view === "network") void loadNodes();
  if (state.token && view === "invitations") void loadInvitations();
  if (view === "agreements" && state.agreementId) void loadAgreement();
}

function renderPagination(page, ids) {
  const [controls, previous, next, number] = ids.map($);
  controls.hidden = page.cursors.length === 1 && !page.next;
  previous.disabled = page.cursors.length === 1;
  next.disabled = !page.next;
  number.textContent = "Page " + page.cursors.length;
}

function renderNodes() {
  const { nodes } = state;
  $("nodes").replaceChildren(...nodes.items.map((node) => {
    const account = element("div");
    account.append(element("div", node.near_account, "account"));
    const profile = [node.metadata?.region, node.metadata?.version && "v" + node.metadata.version].filter(Boolean).join(" · ");
    if (profile) account.append(element("p", profile));
    const details = action("Details", () => openNode(node.id));
    details.setAttribute("aria-label", "Details for " + node.near_account);
    return row([account, badge(...(statuses[node.status] ?? [node.status, "muted"])), badge(...connectivity(node)),
      date(node.last_heartbeat_at), details]);
  }));
  if (!nodes.items.length) empty($("nodes"), 5, $("filter").value === "pending" ? "No nodes awaiting approval." : "No oracle nodes registered.");
  renderPagination(nodes, ["pagination", "previous", "next", "page-number"]);
}

async function loadNodes() {
  if (!state.token) return;
  const request = ++state.nodeRequest;
  const page = state.nodes;
  try {
    const list = $("filter").value === "pending" ? "oracles/pending" : "oracles";
    const [counts, result] = await Promise.all([api("oracles/summary"), api(list, { after: page.cursors.at(-1) })]);
    if (request !== state.nodeRequest) return;
    for (const name of ["registered", "online", "pending"]) $(name).textContent = counts[name];
    Object.assign(page, result);
    const focused = document.activeElement?.getAttribute("aria-label");
    renderNodes();
    if (focused?.startsWith("Details for ")) {
      [...$("nodes").querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === focused)?.focus();
    }
    $("last-refresh").textContent = "Updated " + date(Date.now());
    $("registry-error").textContent = "";
  } catch (error) {
    if (request === state.nodeRequest) {
      $("last-refresh").textContent = "Registry refresh failed";
      failed(error, "registry-error");
    }
  }
}

function inviteStatus(invitation) {
  if (invitation.revoked_at) return ["Revoked", "muted"];
  if (invitation.consumed_at) return ["Used", "muted"];
  return new Date(invitation.expires_at).getTime() <= Date.now() ? ["Expired", "muted"] : ["Available", "good"];
}

async function loadInvitations() {
  if (!state.token) return;
  const request = ++state.inviteRequest;
  try {
    const page = state.invites;
    const result = await api("oracles/invitations", { after: page.cursors.at(-1) });
    if (request !== state.inviteRequest) return;
    Object.assign(page, result);
    $("invite-list").replaceChildren(...page.items.map((invite) => {
      const status = inviteStatus(invite);
      return row([element("code", invite.id), badge(...status), date(invite.expires_at),
        status[0] === "Available" ? action("Revoke", () => revokeInvitation(invite.id), "danger") : "—"]);
    }));
    if (!page.items.length) empty($("invite-list"), 4, "No invitations.");
    renderPagination(page, ["invite-pagination", "invite-previous", "invite-next", "invite-page-number"]);
    $("invitations-error").textContent = "";
  } catch (error) {
    if (request === state.inviteRequest) failed(error, "invitations-error");
  }
}

function turnPage(page, direction, load) {
  if (direction === "next" && page.next) page.cursors.push(page.next);
  else if (direction === "previous" && page.cursors.length > 1) page.cursors.pop();
  else return;
  void load();
}

function metrics(target, entries) {
  $(target).replaceChildren(...entries.map(([name, value]) => {
    const item = element("div");
    const definition = element("dd");
    definition.append(value ?? "—");
    item.append(element("dt", name), definition);
    return item;
  }));
}

function nearAmount(yocto) {
  const digits = yocto.padStart(25, "0");
  const fraction = digits.slice(-24).replace(/0+$/, "");
  return digits.slice(0, -24) + (fraction ? "." + fraction : "") + " NEAR";
}

function renderAgreement(value) {
  const { sla_id, chain_time_ms: now, starts_at_ms: start, ends_at_ms: end, reporting_deadline_ms: deadline, votes, oracles } = value;
  const reported = votes.filter((vote) => vote.submitted).length;
  let phase = "Awaiting finalization";
  if (value.outcome !== "undecided") phase = label(value.outcome);
  else if (!value.accepted && now < Number(start)) phase = "Awaiting acceptance";
  else if (value.accepted && now < Number(start)) phase = "Scheduled";
  else if (value.accepted && now < Number(end)) {
    phase = "Observing · slot " + (1 + Math.floor((now - Number(start)) / value.slot_ms)) + " of " + value.slot_count;
  } else if (value.accepted && now < Number(deadline) && reported < oracles.length) phase = "Reporting";
  $("agreement-heading").textContent = "SLA " + sla_id + " · " + value.contract;
  $("agreement-phase").textContent = phase;
  $("agreement-phase").dataset.tone = value.outcome === "breach" ? "bad" : value.outcome === "inconclusive" ? "warn" : "good";
  $("agreement-block").textContent = "Final block " + value.block_hash + " · " + date(now);
  const settlement = value.payment === "paid"
    ? value.outcome === "breach" ? "Compensation paid to customer" : "Deposit returned to provider"
    : label(value.payment);
  state.settlement = value.payment === "paid" ? {
    slaId: sla_id, payout: value.payout,
    beneficiary: value.outcome === "breach" ? value.customer : value.provider,
  } : null;
  $("settlement-check").hidden = !state.settlement;
  metrics("agreement-terms", [
    ["Provider", value.provider], ["Customer", value.customer], ["Target", value.target_url ?? "Unverified"],
    ["Compensation", nearAmount(value.payout)],
    ["Customer accepted", value.accepted ? "Yes" : "No"], ["Down quorum", value.down_quorum + " of " + oracles.length],
    ["Consecutive failures", value.min_down_slots + " slots"], ["Slot interval", value.slot_ms / 1000 + " s"],
    ["Window starts", date(Number(start))], ["Window ends", date(Number(end))], ["Reporting deadline", date(Number(deadline))],
    ["Votes reported", reported + " of " + oracles.length], ["Settlement", settlement],
    ["Confirmed down streak", value.outcome === "undecided" ? "—" : String(value.confirmed_down_slots)],
    ["Possible down streak", value.outcome === "undecided" ? "—" : String(value.possible_down_slots)],
  ]);
  const slots = Array.from({ length: value.slot_count }, (_, index) => index);
  const header = element("tr");
  for (const title of ["Oracle", ...slots.map((slot) => String(slot + 1))]) {
    const th = element("th", title);
    th.scope = "col";
    header.append(th);
  }
  $("slots").replaceChildren(header);
  $("votes").replaceChildren(...oracles.map((oracle, index) => {
    const vote = votes[index];
    const up = BigInt(vote.up_mask);
    const down = BigInt(vote.down_mask);
    const cells = slots.map((slot) => {
      const bit = 1n << BigInt(slot);
      if (!vote.submitted) return badge("—", "muted");
      if ((up & bit) !== 0n) return badge("Up", "good");
      if ((down & bit) !== 0n) return badge("Down", "bad");
      return badge("Unknown", "warn");
    });
    return row([element("code", oracle), ...cells]);
  }));
  $("agreement-details").hidden = false;
  agreementControls.show(value);
  evidenceControls.show(value);
}

async function loadAgreement() {
  if (!state.agreementId) return;
  const request = ++state.agreementRequest;
  try {
    const value = await api("agreements/" + encodeURIComponent(state.agreementId), { authenticated: false });
    if (request !== state.agreementRequest) return;
    if (state.agreementGenesis !== null && state.agreementGenesis !== value.genesis) {
      throw new Error("This offer belongs to a different Sandbox chain.");
    }
    if (state.agreementGenesis === null) {
      state.agreementGenesis = value.genesis;
      setAgreementUrl();
    }
    renderAgreement(value);
    $("agreement-error").textContent = "";
  } catch (error) {
    if (request !== state.agreementRequest) return;
    resetSettlement($("settlement-hash").value);
    $("agreement-details").hidden = true;
    agreementControls.show(null);
    evidenceControls.show(null);
    failed(error, "agreement-error");
  }
}

function setAgreementUrl() {
  const url = new URL(location.href);
  url.searchParams.set("sla", state.agreementId);
  if (state.agreementGenesis !== null) url.searchParams.set("genesis", state.agreementGenesis);
  else url.searchParams.delete("genesis");
  if ($("settlement-hash").value) url.searchParams.set("claim", $("settlement-hash").value);
  else url.searchParams.delete("claim");
  history.replaceState(null, "", url);
}

function resetSettlement(claim = "") {
  state.settlement = null;
  ++state.settlementRequest;
  $("settlement-check").open = Boolean(claim);
  $("settlement-check").hidden = true;
  $("settlement-hash").value = claim;
  $("settlement-check-status").textContent = "";
  $("settlement-check-receipts").replaceChildren();
}

function openAgreement(id, genesis = state.escrow?.genesis ?? null, claim = "") {
  state.agreementId = $("sla-id").value = id;
  state.agreementGenesis = genesis;
  resetSettlement(claim);
  $("agreement-details").hidden = true;
  agreementControls.show(null);
  evidenceControls.show(null);
  $("agreement-error").textContent = "";
  setAgreementUrl();
  navigate("agreements");
}

$("settlement-hash").addEventListener("input", () => {
  ++state.settlementRequest;
  const url = new URL(location.href);
  url.searchParams.delete("claim");
  history.replaceState(null, "", url);
  $("settlement-check-status").textContent = "";
  $("settlement-check-receipts").replaceChildren();
});
$("settlement-form").addEventListener("submit", async event => {
  event.preventDefault();
  const scope = state.settlement;
  if (!scope) return;
  const hash = $("settlement-hash").value;
  const request = ++state.settlementRequest;
  $("settlement-check-status").textContent = "Checking finalized receipts…";
  $("settlement-check-receipts").replaceChildren();
  try {
    const result = await api("settlement/verify", { method: "POST", authenticated: false,
      body: { hash, signer: scope.beneficiary } });
    if (request !== state.settlementRequest) return;
    const proof = result.proof;
    if (result.status !== "final" || result.method !== "claim" || !proof
        || proof.sla_id !== scope.slaId || proof.transaction_hash !== hash || proof.amount_yoctonear !== scope.payout) {
      throw new Error("The claim did not verify for this agreement.");
    }
    $("settlement-check-status").textContent = result.source === "recorded"
      ? "Verified against recorded final receipts" : "Verified at finality";
    metrics("settlement-check-receipts", [
      ["Amount", nearAmount(proof.amount_yoctonear)], ["Attempt", String(proof.attempt)],
      ["Native transfer", element("code", proof.transfer_receipt_id)],
      ["Payment callback", element("code", proof.callback_receipt_id)],
    ]);
    setAgreementUrl();
  } catch (error) {
    if (request === state.settlementRequest) failed(error, "settlement-check-status");
  }
});

const nodeActions = {
  PENDING_APPROVAL: ["approve", "reject"], ACTIVE: ["disable", "revoke"], DISABLED: ["enable", "revoke"],
};
const label = (value) => value.charAt(0).toUpperCase() + value.slice(1);

function renderDetails(detail) {
  const { node, heartbeats, assignments } = detail;
  const latest = heartbeats.items[0]?.health ?? {};
  $("node-title").textContent = node.near_account;
  $("node-id").textContent = node.id;
  metrics("node-metrics", [
    ["Registry", badge(...(statuses[node.status] ?? [node.status, "muted"]))],
    ["Heartbeat", badge(...connectivity(node))],
    ["Active SLAs reported", latest.active_slas],
    ["Last measurement", date(latest.last_measurement)],
    ["Control probe", latest.control],
    ["RPC", latest.rpc],
    ["Clock", latest.clock],
    ["Last diagnostic", latest.diagnostic],
  ]);
  $("heartbeats").replaceChildren(...heartbeats.items.map(({ received_at, health }) =>
    row([date(received_at), health.control, health.rpc, health.diagnostic ?? "—"])));
  if (!heartbeats.items.length) empty($("heartbeats"), 4, "No signed heartbeats received.");
  $("older-heartbeats").hidden = !heartbeats.next;
  $("assignments").replaceChildren(...assignments.items.map(({ assignment }) => {
    const referenceLabel = assignment.contract + " / " + assignment.sla_id;
    const reference = assignment.network === state.escrow?.network && assignment.contract === state.escrow.contract
      ? action(referenceLabel, () => {
        $("node-dialog").close();
        openAgreement(assignment.sla_id);
      }, "agreement-link") : element("code", referenceLabel);
    return row([reference, assignment.policy.down_quorum + " of " + assignment.policy.oracles.length, date(Number(assignment.policy.ends_at_ms))]);
  }));
  if (!assignments.items.length) empty($("assignments"), 3, "No agreements assigned.");
  $("more-assignments").hidden = !assignments.next;
  $("node-actions").replaceChildren(...(nodeActions[node.status] ?? []).map((name) =>
    action(label(name), () => changeNode(node, name), ["revoke", "reject"].includes(name) ? "danger" : "")));
}

async function openNode(id) {
  const dialog = $("node-dialog");
  const request = ++state.detailRequest;
  state.node = null;
  $("node-error").textContent = "";
  $("node-title").textContent = "Loading oracle details";
  $("node-id").textContent = "";
  for (const section of ["node-metrics", "node-actions", "assignments", "heartbeats"]) $(section).replaceChildren();
  $("older-heartbeats").hidden = $("more-assignments").hidden = true;
  if (!dialog.open) dialog.showModal();
  try {
    const path = "oracles/" + id;
    const [node, heartbeats, assignments] = await Promise.all([
      api(path), api(path + "/heartbeats"), api(path + "/assignments"),
    ]);
    if (!dialog.open || request !== state.detailRequest) return;
    state.node = { node, heartbeats, assignments };
    renderDetails(state.node);
  } catch (error) {
    if (dialog.open && request === state.detailRequest) failed(error, "node-error");
  }
}

async function moreHistory(name, button) {
  const detail = state.node;
  if (!detail?.[name].next) return;
  const control = $(button);
  control.disabled = true;
  try {
    const result = await api("oracles/" + detail.node.id + "/" + name, { after: detail[name].next });
    if (state.node !== detail || !$("node-dialog").open) return;
    detail[name].items.push(...result.items);
    detail[name].next = result.next;
    renderDetails(detail);
  } catch (error) {
    if (state.node === detail) failed(error, "node-error");
  } finally { control.disabled = false; }
}

async function mutate(path, target, options, onSuccess, button) {
  if (state.mutation || !state.token) return;
  state.mutation = true;
  const session = state.session;
  if (button) button.disabled = true;
  $(target).textContent = "";
  try {
    const result = await api(path, options);
    if (session === state.session) onSuccess(result);
  } catch (error) {
    if (session === state.session) failed(error, target);
  } finally {
    if (session === state.session) state.mutation = false;
    if (button) button.disabled = false;
  }
}

function changeNode(node, name) {
  if (!window.confirm(label(name) + " " + node.near_account + "?")) return;
  const detail = state.node;
  void mutate("oracles/" + node.id + "/" + name, "node-error", { method: "POST" }, ({ status }) => {
    notify(node.near_account + " · " + (statuses[status]?.[0] ?? status));
    if (state.node === detail && $("node-dialog").open) void openNode(node.id);
    void loadNodes();
  });
}

function revokeInvitation(id) {
  if (!window.confirm("Revoke this invitation?")) return;
  void mutate("oracles/invitations/" + id, "invitations-error", { method: "DELETE" }, () => {
    notify("Invitation revoked");
    void loadInvitations();
  });
}

function openInvitation() {
  $("invitation-result").hidden = true;
  $("invitation-code").value = "";
  $("invite-error").textContent = "";
  $("invite-dialog").showModal();
}

$("access-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (button.disabled) return;
  button.disabled = true;
  const candidate = $("token").value.trim();
  $("token").value = "";
  $("access-error").textContent = "";
  state.token = candidate;
  const session = ++state.session;
  try {
    await api("oracles/summary");
    if (session !== state.session) return;
    setAccess(true);
    void loadNodes();
  } catch (error) {
    if (session === state.session) lock(error.status === 401 ? "Operator authentication failed. Check the token." : error.message);
  } finally { button.disabled = false; }
});
$("lock").addEventListener("click", () => lock());
for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => navigate(button.dataset.view));
for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => {
  const dialog = button.closest("dialog");
  if (dialog.id === "invite-dialog") {
    $("invitation-code").value = "";
    $("invitation-result").hidden = true;
  }
  dialog.close();
});
$("filter").addEventListener("change", () => { resetPage(state.nodes); void loadNodes(); });
$("refresh").addEventListener("click", loadNodes);
$("refresh-invitations").addEventListener("click", loadInvitations);
$("previous").addEventListener("click", () => turnPage(state.nodes, "previous", loadNodes));
$("next").addEventListener("click", () => turnPage(state.nodes, "next", loadNodes));
$("invite-previous").addEventListener("click", () => turnPage(state.invites, "previous", loadInvitations));
$("invite-next").addEventListener("click", () => turnPage(state.invites, "next", loadInvitations));
$("older-heartbeats").addEventListener("click", () => moreHistory("heartbeats", "older-heartbeats"));
$("more-assignments").addEventListener("click", () => moreHistory("assignments", "more-assignments"));
$("agreement-form").addEventListener("submit", (event) => {
  event.preventDefault();
  openAgreement($("sla-id").value);
});
$("node-dialog").addEventListener("close", () => { ++state.detailRequest; state.node = null; });
for (const id of ["open-invite", "new-invite"]) $(id).addEventListener("click", openInvitation);
$("invite-dialog").addEventListener("close", () => { $("invitation-code").value = ""; $("invitation-result").hidden = true; });
$("invite-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void mutate("oracles/invitations", "invite-error", { method: "POST", body: { ttl_seconds: Number($("ttl").value) } },
    (invite) => {
      if ($("invite-dialog").open) {
        $("invitation-code").value = invite.code;
        $("invite-expiry").textContent = "Expires " + date(invite.expires_at);
        $("invitation-result").hidden = false;
      }
      if (state.view === "invitations") void loadInvitations();
    }, event.submitter);
});
$("copy").addEventListener("click", async () => {
  const input = $("invitation-code");
  try { await navigator.clipboard.writeText(input.value); notify("Invitation copied"); }
  catch { input.focus(); input.select(); notify("Copy the selected invitation code"); }
});

const agreementControls = agreementUi({
  api, admin: () => !$("management").hidden && Boolean(state.token), open: openAgreement,
  refresh: loadAgreement, metrics, date, nearAmount, notify, action,
});
const evidenceControls = evidenceUi({ api, badge, date, row });
setAccess(false);
const initial = new URL(location.href).searchParams;
if (initial.has("sla")) {
  const hash = initial.get("claim") ?? "";
  openAgreement(initial.get("sla"), initial.get("genesis"), /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash) ? hash : "");
}
void health();
setInterval(() => {
  if (document.hidden) return;
  void health();
  if (state.view === "network" && !$("node-dialog").open) void loadNodes();
  if (state.view === "agreements" && state.agreementId) void loadAgreement();
}, 10_000);

