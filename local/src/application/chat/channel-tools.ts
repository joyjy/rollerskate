import { createHash } from "node:crypto";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { ChannelStore } from "../../infrastructure/sqlite/channel-store.js";
import { TopicInboxStore } from "../../infrastructure/files/topic-inbox-store.js";
import { chatActionDispatch, ownerActionScope } from "./action-scope.js";
import { reserveInteractiveChannelMessage, stopInteractiveChannelFollowInTransaction } from "../channel/control.js";
import { listInteractiveChannels, readInteractiveChannelFollow } from "../channel/query.js";
import { channelSendDeliveryOutcome, channelRefAllowed, interactiveChannelBindingAvailableAt, parseChannelRef } from "../../modules/channel/model.js";
import type { ChatToolContext } from "./tool-policy.js";

const read = {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const object = (properties:Record<string,unknown>,required:string[] = []) => ({type:"object",additionalProperties:false,properties,required});
const id = (prefix:string) => ({type:"string",pattern:`^${prefix}_[A-Za-z0-9_-]+$`});
export const chatChannelToolDefinitions = [
  {name:"list_channels",description:"Discover existing Channel grants and recent follows for this Agent. This does not create or expand grants; no available binding means ask the Owner to configure one.",inputSchema:object({page:{type:"integer",minimum:1,maximum:100000}}),annotations:read},
  {name:"get_channel_follow",description:"Read bounded send/follow state and channel messages. Check deliveryOutcome: unknown means a remote effect may already have occurred; do not send again under a new key. Accepted is not a reply, and quiet is not task success. A snapshot never retries delivery or runs the scheduler.",inputSchema:object({followToken:id("fol"),afterCursor:{type:"string",maxLength:2048}},["followToken"]),annotations:read},
  {name:"send_channel_message",description:"Send as this Agent only when the Local Owner explicitly requests this message and recipient. Use an existing binding and exact allowed channelRef from list_channels. Do not send on discussion, quotations, negation or result notifications. Admission is asynchronous; use get_channel_follow for delivery and replies. One send per Owner message, dispatch and channel; duplicates reuse the receipt. This does not grant new Channel membership or callback authority.",inputSchema:object({bindingId:id("chn"),expectedRevision:{type:"integer",minimum:1},channelRef:object({kind:{type:"string",enum:["local-chat","server-topic"]},channelId:{type:"string",maxLength:512}},["kind","channelId"]),body:{type:"string",minLength:1,maxLength:8192}},["bindingId","expectedRevision","channelRef","body"]),annotations:{...read,readOnlyHint:false,openWorldHint:true}},
  {name:"stop_channel_follow",description:"Stop this Agent's exact follow when explicitly requested by the Local Owner. Does not cancel or retract an admitted message. Use the current follow revision; stale calls conflict.",inputSchema:object({followToken:id("fol"),expectedRevision:{type:"integer",minimum:1}},["followToken","expectedRevision"]),annotations:{...read,readOnlyHint:false,destructiveHint:true}}
];

export function callChatChannelTool(context: ChatToolContext,name:string,args:unknown): unknown {
  if (!args || typeof args!=="object" || Array.isArray(args)) throw new Error("Channel tool arguments are malformed");
  const input=args as Record<string,unknown>;
  const allowed=name==="list_channels" ? ["page"] : name==="get_channel_follow" ? ["followToken","afterCursor"] : name==="stop_channel_follow" ? ["followToken","expectedRevision"] : ["bindingId","expectedRevision","channelRef","body"];
  if (Object.keys(input).some(key=>!allowed.includes(key))) throw new Error("Channel tool arguments are malformed");
  const sending=name==="send_channel_message", stopping=name==="stop_channel_follow";
  const identifier=(key:string,prefix:string)=>{
    if(typeof input[key]!=="string" || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(input[key] as string)) throw new Error("Channel tool identifier is malformed");
    return input[key] as string;
  };
  if (name==="list_channels" && input.page!==undefined && (!Number.isInteger(input.page) || Number(input.page)<1 || Number(input.page)>100000)) throw new Error("Invalid Channel page");
  if ((sending || stopping) && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision)<1)) throw new Error("Channel revision is required");
  if (input.afterCursor!==undefined && (typeof input.afterCursor!=="string" || input.afterCursor.length>2048)) throw new Error("Invalid Channel cursor");
  if(sending && (typeof input.body!=="string" || !input.body.trim() || input.body.length>8192)) throw new Error("Invalid Channel message body");
  const paths=runtimePaths(context.repoRoot,context.runtimeDirectory);
  const database=openRuntimeDatabase(paths.database);
  const runtime=new RuntimeStore(database,{migrate:false});
  const foundation=new LocalFoundationStore(database,{migrate:false});
  const store=new ChannelStore(database,{migrate:false});
  try { return runtime.withImmediateTransaction(()=>{
    const dispatch=chatActionDispatch(context,database,runtime);
    if(name==="list_channels") return listInteractiveChannels(database,dispatch.agentId,(input.page as number|undefined)??1);
    const scope=sending || stopping ? ownerActionScope(context,database,runtime,foundation) : undefined;
    if(scope!==undefined && "status" in scope) return scope;
    const follow=sending ? undefined : store.requireFollow(identifier("followToken","fol"));
    const binding=store.requireBinding(sending ? identifier("bindingId","chn") : follow!.bindingId);
    if(binding.agentId!==dispatch.agentId) throw new Error("Channel binding belongs to another Agent");
    if(binding.callbackSessionId!==undefined && binding.callbackSessionId!==dispatch.sessionId) throw new Error("Channel binding belongs to another Session");
    if(stopping) return stopInteractiveChannelFollowInTransaction(store,follow!.followToken,input.expectedRevision as number,new Date().toISOString());
    if(!interactiveChannelBindingAvailableAt(binding,new Date().toISOString())) {
      if(sending) throw new Error("Channel binding is expired or revoked");
      const receipt=store.requireSend(follow!.sendId);
      return {sendId:receipt.sendId,sendStatus:receipt.status,deliveryOutcome:channelSendDeliveryOutcome(receipt),follow:follow!,delta:[],contentUnavailable:"Channel binding is expired or revoked"};
    }
    if(!sending) {
      const result=readInteractiveChannelFollow(context.repoRoot,follow!.followToken,{...(context.runtimeDirectory===undefined?{}:{runtimeDirectory:context.runtimeDirectory}),...(input.afterCursor===undefined?{}:{afterCursor:input.afterCursor as string})});
      return result;
    }
    if(binding.revision!==input.expectedRevision) throw new Error("Channel binding revision changed");
    if(!input.channelRef || typeof input.channelRef!=="object" || Object.keys(input.channelRef).some(key=>!["kind","channelId"].includes(key))) throw new Error("Invalid Channel reference");
    const channelRef=parseChannelRef(input.channelRef);
    if(!channelRefAllowed(binding,channelRef)) throw new Error("Channel is outside the binding allowlist");
    const inbox=new TopicInboxStore(paths.topicInbox);
    const targetDigest=createHash("sha256").update(JSON.stringify(channelRef)).digest("hex");
    const idempotencyKey=`chat-channel:${scope!.source.eventId}:${dispatch.eventId}:${targetDigest}`;
    const previous=database.prepare("SELECT binding_id FROM channel_send_receipts WHERE idempotency_key = ?").get(idempotencyKey) as {binding_id:string}|undefined;
    if(previous!==undefined && previous.binding_id!==binding.bindingId) throw new Error("This message already used another Channel binding; inspect the original follow");
    const result=reserveInteractiveChannelMessage(database,{bindingId:binding.bindingId,channelRef,
      idempotencyKey,body:input.body as string},new Date().toISOString(),String(inbox.cursor(channelRef.channelId)),false);
    return {outcome:result.created ? "accepted" : "duplicate",receipt:result.receipt,follow:result.follow,
      authoritySourceEventId:scope!.source.eventId,completion:"asynchronous"};
  }); } finally {store.close();foundation.close();runtime.close();database.close();}
}
