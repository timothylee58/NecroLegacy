import { vi } from "vitest";

export const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

export function setEnv(): void {
  process.env.NECRO_API_URL = "http://api.test";
  process.env.NECRO_API_TOKEN = "test-token";
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

export function parse(result: { content: { text: string }[] }): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}
