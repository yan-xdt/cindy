/**
 * codex-remote-mcp — 让远端常驻 codex daemon 用上本机 in-process MCP
 * (cindy_orca / orca_worker_bridge 等),经 SSH remote-forward 直连本机
 * HTTP bridge (codexHttpBridge)。
 *
 * 链路:
 *   远端 daemon → http://127.0.0.1:<remotePort>/mcp/<server>  (sshd 监听)
 *     → SSH remote-forward (`ssh -R`)
 *     → 本机 127.0.0.1:<bridgePort>  (codexHttpBridge, Bearer 鉴权)
 *
 * 稳定性设计(daemon 常驻,不能每次 app 重启都要求它重配):
 *   - remotePort per-host 固定并持久化 (<userData>/remote-mcp-forwards.json),
 *     app 重启 / SSH 重连后端口不变,远端 config.toml 里的 url 保持有效;
 *   - bearer 用 persistent token (safeStorage, 见 mcp-integrations/
 *     remoteMcpBridgeToken.ts),daemon env 在 bootstrap 时注入后不失效;
 *   - 远端 config.toml 漂移检测:内容一致不重写、不重启 daemon;
 *     漂移 (首次 / 端口换 / server 列表变) 才写入并经幂等 bootstrap 重启 daemon。
 *
 * 安全:
 *   - sshd 只监听远端 127.0.0.1 (不暴露到远端网络);token 防远端本机的
 *     无意/低端伪造请求,远端主机自身安全由其自身负责;
 *   - token 只经 exec stdin 的 KEY=value 块传给 bootstrap (secrets only
 *     live in stdin: argv 与远端 `ps` 不可见, cmd 不进日志, 见
 *     RemoteHost.exec 的 label 约定),不落远端文件。
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { RemoteHost } from '@cindy/maker-remote-ssh';

import { createLogger } from '../logger.js';
import { getRemoteMcpBridgeToken } from '../mcp-integrations/remoteMcpBridgeToken.js';
import { serializeEnvBlock } from './env-block.js';

const log = createLogger('codex-remote-mcp');

const FORWARD_ID = 'codex-mcp-bridge';
const TOKEN_ENV = 'LIZI_MCP_TOKEN';
const MANAGED_BEGIN = '# >>> cindy-remote-mcp (managed, do not edit) >>>';
const MANAGED_END = '# <<< cindy-remote-mcp <<<';
/**
 * 受管段内 token 指纹注释行前缀 (见 renderManagedMcpBlock)。merge 的残留
 * 判定必须认识它, 否则该行被当成用户内容剥出受管段, 幂等漂移检测失效。
 */
const TOKEN_FINGERPRINT_PREFIX = '# cindy-token-fingerprint:';
const PROXY_FINGERPRINT_PREFIX = '# cindy-proxy-fingerprint:';
/** per-host 固定远端端口的起始探测值与探测上限。 */
const DEFAULT_REMOTE_PORT_START = 47921;
const MAX_PORT_ATTEMPTS = 20;
/** 与 codex-remote-transport.ts 的 installRoot 默认值一致。 */
const DEFAULT_INSTALL_ROOT = '$HOME/.xdt-server/v1';
const REMOTE_CODEX_PROXY_URL_ENV = 'CINDY_REMOTE_CODEX_PROXY_URL';
const REMOTE_CODEX_HTTP_PROXY_ENV = 'CINDY_REMOTE_CODEX_HTTP_PROXY';
const REMOTE_CODEX_HTTPS_PROXY_ENV = 'CINDY_REMOTE_CODEX_HTTPS_PROXY';
const REMOTE_CODEX_ALL_PROXY_ENV = 'CINDY_REMOTE_CODEX_ALL_PROXY';
const REMOTE_CODEX_NO_PROXY_ENV = 'CINDY_REMOTE_CODEX_NO_PROXY';
const LOCALHOST_NO_PROXY = ['127.0.0.1', 'localhost', '::1'];

/** 远端 MCP 注入所需的 bridge 信息(由调用方确保 bridge 已启动后提供)。 */
export interface RemoteMcpBridgeEndpoint {
  port: number;
  /** bridge 上实际挂出的 server 名 (如 cindy_orca / orca_worker_bridge)。 */
  serverNames: string[];
}

export interface EnsureRemoteCodexMcpResult {
  ok: boolean;
  /** 失败原因 (bridge-unavailable / token-unavailable / forward-failed / ...)。 */
  reason?: string;
}

function nonEmptyEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeNoProxy(value: string | null): string {
  const existing = value
    ? value.split(',').map((part) => part.trim()).filter(Boolean)
    : [];
  return Array.from(new Set([...existing, ...LOCALHOST_NO_PROXY])).join(',');
}

/**
 * Hidden dev/ops override for remote Codex daemon outbound networking.
 *
 * Cindy cannot ship the local loopback Codex proxy to an SSH host. Operators
 * who provide their own remote-visible proxy should start Cindy with:
 *   CINDY_REMOTE_CODEX_PROXY_URL=http://127.0.0.1:7890
 * or the per-scheme variants below. Values are ferried to daemon bootstrap via
 * stdin only, because proxy URLs may contain credentials.
 */
export function getRemoteCodexDaemonProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const sharedProxy = nonEmptyEnv(env, REMOTE_CODEX_PROXY_URL_ENV);
  const httpProxy = nonEmptyEnv(env, REMOTE_CODEX_HTTP_PROXY_ENV) ?? sharedProxy;
  const httpsProxy = nonEmptyEnv(env, REMOTE_CODEX_HTTPS_PROXY_ENV) ?? sharedProxy;
  const allProxy = nonEmptyEnv(env, REMOTE_CODEX_ALL_PROXY_ENV);
  if (!httpProxy && !httpsProxy && !allProxy) return {};

  const out: Record<string, string> = {};
  if (httpProxy) {
    out.HTTP_PROXY = httpProxy;
  }
  if (httpsProxy) {
    out.HTTPS_PROXY = httpsProxy;
  }
  if (allProxy) {
    out.ALL_PROXY = allProxy;
  }
  const noProxy = mergeNoProxy(nonEmptyEnv(env, REMOTE_CODEX_NO_PROXY_ENV));
  out.NO_PROXY = noProxy;
  return out;
}

function envFingerprint(env: Record<string, string>): string | null {
  const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return createHash('sha256')
    .update(entries.map(([k, v]) => `${k}=${v}`).join('\0'), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

// ── per-host 固定 remotePort 持久化 ─────────────────────────────────────────

type PortPrefs = Record<string, { remotePort: number }>;

function portPrefsPath(): string {
  return path.join(app.getPath('userData'), 'remote-mcp-forwards.json');
}

let portPrefsCache: PortPrefs | null = null;

function readPortPrefs(): PortPrefs {
  if (portPrefsCache) return portPrefsCache;
  const file = portPrefsPath();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      const out: PortPrefs = {};
      if (raw && typeof raw === 'object') {
        for (const [hostId, v] of Object.entries(raw as Record<string, unknown>)) {
          const port = (v as { remotePort?: unknown })?.remotePort;
          if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) {
            out[hostId] = { remotePort: port };
          }
        }
      }
      portPrefsCache = out;
      return out;
    }
  } catch (err) {
    log.warn('remote-mcp-forwards.json read failed → falling back to empty', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  portPrefsCache = {};
  return portPrefsCache;
}

function writeHostRemotePort(hostId: string, remotePort: number): void {
  const next = { ...readPortPrefs(), [hostId]: { remotePort } };
  const file = portPrefsPath();
  const tmp = `${file}.tmp`;
  // userData 在真实 app 里由 electron 保证存在; 测试 stub 只拼路径不建
  // 目录, 全新环境直接 writeFileSync 会 ENOENT (CI 回归: 目录依赖测试
  // 执行顺序)。recursive mkdir 对已有目录是 no-op。
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  portPrefsCache = next;
}

/** host 被删时清理端口记录 (registerRemoteSshIpc 的 remove 路径调用)。 */
export function removeRemoteMcpForwardPref(hostId: string): void {
  const current = readPortPrefs();
  if (!(hostId in current)) return;
  const next = { ...current };
  delete next[hostId];
  const file = portPrefsPath();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  portPrefsCache = next;
}

// ── 远端 config.toml 管理段 (纯函数, 便于单测) ──────────────────────────────

/** 生成我们管理的 mcp_servers 配置块 (带 begin/end 标记)。 */
export function renderManagedMcpBlock(opts: {
  remotePort: number;
  serverNames: string[];
  /**
   * 当前 bridge token 的指纹 (sha256 前 12 hex, 非 token 本身)。写进受管段
   * 让 token 轮换 (账号切换清空重生成) 也构成 config 漂移 — 否则 daemon
   * env 里的旧 token 不失效, config 无漂移不重启, 远端请求全部 401。
   */
  tokenFingerprint: string;
  /**
   * 当前远端 Codex daemon proxy env 指纹。proxy env 只经 bootstrap stdin 注入,
   * 不落 config.toml；指纹写入受管段用于让代理变更触发 daemon 重启。
   */
  proxyFingerprint?: string | null;
}): string {
  const lines: string[] = [MANAGED_BEGIN, `${TOKEN_FINGERPRINT_PREFIX} ${opts.tokenFingerprint}`];
  if (opts.proxyFingerprint) {
    lines.push(`${PROXY_FINGERPRINT_PREFIX} ${opts.proxyFingerprint}`);
  }
  for (const name of opts.serverNames) {
    lines.push(
      `[mcp_servers.${name}]`,
      `url = "http://127.0.0.1:${opts.remotePort}/mcp/${name}"`,
      `bearer_token_env_var = "${TOKEN_ENV}"`,
      'startup_timeout_sec = 600',
      'tool_timeout_sec = 600',
      '',
    );
  }
  lines.push(MANAGED_END);
  return lines.join('\n');
}

/**
 * 解析一行为 TOML table header 的 dotted key 分段; 非 header 行返回 null。
 * 覆盖尾注释 (`[a.b] # note`)、array-of-tables (`[[a.b]]`) 与引号 key
 * (`[mcp_servers."name"]`) — 只做强直判定 (inner 不含 `]` 的形态),
 * 多行字符串内容里以 `[` 开头但不符合 header 形态的行不会被误判成边界。
 */
function parseTableHeaderKey(line: string): string[] | null {
  const m = /^(\[+)([^\]]*?)(\]+)(?:\s*#.*)?$/.exec(line);
  if (!m) return null;
  const inner = m[2].trim();
  if (!inner) return null;
  return inner
    .split('.')
    .map((seg) => seg.trim().replace(/^(['"]?)(.*)\1$/, '$2').trim());
}

/**
 * 判断一行 (trim 后) 是否为指定 server 的用户级 mcp_servers table header
 * (含 `[mcp_servers.<name>.*]` 子表、引号 key 与 array-of-tables 形态)。
 */
function userMcpServerHeader(line: string, serverNames: string[]): string | null {
  const segments = parseTableHeaderKey(line);
  if (!segments || segments[0] !== 'mcp_servers' || segments.length < 2) return null;
  const name = segments[1];
  return serverNames.includes(name) ? name : null;
}

/**
 * managed 段残留内容的行形态:orphan begin (有 begin 无 end, 通常是写文件
 * 半途中断) 的自愈只剥这一段连续形态, 遇到任何不属于它的行 (用户配置)
 * 即停 — 不会像"剥到 EOF"那样误删用户配置。
 */
function isManagedResidueLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return true;
  if (t.startsWith(TOKEN_FINGERPRINT_PREFIX)) return true;
  const header = parseTableHeaderKey(t);
  if (header && header[0] === 'mcp_servers') return true;
  return /^(url|bearer_token_env_var|startup_timeout_sec|tool_timeout_sec)\s*=/.test(t);
}

/**
 * 把管理段 merge 进现有 config.toml 内容。逐行处理:
 *   - marker 行级精确匹配 (trim 后整行相等):子串匹配会把用户注释里提到
 *     marker 文本的内容误判成管理段起点;
 *   - managed 段原位剥除后在文末重建 (TOML 与顺序无关, 幂等收敛);
 *     orphan begin (缺 end) 只剥连续的 managed 残留形态行, 不波及用户配置;
 *   - managed 段之外用户手写的同名 `[mcp_servers.<name>]` table 一并剥离
 *     (重复 table 是非法 TOML, codex 会直接起不来), 由 managed 段接管,
 *     名字经 strippedUserServers 返回给调用方记 warn;
 *   - table 边界按 header 形态判定 (parseTableHeaderKey), 多行字符串内容里
 *     以 `[` 开头但形态不符的行不会提前结束剥离 (残留风险: 内容行恰好是
 *     合法 header 形态时仍会误判 — 已知局限, codex config 场景可接受)。
 * 返回 { next, changed } — 内容一致时 changed=false, 调用方据此跳过写文件
 * 与 daemon 重启。
 */
export function mergeManagedMcpBlock(
  existing: string,
  block: string,
  opts?: { serverNames?: string[] },
): { next: string; changed: boolean; strippedUserServers: string[] } {
  const serverNames = opts?.serverNames ?? [];
  const stripped = new Set<string>();
  const kept: string[] = [];
  let inManaged = false;
  let inUserBlock = false;
  for (const line of existing.split('\n')) {
    const t = line.trim();
    if (t === MANAGED_BEGIN) {
      inManaged = true;
      continue;
    }
    if (t === MANAGED_END) {
      inManaged = false;
      continue;
    }
    if (inManaged) {
      if (isManagedResidueLine(line)) continue;
      // orphan begin: 用户内容开始, 退出 managed 状态并保留该行。
      inManaged = false;
    }
    const hit = userMcpServerHeader(t, serverNames);
    if (hit) {
      stripped.add(hit);
      inUserBlock = true;
      continue;
    }
    if (inUserBlock) {
      // table 延伸到下一个任何 header 形态行 (table / array-of-tables) 为止。
      if (parseTableHeaderKey(t)) {
        inUserBlock = false;
      } else {
        continue;
      }
    }
    kept.push(line);
  }
  const trimmed = kept.join('\n').replace(/\s+$/, '');
  const next = (trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`);
  return { next, changed: next !== existing, strippedUserServers: [...stripped] };
}

// ── 远端命令 (与 codex-remote-transport.ts 的 codexCmd wrapper 同布局) ────────

function shellQuoteSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function codexHomePrefix(installRoot: string): string {
  return [
    `INSTALL_ROOT="${installRoot}"`,
    'export CODEX_HOME="$INSTALL_ROOT/codex-home"',
  ].join('; ');
}

function codexDaemonCmd(subArgs: string[], opts?: { envFromStdin?: boolean }): string {
  const lines = [
    codexHomePrefix(DEFAULT_INSTALL_ROOT),
    'CODEX="$CODEX_HOME/packages/standalone/current/codex"',
    'if [ ! -x "$CODEX" ]; then exit 127; fi',
    // secret 不进 argv (远端 `ps` 可见):经 stdin 的 KEY=value 块传入, 空行
    // 终止, 与 remote-ssh/index.ts oneShotCommand 的 stdin 协议一致。
    ...(opts?.envFromStdin
      ? [
          'while IFS= read -r LINE; do [ -z "$LINE" ] && break; export "$LINE"; done',
          '[ -n "${HTTP_PROXY+x}" ] && export http_proxy="$HTTP_PROXY"',
          '[ -n "${HTTPS_PROXY+x}" ] && export https_proxy="$HTTPS_PROXY"',
          '[ -n "${ALL_PROXY+x}" ] && export all_proxy="$ALL_PROXY"',
          '[ -n "${NO_PROXY+x}" ] && export no_proxy="$NO_PROXY"',
        ]
      : []),
    `exec "$CODEX" ${subArgs.map(shellQuoteSh).join(' ')}`,
  ].join('\n');
  return `bash -c ${shellQuoteSh(lines)}`;
}

function readConfigCmd(): string {
  return `bash -c ${shellQuoteSh(
    `${codexHomePrefix(DEFAULT_INSTALL_ROOT)}; cat "$CODEX_HOME/config.toml" 2>/dev/null || true`,
  )}`;
}

function writeConfigCmd(contentBase64: string): string {
  return `bash -c ${shellQuoteSh(
    `${codexHomePrefix(DEFAULT_INSTALL_ROOT)}; mkdir -p "$CODEX_HOME" && ` +
      `printf '%s' ${shellQuoteSh(contentBase64)} | base64 -d > "$CODEX_HOME/config.toml"`,
  )}`;
}

async function readRemoteConfig(host: RemoteHost): Promise<string> {
  const result = await host.exec(readConfigCmd(), { timeoutMs: 15_000, label: 'read codex config.toml' });
  if (result.exitCode !== 0) {
    throw new Error(`read remote config.toml failed: ${result.stderr.trim().slice(0, 200)}`);
  }
  return result.stdout;
}

async function writeRemoteConfig(host: RemoteHost, content: string): Promise<void> {
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  const result = await host.exec(writeConfigCmd(b64), { timeoutMs: 15_000, label: 'write codex config.toml' });
  if (result.exitCode !== 0) {
    throw new Error(`write remote config.toml failed: ${result.stderr.trim().slice(0, 200)}`);
  }
}

/** daemon 是否在跑 (version 探活, 与 transport 的 discoverSocketPath 同语义)。 */
async function isDaemonRunning(host: RemoteHost): Promise<boolean> {
  const result = await host.exec(codexDaemonCmd(['app-server', 'daemon', 'version']), {
    timeoutMs: 10_000,
    label: 'codex-daemon-version',
  });
  return result.exitCode === 0;
}

/**
 * 幂等 bootstrap (不存在则创建 settings + 启动, 已存在则重写 settings +
 * 重启 daemon)。token 只经 stdin 的 KEY=value 块注入 daemon env —— argv 与
 * 远端 `ps` 可见的命令行都不含 secret (与 oneShotCommand 的 "secrets only
 * live in stdin" 一致), cmd 不进日志 (RemoteHost.exec 的 label 约定),
 * 不落远端文件。
 */
async function bootstrapDaemon(
  host: RemoteHost,
  token: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const envBlock = serializeEnvBlock({
    [TOKEN_ENV]: token,
    ...extraEnv,
  });
  const result = await host.exec(
    codexDaemonCmd(['app-server', 'daemon', 'bootstrap', '--remote-control'], {
      envFromStdin: true,
    }),
    {
      timeoutMs: 30_000,
      label: 'codex-daemon-bootstrap',
      // KEY=value 行 + 空行终止符 (wrapper 的 read 循环消费; token 是 hex,
      // 无换行/空格, 单行安全)。read 循环后 stdin 即 EOF, daemon 不读 stdin。
      input: `${envBlock}\n\n`,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`daemon bootstrap exit=${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`);
  }
}

// ── per-host 固定 remotePort:持久化值优先, 被占则递增探测并更新持久化 ────────

async function ensureRemotePort(host: RemoteHost, localBridgePort: number): Promise<number> {
  const preferred = readPortPrefs()[host.id]?.remotePort;
  const candidates: number[] = [];
  if (preferred) candidates.push(preferred);
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const p = DEFAULT_REMOTE_PORT_START + i;
    if (!candidates.includes(p)) candidates.push(p);
  }
  let lastError: Error | null = null;
  for (const port of candidates) {
    try {
      await host.openRemoteForward({
        id: FORWARD_ID,
        remotePort: port,
        localHost: '127.0.0.1',
        localPort: localBridgePort,
      });
      if (port !== preferred) {
        // 换了端口:持久化新值。旧 daemon config 指向旧端口,但接下来的
        // config 漂移检测会重写并重启 daemon,自洽恢复。
        writeHostRemotePort(host.id, port);
        log.info('remote MCP forward port (re)assigned', { host: host.id, remotePort: port });
      }
      return port;
    } catch (err) {
      // 连接代际错误 (bind 期间 SSH 重连换代) 不是端口不可用:直接上抛,
      // 不在候选间漂移 — 否则瞬时 reconnect 会造成无意义的端口 churn,
      // 远端 config 跟着反复重写。下一次 ensure (串行锁内) 会按同端口重试。
      if (err instanceof Error && err.message.includes('connection replaced during forward bind')) {
        throw err;
      }
      lastError = err as Error;
      log.warn('remote forward port candidate unavailable', {
        host: host.id,
        remotePort: port,
        error: (err as Error).message,
      });
    }
  }
  throw lastError ?? new Error('no remote port candidate available');
}

// ── per-host 串行锁与共用 forward 入口 ───────────────────────────────────────

/**
 * per-host 串行链:同一 host 的 forward 端口分配 / config.toml 读写 / daemon
 * bootstrap 必须串行——并发时两个 ensure 会经 openRemoteForward 的替换语义
 * 互相拆对方刚建好的 forward,并把 config 写成已关闭的端口。codex daemon
 * ensure 与 cc per-query forward ensure 共用同一把锁。
 * 链上每个环节都吞掉异常(锁永不死锁),Map 每 host 常驻一条,量可忽略。
 */
const hostSerialChain = new Map<string, Promise<void>>();

function withHostSerial<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostSerialChain.get(hostId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  hostSerialChain.set(
    hostId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * 确保 host 上有指向本机 MCP bridge 的 remote-forward,返回远端监听端口。
 * per-host 固定端口(持久化),cc 与 codex 的远端 session 共用同一条 forward。
 * 锁内执行,与 daemon ensure 串行。
 */
export function ensureRemoteMcpForward(
  host: RemoteHost,
  localBridgePort: number,
): Promise<number> {
  return withHostSerial(host.id, () => ensureRemotePort(host, localBridgePort));
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 确保远端 codex daemon 能用上本机 MCP bridge。幂等,挂在 remote codex
 * session 的 start/resume 前置 (ensureRemoteReadyForSessionStart)。
 * 整个 ensure 在 per-host 串行锁内执行 (见 withHostSerial)。
 *
 * best-effort 之外的失败语义:bridge/token 不可用 → { ok:false } 并记 warn,
 * 调用方放行 session (远端无 MCP 也能跑, 与现状一致);forward/config/daemon
 * 操作抛错同样折叠为 { ok:false } — 不让 MCP 注入阻塞 session 建立。
 */
export function ensureRemoteCodexMcpBridge(
  host: RemoteHost,
  deps: {
    ensureBridgeStarted: () => Promise<RemoteMcpBridgeEndpoint | null>;
    /**
     * 同 host 是否有 live turn (远端 daemon 正在跑 query)。config 漂移需要
     * 重启 daemon 才能生效,而重启会断 live turn — 有 live turn 时本次
     * 跳过 config 写入与重启 (config 保持旧值, 下次 ensure 仍会检测到
     * 漂移并重试), 降级为远端无 MCP。未注入时按无 live turn 处理。
     */
    hasLiveTurnOnHost?: (hostId: string) => boolean;
  },
): Promise<EnsureRemoteCodexMcpResult> {
  return withHostSerial(host.id, () => doEnsureRemoteCodexMcpBridge(host, deps));
}

async function doEnsureRemoteCodexMcpBridge(
  host: RemoteHost,
  deps: {
    ensureBridgeStarted: () => Promise<RemoteMcpBridgeEndpoint | null>;
    hasLiveTurnOnHost?: (hostId: string) => boolean;
  },
): Promise<EnsureRemoteCodexMcpResult> {
  try {
    const bridge = await deps.ensureBridgeStarted();
    if (!bridge) {
      log.warn('remote MCP injection skipped: http bridge unavailable', { host: host.id });
      return { ok: false, reason: 'bridge-unavailable' };
    }
    if (bridge.serverNames.length === 0) {
      // collab plugin 被禁用等场景:cindy_orca 不在 bridge 上,没有可注入的
      // server。视为成功 (无需注入),daemon config 也不写管理段。
      return { ok: true };
    }
    const token = getRemoteMcpBridgeToken();
    if (!token) {
      log.warn('remote MCP injection skipped: persistent token unavailable (safeStorage?)', {
        host: host.id,
      });
      return { ok: false, reason: 'token-unavailable' };
    }

    const remotePort = await ensureRemotePort(host, bridge.port);

    const tokenFingerprint = createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);
    const daemonProxyEnv = getRemoteCodexDaemonProxyEnv();
    const proxyFingerprint = envFingerprint(daemonProxyEnv);
    const existing = await readRemoteConfig(host);
    const block = renderManagedMcpBlock({
      remotePort,
      serverNames: bridge.serverNames,
      tokenFingerprint,
      proxyFingerprint,
    });
    const { next, changed, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames: bridge.serverNames,
    });
    if (strippedUserServers.length > 0) {
      log.warn('user-defined mcp_servers blocks taken over by managed block', {
        host: host.id,
        servers: strippedUserServers,
      });
    }
    if (changed && deps.hasLiveTurnOnHost?.(host.id)) {
      // 漂移生效要重启 daemon, 重启会断 live turn:本次跳过写入与重启,
      // config 保持旧值 (下次 ensure 仍 changed=true 会重试), 远端降级无 MCP。
      log.warn('remote MCP config drift deferred: live turn in progress on host', {
        host: host.id,
      });
      return { ok: true };
    }
    if (changed) {
      await writeRemoteConfig(host, next);
      log.info('remote codex config.toml mcp_servers updated', {
        host: host.id,
        remotePort,
        servers: bridge.serverNames,
      });
    }

    const daemonRunning = await isDaemonRunning(host);
    if (!daemonRunning || changed) {
      await bootstrapDaemon(host, token, daemonProxyEnv);
      // 防御:bootstrap 若覆盖了 config.toml (managed_install 行为未文档化),
      // 管理段丢失时补写一次并再次 bootstrap。最多两轮,避免无限循环。
      const after = await readRemoteConfig(host);
      if (!after.includes(MANAGED_BEGIN)) {
        log.warn('managed mcp block lost after bootstrap — rewriting once', { host: host.id });
        await writeRemoteConfig(host, next);
        await bootstrapDaemon(host, token, daemonProxyEnv);
      }
      log.info('remote codex daemon (re)bootstrapped with MCP bridge env', {
        host: host.id,
        daemonWasRunning: daemonRunning,
        configChanged: changed,
      });
    }
    return { ok: true };
  } catch (err) {
    log.error('ensureRemoteCodexMcpBridge failed', {
      host: host.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: (err as Error).message };
  }
}
