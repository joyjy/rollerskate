import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ARTIFACT_ROOTS = [
  "local/dist/src",
  "local/dist/resources",
  "packages/protocol/dist/src"
] as const;

export function runtimeArtifactRevision(repoRoot: string): string {
  const hash = createHash("sha256");
  hash.update("RuntimeArtifactRevision@1\0");
  for (const artifactRoot of ARTIFACT_ROOTS) {
    const root = join(repoRoot, artifactRoot);
    if (!existsSync(root)) {
      hash.update(`missing:${artifactRoot}\0`);
      continue;
    }
    for (const path of runtimeArtifactFiles(root, artifactRoot === "local/dist/resources")) {
      hash.update(relative(repoRoot, path));
      hash.update("\0");
      hash.update(readFileSync(path));
      hash.update("\0");
    }
  }
  return `rt1_${hash.digest("hex")}`;
}

function runtimeArtifactFiles(root: string, includeAllFiles: boolean): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (includeAllFiles || entry.name.endsWith(".js"))) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}
