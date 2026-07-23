import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface WorkspaceInspectionRequest {
  readonly eventId: string;
  readonly traceId: string;
  readonly subject: string;
  readonly workspaceRoot: string;
}

export interface WorkspaceInspection {
  readonly eventId: string;
  readonly traceId: string;
  readonly projectRoot: string;
  readonly entryCount: number;
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly type: "file" | "directory" | "symlink" | "other";
  }>;
  readonly truncated: boolean;
  readonly package: unknown;
}

export function canonicalWorkspaceRoot(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error("workspaceRoot must be an absolute path");
  }
  const root = realpathSync(path);
  if (!statSync(root).isDirectory()) {
    throw new Error("workspaceRoot must be a directory");
  }
  return root;
}

export function inspectWorkspace(
  request: WorkspaceInspectionRequest
): WorkspaceInspection {
  const workspaceRoot = canonicalWorkspaceRoot(request.workspaceRoot);
  const subjectRoot = isAbsolute(request.subject)
    ? realpathSync(request.subject)
    : request.subject;
  if (subjectRoot !== workspaceRoot) {
    throw new Error("command subject does not match workspaceRoot");
  }

  const entries = readdirSync(workspaceRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const visible = entries.slice(0, 100).map((entry) => ({
    name: entry.name,
    type: entry.isFile()
      ? "file" as const
      : entry.isDirectory()
        ? "directory" as const
        : entry.isSymbolicLink()
          ? "symlink" as const
          : "other" as const
  }));

  return {
    eventId: request.eventId,
    traceId: request.traceId,
    projectRoot: workspaceRoot,
    entryCount: entries.length,
    entries: visible,
    truncated: entries.length > visible.length,
    package: readPackageSummary(workspaceRoot)
  };
}

function readPackageSummary(workspaceRoot: string): unknown {
  const packagePath = join(workspaceRoot, "package.json");
  try {
    const stat = lstatSync(packagePath);
    if (!stat.isFile() || stat.size > 65_536) {
      return null;
    }
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
      name?: unknown;
      version?: unknown;
      scripts?: unknown;
    };
    return {
      name: typeof manifest.name === "string" ? manifest.name : null,
      version: typeof manifest.version === "string" ? manifest.version : null,
      scripts: manifest.scripts !== null && typeof manifest.scripts === "object"
        ? Object.keys(manifest.scripts).sort()
        : []
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
