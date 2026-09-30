import { z } from 'zod';
import { HttpsEndpointSchema } from '@mindi/agent-box-core';
import type { RegistrationRequest, Transport } from './index.js';

/** Redirects are forbidden so bearer credentials cannot follow another origin. */
export async function requestJson(url: string, token: string, method: 'GET' | 'POST', body?: unknown,
  runId?: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  try {
    const response = await fetcher(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(runId ? { 'X-Paperclip-Run-Id': runId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new Error('request_failed'); }
}

export class HttpTransport implements Transport {
  private base: string;
  constructor(base: string, private token: string,
    private resolveCredential: (reference: string) => string,
    private runId?: string, private fetcher: typeof fetch = fetch) {
    this.base = HttpsEndpointSchema.parse(base).replace(/\/$/, '').replace(/\/api$/, '');
    if (!token) throw new Error('paperclip_credential_required');
  }
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    return requestJson(`${this.base}/api${path}`, this.token, method, body, this.runId, this.fetcher);
  }
  async probe(box: RegistrationRequest['box']): Promise<void> {
    const token = this.resolveCredential(box.apiCredentialRef);
    if (!token) throw new Error('box_credential_required');
    const url = `${box.endpoint.replace(/\/$/, '')}/health`;
    // A public health page must not count as proof of credential control.
    try {
      const response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      await response.body?.cancel();
      if (![401, 403].includes(response.status)) throw new Error();
    } catch { throw new Error('box_health_auth_unverified'); }
    const health = await requestJson(url, token, 'GET', undefined, undefined, this.fetcher);
    if (!z.object({ status: z.literal('ok') }).safeParse(health).success)
      throw new Error('box_not_ready');
  }
}
