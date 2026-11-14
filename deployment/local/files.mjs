import { randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";

// Keep the first complete file, including when Compose reruns a one-shot service.
export async function ensureFile(path, value, mode = 0o600, owner) {
  const temporary = path + "." + randomUUID();
  const file = await open(temporary, "wx", mode);
  try {
    try {
      await file.writeFile(value);
      if (owner) await file.chown(...owner);
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    return await readFile(path);
  } finally { await unlink(temporary); }
}
