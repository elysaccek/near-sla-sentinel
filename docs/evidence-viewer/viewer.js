"use strict";

const byId = id => document.getElementById(id);
const pairIndexes = [[0, 1], [0, 2], [1, 2]];
const scenarioButtons = [...document.querySelectorAll("[data-case]")];
const archiveRoot = "https://github.com/elysaccek/near-sla-sentinel/blob/main/";

function longestRun(flags) {
  let current = 0;
  let length = 0;
  let start = 0;
  flags.forEach((matched, slot) => {
    current = matched ? current + 1 : 0;
    if (current > length) {
      length = current;
      start = slot - length + 1;
    }
  });
  return { start, length };
}

function analyze(rows) {
  return pairIndexes.map(([a, b]) => {
    const left = rows[a].slots;
    const right = rows[b].slots;
    return {
      indexes: [a, b],
      label: String.fromCharCode(65 + a) + " + " + String.fromCharCode(65 + b),
      confirmed: longestRun(left.map((slot, i) => slot.result === "down" && right[i].result === "down")),
      possible: longestRun(left.map((slot, i) => slot.result !== "up" && right[i].result !== "up")).length
    };
  });
}

function append(parent, tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
}

function drawMatrix(rows, pairs, selected, sandbox) {
  const matrix = byId("matrix");
  matrix.replaceChildren();
  const header = matrix.createTHead().insertRow();
  append(header, "th", "Oracle").scope = "col";
  rows[0].slots.forEach((_, i) => { append(header, "th", String(i + 1)).scope = "col"; });

  const body = matrix.createTBody();
  rows.forEach(({ oracle, slots }, i) => {
    const row = body.insertRow();
    const label = append(row, "th", String.fromCharCode(65 + i));
    label.scope = "row";
    label.title = oracle;
    slots.forEach(({ result, status }, slot) => {
      const cell = row.insertCell();
      cell.textContent = status ?? "?";
      cell.dataset.result = result;
      cell.title = result;
      const run = selected.confirmed;
      if (selected.indexes.includes(i) && slot >= run.start && slot < run.start + run.length) {
        cell.dataset.highlight = "true";
        cell.title = "Confirmed by pair " + selected.label;
      }
    });
  });
  if (sandbox) {
    const row = matrix.createTFoot().insertRow();
    append(row, "th", "Down pair").scope = "row";
    let previous;
    rows[0].slots.forEach((_, slot) => {
      const matching = pairs.filter(({ indexes }) => indexes.every(i => rows[i].slots[slot].result === "down"));
      const cell = row.insertCell();
      cell.textContent = matching.map(pair => pair.label).join(", ") || "—";
      cell.dataset.break = String(previous !== undefined && previous !== cell.textContent);
      previous = cell.textContent;
    });
  }
}

function near(yocto) {
  const digits = yocto.padStart(25, "0");
  const fraction = digits.slice(-24).replace(/0+$/, "");
  return digits.slice(0, -24) + (fraction ? "." + fraction : "") + " NEAR";
}

function showScenario(index) {
  const data = evidenceCases[index];
  const sandbox = index === 1;
  const pairs = analyze(data.rows);
  const confirmed = Math.max(...pairs.map(pair => pair.confirmed.length));
  const possible = Math.max(...pairs.map(pair => pair.possible));
  const verdict = confirmed >= data.threshold ? "breach" : possible < data.threshold ? "healthy" : "inconclusive";
  const matches = verdict === data.verdict.outcome && confirmed === data.verdict.confirmed && possible === data.verdict.possible;

  scenarioButtons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
  byId("source").textContent = sandbox ? "Sandbox · Scripted observations" : "Testnet · Recorded on one host";
  byId("confirmed").textContent = confirmed;
  byId("possible").textContent = possible;
  byId("threshold").textContent = data.threshold;
  byId("verdict").textContent = matches ? (sandbox ? "Inconclusive" : "Breach") : "Archive mismatch";
  byId("verdict").dataset.outcome = matches ? verdict : "inconclusive";
  byId("amount").textContent = matches ? near(data.amount) : "—";
  byId("outcome").textContent = !matches ? "Recomputed streaks differ from the archived verdict."
    : sandbox ? "Customer claim rejected. Provider refunded in Sandbox."
      : "Customer paid on NEAR Testnet.";
  for (const [id, value] of Object.entries({ recipient: data.beneficiary, transaction: data.transaction, transfer: data.transfer, callback: data.callback })) {
    byId(id).textContent = value;
  }
  byId("archive").href = archiveRoot + data.path;
  byId("explorer").hidden = !data.explorer;
  if (data.explorer) byId("explorer").href = data.explorer;

  const picker = byId("pairs");
  picker.replaceChildren();
  const buttons = pairs.map(pair => append(picker, "button", pair.label));
  function selectPair(selected) {
    const pair = pairs[selected];
    buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === selected)));
    drawMatrix(data.rows, pairs, pair, sandbox);
    const length = pair.confirmed.length;
    const span = length ? " · slots " + (pair.confirmed.start + 1) + "–" + (pair.confirmed.start + length) : "";
    byId("pair-summary").textContent = pair.label + " confirms " + length + " consecutive failed checks" + span + ".";
  }
  buttons.forEach((button, i) => {
    button.type = "button";
    button.addEventListener("click", () => selectPair(i));
  });
  selectPair(pairs.findIndex(pair => pair.confirmed.length === confirmed));
}

scenarioButtons.forEach((button, i) => button.addEventListener("click", () => showScenario(i)));
showScenario(0);
