import { rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const target = resolve(process.cwd(), "dist");
if (basename(target) !== "dist") {
  throw new Error(`Refusing to clean unexpected build directory: ${target}`);
}
rmSync(target, { recursive: true, force: true });
