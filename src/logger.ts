type Level = 'info' | 'warn' | 'error';

function emit(level: Level, module: string, message: string, extra?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    module,
    msg: message,
  };
  if (extra) Object.assign(entry, extra);
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export function createLogger(module: string) {
  return {
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', module, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', module, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', module, msg, extra),
  };
}
