import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const settingsPath = /^\/[A-Za-z0-9._/ -]+$/;

export async function install(role, action) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!uid || gid === undefined) throw new Error("Run setup as a non-root user with access to Docker");
  process.umask(0o077);
  if (process.argv[2] === "--help") {
    console.log(`Usage: node deployment/${role}/install.mjs [absolute-config-directory]`);
    return;
  }
  if (process.argv.length > 3) throw new Error("Provide at most one configuration directory");
  const dir = await realDestination(resolve(process.argv[2] ?? join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, ".config"), "sla-sentinel", role)));
  if (!settingsPath.test(dir) || dir === resolve(root)
      || dir.startsWith(resolve(root) + sep)) throw new Error("Use a configuration directory outside the checkout");
  await command("docker", ["info", "--format", "{{.ServerVersion}}"]);
  await command("docker", ["compose", "version", "--short"]);

  const ui = createInterface({ input: process.stdin, output: process.stderr, terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY) });
  const answers = ui[Symbol.asyncIterator]();
  async function ask(label, fallback = "") {
    process.stderr.write(label + (fallback ? ` [${fallback}] ` : " "));
    const answer = await answers.next();
    if (answer.done) throw new Error("Setup input ended before all required fields were entered");
    return answer.value.trim() || fallback;
  }
  const config = join(dir, "install.json");
  const env = join(dir, "compose-settings");
  const credentials = join(dir, "credentials");
  const projectSuffix = process.argv[2] ? "-" + createHash("sha256").update(dir).digest("hex").slice(0, 8) : "";
  const projectPrefix = role === "local" ? "sla-sentinel-local" : `sla-${role}`;
  const defaultProject = projectPrefix + projectSuffix;
  async function checkProject(project) {
    const rows = await command("docker", ["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`,
      "--format", "{{json .}}"], process.env, true);
    const other = rows.split(/\r?\n/).filter(Boolean).some(line =>
      !JSON.parse(line).Labels.split(",").includes(`com.docker.compose.project.environment_file=${env}`));
    if (other) throw new Error("This Compose project already uses another configuration directory. Choose a different project name.");
  }
  async function compose(project, args, capture = false) {
    const childEnv = { ...process.env };
    for (const name of Object.keys(childEnv)) {
      if (name.startsWith("SLA_") || name.startsWith("COMPOSE_")) delete childEnv[name];
    }
    const options = ["compose", "-p", project, "-f", `deployment/${role}/compose.yml`, "--env-file", env];
    // Local tests and private deployments can supply a managed CA or network override.
    if (process.env.SLA_COMPOSE_OVERRIDE_FILE) {
      const override = resolve(process.env.SLA_COMPOSE_OVERRIDE_FILE);
      if (!settingsPath.test(override)) throw new Error("Invalid Compose override path");
      options.push("-f", override);
    }
    return command("docker", [...options, ...args], childEnv, capture);
  }
  try {
    const saved = await readOptional(config, 8192);
    let parsed;
    if (saved) {
      try { parsed = JSON.parse(saved.toString("utf8")); }
      catch { throw new Error("Invalid saved installation configuration"); }
    }
    if (saved && (parsed?.version !== 1 || parsed.role !== role || parsed.uid !== uid || parsed.gid !== gid)) {
      throw new Error("Configuration belongs to a different role or OS account");
    }
    await action({ dir, credentials, ask, saved: parsed, compose, defaultProject, checkProject,
      async writeConfig(values, settings) {
        await createFile(env, Object.entries({ SLA_UID: uid, SLA_GID: gid, ...settings })
          .map(([key, value]) => {
            if (/[\x00-\x1f']/u.test(String(value))) throw new Error("Invalid setting " + key);
            return `${key}='${value}'\n`;
          }).join(""));
        await createFile(config, JSON.stringify({ version: 1, role, uid, gid, ...values }) + "\n");
      },
    });
  } finally {
    ui.close();
  }
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error("Expected an owner-only directory with mode 0700");
  }
}

async function realDestination(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return join(await realDestination(dirname(path)), basename(path));
  }
}

export async function readFile(path, limit, privateOnly = true) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit || (privateOnly && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
      throw new Error("Expected a small owner-controlled file");
    }
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error("Configuration file is too large");
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readOptional(path, limit) {
  try { return await readFile(path, limit); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Publish only complete files and compare against a previous partial setup.
export async function createFile(path, contents) {
  const bytes = Buffer.from(contents);
  const current = await readOptional(path, 16_384);
  if (current) {
    if (!current.equals(bytes)) throw new Error(`Saved ${basename(path)} differs from these settings`);
    return;
  }
  const temporary = join(dirname(path), `.install-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, path);
  } finally {
    await unlink(temporary);
  }
}

export function projectName(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(value)) throw new Error("Use a lower-case Compose project name of up to 48 characters");
  return value;
}

export function tcpPort(value) {
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65_535) {
    throw new Error("Use a TCP port from 1 to 65535");
  }
  return value;
}

export function rpcUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || /[\r\n']/.test(value)) {
    throw new Error("Use a Testnet HTTPS RPC URL without URL credentials");
  }
  return url.href;
}

function command(program, args, env = process.env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env, stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"] });
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.once("error", () => reject(new Error(`Could not start ${program}`)));
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`${program} command failed (${code ?? "interrupted"})`)));
  });
}
