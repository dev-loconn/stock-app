import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProbe } from '../src/main/probe';
import { validateInput, type ProbeInput } from '../src/shared/probe';
import { createGateway } from './gateway';

const input = (port: number): ProbeInput => ({ host: '127.0.0.1', port, ssl: false, key: '', symbols: ['US.AAPL'], observeMs: 1000 });
beforeEach(() => { vi.spyOn(console, 'debug').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe('real futu-api SDK through a loopback protocol fixture', () => {
  it('receives quotes and push events, queries only selected rights, and excludes account data', async () => {
    const gateway = await createGateway();
    try {
      const report = await runProbe(input(gateway.port), new AbortController().signal, () => undefined);
      expect(report.checks.find(check => check.name === '行情权限')?.status).toBe('passed');
      expect(report.outcome).toBe('passed');
      expect(report.symbols[0].quote?.price).toBe(101);
      expect(report.symbols[0].pushCount).toBe(1);
      expect(report.symbols[0].distinctSourceTimes).toEqual(['2026-10-23 10:00:00']);
      expect(gateway.calls.find(call => call.cmd === 1005)?.c2s.flag).toBe(6);
      expect(JSON.stringify(report)).not.toContain('MUST NOT APPEAR');
      expect(JSON.stringify(report)).not.toContain('987654321');
      expect(gateway.calls.every(call => [1, 1002, 1005, 3202, 3223, 3001, 3004].includes(call.cmd))).toBe(true);
    } finally { await gateway.close(); }
  });

  it('reports refused handshakes honestly and redacts the supplied secret', async () => {
    const key = 'fixture-secret-only';
    const gateway = await createGateway({ rejectKey: key });
    try {
      const report = await runProbe({ ...input(gateway.port), key }, new AbortController().signal, () => undefined);
      expect(report.outcome).toBe('failed');
      expect(report.symbols[0].subscription).toBe('pending');
      expect(report.checks.at(-1)?.detail).toContain('握手被拒绝');
      expect(JSON.stringify(report)).not.toContain(key);
      expect(JSON.stringify(report)).toContain('<REDACTED>');
      expect(gateway.calls.map(call => call.cmd)).toEqual([1]);
    } finally { await gateway.close(); }
  });

  it('isolates a permission failure without marking every security successful', async () => {
    const gateway = await createGateway({ deniedCode: '00700' });
    try {
      const report = await runProbe({ ...input(gateway.port), symbols: ['HK.00700', 'US.AAPL'] }, new AbortController().signal, () => undefined);
      expect(report.outcome).toBe('partial');
      expect(report.symbols[0]).toMatchObject({ subscription: 'failed', error: '无行情权限', pushCount: 0 });
      expect(report.symbols[0].quote).toBeUndefined();
      expect(report.symbols[1]).toMatchObject({ subscription: 'passed', pushCount: 1 });
    } finally { await gateway.close(); }
  });

  it('stops on disconnection and prevents the SDK from reconnecting after completion', async () => {
    const gateway = await createGateway({ disconnect: true });
    try {
      const report = await runProbe(input(gateway.port), new AbortController().signal, () => undefined);
      expect(report.outcome).toBe('failed');
      expect(report.checks.some(check => check.name === '连接中断' && check.status === 'failed')).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(gateway.connections()).toBe(1);
      expect(gateway.openConnections()).toBe(0);
    } finally { await gateway.close(); }
  });

  it('cancels an in-progress observation and closes its own socket', async () => {
    const gateway = await createGateway();
    const controller = new AbortController();
    try {
      const report = await runProbe(input(gateway.port), controller.signal, report => {
        if (report.checks.some(check => check.name === '观察报价推送')) controller.abort();
      });
      expect(report.outcome).toBe('failed');
      expect(report.running).toBe(false);
      expect(report.checks.at(-1)?.detail).toContain('验证已停止');
    } finally { await gateway.close(); }
  });
});

describe('probe boundary validation', () => {
  it('rejects remote endpoints, duplicate symbols and invalid port/time ranges', () => {
    expect(() => validateInput({ ...input(33333), host: 'example.com' })).toThrow('本机');
    expect(() => validateInput({ ...input(33333), symbols: ['US.AAPL', 'us.aapl'] })).toThrow('重复');
    expect(() => validateInput(input(0))).toThrow('端口');
    expect(() => validateInput({ ...input(33333), observeMs: 0 })).toThrow('观察时间');
    expect(() => validateInput({ ...input(33333), symbols: ['US.AAPL/../secret'] })).toThrow('准确代码');
  });
});
