/**
 * Sends one request and records exactly what went out and came back.
 *
 * The defaults are the whole point of this file. Retries are off, redirects are
 * not followed, and connections are not silently reused across identities —
 * each of those conveniences would make the observed database changes stop
 * matching the request the user thinks they sent. A transparent retry in
 * particular turns an idempotency test into a coin flip.
 */

import type { HttpRequest, RecordedRequest, RecordedResponse } from '@statescope/core';

/** Header values matching these are recorded redacted. Masking happens before storage. */
const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i;

export interface Identity {
  id: string;
  /** Header name/value pair this identity authenticates with. */
  header: { name: string; value: string };
}

export interface RunnerOptions {
  baseUrl: string;
  identities?: ReadonlyArray<Identity>;
  defaultTimeoutMs?: number;
}

export interface Exchange {
  request: RecordedRequest;
  response: RecordedResponse;
  /** Parsed body when the response was JSON; the raw string otherwise. */
  body: unknown;
}

export class HttpRunner {
  constructor(private readonly options: RunnerOptions) {}

  async send(request: HttpRequest): Promise<Exchange> {
    const url = new URL(request.path, this.options.baseUrl).toString();
    const headers = new Headers(request.headers ?? {});

    if (request.as) {
      const identity = this.options.identities?.find((i) => i.id === request.as);
      if (!identity) {
        throw new Error(
          `Step wants to act as \`${request.as}\`, which is not a configured identity. ` +
            `Known: ${this.options.identities?.map((i) => i.id).join(', ') || '(none)'}.`,
        );
      }
      headers.set(identity.header.name, identity.header.value);
    }
    if (request.idempotencyKey) headers.set('idempotency-key', request.idempotencyKey);

    let payload: string | undefined;
    if (request.body !== undefined && request.body !== null) {
      payload = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }

    const attempts = request.retry?.attempts ?? 1;
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    const startedAt = Date.now();

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: request.method,
          headers,
          ...(payload !== undefined ? { body: payload } : {}),
          redirect: request.followRedirects ? 'follow' : 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });

        const text = await response.text();
        const contentType = response.headers.get('content-type') ?? '';
        let body: unknown = text;
        if (contentType.includes('json') && text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            // A malformed JSON body is data about the failure; keep it as text.
          }
        }

        return {
          request: {
            method: request.method,
            url,
            headers: redact(headers),
            ...(payload !== undefined ? { body: payload } : {}),
            ...(request.as !== undefined ? { as: request.as } : {}),
          },
          response: {
            status: response.status,
            headers: redact(response.headers),
            body: text,
            durationMs: Date.now() - startedAt,
          },
          body,
        };
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, request.retry?.backoffMs ?? 0));
        }
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new HttpRunnerError(`${request.method} ${url} failed: ${reason}`, url);
  }
}

export class HttpRunnerError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpRunnerError';
  }
}

function redact(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = SENSITIVE_HEADERS.test(name) ? '••••••••' : value;
  });
  return out;
}
