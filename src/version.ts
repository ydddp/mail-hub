import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from './logger.js';
import { errorMessage } from './errors.js';

const log = createLogger('version');

function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch (error) {
    log.warn('failed to read package version', { error: errorMessage(error) });
    return '0.0.0';
  }
}

export const APP_VERSION = readAppVersion();
