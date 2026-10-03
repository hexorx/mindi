import { DiagnosticTail } from "./diagnostics.js";
import { nativeInteraction } from "./interactions.js";
import type { WorkerInput } from "@mindi/agent-runtime";
import { RuntimeError } from "@mindi/agent-runtime";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { OwnedOmpProcess } from "./owned-process.js";
export type Frame = Record<string, unknown>;
export function object(value: unknown): Frame {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid OMP object");
  return value as Frame;
}
export class OmpProcess {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private chunk?: {
    id: string;
    count: number;
    bytes: number;
    parts: Buffer[];
    received: number;
  };
  private pending = new Map<
    string,
    {
      command: string;
      resolve: (value: Frame) => void;
      reject: (error: Error) => void;
    }
  >();
  private waiters = new Set<{
    read: (frame: Frame) => void;
    reject: (error: Error) => void;
  }>();
  private readonly dialogIds = new Set<string>();
  private readonly dialogs = new Map<string, AbortController>();
  private failed?: Error;
  private owner: OwnedOmpProcess;
  private closing?: Promise<void>;
  readonly ready: Promise<Frame>;
  get pid() {
    return this.child.pid;
  }
  get ownership() {
    return this.owner.ownership;
  }
  start() {
    return this.owner.start();
  }
  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private timeoutMs: number,
    private limit: number,
    onDiagnostic?: (text: string) => void,
    private requestInteraction?: WorkerInput["requestInteraction"],
  ) {
    this.owner = new OwnedOmpProcess(command, args, cwd, env, () => {
      this.fail(new Error("OMP process closed"));
      void this.close();
    });
    this.child = this.owner.child;
    const diagnostics = onDiagnostic ? new DiagnosticTail(env) : undefined;
    this.child.once("close", () => {
      this.fail(new Error("OMP process closed"));
      if (diagnostics && onDiagnostic) {
        const tail = diagnostics.finish();
        // An operator sink failure must not interrupt owned-process cleanup.
        try {
          if (tail) onDiagnostic(tail);
        } catch {
          /* diagnostic sink only */
        }
      }
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk: Buffer) => diagnostics?.read(chunk));
    this.ready = this.wait((frame) =>
      frame.type === "ready" ? frame : undefined,
    );
    // Ownership registration can fail before the caller awaits readiness.
    // Observe early shutdown without changing the rejection seen by that await.
    void this.ready.catch(() => {});
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.failed) return;
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let newline: number;
        while ((newline = this.buffer.indexOf(10)) >= 0) {
          if (newline > this.limit) throw new Error("OMP frame exceeds limit");
          const frame = object(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                this.buffer.subarray(0, newline),
              ),
            ),
          );
          this.buffer = this.buffer.subarray(newline + 1);
          this.receive(frame);
        }
        if (this.buffer.length > this.limit)
          throw new Error("OMP frame exceeds limit");
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error("Invalid OMP frame"),
        );
        void this.close();
      }
    });
  }
  private receive(frame: Frame) {
    if (typeof frame.type !== "string")
      throw new Error("Invalid OMP frame type");
    if (frame.type === "rpc_chunk") {
      if (
        typeof frame.chunkId !== "string" ||
        !Number.isSafeInteger(frame.index) ||
        !Number.isSafeInteger(frame.count) ||
        !Number.isSafeInteger(frame.byteLength) ||
        typeof frame.data !== "string"
      )
        throw new Error("Invalid OMP chunk");
      const index = frame.index as number;
      const count = frame.count as number;
      const bytes = frame.byteLength as number;
      if (count < 1 || count > 1024 || bytes < 1 || bytes > this.limit)
        throw new Error("OMP chunk exceeds limit");
      if (index === 0 && !this.chunk)
        this.chunk = {
          id: frame.chunkId,
          count,
          bytes,
          parts: [],
          received: 0,
        };
      const chunk = this.chunk;
      if (
        !chunk ||
        chunk.id !== frame.chunkId ||
        chunk.count !== count ||
        chunk.bytes !== bytes ||
        chunk.parts.length !== index
      )
        throw new Error("Invalid OMP chunk sequence");
      const part = Buffer.from(frame.data, "base64");
      if (part.toString("base64") !== frame.data)
        throw new Error("Invalid OMP chunk encoding");
      chunk.received += part.length;
      if (chunk.received > bytes) throw new Error("OMP chunk overflow");
      chunk.parts.push(part);
      if (chunk.parts.length < count) return;
      if (chunk.received !== bytes)
        throw new Error("OMP chunk length mismatch");
      this.chunk = undefined;
      const reassembled = object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunk.parts),
          ),
        ),
      );
      if (reassembled.type === "rpc_chunk")
        throw new Error("Nested OMP chunks");
      this.receive(reassembled);
      return;
    }
    if (this.chunk) throw new Error("Interrupted OMP chunk sequence");
    if (frame.type === "extension_ui_request") {
      if (
        typeof frame.id !== "string" ||
        !frame.id ||
        frame.id.length > 256 ||
        typeof frame.method !== "string"
      )
        throw new Error("Invalid OMP UI request");
      if (frame.method === "cancel") {
        if (typeof frame.targetId !== "string")
          throw new Error("Invalid native cancellation");
        const dialog = this.dialogs.get(frame.targetId);
        if (dialog) {
          dialog.abort();
          this.send({
            type: "extension_ui_response",
            id: frame.targetId,
            cancelled: true,
          });
        }
      }
      if (
        ["confirm", "select", "input", "editor", "custom"].includes(
          frame.method,
        )
      ) {
        if (!this.requestInteraction || frame.method === "custom") {
          this.send({
            type: "extension_ui_response",
            id: frame.id,
            cancelled: true,
          });
        } else {
          if (
            this.dialogIds.has(frame.id) ||
            this.dialogs.size >= 8 ||
            this.dialogIds.size >= 32
          )
            throw new Error("Duplicate or excessive native interaction");
          const native = nativeInteraction(frame);
          const controller = new AbortController();
          const id = frame.id;
          this.dialogIds.add(id);
          this.dialogs.set(id, controller);
          void Promise.resolve()
            .then(() =>
              this.requestInteraction!(native.request, controller.signal),
            )
            .then((answer) => {
              if (!this.failed && !controller.signal.aborted)
                this.send({
                  type: "extension_ui_response",
                  id,
                  ...native.response(answer),
                });
            })
            .catch((error) => {
              if (!controller.signal.aborted) {
                this.fail(
                  error instanceof Error
                    ? error
                    : new Error("Native interaction failed"),
                );
                void this.close();
              }
            })
            .finally(() => this.dialogs.delete(id));
        }
      }
    }
    if (frame.type === "response") {
      if (
        typeof frame.id !== "string" ||
        typeof frame.command !== "string" ||
        typeof frame.success !== "boolean"
      )
        throw new Error("Invalid OMP response");
      const pending = this.pending.get(frame.id);
      if (pending) {
        if (pending.command !== frame.command)
          throw new Error("Mismatched OMP response");
        this.pending.delete(frame.id);
        if (frame.success) pending.resolve(frame);
        else pending.reject(new Error("OMP request failed"));
      }
    }
    for (const waiter of [...this.waiters]) waiter.read(frame);
  }
  private fail(error: Error) {
    this.failed ??= error;
    for (const dialog of this.dialogs.values()) dialog.abort();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }
  private expire() {
    if (!this.failed) this.send({ type: "abort" });
    this.fail(new RuntimeError("timeout", "OMP timed out; no retry performed"));
    void this.close();
  }
  private send(frame: Frame) {
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }
  wait(read: (frame: Frame) => Frame | undefined): Promise<Frame> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.expire(), this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
      };
      const waiter = {
        read: (frame: Frame) => {
          try {
            const value = read(frame);
            if (value) {
              cleanup();
              resolve(value);
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      this.waiters.add(waiter);
    });
  }
  request(type: string, params: Frame = {}): Promise<Frame> {
    if (this.failed) return Promise.reject(this.failed);
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.expire(), this.timeoutMs);
      this.pending.set(id, {
        command: type,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ id, type, ...params });
    });
  }
  abort() {
    if (!this.failed) this.send({ type: "abort" });
    this.fail(new RuntimeError("cancelled", "OMP cancelled"));
    void this.close();
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.fail(new Error("OMP closed"));
      this.closing = this.owner.close();
      // Abort, timeout, and parser callbacks initiate cleanup without awaiting.
      // Observe that rejection while preserving it for the owning run/fork.
      void this.closing.catch(() => {});
    }
    return this.closing;
  }
}
