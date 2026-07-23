export default {
  preset: "node-ts-build",
  build: "npm run build",
  suites: [{
    name: "protocol",
    cwd: "packages/protocol",
    files: ["dist/test/*.test.js"],
    coverage: { include: ["dist/src/**"] },
  }, {
    name: "local",
    cwd: "local",
    files: ["dist/test/*.test.js"],
    coverage: { include: ["dist/src/**"] },
  }, {
    name: "server",
    cwd: "server",
    files: ["dist/test/*.test.js"],
    coverage: { include: ["dist/src/**"] },
  }],
  diagnostics: {
    sourceRoots: [
      "packages/protocol/dist/src",
      "local/dist/src",
      "server/dist/src",
    ],
    entrypoints: {
      local_cli_processes: "local/dist/src/entrypoints/cli/main.js",
      server_processes: "server/dist/src/main.js",
    },
  },
  report: {
    schema: "rollerskate.test-diagnostics.v1",
    output: "tmp/node-test-report.json",
  },
};
