import { clearPending, openSandboxWallet, pendingTransaction, signEscrow, storePending, targetHash, toYocto } from "/wallet-bundle.js";

const $ = (id) => document.getElementById(id);
const validity = 120_000;
const elapsed = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const captions = {
  create_sla: "Fund offer", accept_sla: "Accept offer", finalize: "Finalize agreement", claim: "Claim settlement",
};

export function agreementUi({ api, admin, open, refresh, metrics, date, nearAmount, notify, action }) {
  let chain;
  let sandboxReady = false;
  let wallet;
  let funded = false;
  let walletBalance;
  let connecting = false;
  let restoringWallet = false;
  let agreement;
  let prepared;
  let busy = false;
  let restoredGenesis;
  let roster = [];
  let cursor;
  let assigning = false;
  let eligibilityRequest = 0;

  const rpc = (route, body) => api("wallet/" + route, { method: "POST", body, authenticated: false });
  const activePending = () => chain && wallet && pendingTransaction(chain, wallet.account);
  const routeFor = (id) => "agreements/" + encodeURIComponent(id);

  function renderWallet() {
    $("wallet-account").hidden = $("refresh-wallet").hidden = !wallet;
    $("wallet-account").textContent = wallet?.account ?? "";
    $("connect-wallet").disabled = (!wallet && !sandboxReady) || restoringWallet || connecting;
    $("connect-wallet").textContent = wallet ? "Copy wallet address" : "Connect Sandbox wallet";
    $("wallet-funding").hidden = !wallet || funded;
    $("wallet-command").textContent = wallet
      ? "docker compose -p " + chain.compose_project + " -f deployment/local/compose.yml run --rm --no-deps wallet-fund"
        + " node local/wallet-fund.mjs " + wallet.account + " --genesis " + chain.genesis
      : "";
    $("wallet-summary").textContent = !wallet
      ? sandboxReady ? "Connect a wallet to sign local agreement transactions." : "Waiting for the local Sandbox."
      : !funded ? "This account needs Sandbox NEAR."
        : walletBalance ? nearAmount(walletBalance) + " · Local Sandbox" : "Local Sandbox";
    $("offer-panel").hidden = !admin() || !funded;
    renderActions();
  }

  async function checkWallet() {
    if (!wallet || !chain) return;
    const current = wallet;
    const result = await rpc("account", { account: current.account, public_key: current.public_key });
    if (current !== wallet) return;
    funded = result.registered;
    walletBalance = result.balance;
    renderWallet();
  }

  async function connect() {
    if (wallet) return copy(wallet.account, "Wallet address copied");
    if (connecting || restoringWallet) return;
    if (!sandboxReady || !chain) throw new Error("Start the local Sandbox before connecting a wallet.");
    const genesis = chain.genesis;
    connecting = true;
    $("connect-wallet").disabled = true;
    try {
      const created = await openSandboxWallet(genesis, true);
      if (chain?.genesis !== genesis) return;
      wallet = created;
      renderWallet();
      await checkWallet();
    } finally {
      connecting = false;
      renderWallet();
    }
  }

  async function copy(value, message) {
    try { await navigator.clipboard.writeText(value); notify(message); }
    catch { window.prompt("Copy this value", value); }
  }

  function drawRoster() {
    const selected = new Set([...$("offer-oracles").querySelectorAll("input:checked")].map((box) => box.value));
    const first = !roster.some((node) => selected.has(node.near_account));
    $("offer-oracles").replaceChildren(...roster.map((node, index) => {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "oracle";
      checkbox.value = node.near_account;
      checkbox.checked = selected.has(node.near_account) || (first && index < 3);
      label.append(checkbox, node.near_account);
      return label;
    }));
    if (!roster.length) $("offer-oracles").textContent = "No eligible oracle is available on this page.";
    $("more-offer-oracles").hidden = !cursor;
    setQuorum();
  }

  function setQuorum() {
    const n = $("offer-oracles").querySelectorAll("input:checked").length;
    const quorum = $("offer-quorum");
    quorum.min = Math.floor(n / 2) + 1;
    quorum.max = Math.max(Number(quorum.min), n);
    if (Number(quorum.value) < Number(quorum.min) || Number(quorum.value) > n) quorum.value = quorum.min;
  }

  async function loadRoster(more = false) {
    if (!admin()) return;
    const request = ++eligibilityRequest;
    $("offer-error").textContent = "";
    const page = await api("oracles/eligible", { after: more ? cursor : undefined });
    if (request !== eligibilityRequest || !admin()) return;
    roster = more ? roster.concat(page.items) : page.items;
    cursor = page.next;
    drawRoster();
  }

  async function eligibleAccounts(accounts) {
    const found = new Map();
    let next;
    do {
      const page = await api("oracles/eligible", { after: next });
      for (const node of page.items) if (accounts.includes(node.near_account)) found.set(node.near_account, node.id);
      next = page.next;
    } while (next && found.size < accounts.length);
    return found;
  }

  function currentActions(value) {
    if (!wallet || !funded || !value || busy || activePending()) return [];
    if (value.outcome === "undecided") {
      const beforeStart = value.chain_time_ms < Number(value.starts_at_ms);
      if (!value.accepted && beforeStart && value.customer === wallet.account) return ["accept_sla"];
      const ready = value.accepted
        ? value.chain_time_ms >= Number(value.reporting_deadline_ms)
          || (value.chain_time_ms >= Number(value.ends_at_ms) && value.votes.every((vote) => vote.submitted))
        : !beforeStart;
      if (ready) return ["finalize"];
    }
    const beneficiary = value.outcome === "breach" ? value.customer : value.provider;
    return value.payment === "claimable" && beneficiary === wallet.account ? ["claim"] : [];
  }

  function renderActions() {
    const target = $("agreement-actions");
    const existing = document.activeElement;
    const focused = target.contains(existing) ? existing.textContent : "";
    if (!agreement) { target.replaceChildren(); return; }
    const buttons = currentActions(agreement).map((method) =>
      action(captions[method], () => void safe(() => reviewExisting(method), "agreement-action-status"), "primary"));
    buttons.push(action("Copy offer link", () => {
      const params = new URLSearchParams({ sla: agreement.sla_id, genesis: agreement.genesis });
      return copy(location.origin + "/?" + params, "Offer link copied");
    }));
    const canAssign = admin() && agreement.outcome === "undecided"
      && agreement.chain_time_ms < Number(agreement.ends_at_ms) && agreement.target_url === chain?.endpoint;
    if (canAssign) {
      const button = action("Assign oracle roster", () => void safe(assignRoster, "agreement-action-status"));
      button.disabled = assigning;
      buttons.push(button);
    }
    target.replaceChildren(...buttons);
    buttons.find((button) => button.textContent === focused)?.focus();
  }

  async function assignRoster() {
    if (!agreement || !chain || !admin() || assigning) return;
    assigning = true;
    renderActions();
    const current = agreement;
    try {
      const nodes = await eligibleAccounts(current.oracles);
      const missing = current.oracles.filter((account) => !nodes.has(account));
      const assigned = await Promise.allSettled([...nodes.values()].map((node) => api("oracles/" + node + "/assignments", {
        method: "POST", body: { contract: chain.contract, sla_id: current.sla_id, endpoint: chain.endpoint },
      })));
      const failures = assigned.filter((result) => result.status === "rejected");
      const pieces = [assigned.length - failures.length + " of " + current.oracles.length + " assignments available."];
      if (missing.length) pieces.push("Currently ineligible: " + missing.join(", ") + ".");
      if (failures.length) pieces.push(failures[0].reason.message);
      if (agreement?.sla_id === current.sla_id) $("agreement-action-status").textContent = pieces.join(" ");
    } finally { assigning = false; renderActions(); }
  }

  async function safe(work, output) {
    $(output).textContent = "";
    try { await work(); }
    catch (error) { $(output).textContent = error.message; }
  }

  async function confirmTerms(method, args, entries) {
    if (!wallet || !funded || !chain || activePending()) throw new Error("Connect a funded wallet and resolve any pending transaction.");
    if (busy || $("sign-dialog").open) return;
    busy = true;
    renderActions();
    const signer = wallet;
    const network = chain;
    try {
      const result = await rpc("prepare", { account: signer.account, public_key: signer.public_key, method, args });
      if (wallet !== signer || network.genesis !== chain?.genesis || (method === "create_sla" && !admin())) return;
      const deposit = method === "create_sla" ? (BigInt(args.payout) + BigInt(result.storage)).toString() : "0";
      prepared = { method, args, deposit, result, signer, network };
      $("sign-title").textContent = captions[method];
      $("sign-description").textContent = "Review the exact action before signing on this Sandbox.";
      metrics("sign-terms", [
        ["Network", network.network], ["Escrow", network.contract], ["Signing wallet", signer.account],
        ...entries, ...(result.storage ? [["Storage deposit", nearAmount(result.storage)]] : []),
        ["Attached deposit", nearAmount(deposit)], ["Gas limit", Number(result.gas) / 1e12 + " Tgas"],
      ]);
      $("sign-error").textContent = "";
      $("sign-dialog").showModal();
    } finally { busy = false; renderActions(); }
  }

  async function reviewOffer() {
    if (!admin() || !chain) return;
    const checked = [...$("offer-oracles").querySelectorAll("input:checked")].map((box) => box.value);
    if (checked.length < 3 || checked.length > 16) throw new Error("Select 3 to 16 distinct oracles.");
    const online = await eligibleAccounts(checked);
    if (online.size !== checked.length) throw new Error("An oracle is no longer eligible. Refresh the roster and review again.");
    const args = {
      customer: $("offer-customer").value.trim(), oracles: checked, down_quorum: Number($("offer-quorum").value),
      endpoint_hash: await targetHash(chain.endpoint), starts_at_ms: String(Date.now() + Number($("offer-start").value) * 1000),
      slot_ms: Number($("offer-interval").value) * 1000, slot_count: Number($("offer-slots").value),
      min_down_slots: Number($("offer-threshold").value), reporting_grace_ms: Number($("offer-grace").value) * 1000,
      payout: toYocto($("offer-payout").value.trim()),
    };
    if (args.customer === wallet?.account) throw new Error("Use the customer's separate Sandbox wallet address.");
    await confirmTerms("create_sla", args, [
      ["Customer", args.customer], ["Target", chain.endpoint], ["Oracle accounts", args.oracles.join(", ")],
      ["Down quorum", args.down_quorum + " of " + args.oracles.length],
      ["Start", date(Number(args.starts_at_ms))], ["Slot interval", args.slot_ms / 1000 + " s"],
      ["Slots", String(args.slot_count)], ["Consecutive failures", String(args.min_down_slots)],
      ["Reporting grace", args.reporting_grace_ms / 1000 + " s"], ["Compensation", nearAmount(args.payout)],
    ]);
  }

  async function reviewExisting(method) {
    const id = agreement?.sla_id;
    if (!id) return;
    const value = await api(routeFor(id), { authenticated: false });
    if (agreement?.sla_id !== id) return;
    if (value.genesis !== agreement.genesis || value.genesis !== chain?.genesis) {
      throw new Error("This offer belongs to a different Sandbox chain.");
    }
    agreement = value;
    if (!currentActions(value).includes(method)) throw new Error("This wallet or agreement is no longer eligible for that action.");
    if (method === "accept_sla" && !value.target_url) throw new Error("The endpoint cannot be verified against the on-chain hash.");
    await confirmTerms(method, { sla_id: id }, [
      ["Agreement", id], ["Provider", value.provider], ["Customer", value.customer],
      ["Target", value.target_url ?? "Unverified"], ["Oracle accounts", value.oracles.join(", ")],
      ["Down quorum", value.down_quorum + " of " + value.oracles.length],
      ["Consecutive failures", String(value.min_down_slots)], ["Compensation", nearAmount(value.payout)],
      ["Starts", date(Number(value.starts_at_ms))], ["Slot interval", value.slot_ms / 1000 + " s"],
      ["Slots", String(value.slot_count)], ["Reporting deadline", date(Number(value.reporting_deadline_ms))],
    ]);
  }

  function transactionStatus(message, hash, pending = false) {
    $("transaction-panel").hidden = false;
    $("transaction-status").textContent = message;
    $("transaction-hash").textContent = hash;
    $("transaction-receipts").hidden = true;
    $("transaction-receipts").replaceChildren();
    refreshRecovery(pending);
  }

  function refreshRecovery(pending) {
    const age = pending ? Date.now() - Number(pending.anchor) : 0;
    $("check-transaction").hidden = !pending;
    $("resend-transaction").hidden = !pending || age >= validity;
    $("discard-transaction").hidden = !pending || age < validity + 30_000;
  }

  async function waitForTransaction(network, pending, attempts) {
    for (let count = 0; count < attempts; count++) {
      const result = await rpc("status", { hash: pending.hash, signer: pending.signer });
      if (chain?.genesis !== network.genesis) return;
      if (result.status !== "pending" && result.status !== "unknown") {
        clearPending(network, pending);
        if (result.status === "final") {
          const message = result.method === "claim" && !result.proof
            ? "Claim finalized without a verified payment. Escrow state is " + result.payment + "."
            : captions[result.method] + " finalized · SLA " + result.sla_id;
          transactionStatus(message, pending.hash);
          if (result.proof) {
            metrics("transaction-receipts", [
              ["Native transfer", result.proof.transfer_receipt_id], ["Payment callback", result.proof.callback_receipt_id],
            ]);
            $("transaction-receipts").hidden = false;
          }
          open(result.sla_id, network.genesis);
          await checkWallet();
        } else {
          transactionStatus("The transaction failed on Sandbox. Review the agreement before trying again.", pending.hash);
          void refresh();
        }
        return;
      }
      if (count + 1 < attempts) await elapsed(1200);
    }
    transactionStatus("Waiting for finalized Sandbox receipts.", pending.hash, pending);
  }

  async function sendPending(network, pending, send) {
    transactionStatus("Waiting for finalized Sandbox receipts.", pending.hash, pending);
    try {
      if (send) {
        const response = await rpc("send", { signed: pending.signed });
        if (response.hash !== pending.hash) throw new Error("The RPC returned a different transaction hash.");
      }
      await waitForTransaction(network, pending, 12);
    } catch (error) {
      if (chain?.genesis === network.genesis && activePending()?.hash === pending.hash) {
        const reason = [400, 403, 409].includes(error.status) ? error.message + " " : "";
        transactionStatus(reason + "Check its hash or resend the same signed bytes.", pending.hash, pending);
      }
    }
  }

  async function sign() {
    if (busy || !prepared) return;
    const { network, signer, method, args, result, deposit } = prepared;
    if (activePending() || wallet !== signer || network.genesis !== chain?.genesis) throw new Error("The wallet session changed. Review the transaction again.");
    if (Date.now() >= result.prepared_at_ms + validity) throw new Error("This review has expired. Cancel and review the current terms.");
    if (!navigator.locks) throw new Error("Use a current browser with Web Locks for local transaction signing.");
    busy = true;
    $("confirm-sign").disabled = $("cancel-sign").disabled = true;
    try {
      const pending = await navigator.locks.request("sla-sentinel-wallet:" + network.genesis + ":" + signer.account, async () => {
        if (pendingTransaction(network, signer.account)) throw new Error("Check the pending transaction before signing another one.");
        const signed = await signEscrow({ wallet: signer, chain: network, prepared: result, method, args, deposit });
        const transaction = { ...signed, signer: signer.account, anchor: result.prepared_at_ms };
        storePending(network, transaction);
        return transaction;
      });
      prepared = null;
      $("sign-dialog").close();
      renderActions();
      await sendPending(network, pending, true);
    } finally {
      busy = false;
      $("confirm-sign").disabled = $("cancel-sign").disabled = false;
      renderActions();
    }
  }

  async function reconcile(send, discard = false) {
    const pending = activePending();
    const network = chain;
    if (!pending || busy) return;
    busy = true;
    try {
      if (discard) {
        if (Date.now() < Number(pending.anchor) + validity + 30_000) return;
        const result = await rpc("status", { hash: pending.hash, signer: pending.signer });
        if (result.status === "unknown") {
          clearPending(network, pending);
          transactionStatus("Expired transaction cleared.", pending.hash);
          return;
        }
      }
      await sendPending(network, pending, send);
    } finally { busy = false; renderActions(); }
  }

  $("connect-wallet").addEventListener("click", () => void safe(connect, "wallet-error"));
  $("refresh-wallet").addEventListener("click", () => void safe(checkWallet, "wallet-error"));
  $("copy-wallet-command").addEventListener("click", () => void copy($("wallet-command").textContent, "Funding command copied"));
  $("offer-form").addEventListener("submit", (event) => { event.preventDefault(); void safe(reviewOffer, "offer-error"); });
  $("offer-oracles").addEventListener("change", setQuorum);
  $("offer-slots").addEventListener("input", () => { $("offer-threshold").max = $("offer-slots").value; });
  $("refresh-offer-oracles").addEventListener("click", () => void safe(() => loadRoster(), "offer-error"));
  $("more-offer-oracles").addEventListener("click", () => void safe(() => loadRoster(true), "offer-error"));
  $("confirm-sign").addEventListener("click", () => void safe(sign, "sign-error"));
  $("sign-dialog").addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  $("sign-dialog").addEventListener("close", () => { prepared = null; renderActions(); });
  $("check-transaction").addEventListener("click", () => void safe(() => reconcile(false), "wallet-error"));
  $("resend-transaction").addEventListener("click", () => void safe(() => reconcile(true), "wallet-error"));
  $("discard-transaction").addEventListener("click", () => void safe(() => reconcile(false, true), "wallet-error"));

  return {
    async network(value) {
      const wasReady = sandboxReady;
      sandboxReady = Boolean(value?.sandbox && value.genesis);
      if (!sandboxReady) {
        if (wasReady) renderWallet();
        return;
      }
      chain = value;
      $("offer-endpoint").value = chain.endpoint;
      if (restoredGenesis === value.genesis) {
        if (!wasReady) renderWallet();
        refreshRecovery(activePending());
        return;
      }
      restoredGenesis = value.genesis;
      restoringWallet = true;
      wallet = null;
      funded = false;
      walletBalance = undefined;
      prepared = null;
      $("transaction-panel").hidden = true;
      renderWallet();
      try {
        await safe(async () => {
          const restored = await openSandboxWallet(value.genesis);
          if (chain?.genesis !== value.genesis) return;
          wallet = restored;
          await checkWallet();
          const pending = activePending();
          if (pending) transactionStatus("Check the pending Sandbox transaction.", pending.hash, pending);
        }, "wallet-error");
      } finally {
        if (chain?.genesis === value.genesis) {
          restoringWallet = false;
          renderWallet();
        }
      }
    },
    async access() {
      if (!admin() && prepared?.method === "create_sla") $("sign-dialog").close();
      $("offer-panel").hidden = !admin() || !funded;
      renderActions();
      if (admin()) await safe(loadRoster, "offer-error");
    },
    show(value) {
      if (agreement?.sla_id !== value?.sla_id) $("agreement-action-status").textContent = "";
      agreement = value;
      renderActions();
    },
  };
}
