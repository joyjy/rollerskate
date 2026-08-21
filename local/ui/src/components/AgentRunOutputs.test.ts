import { mount } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { describe, expect, it } from "vitest";

import AgentRunOutputs from "@/components/AgentRunOutputs.vue";
import { createConsoleRouter } from "@/router";

describe("AgentRunOutputs", () => {
  it("renders a readable structured preview and stable deep links", async () => {
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward?runId=run_1&cycleId=cyc_1&outputId=result");
    const wrapper = mount(AgentRunOutputs, {
      global: { plugins: [router] },
      props: {
        runId: "run_1",
        cycleId: "cyc_1",
        outputId: "stp_1:output:result",
        folders: [{
          cycleId: "cyc_1",
          sourceRevision: "abc123",
          outputs: [{
            outputId: "stp_1:primary",
            stepId: "stp_1",
            title: "Terminal result",
            kind: "primary",
            contentType: "text/plain",
            schemaVersion: null,
            value: "ready"
          }, {
            outputId: "stp_1:output:result",
            stepId: "stp_1",
            title: "MR readiness",
            kind: "output",
            contentType: "application/json",
            schemaVersion: "MrReadinessResult@1",
            value: {
              sourceRevision: "abc123",
              changeSummary: "Moves the baseline to V2.",
              completeness: "complete"
            }
          }]
        }]
      }
    });

    expect(wrapper.text()).toContain("changeSummary");
    expect(wrapper.text()).toContain("Moves the baseline to V2.");
    expect(wrapper.text()).toContain("completeness");
    expect(wrapper.text()).toContain("complete");
    expect(wrapper.get(".output-link.active").attributes("href")).toContain("runId=run_1");
    expect(wrapper.get(".output-link.active").attributes("href")).toContain("cycleId=cyc_1");
    expect(wrapper.get(".output-link.active").attributes("href")).toContain("outputId=stp_1:output:result");
    expect(wrapper.get(".raw-preview").text()).toContain("Raw output");
  });
});
