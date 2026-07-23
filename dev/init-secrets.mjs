#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const secretDirectory = resolve(
  process.env.ROLLERSKATE_DEV_SECRET_DIR ?? `${scriptDirectory}/secrets`
);
const secretNames = ["matrix_as_token", "matrix_hs_token"];

await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
await chmod(secretDirectory, 0o700);

for (const name of secretNames) {
  await ensureSecret(resolve(secretDirectory, name));
}

process.stdout.write(`Rollerskate development secrets ready in ${secretDirectory}\n`);

async function ensureSecret(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`development secret must be a regular file: ${path}`);
    }
    if ((await readFile(path, "utf8")).trim() === "") {
      throw new Error(`development secret is empty: ${path}`);
    }
    await chmod(path, 0o600);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${randomBytes(32).toString("hex")}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    await link(temporaryPath, path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    await unlink(temporaryPath);
  }
  if ((await readFile(path, "utf8")).trim() === "") {
    throw new Error(`development secret is empty: ${path}`);
  }
  await chmod(path, 0o600);
}
