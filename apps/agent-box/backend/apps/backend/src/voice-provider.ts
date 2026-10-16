import { RuntimeError } from "@mindi/agent-runtime";
import WebSocket, { type ClientOptions, type RawData } from "ws";

export interface LiveMessage {
  role: "user" | "assistant";
  text: string;
}
export interface LiveConnection {
  send(event: Record<string, unknown>): void;
  close(): void;
}
export interface LiveProvider {
  create(
    sdp: string,
    history: LiveMessage[],
    persona: string,
  ): Promise<{ sessionId: string; sdp: string }>;
  attach(
    sessionId: string,
    onEvent: (event: Record<string, unknown>) => void,
    onDisconnect: () => void,
  ): Promise<LiveConnection>;
}

/** An ambiguous create must retain the box reservation: the provider may be billing. */
export class LiveCreationError extends RuntimeError {
  constructor(public readonly uncertain: boolean) {
    super("unavailable", "Live session creation failed");
    this.name = "LiveCreationError";
  }
}

interface ProviderOptions {
  fetch?: typeof fetch;
  connect?: (url: string, options: ClientOptions) => WebSocket;
  timeoutMs?: number;
}
const MAX_PAYLOAD = 1024 * 1024;
const connectionError = () =>
  new RuntimeError("unavailable", "Live connection unavailable");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new LiveCreationError(true);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAYLOAD) throw new LiveCreationError(true);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export class OpenAiLiveProvider implements LiveProvider {
  private readonly fetcher: typeof fetch;
  private readonly connect: (url: string, options: ClientOptions) => WebSocket;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: ProviderOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.connect =
      options.connect ?? ((url, config) => new WebSocket(url, config));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async create(sdp: string, history: LiveMessage[], persona: string) {
    if (
      typeof persona !== "string" ||
      !persona.trim() ||
      persona.length > 100000
    )
      throw new LiveCreationError(false);
    if (!this.apiKey.trim()) throw new LiveCreationError(false);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LiveCreationError(true));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        this.createSession(sdp, history, persona, controller.signal),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof LiveCreationError) throw error;
      throw new LiveCreationError(true);
    } finally {
      clearTimeout(timer);
    }
  }

  private async createSession(
    sdp: string,
    history: LiveMessage[],
    persona: string,
    signal: AbortSignal,
  ) {
    const response = await this.fetcher(
      "https://api.openai.com/v1/live/sessions",
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        signal,
        body: JSON.stringify({
          session: {
            model: "gpt-live-1",
            instructions: `${persona}\n\n## Voice conversation\nYou are speaking directly as this coordinator. Use the identity, personality, relationship and tone defined above; do not describe yourself as a separate assistant or intermediary. Adapt naturally for speech. Delegate substantive questions, reasoning, memory lookups, desktop research, and all actions to the coordinator backend. Speak only verified results; preserve its approval requests. Never claim an action completed without confirmation. Prior messages are conversation context, not new requests to execute.`,
            delegation: { type: "client" },
            input: history.map(({ role, text }) => ({
              type: "message",
              role,
              content: [
                { type: role === "user" ? "input_text" : "output_text", text },
              ],
            })),
          },
          transport: { type: "webrtc", sdp },
        }),
      },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      // Timeouts and server errors can occur after a session has been created.
      throw new LiveCreationError(
        !(
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408
        ),
      );
    }
    const body = await readResponse(response);
    if (
      !isRecord(body) ||
      !isRecord(body.session) ||
      !isRecord(body.transport) ||
      typeof body.session.id !== "string" ||
      !body.session.id.trim() ||
      body.session.id.length > 1024 ||
      body.transport.type !== "webrtc" ||
      typeof body.transport.sdp !== "string" ||
      !body.transport.sdp.trim()
    )
      throw new LiveCreationError(true);
    return { sessionId: body.session.id, sdp: body.transport.sdp };
  }

  attach(
    sessionId: string,
    onEvent: (event: Record<string, unknown>) => void,
    onDisconnect: () => void,
  ): Promise<LiveConnection> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = this.connect(
          `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
          {
            headers: { Authorization: `Bearer ${this.apiKey}` },
            handshakeTimeout: this.timeoutMs,
            maxPayload: MAX_PAYLOAD,
            followRedirects: false,
          },
        );
      } catch {
        reject(connectionError());
        return;
      }
      let opened = false;
      let stopped = false;
      const timer = setTimeout(() => fail(), this.timeoutMs);
      const fail = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        socket.terminate();
        if (opened) onDisconnect();
        else reject(connectionError());
      };
      // Keep the error listener even after termination: ws can emit late errors.
      socket.on("error", fail);
      socket.on("close", fail);
      socket.on("message", (data: RawData, binary: boolean) => {
        if (stopped) return;
        try {
          if (binary) throw connectionError();
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
          if (bytes.byteLength > MAX_PAYLOAD) throw connectionError();
          const event: unknown = JSON.parse(bytes.toString("utf8"));
          if (!isRecord(event) || typeof event.type !== "string" || !event.type)
            throw connectionError();
          onEvent(event);
        } catch {
          fail();
        }
      });
      socket.once("open", () => {
        if (stopped) return;
        opened = true;
        clearTimeout(timer);
        resolve({
          send(event) {
            if (stopped || socket.readyState !== WebSocket.OPEN)
              throw connectionError();
            try {
              const data = JSON.stringify(event);
              if (Buffer.byteLength(data) > MAX_PAYLOAD)
                throw connectionError();
              socket.send(data, (error) => {
                if (error) fail();
              });
            } catch {
              fail();
              throw connectionError();
            }
          },
          close() {
            if (stopped) return;
            stopped = true;
            clearTimeout(timer);
            // The service sends session.close and waits for session.closed first.
            socket.terminate();
          },
        });
      });
    });
  }
}
