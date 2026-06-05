import { createLogger } from './logger.js';

export interface AppConfig {
  port: number;
  host: string;
  apiSecret: string;
  dbPath: string;
  proxyUrl: string;
  outlookOAuthClientId: string;
  outlookOAuthRedirectUri: string;
  outlookOAuthScopes: string;
  outlookOAuthTenant: string;
  requestLogSuccess: boolean;
  requestLogSampleRate: number;
  requestLogSlowMs: number;
}

export interface ConfigValidationResult {
  errors: string[];
  warnings: string[];
}

const log = createLogger('config');

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  return Number(value);
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    port: parseInt(env.PORT || '3100', 10),
    host: env.HOST || '0.0.0.0',
    apiSecret: env.API_SECRET || '',
    dbPath: env.DB_PATH || './data/mail.db',
    proxyUrl: env.PROXY_URL || '',
    outlookOAuthClientId: env.OUTLOOK_OAUTH_CLIENT_ID || '',
    outlookOAuthRedirectUri: env.OUTLOOK_OAUTH_REDIRECT_URI || `http://localhost:${env.PORT || '3100'}/api/outlook/oauth/callback`,
    outlookOAuthScopes: env.OUTLOOK_OAUTH_SCOPES || 'offline_access https://graph.microsoft.com/Mail.Read',
    outlookOAuthTenant: env.OUTLOOK_OAUTH_TENANT || 'consumers',
    requestLogSuccess: parseBoolean(env.REQUEST_LOG_SUCCESS, false),
    requestLogSampleRate: parseNumber(env.REQUEST_LOG_SAMPLE_RATE, 0),
    requestLogSlowMs: parseNumber(env.REQUEST_LOG_SLOW_MS, 1000),
  };
}

export function validateConfig(appConfig: AppConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isInteger(appConfig.port) || appConfig.port < 1 || appConfig.port > 65535) {
    errors.push('PORT must be an integer between 1 and 65535');
  }

  if (!appConfig.host.trim()) {
    errors.push('HOST must not be empty');
  }

  if (!appConfig.dbPath.trim()) {
    errors.push('DB_PATH must not be empty');
  }

  if (appConfig.proxyUrl) {
    try {
      const proxy = new URL(appConfig.proxyUrl);
      if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(proxy.protocol)) {
        errors.push('PROXY_URL must use http, https, socks, socks4, or socks5 protocol');
      }
    } catch {
      errors.push('PROXY_URL must be a valid URL');
    }
  }

  if (!Number.isFinite(appConfig.requestLogSampleRate) || appConfig.requestLogSampleRate < 0 || appConfig.requestLogSampleRate > 1) {
    errors.push('REQUEST_LOG_SAMPLE_RATE must be a number between 0 and 1');
  }

  if (!Number.isFinite(appConfig.requestLogSlowMs) || appConfig.requestLogSlowMs < 0) {
    errors.push('REQUEST_LOG_SLOW_MS must be a non-negative number');
  }

  if (!appConfig.apiSecret) {
    warnings.push('API_SECRET is empty; all API routes will run with admin access');
  }

  return { errors, warnings };
}

export function assertValidConfig(appConfig: AppConfig): void {
  const result = validateConfig(appConfig);
  for (const warning of result.warnings) {
    log.warn('configuration warning', { warning });
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      log.error('configuration error', { error });
    }
    throw new Error(`Invalid configuration: ${result.errors.join('; ')}`);
  }
}

export const config = loadConfig(process.env);
