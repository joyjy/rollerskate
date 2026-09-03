import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export const GIT_WORKSPACE_ENV = "ROLLERSKATE_GIT_WORKSPACE";
export const MAX_GIT_PATHS = 64;
export const MAX_GIT_PATH_BYTES = 4_096;
export const MAX_GIT_TOTAL_PATH_BYTES = 32_768;
export const MAX_GIT_OUTPUT_BYTES = 262_144;
export const GIT_TIMEOUT_MILLISECONDS = 15_000;

const GIT_BINARY = "git";

export function resolveWorkspace(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Rollerskate Git workspace is missing");
  }
  if (!isAbsolute(raw)) {
    throw new Error("Rollerskate Git workspace must be absolute");
  }
  const canonical = realpathSync(raw);
  if (!statSync(canonical).isDirectory()) {
    throw new Error("Rollerskate Git workspace must be a directory");
  }
  return canonical;
}

export function validateGitPaths(paths, workspace) {
  if (paths === undefined || paths === null) return { ok: true, paths: [] };
  if (!Array.isArray(paths)) {
    return { ok: false, error: "paths must be an array of workspace-relative paths" };
  }
  if (paths.length > MAX_GIT_PATHS) {
    return { ok: false, error: `paths must contain at most ${MAX_GIT_PATHS} entries` };
  }
  const result = [];
  let totalBytes = 0;
  for (const raw of paths) {
    if (typeof raw !== "string") return { ok: false, error: "each path must be a string" };
    if (raw.length === 0) return { ok: false, error: "paths must not be empty" };
    if (raw.includes("\0")) return { ok: false, error: "paths must not contain NUL" };
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > MAX_GIT_PATH_BYTES) {
      return { ok: false, error: `each path must be at most ${MAX_GIT_PATH_BYTES} bytes` };
    }
    totalBytes += bytes;
    if (totalBytes > MAX_GIT_TOTAL_PATH_BYTES) {
      return { ok: false, error: `paths must total at most ${MAX_GIT_TOTAL_PATH_BYTES} bytes` };
    }
    if (isAbsolute(raw)) return { ok: false, error: "paths must be workspace-relative" };
    if (raw.startsWith("-")) return { ok: false, error: "paths must not look like options" };
    if (raw.split(/[\\/]/).includes("..")) {
      return { ok: false, error: "paths must not traverse upward" };
    }
    if (!isWithinWorkspace(workspace, resolve(workspace, raw))) {
      return { ok: false, error: "paths must not escape the workspace" };
    }
    result.push(raw);
  }
  return { ok: true, paths: result };
}

export function gitEnvironment() {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
  );
  return {
    ...inherited,
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ASKPASS: "",
    SSH_ASKPASS: ""
  };
}

export function gitBaseArgs() {
  return [
    "--no-pager",
    "-c", "core.pager=cat",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false"
  ];
}

export function gitStatusArgs(paths = []) {
  return [...gitBaseArgs(), "status", "--porcelain=v1", "--", ...paths];
}

export function gitDiffArgs(paths = []) {
  return [...gitBaseArgs(), "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...paths];
}

export async function readGitDiff(params, workspace, options = {}) {
  const canonical = resolveWorkspace(workspace);
  const validated = validateGitPaths(params?.paths, canonical);
  if (!validated.ok) throw new Error(validated.error);
  const maxOutputBytes = finiteMaxOutputBytes(options.maxOutputBytes);
  const maxStreamOutputBytes = Math.max(1, Math.floor(maxOutputBytes / 4));
  const timeoutMilliseconds = finiteTimeout(options.timeoutMilliseconds);
  const env = gitEnvironment();
  const [status, diff] = await Promise.all([
    runGit(gitStatusArgs(validated.paths), {
      cwd: canonical,
      env,
      maxOutputBytes: maxStreamOutputBytes,
      timeoutMilliseconds
    }),
    runGit(gitDiffArgs(validated.paths), {
      cwd: canonical,
      env,
      maxOutputBytes: maxStreamOutputBytes,
      timeoutMilliseconds
    })
  ]);
  return {
    tool: "read_git_diff",
    workspace: canonical,
    paths: validated.paths,
    status: commandResult(status),
    diff: commandResult(diff)
  };
}

export default function registerRollerskateReadonlyGit(pi) {
  const workspace = resolveWorkspace(process.env[GIT_WORKSPACE_ENV]);
  pi.registerTool({
    name: "read_git_diff",
    label: "Read Git diff and status",
    description: "Return bounded Git working-tree diff and status evidence against HEAD for the Runtime workspace. Optionally restrict to workspace-relative paths. Read-only: never mutates the repository.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional workspace-relative paths to restrict the diff and status. Each path must stay inside the workspace."
        }
      }
    },
    async execute(_toolCallId, params) {
      const result = await readGitDiff(params ?? {}, workspace);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  });
}

function commandResult(execution) {
  return {
    output: execution.stdout.output,
    bytes: execution.stdout.bytes,
    truncated: execution.stdout.truncated,
    stderrBytes: execution.stderr.bytes,
    stderrTruncated: execution.stderr.truncated,
    timedOut: execution.timedOut,
    exitCode: execution.code,
    ...(execution.signal === null ? {} : { signal: execution.signal }),
    ...(execution.stderr.output === "" ? {} : { stderr: execution.stderr.output })
  };
}

function isWithinWorkspace(workspace, target) {
  const rel = relative(workspace, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function finiteMaxOutputBytes(value) {
  if (value === undefined) return MAX_GIT_OUTPUT_BYTES;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("maxOutputBytes must be a positive integer");
  }
  return value;
}

function finiteTimeout(value) {
  if (value === undefined) return GIT_TIMEOUT_MILLISECONDS;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("timeoutMilliseconds must be a positive integer");
  }
  return value;
}

function collectBounded(stream, maxBytes) {
  const chunks = [];
  let stored = 0;
  let total = 0;
  let truncated = false;
  stream.on("data", (chunk) => {
    total += chunk.length;
    if (stored >= maxBytes) {
      truncated = true;
      return;
    }
    const remaining = maxBytes - stored;
    if (chunk.length <= remaining) {
      chunks.push(chunk);
      stored += chunk.length;
    } else {
      chunks.push(chunk.subarray(0, remaining));
      stored += remaining;
      truncated = true;
    }
  });
  return new Promise((resolvePromise, rejectPromise) => {
    stream.once("end", () => resolvePromise({
      output: Buffer.concat(chunks).toString("utf8"),
      bytes: total,
      truncated
    }));
    stream.once("error", rejectPromise);
  });
}

function runGit(args, { cwd, env, maxOutputBytes, timeoutMilliseconds }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(GIT_BINARY, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = collectBounded(child.stdout, maxOutputBytes);
    const stderr = collectBounded(child.stderr, maxOutputBytes);
    let timedOut = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMilliseconds);
    child.once("error", (error) => {
      clearTimeout(timer);
      finish(rejectPromise, error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      Promise.all([stdout, stderr]).then(
        ([out, err]) => finish(resolvePromise, {
          code,
          signal,
          timedOut,
          stdout: out,
          stderr: err
        }),
        (error) => finish(rejectPromise, error)
      );
    });
  });
}
