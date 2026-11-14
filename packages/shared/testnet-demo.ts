export const previousDemoPayout = "100000000000000000000000";

export const testnetDemo = {
  genesis: "FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b",
  codeHash: "FmrCakSHFE5fFPE6JyutaUCDRFgS99Py8pEyBFtoniLT",
  allocation: "1000000000000000000000000000",
  payout: "10000000000000000000000",
  slotMs: 10_000,
  slotCount: 6,
  minDown: 3,
  // The two observer windows line up every six hours. The shared target has its own offset.
  windows: [
    { id: "oracle-a", hours: 2, offsetMinutes: 5, durationMinutes: 3 },
    { id: "oracle-b", hours: 3, offsetMinutes: 5, durationMinutes: 3 },
    { id: "target", hours: 5, offsetMinutes: 35, durationMinutes: 3 },
  ],
} as const;

export type DemoScenario = (typeof testnetDemo.windows)[number]["id"] | "oracle-pair";
export const demoRoles = ["oracle-a", "oracle-b", "oracle-c"] as const;
export type DemoRole = (typeof demoRoles)[number];

const minute = 60_000;
function windowAt(now: number, hours: number, offsetMinutes: number, durationMinutes: number) {
  const period = hours * 60 * minute;
  const offset = offsetMinutes * minute;
  const start = Math.floor((now - offset) / period) * period + offset;
  const end = start + durationMinutes * minute;
  return { start, end, active: now < end, next: start + period };
}

export function demoWindows(now: number) {
  return testnetDemo.windows.map(({ id, hours, offsetMinutes, durationMinutes }) =>
    ({ id, ...windowAt(now, hours, offsetMinutes, durationMinutes) }));
}

export function demoPairWindow(now: number) {
  return windowAt(now, 6, testnetDemo.windows[0].offsetMinutes, testnetDemo.windows[0].durationMinutes);
}

export function nextDemoWindows(after: number) {
  const windows = demoWindows(after);
  return [...new Set(windows.map(window => window.next))].map(start => {
    const opening = windows.filter(window => window.next === start);
    const scenario: DemoScenario = opening.length === 2 ? "oracle-pair" : opening[0].id;
    return { scenario, start, end: start + opening[0].end - opening[0].start };
  });
}

export function demoTargetStatus(now: number, oracle?: DemoRole) {
  return demoWindows(now).some(window => window.active && (window.id === "target" || window.id === oracle)) ? 503 : 200;
}
