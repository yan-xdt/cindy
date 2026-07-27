/**
 * remoteCcQueryFactory (maker-host/index.ts) 的结构性回归断言。
 *
 * maker-host/index.ts 是巨型组装函数, 闭包逻辑难以单测; 这里用源码结构
 * 断言守住两条 P1 回归 (与 makerSendToSessionOrdering.test.ts 同一模式):
 *
 *  1. race-2: openCcManagerSession 失败时必须调 mcpCleanup() 再 rethrow —
 *     否则 buildCcRemoteHttpMcpServers 注册的 per-session ctx / forward
 *     intent 残留到同 session 下一次重建或应用退出。
 *  2. remoteQuery.close 必须先 mcpCleanup 再 dispose (query close 注销
 *     session ctx; detach 不清, 重连时 factory 重新注册)。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, '..', 'index.ts');
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');
const ccManagerClientSource = readFileSync(
  resolve(__dirname, '..', 'cc-manager-client.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('remoteCcQueryFactory cleanup wiring', () => {
  it('calls mcpCleanup before rethrowing when openCcManagerSession fails', () => {
    const openCall = source.indexOf('return await openCcManagerSession({');
    expect(openCall).toBeGreaterThan(-1);
    const cleanup = source.indexOf('mcpCleanup();', openCall);
    const rethrow = source.indexOf('throw err;', openCall);
    expect(cleanup).toBeGreaterThan(openCall);
    expect(rethrow).toBeGreaterThan(cleanup);
  });

  it('runs mcpCleanup before dispose on remoteQuery.close', () => {
    const disposeFn = source.indexOf('const disposeWithMcpCleanup = async');
    expect(disposeFn).toBeGreaterThan(-1);
    const cleanup = source.indexOf('mcpCleanup();', disposeFn);
    const dispose = source.indexOf('await dispose();', disposeFn);
    expect(cleanup).toBeGreaterThan(disposeFn);
    expect(dispose).toBeGreaterThan(cleanup);
  });

  it('threads session vendorOptions into buildCcRemoteHttpMcpServers (worker bootstrap race)', () => {
    // 验收实锤回归:factory 必须把 maker-core 透传的 vendorOptions 交给
    // buildCcRemoteHttpMcpServers — worker 首次创建时 DB 标记未写, 现场
    // 查库会 fail-closed 掉 send_to_lead。
    const destructure = source.indexOf('startParams, vendorOptions, onApprovalRequest');
    expect(destructure).toBeGreaterThan(-1);
    const buildArgs = source.indexOf("workingDir: typeof startParams.cwd === 'string' ? startParams.cwd : '',");
    expect(buildArgs).toBeGreaterThan(-1);
    const passDown = source.indexOf('vendorOptions,', buildArgs);
    expect(passDown).toBeGreaterThan(buildArgs);
  });

  it('forces a fresh query on the first bridge-MCP injection per process (app restart reattach)', () => {
    // cc P1 回归:app 重启后 reattach 到 alive 旧 query, 旧 SDK 持有的
    // mcp-session-id 在新 bridge 不存在, attach 会让协同 MCP 永久 404。
    // factory 必须在首轮注入时传 forceFreshQuery, cc-manager-client 据此
    // kill alive + fresh start (resumeSdkSessionId 保上下文)。
    const gate = source.indexOf('forcedFreshCcBridgeSessions.add(sessionId)');
    expect(gate).toBeGreaterThan(-1);
    const passDown = source.indexOf('forceFreshQuery,', gate);
    expect(passDown).toBeGreaterThan(gate);

    const killFirst = ccManagerClientSource.indexOf('killAliveForFresh');
    expect(killFirst).toBeGreaterThan(-1);
    const existingGuard = ccManagerClientSource.indexOf(
      'listedSession?.alive && !killAliveForFresh',
    );
    expect(existingGuard).toBeGreaterThan(killFirst);
  });
});
