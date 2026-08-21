import type { WorkRequestRouteReceipt } from "@rollerskate/protocol";

export class WorkRequestRouteRegistry {
  readonly #routes = new Map<string, WorkRequestRouteReceipt>();

  public register(
    agentId: string,
    routeId: string,
    leaseMilliseconds: number,
    at = new Date()
  ): WorkRequestRouteReceipt {
    const receipt: WorkRequestRouteReceipt = {
      schemaVersion: "WorkRequestRouteReceipt@1",
      routeId,
      agentId,
      expiresAt: new Date(at.getTime() + leaseMilliseconds).toISOString()
    };
    this.#routes.set(agentId, receipt);
    return receipt;
  }

  public active(agentId: string, at = new Date()): WorkRequestRouteReceipt | undefined {
    const route = this.#routes.get(agentId);
    if (route === undefined) return undefined;
    if (Date.parse(route.expiresAt) <= at.getTime()) {
      this.#routes.delete(agentId);
      return undefined;
    }
    return route;
  }

  public matches(agentId: string, routeId: string, at = new Date()): boolean {
    return this.active(agentId, at)?.routeId === routeId;
  }
}
