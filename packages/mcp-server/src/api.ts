import { ToolError } from "./types.js";

export const REQUEST_TIMEOUT_MS = 30_000;

export interface ApiEnv {
  baseUrl: string;
  token: string;
}

export function missingEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["NECRO_API_URL", "NECRO_API_TOKEN"].filter((name) => !env[name]);
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const missing = missingEnv(env);
  const first = missing[0];
  if (first) {
    throw new ToolError("missing_configuration", `Environment variable ${first} is not set.`, missing);
  }
  return { baseUrl: (env.NECRO_API_URL as string).replace(/\/+$/, ""), token: env.NECRO_API_TOKEN as string };
}

export async function apiRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const { baseUrl, token } = readEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ToolError("api_unavailable", "The NecroLegacy API is unreachable or did not answer within 30 seconds.");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) throw new ToolError("session_not_found", "session not found");
  if (!response.ok) {
    let code = "api_error";
    let message = `The API answered with status ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error bodies keep the generic message.
    }
    throw new ToolError(code, message);
  }
  try {
    return await response.json();
  } catch {
    throw new ToolError("api_unavailable", "The API returned an unreadable response.");
  }
}
