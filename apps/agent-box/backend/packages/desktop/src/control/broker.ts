import { DesktopControl } from "./control.js";
import { bindWindowRequest, bindDesktopRequest } from "./target.js";

interface Driver {
  /** Resolves only a correlated successful tool response; rejects uncertainty. */
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/**
 * Owns input lifetime independently of HTTP callers. This is an internal adapter
 * API: owner must come from authenticated server context. Target and driver
 * session are derived internally from validated window or desktop arguments. No retry, cancel,
 * timeout cleanup or public permit-completion escape hatch is provided.
 */
export class DesktopInputBroker {
  private readonly control = new DesktopControl();
  constructor(private readonly driver: Driver) {}
  status() {
    return this.control.status();
  }
  acquire(owner: string) {
    return this.control.acquire(owner);
  }
  heartbeat(owner: string, id: string) {
    return this.control.heartbeat(owner, id);
  }
  release(owner: string, id: string) {
    this.control.release(owner, id);
  }

  /** Explicit per-window capture; failure never falls back to another scope. */
  async capture(owner: string, input: Record<string, unknown>) {
    return this.captureBound(
      "get_window_state",
      bindWindowRequest(owner, "get_window_state", input),
    );
  }

  async captureDesktop(owner: string) {
    return this.captureBound(
      "get_desktop_state",
      bindDesktopRequest(owner, "get_desktop_state", {}),
    );
  }

  private async captureBound(
    name: string,
    { scope, args }: ReturnType<typeof bindWindowRequest>,
  ) {
    const permit = this.control.beginObservation(scope);
    // A rejected call may still be executing; deliberately retain its permit.
    const result = await this.driver.call(name, args);
    const hasImage =
      Array.isArray(result.content) &&
      result.content.some((item: unknown) => {
        if (!item || typeof item !== "object") return false;
        const block = item as Record<string, unknown>;
        return (
          block.type === "image" &&
          typeof block.data === "string" &&
          block.data.length > 0 &&
          typeof block.mimeType === "string" &&
          block.mimeType.startsWith("image/")
        );
      });
    if (!hasImage) {
      this.control.endInput(permit.id);
      throw new Error("A successful screen image is required before input.");
    }
    const observation = this.control.completeObservation(permit.id);
    return { result, observation };
  }

  /** Window observations authorize window mutations only. */
  async agentInput(
    owner: string,
    observation: string,
    name: string,
    input: Record<string, unknown>,
  ) {
    if (name === "get_window_state")
      throw new Error("Use capture for screen observations.");
    return this.inputBound(
      observation,
      name,
      bindWindowRequest(owner, name, input),
    );
  }

  async desktopInput(
    owner: string,
    observation: string,
    name: string,
    input: Record<string, unknown>,
  ) {
    if (name === "get_desktop_state")
      throw new Error("Use captureDesktop for screen observations.");
    return this.inputBound(
      observation,
      name,
      bindDesktopRequest(owner, name, input),
    );
  }

  /** The transport must authenticate an operator before calling this method. */
  async humanDesktopInput(
    owner: string,
    lease: string,
    name: string,
    input: Record<string, unknown>,
  ) {
    if (name === "get_desktop_state")
      throw new Error("Human input requires a mutation tool.");
    const { args } = bindDesktopRequest(owner, name, input);
    const permit = this.control.beginHumanInput(owner, lease);
    const result = await this.driver.call(name, args);
    this.control.endInput(permit.id);
    return result;
  }

  private async inputBound(
    observation: string,
    name: string,
    { scope, args }: ReturnType<typeof bindWindowRequest>,
  ) {
    const permit = this.control.beginAgentInput(observation, scope);
    // No finally: timeout, rejection or caller disconnect is not completion.
    const result = await this.driver.call(name, args);
    this.control.endInput(permit.id);
    return result;
  }
}
