import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { providerEnvironment, providerExecutable } from "../src/entrypoints/cli/provider-paths.js";

test("provider discovery preserves explicit/PATH priority and finds standard user installers", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rs-provider-paths-")));
  try {
    const directories = [join(home, "existing"), join(home, ".kimi-code", "bin")];
    for (const directory of directories) mkdirSync(directory, { recursive: true });
    const executable = (directory: string, name: string): string => {
      const path = join(directory, name); writeFileSync(path, "#!/bin/sh\nexit 0\n"); chmodSync(path, 0o700); return path;
    };
    const preferred = executable(directories[0]!, "kimi");
    const fallback = executable(directories[1]!, "kimi");
    const environment = providerEnvironment({ HOME: home, PATH: directories[0] });
    assert.equal(providerExecutable("kimi", undefined, environment), preferred);
    assert.equal(providerExecutable("kimi", fallback, environment), fallback);
    assert.deepEqual(environment.PATH?.split(delimiter), directories);
    assert.deepEqual(providerEnvironment({HOME: home, PATH: ""}).PATH?.split(delimiter), directories.slice(1));
    assert.equal(providerExecutable("kimi", join(home, "missing"), environment), join(home, "missing"));
    assert.equal(providerExecutable("uninstalled-provider", undefined, environment), undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
