/**
 * codex-remote-mcp 远端 config.toml 管理段的纯函数测试:
 * renderManagedMcpBlock 的输出形态,mergeManagedMcpBlock 的幂等 / 替换 /
 * 追加语义(漂移检测是"内容一致则不重写、不重启 daemon"的前提)。
 */

import { describe, expect, it, vi } from 'vitest';

import type { RemoteHost } from '@cindy/maker-remote-ssh';

import {
  renderManagedMcpBlock,
  mergeManagedMcpBlock,
  ensureRemoteCodexMcpBridge,
} from '../codex-remote-mcp.js';

// safeStorage 在测试 stub 里 isEncryptionAvailable=false → token 真源恒 null;
// 走完整 ensure 流程的用例需要固定 token。
vi.mock('../../mcp-integrations/remoteMcpBridgeToken.js', () => ({
  getRemoteMcpBridgeToken: () => 'test-persistent-token',
}));

const SERVERS = ['cindy_orca', 'orca_worker_bridge'];

describe('renderManagedMcpBlock', () => {
  it('renders one mcp_servers table per server with bridge url and bearer env var', () => {
    const block = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS });
    expect(block).toContain('[mcp_servers.cindy_orca]');
    expect(block).toContain('url = "http://127.0.0.1:47921/mcp/cindy_orca"');
    expect(block).toContain('[mcp_servers.orca_worker_bridge]');
    expect(block).toContain('url = "http://127.0.0.1:47921/mcp/orca_worker_bridge"');
    expect(block.match(/bearer_token_env_var = "LIZI_MCP_TOKEN"/g)).toHaveLength(2);
    expect(block).toContain('startup_timeout_sec = 600');
  });

  it('is wrapped in managed begin/end markers', () => {
    const block = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS });
    expect(block.startsWith('# >>> cindy-remote-mcp')).toBe(true);
    expect(block.trimEnd().endsWith('# <<< cindy-remote-mcp <<<')).toBe(true);
  });
});

describe('mergeManagedMcpBlock', () => {
  const block = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS });

  it('appends to an empty config', () => {
    const { next, changed } = mergeManagedMcpBlock('', block);
    expect(changed).toBe(true);
    expect(next).toBe(`${block}\n`);
  });

  it('appends below existing user content and preserves it', () => {
    const existing = 'model = "gpt-5.5"\n\n[history]\npersistence = "save-all"\n';
    const { next, changed } = mergeManagedMcpBlock(existing, block);
    expect(changed).toBe(true);
    expect(next).toContain('model = "gpt-5.5"');
    expect(next).toContain('[history]');
    expect(next).toContain(block);
    expect(next.indexOf('model = "gpt-5.5"')).toBeLessThan(next.indexOf(block));
  });

  it('is idempotent when content already matches (drift check stays quiet)', () => {
    const first = mergeManagedMcpBlock('', block);
    const second = mergeManagedMcpBlock(first.next, block);
    expect(second.changed).toBe(false);
    expect(second.next).toBe(first.next);
  });

  it('replaces a stale managed block in place (port change) and keeps surrounding content', () => {
    const stale = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS });
    const existing = `model = "gpt-5.5"\n\n${stale}\n\n[history]\npersistence = "save-all"\n`;
    const fresh = renderManagedMcpBlock({ remotePort: 47930, serverNames: SERVERS });
    const { next, changed } = mergeManagedMcpBlock(existing, fresh);
    expect(changed).toBe(true);
    expect(next).toContain('url = "http://127.0.0.1:47930/mcp/cindy_orca"');
    expect(next).not.toContain('47921');
    expect(next).toContain('model = "gpt-5.5"');
    expect(next).toContain('[history]');
    // 管理段仍恰好出现一次。
    expect(next.match(/# >>> cindy-remote-mcp/g)).toHaveLength(1);
  });

  it('drops a server removed from the bridge list on next merge', () => {
    const twoServers = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS });
    const existing = mergeManagedMcpBlock('', twoServers).next;
    const oneServer = renderManagedMcpBlock({ remotePort: 47921, serverNames: ['cindy_orca'] });
    const { next, changed } = mergeManagedMcpBlock(existing, oneServer);
    expect(changed).toBe(true);
    expect(next).toContain('[mcp_servers.cindy_orca]');
    expect(next).not.toContain('orca_worker_bridge');
  });

  it('matches markers by whole line only (a comment mentioning the marker text survives)', () => {
    // P1 回归:子串匹配会把用户注释里提到 marker 文本的内容误判成管理段起点,
    // 把该用户的其余配置当管理段剥掉。行级精确匹配后注释行原样保留。
    const note = '# my note referencing # >>> cindy-remote-mcp (managed, do not edit) >>> inline';
    const existing = `${note}\nmodel = "gpt-5.5"\n`;
    const { next, changed, strippedUserServers } = mergeManagedMcpBlock(existing, block);
    expect(changed).toBe(true);
    expect(next).toContain(note);
    expect(next).toContain('model = "gpt-5.5"');
    expect(strippedUserServers).toEqual([]);
  });

  it('strips user-defined mcp_servers blocks for managed servers (invalid duplicate TOML)', () => {
    // P1 回归:用户在 managed 段之外手写同名 server table 时,直接追加 managed
    // 段会产生重复 table (非法 TOML, codex 起不来)。merge 必须剥离用户段并
    // 报告名字。
    const existing = [
      'model = "gpt-5.5"',
      '',
      '[mcp_servers.cindy_orca]',
      'url = "http://127.0.0.1:11111/mcp/cindy_orca"',
      'startup_timeout_sec = 30',
      '',
      '[mcp_servers.cindy_orca.advanced]',
      'flag = true',
      '',
      '[history]',
      'persistence = "save-all"',
      '',
    ].join('\n');
    const { next, changed, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames: SERVERS,
    });
    expect(changed).toBe(true);
    expect(strippedUserServers).toEqual(['cindy_orca']);
    expect(next).not.toContain('11111');
    // 用户段与其子表都被剥掉, 其他 table 保留。
    expect(next).not.toContain('[mcp_servers.cindy_orca.advanced]');
    expect(next).not.toContain('flag = true');
    expect(next).toContain('[history]');
    expect(next).toContain('model = "gpt-5.5"');
    // managed 段恰好一次。
    expect(next.match(/\[mcp_servers\.cindy_orca\]/g)).toHaveLength(1);
  });

  it('keeps user-defined blocks for unmanaged servers untouched', () => {
    const existing = [
      '[mcp_servers.my_custom]',
      'url = "http://127.0.0.1:22222/mcp/my_custom"',
      '',
    ].join('\n');
    const { next, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames: SERVERS,
    });
    expect(strippedUserServers).toEqual([]);
    expect(next).toContain('[mcp_servers.my_custom]');
    expect(next).toContain('22222');
  });

  it('strips TOML-variant user headers (trailing comment / quoted key / array-of-tables)', () => {
    // P1 回归:`[mcp_servers.cindy_orca] # note`、`[mcp_servers."cindy_orca"]`、
    // `[[mcp_servers.cindy_orca]]` 都是 TOML 合法形态, 漏剥会跟 managed 段
    // 形成重复定义, codex config 解析失败。
    const variants = [
      '[mcp_servers.cindy_orca] # trailing note',
      '[mcp_servers."cindy_orca"]',
      "[[mcp_servers.cindy_orca]]",
    ];
    for (const header of variants) {
      const existing = `${header}\nurl = "http://127.0.0.1:11111/mcp/x"\n`;
      const { next, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
        serverNames: SERVERS,
      });
      expect(strippedUserServers).toEqual(['cindy_orca']);
      expect(next).not.toContain('11111');
      // managed 段的 table 恰好出现一次。
      expect(next.match(/\[mcp_servers\.cindy_orca\]/g)).toHaveLength(1);
    }
  });

  it('does not end a stripped user table on a multiline-string line that merely starts with [', () => {
    // P1 回归:边界判定必须按 header 形态, 用户 table 的多行字符串内容里
    // 以 `[` 开头但形态不符的行不得提前结束剥离。
    const existing = [
      '[mcp_servers.cindy_orca]',
      'instructions = """',
      '[not a header, no closing bracket',
      'still inside the string"',
      'url = "http://127.0.0.1:11111/mcp/x"',
      '',
      '[history]',
      'persistence = "save-all"',
      '',
    ].join('\n');
    const { next, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames: SERVERS,
    });
    expect(strippedUserServers).toEqual(['cindy_orca']);
    // 字符串内容行与用户 key 都随 table 剥掉; [history] 保留。
    expect(next).not.toContain('not a header');
    expect(next).not.toContain('11111');
    expect(next).toContain('[history]');
  });

  it('an orphan managed begin strips only managed residue, never user config after it', () => {
    // P1 回归:有 begin 无 end (写文件中断) 时, 旧实现会一路剥到 EOF, 把
    // begin 之后的 [history] 等用户配置全删掉。自愈必须只剥连续的 managed
    // 残留形态行, 遇到用户内容即停。
    const existing = [
      '# >>> cindy-remote-mcp (managed, do not edit) >>>',
      '[mcp_servers.cindy_orca]',
      'url = "http://127.0.0.1:47921/mcp/cindy_orca"',
      '',
      '[history]',
      'persistence = "save-all"',
      '',
      'model = "gpt-5.5"',
      '',
    ].join('\n');
    const { next, changed, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames: SERVERS,
    });
    expect(changed).toBe(true);
    // managed 残留 (begin + 半截 table) 被剥, 用户配置完整保留。
    expect(next).toContain('[history]');
    expect(next).toContain('persistence = "save-all"');
    expect(next).toContain('model = "gpt-5.5"');
    expect(next.match(/# >>> cindy-remote-mcp/g)).toHaveLength(1);
    // 残留 table 经 managed residue 路径剥除, 不按"用户段"上报。
    expect(strippedUserServers).toEqual([]);
    // 自愈后幂等: 再 merge 不再变化。
    const second = mergeManagedMcpBlock(next, block, { serverNames: SERVERS });
    expect(second.changed).toBe(false);
  });
});

describe('ensureRemoteCodexMcpBridge per-host serialization', () => {
  it('serializes concurrent ensures for the same host (second runs after first settles)', async () => {
    // P1 回归:并发 ensure 同一 host 会经 openRemoteForward 替换语义互相拆
    // forward;per-host 串行锁保证后到的 ensure 在前一个完成后才执行。
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    let callIdx = 0;
    const deps = {
      ensureBridgeStarted: async () => {
        callIdx += 1;
        const mine = callIdx;
        order.push(`start-${mine}`);
        if (mine === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        order.push(`end-${mine}`);
        return null; // 早退 bridge-unavailable,无需走完整 ensure 流程
      },
    };
    const host = { id: 'host-serial-1' } as unknown as RemoteHost;

    const p1 = ensureRemoteCodexMcpBridge(host, deps);
    const p2 = ensureRemoteCodexMcpBridge(host, deps);
    // 第二个调用在锁上排队,不会与第一个并发执行。
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start-1']);
    releaseFirst!();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('different hosts run independently', async () => {
    let bridgeCalls = 0;
    const deps = {
      ensureBridgeStarted: async () => {
        bridgeCalls += 1;
        return null;
      },
    };
    const hostA = { id: 'host-serial-a' } as unknown as RemoteHost;
    const hostB = { id: 'host-serial-b' } as unknown as RemoteHost;
    const [ra, rb] = await Promise.all([
      ensureRemoteCodexMcpBridge(hostA, deps),
      ensureRemoteCodexMcpBridge(hostB, deps),
    ]);
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    expect(bridgeCalls).toBe(2);
  });

  it('a failed ensure does not poison the lock for the next one', async () => {
    let bridgeCalls = 0;
    const deps = {
      ensureBridgeStarted: async () => {
        bridgeCalls += 1;
        if (bridgeCalls === 1) throw new Error('bridge exploded');
        return null;
      },
    };
    const host = { id: 'host-serial-fail' } as unknown as RemoteHost;
    const first = await ensureRemoteCodexMcpBridge(host, deps);
    expect(first.ok).toBe(false);
    const second = await ensureRemoteCodexMcpBridge(host, deps);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('bridge-unavailable');
    expect(bridgeCalls).toBe(2);
  });
});

describe('ensureRemoteCodexMcpBridge live-turn defer', () => {
  function fakeHost(hostId: string, configContent: string) {
    const execCmds: string[] = [];
    const host = {
      id: hostId,
      exec: async (cmd: string) => {
        execCmds.push(cmd);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        // daemon version 探活 / write / bootstrap 一律成功。
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      openRemoteForward: async (spec: { id: string; remotePort: number }) => ({
        id: spec.id,
        remotePort: spec.remotePort,
        localHost: '127.0.0.1',
        localPort: 38080,
        bound: true,
      }),
    } as unknown as RemoteHost;
    return { host, execCmds };
  }

  const bridgeDeps = {
    ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS }),
  };

  it('defers config write and daemon restart while a live turn exists on the host', async () => {
    // P1 回归:config 漂移生效必须重启 daemon, 重启会断同 host 的 live turn —
    // 有 turn 时跳过写入与重启 (config 留旧值, 下次 ensure 重试)。
    const { host, execCmds } = fakeHost('host-defer-live', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ...bridgeDeps,
      hasLiveTurnOnHost: () => true,
    });
    expect(result.ok).toBe(true);
    const joined = execCmds.join('\n');
    expect(joined).toContain('config.toml'); // 仍读了 config (漂移检测)
    expect(joined).not.toContain('base64 -d'); // 不写 config
    expect(joined).not.toContain('bootstrap'); // 不重启 daemon
  });

  it('writes config and rebootstraps once the host has no live turn', async () => {
    const { host, execCmds } = fakeHost('host-defer-idle', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ...bridgeDeps,
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    const joined = execCmds.join('\n');
    expect(joined).toContain('base64 -d');
    expect(joined).toContain('bootstrap');
  });

  it('passes the bridge token to daemon bootstrap via stdin, never argv', async () => {
    // sec 回归:token 内联在 bash -c argv 时远端 `ps` 可见;bootstrap 必须经
    // stdin 的 KEY=value 块注入 (secrets only live in stdin)。
    const execCmds: string[] = [];
    const inputs: string[] = [];
    const host = {
      id: 'host-stdin-token',
      exec: async (cmd: string, opts?: { input?: string }) => {
        execCmds.push(cmd);
        if (opts?.input) inputs.push(opts.input);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      openRemoteForward: async (spec: { id: string; remotePort: number }) => ({
        id: spec.id,
        remotePort: spec.remotePort,
        localHost: '127.0.0.1',
        localPort: 38080,
        bound: true,
      }),
    } as unknown as RemoteHost;

    const result = await ensureRemoteCodexMcpBridge(host, {
      ...bridgeDeps,
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    // argv (任何一条 cmd) 都不含 token。
    expect(execCmds.join('\n')).not.toContain('test-persistent-token');
    // bootstrap 的 stdin 是 KEY=value + 空行终止。
    expect(inputs).toContain('LIZI_MCP_TOKEN=test-persistent-token\n\n');
  });
});
