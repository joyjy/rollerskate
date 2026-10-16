import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatWorkspacePicker from "./ChatWorkspacePicker.vue";
const candidate={ref:"file:///sample",root:"/sample",branch:"working",defaultBranch:"trunk",defaultRef:"refs/heads/trunk",baseSha:"a".repeat(40),defaultSource:"config",forkBlocker:null,token:"b".repeat(64)};
const props={path:"/sample",sourceRevision:"revision",eventId:"owner",dispatchId:"dispatch",disabled:false};
function response(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});}
afterEach(()=>{vi.unstubAllGlobals();sessionStorage.clear();});
describe("workspace selection and Fork",()=>{
  it("automatically discovers the proposal project without authorizing Use or Fork",async()=>{
    const fetch=vi.fn(async(_url:string,_init:RequestInit)=>response({schema:"WorkspaceCandidates@1",items:[{...candidate,defaultBranch:null,baseSha:null,forkBlocker:"Multiple remote HEADs"}],truncated:false}));
    vi.stubGlobal("fetch",fetch);
    const wrapper=mount(ChatWorkspacePicker,{props:{...props,path:"",initialQuery:"service-a"},slots:{default:'<button>Use workspace</button>'}});
    await flushPromises();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({query:"service-a"});
    expect(wrapper.emitted("select")).toEqual([["/sample"]]);
    expect(wrapper.emitted("forked")).toBeUndefined();
    await wrapper.setProps({path:"/sample"});
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    expect(wrapper.findAll("button").find(b=>b.text()==="Use workspace")!.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });
  it("shows exact default before Fork, retries the same intent after timeout, and emits the created path without starting a Run",async()=>{
    const calls:Array<{url:string;body:Record<string,unknown>}>=[];
    vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));calls.push({url,body});
      expect(new Headers(init.headers).get("X-Rollerskate-Request")).toBe("console");
      if(url.endsWith("/find")) return response({schema:"WorkspaceCandidates@1",items:[candidate],truncated:false});
      if(calls.filter(call=>call.url.endsWith("/fork")).length===1) throw new Error("timeout");
      return response({schema:"WorkspaceFork@1",requestId:body.requestId,authority:"proposal:owner:dispatch",sourceRoot:"/sample",defaultBranch:"trunk",baseSha:candidate.baseSha,root:"/sample-wt-feature",branch:"rs/feature"});
    }));
    const wrapper=mount(ChatWorkspacePicker,{props});
    await flushPromises();
    expect(wrapper.text()).toContain(candidate.baseSha);
    await wrapper.get('[aria-label="Fork purpose"]').setValue("feature");
    await wrapper.findAll("button").find(b=>b.text()==="Fork Workspace")!.trigger("click");await flushPromises();
    expect(wrapper.text()).toContain("timeout");
    await wrapper.findAll("button").find(b=>b.text()==="Recover Fork result")!.trigger("click");await flushPromises();
    expect(calls[1]!.body).toEqual(calls[2]!.body);
    expect(wrapper.emitted("forked")?.[0]).toEqual(["/sample-wt-feature"]);
    expect(calls.some(call=>call.url.endsWith("/confirm"))).toBe(false);
    expect(wrapper.text()).toContain("Workspace created");wrapper.unmount();
  });
  it("does not permit Fork for a manually changed path until inspected and preserves multiple choices",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>response({schema:"WorkspaceCandidates@1",items:[candidate,{...candidate,root:"/other"}],truncated:false})));
    const wrapper=mount(ChatWorkspacePicker,{props});
    await flushPromises();
    await wrapper.get('[aria-label="Workspace project name"]').setValue("sample");
    await wrapper.findAll("button").find(b=>b.text()==="Find workspaces")!.trigger("click");await flushPromises();
    expect(wrapper.emitted("select")).toEqual([[""]]);
    expect(wrapper.findAll("option")).toHaveLength(3);
    await wrapper.setProps({path:"/edited"});
    expect(wrapper.findAll("button").some(b=>b.text()==="Fork Workspace")).toBe(false);wrapper.unmount();
  });
});
