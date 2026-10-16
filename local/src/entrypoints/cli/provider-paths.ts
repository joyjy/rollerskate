import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { findExecutable } from "./shared.js";

/** Keep explicit configuration and PATH precedence; support installers outside shell PATH. */
export function providerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = environment.HOME?.trim();
  const directories = home ? [join(home, ".kimi-code", "bin")] : [];
  const path = (environment.PATH ?? "").split(delimiter).filter((directory) => directory.trim() !== "");
  for (const directory of directories) {
    try { if (statSync(directory).isDirectory() && !path.includes(directory)) path.push(directory); }
    catch { /* Optional provider installations. */ }
  }
  return { ...environment, PATH: path.join(delimiter) };
}

export function providerExecutable(name: string, override: string | undefined,
  environment: NodeJS.ProcessEnv): string | undefined {
  const configured = override?.trim();
  if (configured) return configured; // Adapter readiness owns invalid optional overrides.
  const candidate = findExecutable(name, environment.PATH);
  try { return candidate !== undefined && statSync(candidate).isFile() ? candidate : undefined; }
  catch { return undefined; }
}
