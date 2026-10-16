export async function boundedJson(
  url: string,
  body: unknown,
  signal: AbortSignal,
  token?: string,
  maxBytes = 512 * 1024,
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      `Tool service rejected (${response.status}); inspect state before retrying writes`,
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing tool response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("Tool response exceeds limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  JSON.parse(text);
  return text;
}
