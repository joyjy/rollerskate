import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ChatComposer from "@/components/ChatComposer.vue";

describe("ChatComposer", () => {
  it("starts compact and caps automatic growth", async () => {
    const wrapper = mount(ChatComposer, {
      props: {modelValue: "", agents: [], activeAgents: [], pending: null}
    });
    const textarea = wrapper.get("textarea").element as HTMLTextAreaElement;
    let contentHeight = 220;
    Object.defineProperty(textarea, "scrollHeight", {configurable: true, get: () => contentHeight});

    expect(textarea.rows).toBe(1);
    await wrapper.get("textarea").setValue("A longer draft");
    expect(textarea.style.height).toBe("160px");
    expect(textarea.style.overflowY).toBe("auto");

    contentHeight = 42;
    await wrapper.get("textarea").setValue("Short");
    expect(textarea.style.height).toBe("42px");
    expect(textarea.style.overflowY).toBe("hidden");
  });
});
