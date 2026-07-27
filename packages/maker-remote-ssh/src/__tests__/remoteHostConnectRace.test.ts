/**
 * RemoteHost doConnect 的 ready/rebind/close 竞态回归 (review P1):
 * onReady 里 rebind 异步执行,期间连接断开/被 disconnect/被新 doConnect
 * 替换时,connect() 必须按失败收尾,status 不得被覆盖成
 * "ready 但 client 为空"。
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeClient extends EventEmitter {
  forwardInPending: Array<(err: Error | undefined, port: number) => void> = [];
  ended = false;

  connect(): void {}
  forwardIn(_addr: string, _port: number, cb: (err: Error | undefined, port: number) => void): void {
    this.forwardInPending.push(cb);
  }
  unforwardIn(_addr: string, _port: number, cb: () => void): void {
    cb();
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    queueMicrotask(() => this.emit('close'));
  }
  /** 模拟连接死后 ssh2 对 pending global request 的迟到回调。 */
  flushForwardIn(): void {
    const pending = this.forwardInPending.splice(0);
    for (const cb of pending) cb(undefined, 47921);
  }
}

const h = vi.hoisted(() => ({ client: null as FakeClient | null }));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    h.client = new FakeClient();
    return h.client;
  }),
}));
vi.mock('../credentials.js', () => ({
  resolveAuth: vi.fn(async () => ({ label: 'agent' })),
  defaultAgentEndpoint: vi.fn(() => ''),
}));

import { RemoteHost } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

const HOST_CONFIG: HostConfig = {
  id: 'race-host',
  hostname: '10.0.0.1',
  port: 22,
  user: 'deploy',
  authMethod: 'agent',
  source: 'manual',
};

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe('RemoteHost connect/rebind/close race', () => {
  it('rejects connect and never publishes ready when the connection dies during rebind', async () => {
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });
    // 预置转发意图:doConnect ready 后会 rebind(异步)。
    (
      host as unknown as { forwards: Map<string, unknown> }
    ).forwards.set('codex-mcp', {
      id: 'codex-mcp',
      remotePort: 47921,
      localHost: '127.0.0.1',
      localPort: 38080,
      bound: false,
    });

    const connectP = host.connect();
    // 立即挂上 rejection 断言,避免事件驱动期间出现 unhandled rejection。
    const assertion = expect(connectP).rejects.toThrow(/closed during forward rebind/);

    // doConnect 里 new Client() 在 await resolveAuth 之后,先让微任务推进。
    await flush();
    const client = h.client!;
    expect(client).toBeTruthy();
    client.emit('ready');
    await flush(); // onReady → rebindForwards 启动,forwardIn pending
    expect(client.forwardInPending.length).toBe(1);

    // rebind 期间用户断开:client 置空,status 进入 disconnected。
    await host.disconnect();
    // forwardIn 回调此时才到达。
    client.flushForwardIn();

    await assertion;
    expect(host.getStatus()).toBe('disconnected');
  });
});
