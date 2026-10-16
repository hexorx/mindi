/** Bounded loopback transport for a host-issued, per-run interaction capability. */
export async function requestInteractionBridge(input: {
  route: "question" | "permission";
  label: "Question" | "Permission";
  url: string | undefined;
  token: string | undefined;
  callId: string;
  request: unknown;
  signal?: AbortSignal;
}): Promise<unknown> {
  const unavailable = () => new Error(`${input.label} bridge unavailable`);
  let url: URL;
  try {
    if (
      !input.url ||
      input.url.length > 256 ||
      !input.token ||
      !/^[a-zA-Z0-9_-]{32,256}$/.test(input.token)
    )
      throw Error();
    url = new URL(input.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== `/${input.route}` ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw Error();
  } catch {
    throw unavailable();
  }
  const timeout = AbortSignal.timeout(120000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  try {
    const body = JSON.stringify({
      callId: input.callId,
      request: input.request,
    });
    if (Buffer.byteLength(body) > 65536) throw Error();
    const response = await fetch(url.href, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.token}`,
      },
      body,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65536) throw Error();
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (signal.aborted) throw Error();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw signal.aborted
      ? new Error(`${input.label} cancelled`)
      : unavailable();
  }
}
