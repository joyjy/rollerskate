import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentRunDetailViewOutput,
  AgentRunSummaryViewOutput
} from "@/api/schema";
import { createConsoleRouter } from "@/router";
import StewardView from "@/views/StewardView.vue";

afterEach(() => vi.unstubAllGlobals());

describe("StewardView", () => {
  it("auto-selects the newest Run and syncs ?runId", async () => {
    const runA = summary({ runId: "run_a", updatedAt: "2026-07-25T00:00:00.000Z" });
    const runB = summary({
      runId: "run_b",
      updatedAt: "2026-07-25T00:00:01.000Z",
      mandate: { kind: "objective", label: "second run", workflowRef: null },
      source: {
        kind: "schedule",
        id: "sch_bound",
        definitionRevision: "ScheduleRevision@2:1"
      }
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Response.json(runPage(url, [runA, runB]));
      if (url === `/api/runs/${runB.runId}`) return Response.json(detail({ summary: runB }));
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward");
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("steward");
    expect(router.currentRoute.value.query.runId).toBe(runB.runId);
    expect(wrapper.text()).toContain("second run");
    expect(wrapper.text()).toContain("schedule · sch_bound");
    expect(wrapper.text()).toContain("@steward");
    expect(wrapper.text()).toContain("succeeded");
    wrapper.unmount();
  });

  it("does not fetch a placeholder detail or render a schema error when the list is empty", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Response.json(runPage(url, []));
      return Response.json({ error: "not_found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward");
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("No Steward Run has been created");
    const detailCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/runs/")
    );
    expect(detailCalls).toHaveLength(0);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps selection in sync with ?runId when a row is clicked", async () => {
    const runA = summary({ runId: "run_a" });
    const runB = summary({
      runId: "run_b",
      updatedAt: "2026-07-25T00:00:01.000Z",
      mandate: { kind: "objective", label: "run b", workflowRef: null }
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Response.json(runPage(url, [runA, runB]));
      const detailMatch = url.match(/^\/api\/runs\/([^/]+)$/);
      if (detailMatch !== null) {
        const runId = detailMatch[1]!;
        return Response.json(detail({
          summary: runId === runA.runId ? runA : runB
        }));
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward");
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    expect(router.currentRoute.value.query.runId).toBe(runB.runId);

    const runARow = wrapper.findAll(".operation-row").find((row) =>
      row.text().includes(runA.runId)
    );
    expect(runARow).toBeDefined();
    await runARow!.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.query.runId).toBe(runA.runId);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/runs/${runA.runId}`,
      expect.any(Object)
    );

    await router.push({ name: "steward", query: { runId: runB.runId } });
    await flushPromises();
    expect(wrapper.findAll(".operation-row")[0]!.classes()).toContain("active");
    wrapper.unmount();
  });

  it("paginates twenty Runs and supports Previous and Next navigation", async () => {
    const runs = Array.from({ length: 23 }, (_, index) => summary({
      runId: `run_${String(index).padStart(2, "0")}`,
      updatedAt: `2026-07-25T00:00:${String(index).padStart(2, "0")}.000Z`,
      mandate: { kind: "objective", label: `run label ${index}`, workflowRef: null }
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Response.json(runPage(url, runs));
      const runId = url.match(/^\/api\/runs\/([^/]+)$/)?.[1];
      const run = runs.find((candidate) => candidate.runId === runId);
      return run
        ? Response.json(detail({ summary: run }))
        : Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward");
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.findAll(".operation-row")).toHaveLength(20);
    expect(wrapper.find(".pagination-info").text()).toBe("Page 1/2");

    await wrapper.find('[aria-label="Next page"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".pagination-info").text()).toBe("Page 2/2");
    expect(wrapper.findAll(".operation-row")).toHaveLength(3);

    await wrapper.find('[aria-label="Previous page"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".pagination-info").text()).toBe("Page 1/2");
    wrapper.unmount();
  });

  it("searches Run fields and clears selection when there are no matches", async () => {
    const selectedRun = summary({
      runId: "run_selected",
      updatedAt: "2026-07-25T00:01:00.000Z",
      mandate: { kind: "objective", label: "selected detail", workflowRef: null }
    });
    const searchRun = summary({
      runId: "run_search_id",
      status: "failed",
      mandate: { kind: "objective", label: "special label", workflowRef: null },
      steward: agent("searchhandle")
    });
    const fillerRuns = Array.from({ length: 10 }, (_, index) => summary({
      runId: `run_filler_${index}`,
      updatedAt: `2026-07-25T00:00:${String(index).padStart(2, "0")}.000Z`
    }));
    const runs = [selectedRun, searchRun, ...fillerRuns];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Response.json(runPage(url, runs));
      const runId = url.match(/^\/api\/runs\/([^/]+)$/)?.[1];
      const run = runs.find((candidate) => candidate.runId === runId);
      return run
        ? Response.json(detail({ summary: run }))
        : Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward");
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    const search = wrapper.find<HTMLInputElement>('[aria-label="Search Steward"]');
    for (const query of ["SPECIAL LABEL", "RUN_SEARCH_ID", "SEARCHHANDLE", "FAILED"]) {
      await search.setValue(query);
      await flushPromises();
      expect(wrapper.find(".pagination-info").text()).toBe("Page 1/1");
      expect(wrapper.findAll(".operation-row")).toHaveLength(1);
      expect(wrapper.find(".operation-row").text()).toContain("run_search_id");
    }

    await search.setValue("definitely-no-match");
    await flushPromises();
    expect(wrapper.text()).toContain("No Steward Run has been created");
    expect(wrapper.find(".pagination-info").text()).toBe("0 results");
    expect(router.currentRoute.value.query.runId).toBeUndefined();
    expect(wrapper.text()).toContain("Select a Steward Run");
    expect(wrapper.find('[aria-label="Previous page"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[aria-label="Next page"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("loads a deep-linked Run independently from the current list query", async () => {
    const runs = Array.from({ length: 12 }, (_, index) => summary({
      runId: `run_deep_${index}`,
      updatedAt: `2026-07-25T00:00:${String(index).padStart(2, "0")}.000Z`
    }));
    const deepLinkedRun = runs[0]!;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Response.json(runPage(url, runs));
      if (url === `/api/runs/${deepLinkedRun.runId}`) {
        return Response.json(detail({ summary: deepLinkedRun }));
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push(`/console/steward?runId=${deepLinkedRun.runId}`);
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.find(".pagination-info").text()).toBe("Page 1/1");
    expect(wrapper.find(".operation-row.active").text()).toContain(deepLinkedRun.runId);
    wrapper.unmount();
  });

  it("preserves an exact Cycle and Output deep link while loading the Run", async () => {
    const run = summary({ runId: "run_linked", status: "awaiting_source" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Response.json(runPage(url, [run]));
      if (url === `/api/runs/${run.runId}`) return Response.json(detail({ summary: run }));
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward?runId=run_linked&cycleId=cyc_1&outputId=result");
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    expect(router.currentRoute.value.query).toMatchObject({
      runId: "run_linked",
      cycleId: "cyc_1",
      outputId: "result"
    });
    wrapper.unmount();
  });

  it("renders detail diagnostics and exposes Cancel for active Runs", async () => {
    const activeRun = summary({
      runId: "run_active",
      status: "active",
      mandate: { kind: "workflow", label: "review@1", workflowRef: "review@1" }
    });
    const activeDetail = detail({
      summary: activeRun,
      steps: [{
        stepId: "stp_1",
        cycleId: null,
        parentStepId: null,
        depth: 0,
        agent: agent("steward"),
        requestEventId: "evt_req",
        resultEventId: "evt_res",
        status: "succeeded",
        prompt: "original prompt",
        effectivePrompt: "effective prompt text",
        result: {
          schemaVersion: "AgentTurnResult@1",
          action: "complete",
          outcome: "succeeded",
          summary: "done",
          artifactRefs: []
        },
        rawOutput: null,
        error: null,
        invocation: {
          schemaVersion: "AgentInvocationDiagnostics@1",
          effectivePrompt: "effective prompt text",
          startedAt: "2026-07-25T00:00:00.000Z",
          completedAt: "2026-07-25T00:00:01.000Z",
          durationMilliseconds: 1000,
          tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          toolUsage: [{ name: "Read", count: 2 }],
          turnCount: 1
        },
        observedWorkspaceRevision: null,
        createdAt: "2026-07-25T00:00:00.000Z",
        completedAt: "2026-07-25T00:00:01.000Z"
      }]
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Response.json(runPage(url, [activeRun]));
      if (url === `/api/runs/${activeRun.runId}`) return Response.json(activeDetail);
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push(`/console/steward?runId=${activeRun.runId}`);
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("effective prompt text");
    expect(wrapper.text()).toContain("2 tool calls");
    expect(wrapper.text()).toContain("AgentTurnResult@1");
    expect(wrapper.find(".cancel-button").exists()).toBe(true);
    wrapper.unmount();
  });

  it("posts to the cancel endpoint when Cancel is clicked", async () => {
    const activeRun = summary({
      runId: "run_active",
      status: "active"
    });
    const activeDetail = detail({ summary: activeRun });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Response.json(runPage(url, [activeRun]));
      if (url === `/api/runs/${activeRun.runId}`) return Response.json(activeDetail);
      if (url === `/api/runs/${activeRun.runId}/cancel` && init?.method === "POST") {
        return Response.json({
          status: "cancelled",
          cancelledExecutions: 1,
          run: { runId: activeRun.runId, status: "cancelled" }
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push(`/console/steward?runId=${activeRun.runId}`);
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.find(".cancel-button").trigger("click");
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/runs/${activeRun.runId}/cancel`,
      expect.objectContaining({ method: "POST" })
    );
    wrapper.unmount();
  });

  it("archives terminal Runs and switches to the archived view", async () => {
    const terminalRun = summary({ runId: "run_terminal" });
    const archivedRun = summary({
      runId: terminalRun.runId,
      archivedAt: "2026-07-25T01:00:00.000Z"
    });
    let archived = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) {
        return Response.json(runPage(url, [archived ? archivedRun : terminalRun]));
      }
      if (url === `/api/runs/${terminalRun.runId}`) {
        return Response.json(detail({ summary: archived ? archivedRun : terminalRun }));
      }
      if (url === `/api/runs/${terminalRun.runId}/archive` && init?.method === "POST") {
        archived = true;
        return Response.json({
          status: "archived",
          run: { ...terminalRun, archivedAt: archivedRun.archivedAt }
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createConsoleRouter(createMemoryHistory());
    await router.push(`/console/steward?runId=${terminalRun.runId}`);
    const wrapper = mount(StewardView, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.find(".archive-button").trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/runs/${terminalRun.runId}/archive`,
      expect.objectContaining({ method: "POST" })
    );
    expect(wrapper.text()).toContain("No Steward Run has been created");

    await wrapper.find(".archive-filter").trigger("click");
    await flushPromises();
    expect(wrapper.find(".operation-row").text()).toContain(terminalRun.runId);
    expect(wrapper.find(".archive-button").text()).toBe("Restore");
    wrapper.unmount();
  });

});

function agent(handle: string) {
  return {
    principalId: `agent-${handle}`,
    handle,
    client: "codex" as const,
    status: "active" as const
  };
}

function summary(
  overrides: Partial<AgentRunSummaryViewOutput> & { runId: string }
): AgentRunSummaryViewOutput {
  const { runId, ...rest } = overrides;
  return {
    runId,
    rootEventId: `evt_${runId}`,
    series: null,
    orchestrationMode: "autonomous",
    status: "succeeded",
    mandate: { kind: "objective", label: "do thing", workflowRef: null },
    steward: agent("steward"),
    workspace: null,
    progress: { steps: 1, maxSteps: 8, maxDepth: 3 },
    terminalSummary: null,
    archivedAt: null,
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...rest
  };
}

function detail(
  overrides: Partial<AgentRunDetailViewOutput> & { summary: AgentRunSummaryViewOutput }
): AgentRunDetailViewOutput {
  const { summary, ...rest } = overrides;
  return {
    summary,
    projection: {
      runId: summary.runId,
      status: summary.status,
      orchestrationMode: summary.orchestrationMode,
      activeStepId: undefined,
      stepCount: 1,
      maxSteps: 8,
      maxDepth: 3
    },
    cycles: [],
    checkpoint: null,
    decisions: [],
    participants: [summary.steward],
    sessions: [],
    exchanges: [],
    exchangeCounts: [],
    steps: [],
    outputFolders: [],
    timeline: [],
    currentWorkspaceRevision: null,
    workspaceRevisionError: null,
    ...rest
  };
}

function runPage(url: string, candidates: AgentRunSummaryViewOutput[]) {
  const parameters = new URL(url, "http://localhost").searchParams;
  const archived = parameters.get("archive") === "archived";
  const search = (parameters.get("q") ?? "").toLowerCase();
  const page = Number(parameters.get("page") ?? 1);
  const pageSize = Number(parameters.get("pageSize") ?? 20);
  const filtered = candidates
    .filter((run) => (run.archivedAt !== null) === archived)
    .filter((run) => search === "" || [
      run.mandate.label,
      run.runId,
      run.steward.handle,
      run.status
    ].some((value) => value.toLowerCase().includes(search)))
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId));
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    pageSize
  };
}
