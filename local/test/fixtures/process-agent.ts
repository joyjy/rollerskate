let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const request = JSON.parse(input) as {
    kind?: unknown;
    delay?: unknown;
    outputBytes?: unknown;
  };
  if (typeof request.delay === "number") {
    setTimeout(
      () => process.stdout.write(JSON.stringify({ delayed: true })),
      request.delay
    );
    return;
  }
  if (typeof request.outputBytes === "number") {
    process.stdout.write("x".repeat(request.outputBytes));
    return;
  }
  process.stdout.write(JSON.stringify({
    summary: `kind=${String(request.kind)}`,
    inheritedSecret: process.env.ROLLERSKATE_TEST_SECRET ?? null
  }));
});
