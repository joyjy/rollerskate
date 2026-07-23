import type { ApiRequest } from "./http.js";
import {
  assertSameOrigin,
  bearerToken,
  readJsonBody,
  redirect,
  requireQuery,
  sessionCookie,
  sessionToken,
  writeJson
} from "./http.js";
import type { DeviceService } from "../modules/device/service.js";
import { ServerError } from "../modules/shared/error.js";
import type { WebOidcProvider } from "../modules/trust/oidc.js";
import type { TrustService } from "../modules/trust/service.js";

export interface TrustApiDependencies {
  readonly trust: TrustService;
  readonly devices: DeviceService;
  readonly oidc: WebOidcProvider;
}

export async function handleTrustApi(
  context: ApiRequest,
  dependencies: TrustApiDependencies
): Promise<boolean> {
  const { request, response, url } = context;

  if (request.method === "GET" && url.pathname === "/auth/login") {
    const authorization = await dependencies.trust.beginAuthorization(
      url.searchParams.get("returnTo") ?? "/"
    );
    redirect(response, await dependencies.oidc.authorizationUrl(authorization));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/auth/callback") {
    const providerError = url.searchParams.get("error");
    if (providerError !== null) {
      throw new ServerError(
        "oidc_authorization_failed",
        400,
        `OIDC authorization failed: ${providerError}`
      );
    }
    const transaction = await dependencies.trust.takeAuthorization(
      requireQuery(url, "state")
    );
    const identity = await dependencies.oidc.exchangeAuthorizationCode({
      code: requireQuery(url, "code"),
      nonce: transaction.nonce,
      codeVerifier: transaction.codeVerifier
    });
    const completion = await dependencies.trust.completeAuthorization(
      transaction,
      identity
    );
    response.setHeader(
      "set-cookie",
      sessionCookie(
        completion.sessionToken,
        dependencies.trust.publicUrl.startsWith("https://")
      )
    );
    redirect(response, completion.returnTo);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/allowlist") {
    assertSameOrigin(request, dependencies.trust.publicUrl);
    const bearer = bearerToken(request);
    const human = bearer === undefined
      ? await dependencies.trust.authenticateSession(sessionToken(request))
      : (await dependencies.devices.authenticateDevice(bearer)).human;
    const body = await readJsonBody(request);
    const subject = typeof body.subject === "string" ? body.subject : "";
    await dependencies.trust.allowSubject(human, subject);
    writeJson(response, 201, { issuer: dependencies.trust.issuer, subject });
    return true;
  }

  return false;
}
