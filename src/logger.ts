import pino from 'pino';

let loggerInstance: pino.Logger | null = null;

export function initLogger(level: string = 'info'): pino.Logger {
  if (loggerInstance) return loggerInstance;

  loggerInstance = pino({
    level,
    transport: process.stdout.isTTY
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
  });

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
