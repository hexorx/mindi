import {
  DesktopError,
  type DesktopOperator,
  type DesktopService,
} from "@mindi/desktop";
import type { IncomingMessage } from "node:http";
import { readJsonBody } from "./http-body.js";
export async function routeDesktops(
  service: DesktopService,
  request: IncomingMessage,
  url: URL,
  operator?: DesktopOperator,
): Promise<{ status: number; value: unknown } | undefined> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts[0] === "profiles" &&
    parts[2] === "desktop" &&
    parts[4] === "control"
  ) {
    if (url.search || request.headers.origin !== undefined)
      throw new DesktopError("invalid");
    if (!operator) throw new DesktopError("unavailable");
    const profileId = parts[1]!;
    const generation = parts[3]!;
    if (parts.length === 5 && request.method === "GET")
      return { status: 200, value: operator.status(profileId, generation) };
    if (parts.length !== 6 || request.method !== "POST") return;
    const action = parts[5];
    if (action === "acquire") {
      await readJsonBody(request, []);
      return { status: 200, value: operator.acquire(profileId, generation) };
    }
    if (action === "heartbeat" || action === "release") {
      const body = await readJsonBody(request, ["leaseId"]);
      return {
        status: 200,
        value: operator[action](profileId, generation, body.leaseId as string),
      };
    }
    if (action === "input") {
      const body = await readJsonBody(request, [
        "leaseId",
        "callId",
        "action",
        "input",
      ]);
      return {
        status: 200,
        value: await operator.input(
          profileId,
          generation,
          body as unknown as Parameters<DesktopOperator["input"]>[2],
        ),
      };
    }
    return;
  }
  if (parts.length !== 3 || parts[0] !== "profiles" || parts[2] !== "desktop")
    return;
  if (url.search) throw new DesktopError("invalid");
  if (request.method === "GET")
    return { status: 200, value: service.get(parts[1]!) };
  if (request.method === "PATCH")
    return {
      status: 200,
      value: service.update(
        parts[1]!,
        (await readJsonBody(request, [
          "expectedRevision",
          "enabled",
        ])) as unknown as { expectedRevision: number; enabled: boolean },
      ),
    };
}
