import { join } from "node:path";
import { install, privateDirectory, projectName, tcpPort } from "../install-common.mjs";

await install("local", async ({ dir, ask, saved, compose, writeConfig, defaultProject, checkProject }) => {
  const project = projectName(saved?.project ?? await ask("Compose project name", defaultProject));
  const port = saved ? undefined : tcpPort(await ask("Local web port", "8780"));
  await checkProject(project);
  if (!saved) {
    await privateDirectory(dir);
    await writeConfig({ project }, { SLA_LOCAL_PORT: port });
  }
  await compose(project, ["up", "--build", "-d", "--wait", "--wait-timeout", "120"]);
  const address = (await compose(project, ["port", "sandbox", "8780"], true)).trim();
  if (!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(address)) throw new Error("Could not find the local website's loopback port");
  console.log("Product website at http://" + address);
  if (process.env.SLA_LOCAL_ENABLE_CONSOLE === "1") console.log("Sandbox console at http://" + address + "/console");
  console.log("Compose project " + project);
  console.log("Port settings " + join(dir, "compose-settings"));
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
