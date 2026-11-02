export const CLOUD_API = 'https://webapi.futunn.com';
export const CLOUD_SOCKET = 'wss://webapi-quote.futunn.com/ws';
export type Json = Record<string, unknown>;
export interface CloudRequest {
  (path: string, options?: { body?: Json | URLSearchParams; token?: string; signal?: AbortSignal }): Promise<Json>;
}
export class CloudError extends Error {
  constructor(message: string, readonly code?: number | string, readonly loginRequired = false) { super(message); }
}
export function obj(value: unknown): Json { return value && typeof value === 'object' ? value as Json : {}; }
export function entries(value: unknown): Json[] { return Array.isArray(value) ? value.map(obj) : []; }
export function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined; }
export function quoteScope(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const scopes = value.split(/\s+/);
  return scopes.includes('quote:read') && scopes.every(scope => scope === 'quote:read' || /^accid:[^\s]+$/.test(scope));
}
export function cloudError(error: unknown): string {
  // Never relay a server payload, URL, token or account identifier to renderers/logs.
  return error instanceof CloudError ? error.message : '云端网络请求失败，请检查网络后重试';
}
