import type { PluginClient } from "./types";

type LogLevel = "debug" | "info" | "warn" | "error";

type ConsoleLogLevel = "debug" | "info" | "warn" | "error";

const ANTIGRAVITY_CONSOLE_PREFIX = "[Antigravity]";

export function printAntigravityConsole(
  level: ConsoleLogLevel,
  message: string,
  extra?: unknown,
  linesBefore: number = 1,
): void {
  const pad = "\n".repeat(Math.max(0, Math.floor(linesBefore)));
  const prefixedMessage = `${ANTIGRAVITY_CONSOLE_PREFIX} ${message}`;

  const args = extra === undefined ? [pad + prefixedMessage] : [pad + prefixedMessage, extra];

  switch (level) {
    case "debug":
      console.debug(...args);
      break;
    case "info":
      console.info(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "error":
      console.error(...args);
      break;
  }
}

interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

let _client: PluginClient | null = null;

export function initLogger(client: PluginClient): void {
  _client = client;
}

export function createLogger(module: string): Logger {
  const service = `antigravity.${module}`;

  const log = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    if (_client) {
      _client.app.log({
        body: { service, level, message, extra },
      }).catch(() => { });
    } else {
      const prefix = `[${service}]`;
      const args = extra ? [prefix, message, extra] : [prefix, message];
      switch (level) {
        case "debug":
          console.debug(...args);
          break;
        case "info":
          console.info(...args);
          break;
        case "warn":
          console.warn(...args);
          break;
        case "error":
          console.error(...args);
          break;
      }
    }
  };

  return {
    debug: (message, extra) => log("debug", message, extra),
    info: (message, extra) => log("info", message, extra),
    warn: (message, extra) => log("warn", message, extra),
    error: (message, extra) => log("error", message, extra),
  };
}
