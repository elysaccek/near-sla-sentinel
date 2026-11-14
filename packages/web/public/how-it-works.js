const byId = id => document.getElementById(id);
const steps = [
  ["Fund the agreement", "The provider locks 0.01 NEAR. The customer accepts the endpoint, oracle roster and payout terms."],
  ["Assign the monitoring", "The Master distributes the signed policy. Each oracle sends its own HTTP checks and reports under its own account."],
  ["Only A sees a failure", "Oracle A reports Down. B and C report Up. A single Down report leaves the escrow held."],
  ["Only B sees a failure", "Oracle B reports Down in the next slot. A and C report Up. The contract has no corroborated outage streak."],
  ["A and B agree", "A and B both report Down. C reports Up. This is the first slot supported by the required pair."],
  ["The same pair agrees again", "A and B report Down again. Two consecutive slots match, and the escrow remains held."],
  ["The streak reaches three", "A and B confirm the third consecutive Down slot. The contract finalizes a breach."],
  ["The customer claims", "The customer claims the 0.01 NEAR. The native transfer and its callback confirm the payment."],
];
const slots = [[503, 200, 200], [200, 503, 200], [503, 503, 200], [503, 503, 200], [503, 503, 200]];
const names = ["A", "B", "C"];
const lastStep = steps.length - 1;
const node = name => document.querySelector('[data-node="' + name + '"]');
let step = 0;
let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
let timer;

function badge(text, tone = "") {
  const span = document.createElement("span");
  span.className = "state";
  span.dataset.tone = tone;
  span.textContent = text;
  return span;
}

function setBadge(id, text, tone = "") {
  const item = byId(id);
  item.textContent = text;
  item.dataset.tone = tone;
}

function render() {
  clearTimeout(timer);
  const [title, caption] = steps[step];
  byId("step-index").textContent = `${step + 1} / ${steps.length}`;
  byId("step-title").textContent = title;
  byId("step-caption").textContent = caption;
  byId("step-prev").disabled = step === 0;
  byId("step-next").disabled = step === lastStep;
  byId("step-play").textContent = step === lastStep ? "Replay" : playing ? "Pause" : "Play";

  const paid = step === lastStep;
  const monitoring = step >= 2 && !paid;
  const visibleSlots = Math.min(slots.length, Math.max(0, step - 1));
  const current = monitoring ? slots[step - 2] : undefined;
  const streak = Math.max(0, visibleSlots - 2);
  const complete = streak === 3;
  node("terms").classList.toggle("active", step === 0 || complete);
  node("master").classList.toggle("active", step === 1);
  node("target").classList.toggle("active", monitoring);
  node("payout").classList.toggle("active", paid);
  byId("payment-flow").hidden = !paid;
  document.querySelectorAll(".map-lines").forEach((line, i) => {
    line.classList.remove("active");
    void line.offsetWidth;
    line.classList.toggle("active", i === 0 ? step === 1 : monitoring);
  });
  setBadge("terms-state", complete ? "Breach finalized" : "Funded · accepted", complete ? "warn" : "good");
  setBadge("payout-state", paid ? "Transfer confirmed" : complete ? "Ready to claim" : "Held in escrow",
    paid ? "good" : complete ? "warn" : "");
  byId("payout-details").textContent = paid ? "Payment callback finalized." :
    complete ? "The customer can submit a claim." : "Awaiting a corroborated outage.";
  byId("streak").textContent = streak + " / 3";
  byId("streak-note").textContent = streak ? "Oracle A + Oracle B" : visibleSlots ? "No matching pair" : "Waiting for checks";

  byId("walk-votes").replaceChildren(...names.map((name, index) => {
    const account = "oracle-" + name.toLowerCase();
    const status = current?.[index];
    const active = monitoring && (index < 2 || step < 4);
    node(account).classList.toggle("active", active);
    setBadge(account, status ? (status === 503 ? "503 · Down" : "200 · Up") : complete ? "Reported" : "Ready",
      status === 503 ? "bad" : status === 200 || complete ? "good" : "");
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = "Oracle " + name;
    row.append(label);
    for (let slot = 0; slot < slots.length; slot++) {
      const cell = document.createElement("td");
      const down = slots[slot][index] === 503;
      cell.append(slot < visibleSlots ? badge(down ? "Down" : "Up", down ? "bad" : "good") : "—");
      row.append(cell);
    }
    return row;
  }));
  byId("walk-votes-mobile").replaceChildren(...slots.map((statuses, slot) => {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = String(slot + 1);
    row.append(label);
    for (const status of statuses) {
      const down = status === 503;
      row.insertCell().append(slot < visibleSlots ? badge(down ? "Down" : "Up", down ? "bad" : "good") : "—");
    }
    return row;
  }));
  [...byId("walk-steps").children].forEach((li, i) => {
    const button = li.firstElementChild;
    if (i === step) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  if (playing && step < lastStep) {
    timer = setTimeout(() => { step++; render(); }, step === 0 ? 3400 : 3100);
  }
}

function go(next) {
  playing = false;
  step = Math.min(lastStep, Math.max(0, next));
  render();
}

["Fund", "Assign", ...slots.map((_, i) => `Slot ${i + 1}`), "Claim"].forEach((label, i) => {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => go(i));
  li.append(button);
  byId("walk-steps").append(li);
});
byId("step-prev").addEventListener("click", () => go(step - 1));
byId("step-next").addEventListener("click", () => go(step + 1));
byId("step-reset").addEventListener("click", () => go(0));
byId("step-play").addEventListener("click", () => {
  if (step === lastStep) { step = 0; playing = true; }
  else playing = !playing;
  render();
});
render();
