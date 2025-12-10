import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { cwd, env } from "node:process";

const DEBUG_FLAG = env.OPENCODE_ANTIGRAVITY_DEBUG ?? "";
const MAX_BODY_PREVIEW_CHARS = 2000;
const debugEnabled = DEBUG_FLAG.trim() === "1";
const logFilePath = debugEnabled ? defaultLogFilePath() : undefined;
const logWriter = createLogWriter(logFilePath);

export interface AntigravityDebugContext {
  id: string;
  streaming: boolean;
  startedAt: number;
}

interface AntigravityDebugRequestMeta {
  originalUrl: string;
  resolvedUrl: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  streaming: boolean;
  projectId?: string;
  sessionId?: string;
}

interface AntigravityDebugResponseMeta {
  body?: string;
  note?: string;
  error?: unknown;
  headersOverride?: HeadersInit;
}

let requestCounter = 0;

export function startAntigravityDebugRequest(meta: AntigravityDebugRequestMeta): AntigravityDebugContext | null {
  if (!debugEnabled) {
    return null;
  }

  const id = `ANTIGRAVITY-${++requestCounter}`;
  const method = meta.method ?? "GET";
  logDebug(`[Antigravity Debug ${id}] ${method} ${meta.resolvedUrl}`);
  if (meta.originalUrl && meta.originalUrl !== meta.resolvedUrl) {
    logDebug(`[Antigravity Debug ${id}] Original URL: ${meta.originalUrl}`);
  }
  if (meta.projectId) {
    logDebug(`[Antigravity Debug ${id}] Project: ${meta.projectId}`);
  }
  if (meta.sessionId) {
    logDebug(`[Antigravity Debug ${id}] Session: ${meta.sessionId}`);
  }
  logDebug(`[Antigravity Debug ${id}] Streaming: ${meta.streaming ? "yes" : "no"}`);
  logDebug(`[Antigravity Debug ${id}] Headers: ${JSON.stringify(maskHeaders(meta.headers))}`);
  const bodyPreview = formatBodyPreview(meta.body);
  if (bodyPreview) {
    logDebug(`[Antigravity Debug ${id}] Body Preview: ${bodyPreview}`);
  }

  return { id, streaming: meta.streaming, startedAt: Date.now() };
}

export function logAntigravityDebugResponse(
  context: AntigravityDebugContext | null | undefined,
  response: Response,
  meta: AntigravityDebugResponseMeta = {},
): void {
  if (!debugEnabled || !context) {
    return;
  }

  const durationMs = Date.now() - context.startedAt;
  logDebug(
    `[Antigravity Debug ${context.id}] Response ${response.status} ${response.statusText} (${durationMs}ms)`,
  );
  logDebug(
    `[Antigravity Debug ${context.id}] Response Headers: ${JSON.stringify(
      maskHeaders(meta.headersOverride ?? response.headers),
    )}`,
  );

  if (meta.note) {
    logDebug(`[Antigravity Debug ${context.id}] Note: ${meta.note}`);
  }

  if (meta.error) {
    logDebug(`[Antigravity Debug ${context.id}] Error: ${formatError(meta.error)}`);
  }

  if (meta.body) {
    logDebug(
      `[Antigravity Debug ${context.id}] Response Body Preview: ${truncateForLog(meta.body)}`,
    );
  }
}

/**
 * Obscures sensitive headers and returns a plain object for logging.
 */
function maskHeaders(headers?: HeadersInit | Headers): Record<string, string> {
  if (!headers) {
    return {};
  }

  const result: Record<string, string> = {};
  const parsed = headers instanceof Headers ? headers : new Headers(headers);
  parsed.forEach((value, key) => {
    if (key.toLowerCase() === "authorization") {
      result[key] = "[redacted]";
    } else {
      result[key] = value;
    }
  });
  return result;
}

/**
 * Produces a short, type-aware preview of a request/response body for logs.
 */
function formatBodyPreview(body?: BodyInit | null): string | undefined {
  if (body == null) {
    return undefined;
  }

  if (typeof body === "string") {
    return truncateForLog(body);
  }

  if (body instanceof URLSearchParams) {
    return truncateForLog(body.toString());
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return `[Blob size=${body.size}]`;
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "[FormData payload omitted]";
  }

  return `[${body.constructor?.name ?? typeof body} payload omitted]`;
}

/**
 * Truncates long strings to a fixed preview length for logging.
 */
function truncateForLog(text: string): string {
  if (text.length <= MAX_BODY_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_BODY_PREVIEW_CHARS)}... (truncated ${text.length - MAX_BODY_PREVIEW_CHARS} chars)`;
}

/**
 * Writes a debug message to the log file and console if debugging is enabled.
 */
export function debugLog(message: string, ...args: unknown[]): void {
  if (!debugEnabled) {
    return;
  }

  const timestamp = new Date().toISOString();
  // Safe serialization of args
  const formattedArgs = args.map(arg => {
    try {
      return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg);
    } catch {
      return '[Circular/Unserializable]';
    }
  }).join(' ');
  
  const line = `[${timestamp}] ${message} ${formattedArgs}`.trim();
  
  logWriter(line);
}

/**
 * Writes a single debug line using the configured writer.
 */
function logDebug(line: string): void {
  logWriter(line);
}

/**
 * Converts unknown error-like values into printable strings.
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Builds a timestamped log file path in the current working directory.
 */
function defaultLogFilePath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(cwd(), `antigravity-debug-${timestamp}.log`);
}

/**
 * Creates a line writer that appends to a file when provided.
 */
function createLogWriter(filePath?: string): (line: string) => void {
  if (!filePath) {
    return () => {};
  }

  const stream = createWriteStream(filePath, { flags: "a" });
  return (line: string) => {
    stream.write(`${line}\n`);
  };
}
