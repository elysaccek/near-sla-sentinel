import { readFile } from "node:fs/promises";

export const scheduleFile = "/demo-state/window.json";

export async function activeScenario(now = Date.now()) {
  try {
    const { scenario, startsAt, endsAt } = JSON.parse(await readFile(scheduleFile, "utf8"));
    if (["outage", "control-loss"].includes(scenario)
        && Number.isSafeInteger(startsAt) && Number.isSafeInteger(endsAt)
        && endsAt > startsAt && endsAt - startsAt <= 60_000 && now >= startsAt && now < endsAt) {
      return scenario;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return "healthy";
}
