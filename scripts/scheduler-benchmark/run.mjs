import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, cpSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let refs = ['HEAD'];
let rounds = 3;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--refs') refs = args[++i]?.split(',') ?? [];
  else if (args[i] === '--rounds') rounds = Number(args[++i]);
  else throw new Error(`Unknown option: ${args[i]}`);
}
if (!refs.length || refs.length > 6 || !Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
  throw new Error('Use --refs <ref,ref,...> --rounds <1..10>');
}
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'package-lock.json', 'packages/protocol', 'local/package.json'], { cwd: repo }).status !== 0) {
  throw new Error('Shared dependency/protocol sources must match HEAD before benchmarking');
}
const revisions = refs.map(ref => ({ ref, commit: git('rev-parse', '--verify', `${ref === "working-tree" ? "HEAD" : ref}^{commit}`) }));
// Dependencies are shared locally; reject a comparison that would require another install.
for (const { commit } of revisions) {
  for (const path of ['package-lock.json', 'packages/protocol', 'local/package.json']) {
    if (git('rev-parse', `${commit}:${path}`) !== git('rev-parse', `HEAD:${path}`)) {
      throw new Error(`Dependency/protocol mismatch at ${commit}:${path}; use matching installed dependencies`);
    }
  }
}
function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
}
console.error('Fresh build of shared, identical protocol dependency');
run('npm', ['run', 'build', '-w', '@rollerskate/protocol'], repo);
const scratch = mkdtempSync(join(tmpdir(), 'rs-scheduler-benchmark-'));
const results = [];
try {
  const builds = revisions.map(({ ref, commit }, i) => {
    const root = join(scratch, `revision-${i}`);
    mkdirSync(root);
    const archive = execFileSync('git', ['archive', commit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    run('tar', ['-x', '-C', root], repo, { input: archive });
    if (ref === 'working-tree') cpSync(join(repo, 'local/src'), join(root, 'local/src'), { recursive: true });
    const hash = createHash('sha256');
    for (const file of readdirSync(join(root, 'local/src'), { recursive: true, withFileTypes: true })
      .filter(file => file.isFile()).map(file => join(file.parentPath, file.name)).sort()) {
      hash.update(file.slice(root.length)); hash.update(readFileSync(file));
    }
    const sourceDigest = hash.digest('hex');
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
    console.error(`Fresh build ${ref} (${commit.slice(0, 7)})`);
    run(join(repo, 'node_modules/.bin/tsc'), ['-p', join(root, 'local/tsconfig.json')], root);
    run(process.execPath, [join(root, 'local/scripts/copy-resources.mjs')], root);
    return { ref, commit, root, sourceDigest };
  });
  // Rotate revision order per round to reduce fixed-order thermal/cache bias.
  for (let round = 0; round < rounds; round++) {
    for (let offset = 0; offset < builds.length; offset++) {
      const build = builds[(round + offset) % builds.length];
      const data = run(process.execPath, ['--disable-warning=ExperimentalWarning',
        join(repo, 'scripts/scheduler-benchmark/workload.mjs'), build.root], repo, { stdio: ['ignore', 'pipe', 'inherit'] });
      results.push({ ref: build.ref, commit: build.commit, sourceDigest: build.sourceDigest, round: round + 1, ...JSON.parse(data) });
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summaries = revisions.map(revision => {
    const samples = results.filter(result => result.commit === revision.commit && result.ref === revision.ref);
    return { ...revision, sourceDigest: samples[0].sourceDigest, hasAdmission: samples[0].hasAdmission, hasWake: samples[0].hasWake, scenarios: samples[0].scenarios.map(({ name }) => {
      const rows = samples.map(sample => sample.scenarios.find(row => row.name === name));
      return { name, medianReadyP95Ms: median(rows.map(row => row.readyToStartMs.p95)),
        medianResultP95Ms: median(rows.map(row => row.resultReadyToStartMs.p95)),
        medianThroughput: median(rows.map(row => row.agentThroughputPerSecond)),
        medianClaimScansPerSecond: median(rows.map(row => row.claimScans / (row.elapsedMs / 1000))),
        medianCpuMs: median(rows.map(row => row.cpuMs)) };
    }) };
  });
  const baseline = summaries.find(summary => !summary.hasWake);
  const checks = [];
  if (baseline) for (const candidate of summaries.filter(summary => summary.hasWake)) {
    const row = (summary, name) => summary.scenarios.find(row => row.name === name);
    for (const name of ['enqueue', 'due']) {
      const limit = row(baseline, name).medianReadyP95Ms * .5;
      const actual = row(candidate, name).medianReadyP95Ms;
      checks.push({ ref: candidate.ref, metric: `${name} ready p95 <= 50% baseline`, actual, limit, pass: actual <= limit });
    }
    const minimum = row(baseline, 'burst').medianThroughput * 2;
    const actual = row(candidate, 'burst').medianThroughput;
    checks.push({ ref: candidate.ref, metric: 'burst throughput >= 2x baseline', actual, minimum, pass: actual >= minimum });
    const idleScans = row(candidate, 'idle').medianClaimScansPerSecond;
    checks.push({ ref: candidate.ref, metric: 'idle claim scans <= 6/s', actual: idleScans, limit: 6, pass: idleScans <= 6 });
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 'SchedulerBenchmark@1', measuredAt: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    rounds, summaries, checks, results }, null, 2) + '\n');
  if (checks.some(check => !check.pass)) process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
