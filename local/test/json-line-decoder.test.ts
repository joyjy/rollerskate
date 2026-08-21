import assert from "node:assert/strict";
import test from "node:test";

import { JsonLineResponseDecoder } from
  "../src/integrations/agent/json-line-decoder.js";

test("JSON line decoder preserves split UTF-8 and discards only oversized records", () => {
  const messages: unknown[] = [];
  let discarded = 0;
  const decoder = new JsonLineResponseDecoder({
    maxLineBytes: 32,
    onDiscardedLine() {
      discarded += 1;
    },
    onMessage(message) {
      messages.push(message);
      return true;
    },
    complete() {
      return messages;
    }
  });
  const output = Buffer.from([
    JSON.stringify({ value: "你" }),
    JSON.stringify({ trace: "x".repeat(64) }),
    JSON.stringify({ value: "done" })
  ].join("\n"), "utf8");
  const split = output.indexOf(Buffer.from("你", "utf8")) + 1;

  decoder.push(output.subarray(0, split));
  decoder.push(output.subarray(split));

  assert.deepEqual(decoder.finish(), [{ value: "你" }, { value: "done" }]);
  assert.equal(discarded, 1);
});
