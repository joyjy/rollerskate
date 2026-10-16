import { callExaMcp } from "pi-web-access/exa.ts";
import { createWebSearchTool } from "./pi-exa-search.mjs";

export default function register(pi) {
  pi.registerTool(createWebSearchTool(callExaMcp));
}
