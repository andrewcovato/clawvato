import pino from 'pino';

let loggerInstance: pino.Logger | null = null;

export function initLogger(level: string = 'info'): pino.Logger {
  if (loggerInstance) return loggerInstance;

  // MCP stdio server sets LOG_DESTINATION=stderr to keep stdout clean for JSON-RPC
  const useStderr = process.env.LOG_DESTINATION === 'stderr';
  const destination = useStderr ? pino.destination(2) : undefined; // fd 2 = stderr

  loggerInstance = pino({
    level,
    transport: !useStderr && process.stdout.isTTY
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
    base: { service: 'clawvato' },
  }, destination as unknown as pino.DestinationStream);

  return loggerInstance;
}

// Lazy-initialized logger (uses 'info' level if initLogger hasn't been called)
export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    if (!loggerInstance) {
      loggerInstance = initLogger();
    }
    return (loggerInstance as unknown as Record<string | symbol, unknown>)[prop];
  },
});
