import { randomBytes } from "node:crypto";

import {
  devicePairingCreateRequestSchema,
  devicePairingRedeemRequestSchema
} from "@rollerskate/protocol";

import type { TrustService } from "../modules/trust/service.js";
import { ServerError } from "../modules/shared/error.js";
import type { ApiRequest } from "./http.js";
import {
  assertSameOrigin,
  bearerToken,
  escapeHtml,
  matchPath,
  readJsonBody,
  redirect,
  sessionToken,
  writeHtml,
  writeJson
} from "./http.js";
import type { DeviceService } from "../modules/device/service.js";
import type { DeviceLoginService } from "../application/device/login-service.js";

export interface DeviceApiDependencies {
  readonly trust: TrustService;
  readonly devices: DeviceService;
  readonly deviceLogin: DeviceLoginService;
}

export async function handleDeviceApi(
  context: ApiRequest,
  dependencies: DeviceApiDependencies
): Promise<boolean> {
  const { request, response, url } = context;

  if (request.method === "POST" && url.pathname === "/api/device-pairings") {
    const body = devicePairingCreateRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 201, await dependencies.deviceLogin.begin(body));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/device-pairings/browser") {
    const body = devicePairingCreateRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 201, await dependencies.devices.createPairing(body));
    return true;
  }

  const apiPairing = matchPath(url.pathname, /^\/api\/device-pairings\/([^/]+)$/);
  if (apiPairing !== undefined && request.method === "GET") {
    writeJson(response, 200, await dependencies.deviceLogin.status(apiPairing));
    return true;
  }

  const redeemPairing = matchPath(
    url.pathname,
    /^\/api\/device-pairings\/([^/]+)\/redeem$/
  );
  if (redeemPairing !== undefined && request.method === "POST") {
    const body = devicePairingRedeemRequestSchema.parse(await readJsonBody(request));
    writeJson(
      response,
      200,
      await dependencies.devices.redeemPairing(
        redeemPairing,
        body.deviceId,
        body.verifier
      )
    );
    return true;
  }

  const browserPairing = matchPath(url.pathname, /^\/device\/pair\/([^/]+)$/);
  if (browserPairing !== undefined && request.method === "GET") {
    let human;
    try {
      human = await dependencies.trust.authenticateSession(sessionToken(request));
    } catch (error) {
      if (error instanceof ServerError && error.status === 401) {
        redirect(response, `/auth/login?returnTo=${encodeURIComponent(url.pathname)}`);
        return true;
      }
      throw error;
    }
    const pairing = await dependencies.devices.getPairingStatus(browserPairing);
    writeHtml(response, 200, pairingApprovalPage({
      pairingId: browserPairing,
      deviceId: pairing.deviceId,
      humanName: human.displayName,
      disabled: pairing.status !== "pending"
    }));
    return true;
  }

  if (browserPairing !== undefined && request.method === "POST") {
    assertSameOrigin(request, dependencies.trust.publicUrl);
    const human = await dependencies.trust.authenticateSession(sessionToken(request));
    await dependencies.devices.approvePairing(browserPairing, human);
    const scriptNonce = randomBytes(18).toString("base64");
    writeHtml(
      response,
      200,
      "<!doctype html><meta charset=\"utf-8\"><title>Device approved</title>" +
        "<p>Device approved. You can close this tab.</p>" +
        `<script nonce="${scriptNonce}">window.close();</script>`,
      { scriptNonce }
    );
    return true;
  }

  if (url.pathname === "/api/device" && request.method === "GET") {
    const authentication = await dependencies.devices.authenticateDevice(bearerToken(request));
    writeJson(response, 200, dependencies.devices.deviceSummary(authentication));
    return true;
  }

  if (url.pathname === "/api/device" && request.method === "DELETE") {
    const authentication = await dependencies.devices.authenticateDevice(bearerToken(request));
    await dependencies.devices.revokeDevice(authentication);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  return false;
}

function pairingApprovalPage(input: {
  readonly pairingId: string;
  readonly deviceId: string;
  readonly humanName: string;
  readonly disabled: boolean;
}): string {
  const returnTo = `/device/pair/${encodeURIComponent(input.pairingId)}`;
  const loginUrl = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  return [
    "<!doctype html>",
    "<meta charset=\"utf-8\">",
    "<title>Approve Rollerskate device</title>",
    "<h1>Approve device</h1>",
    `<p>Signed in as ${escapeHtml(input.humanName)}</p>`,
    `<p><a href="${escapeHtml(loginUrl)}">Sign in again</a></p>`,
    `<p>Device ID: <code>${escapeHtml(input.deviceId)}</code></p>`,
    `<form method=\"post\" action=\"/device/pair/${encodeURIComponent(input.pairingId)}\">`,
    `<button type=\"submit\"${input.disabled ? " disabled" : ""}>Approve</button>`,
    "</form>"
  ].join("\n");
}
