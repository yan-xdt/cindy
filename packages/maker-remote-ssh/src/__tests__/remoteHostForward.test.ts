/**
 * RemoteHost remote→local 端口转发 (`ssh -R`) 测试。
 *
 * 用 fake ssh2 Client 注入私有字段驱动转发链路:注册/幂等/替换/拆除、
 * tcp connection 按 destPort 分发 pipe 到本机、重连后按同端口 rebind。
 * pipe 的端到端字节验证用真实本机 net server (随机端口)。
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import net from 'node:net';

import { RemoteHost } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

/**
 * ssh2 ClientChannel 是 Duplex (远端→本机 / 本机→远端 两个方向独立)。
 * 用自定义 Duplex 模拟:_read 由测试手动 push (模拟远端发数据),
 * _write 记录 (本机经 pipe 写回远端的数据)。
 */
class FakeChannel extends Duplex {
  stderr = new EventEmitter();
  written: Buffer[] = [];
  closed = false;

  _read(): void {}
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.written.push(chunk);
    cb();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', null, null));
  }
  signal(): void {}
}

type ForwardInCall = { addr: string; port: number };

class FakeClient extends EventEmitter {
  forwardInCalls: ForwardInCall[] = [];
  unforwardInCalls: ForwardInCall[] = [];
  failPorts = new Set<number>();

  forwardIn(addr: string, port: number, cb: (err: Error | undefined, port: number) => void): void {
    this.forwardInCalls.push({ addr, port });
    queueMicrotask(() => {
      if (this.failPorts.has(port)) {
        cb(new Error(`open failed: administratively prohibited`), 0);
        return;
      }
      cb(undefined, port);
    });
  }

  unforwardIn(addr: string, port: number, cb: (err?: Error) => void): void {
    this.unforwardInCalls.push({ addr, port });
    queueMicrotask(() => cb(undefined));
  }

  /** 模拟 sshd 侧有连入:触发 'tcp connection' 事件。 */
  emitTcpConnection(
    destPort: number,
  ): { accepted: FakeChannel[]; rejected: boolean[] } {
    const accepted: FakeChannel[] = [];
    const rejected: boolean[] = [];
    this.emit(
      'tcp connection',
      { srcIP: '127.0.0.1', srcPort: 51234, destIP: '127.0.0.1', destPort },
      () => {
        const ch = new FakeChannel();
        accepted.push(ch);
        return ch;
      },
      () => {
        rejected.push(true);
      },
    );
    return { accepted, rejected };
  }
}

const HOST_CONFIG: HostConfig = {
  id: 'test-host',
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

function makeReadyHost(): { host: RemoteHost; client: FakeClient } {
  const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });
  const client = new FakeClient();
  (host as unknown as { status: string }).status = 'ready';
  (host as unknown as { client: unknown }).client = client;
  // doConnect 之外的路径也要能分发 tcp connection:测试直接挂 listener 模拟。
  client.on('tcp connection', (details, accept, reject) => {
    (host as unknown as {
      handleForwardedTcpConnection: (d: unknown, a: unknown, r: unknown) => void;
    }).handleForwardedTcpConnection(details, accept, reject);
  });
  return { host, client };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe('RemoteHost remote forwarding', () => {
  it('openRemoteForward binds via forwardIn and returns the info', async () => {
    const { host, client } = makeReadyHost();
    const info = await host.openRemoteForward({
      id: 'codex-mcp',
      remotePort: 47921,
      localHost: '127.0.0.1',
      localPort: 38080,
    });
    expect(info.remotePort).toBe(47921);
    expect(client.forwardInCalls).toEqual([{ addr: '127.0.0.1', port: 47921 }]);
    expect(host.listRemoteForwards()).toHaveLength(1);
  });

  it('same-id same-args is idempotent (no second forwardIn)', async () => {
    const { host, client } = makeReadyHost();
    const spec = { id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 };
    await host.openRemoteForward(spec);
    await host.openRemoteForward(spec);
    expect(client.forwardInCalls).toHaveLength(1);
  });

  it('same-id different local target replaces (unforward then forward)', async () => {
    const { host, client } = makeReadyHost();
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 });
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 39090 });
    expect(client.unforwardInCalls).toEqual([{ addr: '127.0.0.1', port: 47921 }]);
    expect(client.forwardInCalls).toHaveLength(2);
    expect(host.listRemoteForwards()[0].localPort).toBe(39090);
  });

  it('forwardIn failure propagates and does not register intent', async () => {
    const { host, client } = makeReadyHost();
    client.failPorts.add(47921);
    await expect(
      host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 }),
    ).rejects.toThrow(/remote port 47921 unavailable/);
    expect(host.listRemoteForwards()).toHaveLength(0);
  });

  it('closeRemoteForward unbinds and is idempotent', async () => {
    const { host, client } = makeReadyHost();
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 });
    await host.closeRemoteForward('codex-mcp');
    await host.closeRemoteForward('codex-mcp');
    expect(client.unforwardInCalls).toEqual([{ addr: '127.0.0.1', port: 47921 }]);
    expect(host.listRemoteForwards()).toHaveLength(0);
  });

  it('rejects forwarded connections on unregistered ports', async () => {
    const { host, client } = makeReadyHost();
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 });
    const { accepted, rejected } = client.emitTcpConnection(12345);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it('pipes forwarded bytes to the local target and back', async () => {
    // 真实本机 echo server 验证 pipe 双向字节。
    const echo = net.createServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const echoPort = (echo.address() as net.AddressInfo).port;

    const { host, client } = makeReadyHost();
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: echoPort });
    const { accepted, rejected } = client.emitTcpConnection(47921);
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);

    // channel push (远端发数据) → pipe → echo server → echo 回写 → pipe 回
    // channel._write (written 记录)。
    const channel = accepted[0];
    channel.push(Buffer.from('ping'));
    await flush();
    expect(channel.written.map((b) => b.toString()).join('')).toContain('ping');

    echo.close();
  });

  it('rebinds all forwards with the same ports after reconnect', async () => {
    const { host, client } = makeReadyHost();
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 });
    await host.openRemoteForward({ id: 'file-svc', remotePort: 47922, localHost: '127.0.0.1', localPort: 38081 });

    // 模拟重连:换新 client,调私有 rebindForwards(doConnect onReady 的调用点)。
    const newClient = new FakeClient();
    await (host as unknown as { rebindForwards: (c: unknown) => Promise<void> }).rebindForwards(newClient);

    expect(newClient.forwardInCalls).toEqual([
      { addr: '127.0.0.1', port: 47921 },
      { addr: '127.0.0.1', port: 47922 },
    ]);
    // 意图表保留,端口不变。
    expect(host.listRemoteForwards().map((f) => f.remotePort).sort()).toEqual([47921, 47922]);
  });

  it('rebind failure keeps the intent for the next reconnect and does not throw', async () => {
    const { host, client } = makeReadyHost();
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 });

    const newClient = new FakeClient();
    newClient.failPorts.add(47921);
    await expect(
      (host as unknown as { rebindForwards: (c: unknown) => Promise<void> }).rebindForwards(newClient),
    ).resolves.toBeUndefined();
    expect(host.listRemoteForwards()).toHaveLength(1);
  });

  it('same-args open after a failed rebind retries bind instead of short-circuiting', async () => {
    // P1 回归:rebind 失败后 sshd 侧其实没有监听,同参 open 若幂等短路,
    // 调用方会拿着"假成功"的端口写远端 config,daemon 稳定连接失败。
    const { host } = makeReadyHost();
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 });

    // 重连:新 client 上 rebind 失败(端口暂被占)。
    const failing = new FakeClient();
    failing.failPorts.add(47921);
    await (host as unknown as { rebindForwards: (c: unknown) => Promise<void> }).rebindForwards(failing);

    // 端口恢复后同参 open:必须重新 bindForward,而不是返回旧 intent。
    const recovered = new FakeClient();
    (host as unknown as { client: unknown }).client = recovered;
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 });
    expect(recovered.forwardInCalls).toEqual([{ addr: '127.0.0.1', port: 47921 }]);

    // 恢复 bound 态后,同参 open 才真正幂等。
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 });
    expect(recovered.forwardInCalls).toHaveLength(1);
  });

  it('a late bind success from a replaced client does not flip bound back to true', async () => {
    // P1 回归:rebind pending 期间连接换代,旧 client 迟到的成功回调若把
    // intent 翻回 bound=true,当前 client 其实没监听,同参 open 会短路返回
    // 假成功,后续 ensure 不再重试。
    const { host } = makeReadyHost();
    await host.openRemoteForward({ id: 'codex-mcp', remotePort: 47921, localHost: '127.0.0.1', localPort: 38080 });

    // 旧 client 的 forwardIn 挂起,手动释放。
    let releaseOld: (() => void) | null = null;
    const oldClient = new FakeClient();
    oldClient.forwardIn = (addr: string, port: number, cb: (err: Error | undefined, port: number) => void) => {
      oldClient.forwardInCalls.push({ addr, port });
      releaseOld = () => cb(undefined, port);
    };
    const rebindPromise = (
      host as unknown as { rebindForwards: (c: unknown) => Promise<void> }
    ).rebindForwards(oldClient);
    await flush();
    expect(releaseOld).not.toBeNull();

    // 换代:新一代 rebind 失败(端口被占), bound 留 false。
    const newClient = new FakeClient();
    newClient.failPorts.add(47921);
    (host as unknown as { client: unknown }).client = newClient;
    await (host as unknown as { rebindForwards: (c: unknown) => Promise<void> }).rebindForwards(newClient);
    expect(host.listRemoteForwards()[0].bound).toBe(false);

    // 旧 client 迟到的成功回调:不得翻回 true。
    releaseOld!();
    await rebindPromise;
    expect(host.listRemoteForwards()[0].bound).toBe(false);
  });
});
