/**
 * cc-remote-mcp — 远端 Claude Code query 的协同 MCP 注入。
 *
 * 与 codex 远端的路径差异:cc 的 MCP 配置是 per-query SDK 参数
 * (startParams.mcpServers, 经 cc-mgr 透传到 daemon 端 SDK),没有常驻
 * daemon 的 config.toml / env 问题。但身份通道与 codex 对齐:持久 bearer
 * token (safeStorage, 跨 app 重启稳定) 鉴权 + URL query `?session=<id>`
 * 路由 session ctx。持久 token 解决 detach/reattach 与 app 重启后旧 query
 * 重建时的 token 失效问题;ctx 注册表是内存态,query 重建时重新注册,
 * query close 时注销。
 *
 * 复用:bridge (codexEnvironment 单例) 与 remote-forward (per-host 固定
 * 端口, 与 codex daemon 共用同一条) 与 codex 路径完全一致。
 */

import type { RemoteHost } from '@cindy/maker-remote-ssh';

import type { CodexHttpBridge } from '../mcp-integrations/codexHttpBridge.js';
import { getRemoteMcpBridgeToken } from '../mcp-integrations/remoteMcpBridgeToken.js';
import { getSessionOrcaRole, getWorkerLink } from '../localDb/orcaTeamStore.js';

/**
 * cc 远端允许经 remote-forward 暴露的 server 白名单。只放协同必需的
 * cindy_orca / orca_worker_bridge:其余 in-process server (cindy_memory 远端
 * 本就显式禁用、cindy_ssh 的 exec 从本机发起等) 维持"远端不可用"现状,
 * 收窄影响面,后续按需逐个评估放开。
 */
const CC_REMOTE_HTTP_MCP_SERVER_NAMES = new Set(['cindy_orca', 'orca_worker_bridge']);

/**
 * cc remote 的 MCP session ctx 合成:与 synthesizeOrcaVendorOptionsFromDb
 * (maker-ipc/orcaSessionStartOptions.ts) 同一语义,但这里不能反向依赖
 * maker-ipc,按 orcaTeamStore 直接合成 lead/worker 两分支。
 */
export async function synthesizeCcRemoteVendorOptions(
  sessionId: string,
): Promise<Record<string, unknown>> {
  try {
    const role = await getSessionOrcaRole(sessionId);
    if (role === 'lead') {
      return { orcaRole: 'lead', orcaLeadSessionId: sessionId };
    }
    if (role === 'worker') {
      const link = await getWorkerLink({ workerSessionId: sessionId });
      if (link) {
        return {
          orcaRole: 'worker',
          orcaWorkflowId: link.teamId,
          orcaLeadSessionId: link.leadSessionId,
          orcaWorkerId: link.workerId,
          orcaWorkerSessionId: sessionId,
        };
      }
    }
  } catch {
    // 非 orca session 或 DB 未就绪:空 vendorOptions,控制类工具按无角色拒绝。
  }
  return {};
}

export interface CcRemoteHttpMcpDeps {
  ensureBridgeStarted: () => Promise<{
    port: number;
    serverNames: string[];
    bridge: CodexHttpBridge;
  } | null>;
  ensureForward: (host: RemoteHost, localBridgePort: number) => Promise<number>;
  synthesizeVendorOptions?: (sessionId: string) => Promise<Record<string, unknown>>;
  /** 持久 bridge token;测试注入 stub,生产默认 safeStorage 真源。 */
  getBridgeToken?: () => Promise<string>;
}

export interface CcRemoteHttpMcpServerConfig {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

/**
 * 为远端 cc query 构建 http 形态的 MCP server 配置。返回的 cleanup 必须在
 * query close 时调用,注销 session ctx (detach 不清,重建时重新注册覆盖)。
 * cleanup 带代际比较:同 session 重建覆盖了新 ctx 时,旧 query 迟到的
 * cleanup 不得误删新 ctx。
 *
 * vendorOptions 优先级:args.vendorOptions (session 创建方显式声明, 与本地
 * in-process MCP 同源) 为准;缺失时才回退 DB 合成。worker 首次创建时 DB 的
 * orca 标记发生在 bootstrap 之后, 现场查库会拿到空角色导致 worker 工具被
 * fail-closed ("not an orca worker session") — 真实验收实锤。
 */
export async function buildCcRemoteHttpMcpServers(
  args: {
    host: RemoteHost;
    sessionId: string;
    workingDir: string;
    /** session 自己的 vendorOptions (maker-core startSession 透传); 优先于 DB 合成。 */
    vendorOptions?: Record<string, unknown>;
  },
  deps: CcRemoteHttpMcpDeps,
): Promise<{ servers: Record<string, CcRemoteHttpMcpServerConfig>; cleanup: () => void }> {
  const empty = { servers: {}, cleanup: () => {} };
  const started = await deps.ensureBridgeStarted();
  if (!started) return empty;
  const names = started.serverNames.filter((n) => CC_REMOTE_HTTP_MCP_SERVER_NAMES.has(n));
  if (names.length === 0) return empty;
  const remotePort = await deps.ensureForward(args.host, started.port);
  // token 可用性必须在 register 之前确认:null 时下发出 "Bearer null" 还
  // 保留已注册 ctx (注册后失败无任何 cleanup 可达, 见 race review P1)。
  const bridgeToken = await (deps.getBridgeToken ?? getRemoteMcpBridgeToken)();
  if (!bridgeToken) return empty;
  const synthesize = deps.synthesizeVendorOptions ?? synthesizeCcRemoteVendorOptions;
  const ctx = {
    agentKind: 'claude-code' as const,
    sessionId: args.sessionId,
    workingDir: args.workingDir,
    vendorOptions: args.vendorOptions ?? (await synthesize(args.sessionId)),
  };
  // 同 session 重建 (resume/rebuild/reattach) 直接覆盖注册,注册表以 sessionId
  // 为 key,天然不累积。
  started.bridge.registerSessionCtx(args.sessionId, ctx);
  try {
    const servers = Object.fromEntries(
      names.map((name) => [
        name,
        {
          type: 'http' as const,
          url: `http://127.0.0.1:${remotePort}/mcp/${name}?session=${encodeURIComponent(args.sessionId)}`,
          headers: { Authorization: `Bearer ${bridgeToken}` },
        },
      ]),
    );
    return {
      servers,
      cleanup: () => started.bridge.unregisterSessionCtx(args.sessionId, ctx),
    };
  } catch (err) {
    // 注册后失败必须回滚,否则调用方拿不到 cleanup,ctx 永久残留。
    started.bridge.unregisterSessionCtx(args.sessionId, ctx);
    throw err;
  }
}
