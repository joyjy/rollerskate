import assert from "node:assert/strict";
import test from "node:test";

import { parseInteractivePowerState } from "../src/integrations/power/readiness.js";

test("interactive power state follows IOPM System Capabilities", () => {
  assert.equal(parseInteractivePowerState('  "System Capabilities" = 15'), "awake");
  assert.equal(parseInteractivePowerState('  "System Capabilities" = 0x3'), "awake");
  assert.equal(parseInteractivePowerState('  "System Capabilities" = 1'), "sleeping");
  assert.equal(parseInteractivePowerState('  "System Capabilities" = 8'), "sleeping");
  assert.equal(parseInteractivePowerState('  "System Capabilities" = 0'), "sleeping");
});

test("interactive power state is unknown without one valid numeric capability", () => {
  assert.equal(parseInteractivePowerState(""), "unknown");
  assert.equal(parseInteractivePowerState('"System Capabilities" = 1\n"System Capabilities" = 3'), "unknown");
  assert.equal(parseInteractivePowerState('"System Capabilities" = 1.5'), "unknown");
  assert.equal(parseInteractivePowerState('"System Capabilities" = 0x100000000'), "unknown");
});
