import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Plugin, tool } from '@opencode-ai/plugin';
import { parse } from 'jsonc-parser';
import {
  escapeBash,
  getProjectId,
  Mutex,
  type OpencodeClient,
} from './kdco-primitives';

const DEFAULT_TOOL_NAMES = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'list',
];
const DEFAULT_CONTAINER_PREFIX = 'opencode';
const STATE_VERSION = 1;
const MAX_SESSION_CHAIN_DEPTH = 10;

/** Docker exec builder params. */
export interface DockerExecParams {
  dockerBinary: string;
  container: string;
  command: string;
  workdir?: string;
  env?: Record<string, string>;
}

interface DindConfig {
  enabled: boolean;
  toolNames: string[];
  dockerBinary: string;
  bypassPrefixes: string[];
  stateFile: string;
  logging: {
    debug: boolean;
  };
  routing: {
    scope: 'root' | 'session';
    fallbackToHost: boolean;
  };
  container: {
    name?: string;
    namePrefix: string;
    image: string;
    workdir: string;
    projectPath?: string;
    network?: string;
    env: Record<string, string>;
    mounts: string[];
    command: string[];
    autoCreate: boolean;
    autoStart: boolean;
  };
}

interface ContainerState {
  version: number;
  sessions: Record<
    string,
    {
      container: string;
      updatedAt: number;
    }
  >;
}

interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

type DindLogger = {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Normalize a string into a safe container name fragment.
 */
function sanitizeContainerFragment(value: string): string {
  const raw =
    typeof value === 'string' ? value : value == null ? '' : String(value);
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * Sanitize a container name, falling back to a safe default if empty.
 */
export function sanitizeContainerName(name: string): string {
  const sanitized = sanitizeContainerFragment(name);
  return sanitized || DEFAULT_CONTAINER_PREFIX;
}

/**
 * Format a command for logging with length guard.
 */
export function formatCommandForLog(command: string, maxLength = 160): string {
  if (typeof command !== 'string') return '';
  if (command.length <= maxLength) return command;
  return `${command.slice(0, maxLength)}...`;
}

/**
 * Build a stable container name for a project/session pair.
 */
export function buildContainerName(
  prefix: string,
  projectId: string,
  sessionId: string,
): string {
  const sanitizedPrefix = sanitizeContainerName(prefix);
  const projectShort = sanitizeContainerFragment(projectId)
    .replace(/-/g, '')
    .slice(0, 8);
  const sessionShort = sanitizeContainerFragment(sessionId)
    .split('-')
    .filter(Boolean)[0]
    ?.slice(0, 8);

  const parts = [sanitizedPrefix, projectShort, sessionShort].filter(Boolean);
  return parts.join('-');
}

/**
 * Map a host path into its container-mounted equivalent.
 */
export function mapHostPathToContainer(
  hostPath: string,
  hostRoot: string,
  containerRoot: string,
): string {
  const safeContainerRoot =
    typeof containerRoot === 'string' && containerRoot.length > 0
      ? containerRoot
      : '/';

  if (typeof hostRoot !== 'string' || hostRoot.length === 0) {
    return safeContainerRoot;
  }
  if (typeof hostPath !== 'string' || hostPath.length === 0) {
    return safeContainerRoot;
  }

  const normalizedRoot = path.resolve(hostRoot);
  const resolvedHost = path.isAbsolute(hostPath)
    ? path.resolve(hostPath)
    : path.resolve(normalizedRoot, hostPath);

  if (
    resolvedHost !== normalizedRoot &&
    !resolvedHost.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    return safeContainerRoot;
  }

  const relative = path.relative(normalizedRoot, resolvedHost);
  return path.join(safeContainerRoot, relative);
}

/**
 * Map a container path back to the host-mounted project path.
 */
export function mapContainerPathToHost(
  containerPath: string,
  hostRoot: string,
  containerRoot: string,
): string {
  const safeHostRoot =
    typeof hostRoot === 'string' && hostRoot.length > 0 ? hostRoot : '';
  const safeContainerRoot =
    typeof containerRoot === 'string' && containerRoot.length > 0
      ? containerRoot
      : '/';

  if (!safeHostRoot) return containerPath;
  if (typeof containerPath !== 'string' || containerPath.length === 0) {
    return safeHostRoot;
  }

  const normalizedRoot = path.resolve(safeContainerRoot);
  const resolvedContainer = path.isAbsolute(containerPath)
    ? path.resolve(containerPath)
    : path.resolve(normalizedRoot, containerPath);

  if (
    resolvedContainer !== normalizedRoot &&
    !resolvedContainer.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    return safeHostRoot;
  }

  const relative = path.relative(normalizedRoot, resolvedContainer);
  return path.join(safeHostRoot, relative);
}

/**
 * Build a docker exec command that runs a shell command inside a container.
 */
export function buildDockerExecCommand({
  dockerBinary,
  container,
  command,
  workdir,
  env = {},
}: DockerExecParams): string {
  const safeDockerBinary = typeof dockerBinary === 'string' ? dockerBinary : '';
  const safeContainer = typeof container === 'string' ? container : '';
  const safeCommand = typeof command === 'string' ? command : '';

  if (!safeDockerBinary || !safeContainer || !safeCommand) {
    return buildFailureCommand(
      'DIND routing failed: missing docker exec arguments',
    );
  }

  const args: string[] = [`${safeDockerBinary} exec -i`];

  if (typeof workdir === 'string' && workdir.length > 0) {
    args.push(`--workdir "${escapeBash(workdir)}"`);
  }

  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    args.push(`-e "${escapeBash(`${key}=${String(value)}`)}"`);
  }

  args.push(`"${escapeBash(safeContainer)}"`);
  args.push(`sh -lc "${escapeBash(safeCommand)}"`);

  return args.join(' ');
}

/**
 * Build a shell command for reading a file inside a container.
 */
export function buildReadCommand(filePath: string): string {
  const safePath = typeof filePath === 'string' ? filePath : '';
  return `cat -- "${escapeBash(safePath)}"`;
}

/**
 * Build a shell command for listing directory contents inside a container.
 */
export function buildListCommand(dirPath: string, limit = 200): string {
  const safePath = typeof dirPath === 'string' && dirPath.length > 0 ? dirPath : '.';
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  return `ls -A -p -1 -- "${escapeBash(safePath)}" 2>/dev/null | head -n ${safeLimit}`;
}

/**
 * Build a shell command for running ripgrep inside a container.
 */
export function buildGrepCommand(pattern: string, include?: string): string {
  const safePattern = typeof pattern === 'string' ? pattern.trim() : '';
  if (!safePattern) return '';

  const args = [
    'rg',
    '-nH',
    '--field-match-separator=|',
    '--regexp',
    `"${escapeBash(safePattern)}"`,
  ];

  if (typeof include === 'string' && include.trim().length > 0) {
    args.push('--glob', `"${escapeBash(include.trim())}"`);
  }

  return `${args.join(' ')} 2>/dev/null`;
}

/**
 * Build a shell command for globbing files inside a container.
 */
export function buildGlobCommand(pattern?: string, limit = 100): string {
  const safePattern = typeof pattern === 'string' ? pattern.trim() : '';
  const base = safePattern
    ? `rg --files -g "${escapeBash(safePattern)}"`
    : 'rg --files';
  return `${base} 2>/dev/null | head -n ${limit}`;
}

/**
 * Resolve the project root from plugin context.
 */
function resolveProjectRoot(ctx: {
  worktree?: string;
  project?: { worktree?: string };
  directory?: string;
}): string {
  return (
    ctx.worktree || ctx.project?.worktree || ctx.directory || process.cwd()
  );
}

/**
 * Resolve a host path within the project root (returns null if outside).
 */
function resolveHostPathInProject(
  projectRoot: string,
  targetPath: string,
): string | null {
  if (!projectRoot || typeof targetPath !== 'string' || targetPath.length === 0) {
    return null;
  }

  const normalizedRoot = path.resolve(projectRoot);
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(normalizedRoot, targetPath);

  if (
    resolvedTarget !== normalizedRoot &&
    !resolvedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    return null;
  }

  return resolvedTarget;
}

/**
 * Pick the first non-empty string from args for the provided keys.
 */
function pickFirstStringArg(
  args: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Load plugin config from .opencode/dind.jsonc or env defaults.
 */
async function loadConfig(
  ctx: {
    worktree?: string;
    project?: { worktree?: string };
    directory?: string;
    client: OpencodeClient;
  },
  log: ReturnType<typeof createLogger>,
): Promise<DindConfig> {
  const z = tool.schema;
  const configSchema = z.object({
    enabled: z.boolean().optional(),
    toolNames: z.array(z.string()).optional(),
    dockerBinary: z.string().optional(),
    bypassPrefixes: z.array(z.string()).optional(),
    stateFile: z.string().optional(),
    logging: z
      .object({
        debug: z.boolean().optional(),
      })
      .optional(),
    routing: z
      .object({
        scope: z.enum(['root', 'session']).optional(),
        fallbackToHost: z.boolean().optional(),
      })
      .optional(),
    container: z
      .object({
        name: z.string().optional(),
        namePrefix: z.string().optional(),
        image: z.string().optional(),
        workdir: z.string().optional(),
        projectPath: z.string().optional(),
        network: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        mounts: z.array(z.string()).optional(),
        command: z.array(z.string()).optional(),
        autoCreate: z.boolean().optional(),
        autoStart: z.boolean().optional(),
      })
      .optional(),
  });

  const projectRoot = resolveProjectRoot(ctx);
  const configPath =
    process.env.OPENCODE_DIND_CONFIG ||
    path.join(projectRoot, '.opencode', 'dind.jsonc');

  let fileConfig: unknown = {};
  try {
    const configFile = Bun.file(configPath);
    if (await configFile.exists()) {
      const raw = await configFile.text();
      const parsed = parse(raw);
      const result = configSchema.safeParse(parsed);
      if (result.success) {
        fileConfig = result.data;
      } else {
        log.warn(`[dind] Invalid config at ${configPath}; using defaults`);
      }
    }
  } catch (error) {
    log.warn(`[dind] Failed to read config: ${error}`);
  }

  const defaultStateFile = path.join(
    os.homedir(),
    '.local',
    'share',
    'opencode',
    'plugins',
    'dind',
    'state.json',
  );
  const envDebug = process.env.OPENCODE_DIND_DEBUG;
  const debugEnabled = envDebug ? envDebug !== 'false' : true;
  const envToolNames = process.env.OPENCODE_DIND_TOOL_NAMES
    ? process.env.OPENCODE_DIND_TOOL_NAMES.split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    : undefined;
  const envMounts = process.env.OPENCODE_DIND_MOUNTS
    ? process.env.OPENCODE_DIND_MOUNTS.split(',')
        .map((mount) => mount.trim())
        .filter(Boolean)
    : [];

  const defaults: DindConfig = {
    enabled: process.env.OPENCODE_DIND_ENABLED !== 'false',
    toolNames:
      envToolNames && envToolNames.length > 0
        ? envToolNames
        : DEFAULT_TOOL_NAMES,
    dockerBinary: process.env.OPENCODE_DIND_DOCKER_BIN || 'docker',
    bypassPrefixes: ['docker '],
    stateFile: defaultStateFile,
    logging: {
      debug: debugEnabled,
    },
    routing: {
      scope: process.env.OPENCODE_DIND_SCOPE === 'session' ? 'session' : 'root',
      fallbackToHost: process.env.OPENCODE_DIND_FALLBACK === 'true',
    },
    container: {
      name: process.env.OPENCODE_DIND_CONTAINER || undefined,
      namePrefix: process.env.OPENCODE_DIND_PREFIX || DEFAULT_CONTAINER_PREFIX,
      image: process.env.OPENCODE_DIND_IMAGE || 'opencode-worker:latest',
      workdir: process.env.OPENCODE_DIND_WORKDIR || '/workspace',
      projectPath: process.env.OPENCODE_DIND_PROJECT_PATH || undefined,
      network: process.env.OPENCODE_DIND_NETWORK || undefined,
      env: {},
      mounts: envMounts,
      command: ['sleep', 'infinity'],
      autoCreate: process.env.OPENCODE_DIND_AUTO_CREATE === 'true',
      autoStart: process.env.OPENCODE_DIND_AUTO_START !== 'false',
    },
  };

  return mergeConfig(defaults, fileConfig);
}

/**
 * Merge defaults with JSONC config overrides.
 */
function mergeConfig(defaults: DindConfig, overrides: unknown): DindConfig {
  if (!overrides || typeof overrides !== 'object') return defaults;
  const raw = overrides as Partial<DindConfig>;

  return {
    ...defaults,
    ...raw,
    toolNames: raw.toolNames || defaults.toolNames,
    bypassPrefixes: raw.bypassPrefixes || defaults.bypassPrefixes,
    logging: {
      ...defaults.logging,
      ...(raw.logging || {}),
    },
    routing: {
      ...defaults.routing,
      ...raw.routing,
    },
    container: {
      ...defaults.container,
      ...raw.container,
      env: {
        ...defaults.container.env,
        ...(raw.container?.env || {}),
      },
      mounts: raw.container?.mounts || defaults.container.mounts,
      command: raw.container?.command || defaults.container.command,
    },
  };
}

/**
 * Create a scoped logger for the plugin.
 */
function createLogger(debugEnabled = true): DindLogger {
  return {
    debug: (message: string) =>
      void (debugEnabled ? console.log(message) : undefined),
    info: (message: string) => void console.log(message),
    warn: (message: string) => void console.warn(message),
    error: (message: string) => void console.error(message),
  };
}

/**
 * Read persisted container routing state from disk.
 */
async function readState(stateFile: string): Promise<ContainerState> {
  try {
    const file = Bun.file(stateFile);
    if (!(await file.exists())) {
      return { version: STATE_VERSION, sessions: {} };
    }
    const raw = await file.text();
    const parsed = JSON.parse(raw) as ContainerState;
    if (parsed.version !== STATE_VERSION) {
      return { version: STATE_VERSION, sessions: {} };
    }
    return parsed;
  } catch {
    return { version: STATE_VERSION, sessions: {} };
  }
}

/**
 * Persist container routing state atomically.
 */
async function writeState(
  stateFile: string,
  state: ContainerState,
): Promise<void> {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const tempPath = `${stateFile}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2));
  await fs.rename(tempPath, stateFile);
}

/**
 * Execute a docker CLI command with captured output.
 */
async function runDocker(
  dockerBinary: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<DockerResult> {
  const proc = Bun.spawn([dockerBinary, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: options.cwd,
    env: process.env,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    ok: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

/**
 * Execute a command inside a running container.
 */
async function runDockerExec(
  config: DindConfig,
  input: {
    container: string;
    command: string;
    workdir?: string;
    env?: Record<string, string>;
  },
): Promise<DockerResult> {
  const args = ['exec', '-i'];

  if (input.workdir) {
    args.push('--workdir', input.workdir);
  }

  for (const [key, value] of Object.entries(input.env || {})) {
    if (value == null) continue;
    args.push('-e', `${key}=${value}`);
  }

  args.push(input.container, 'sh', '-lc', input.command);
  return runDocker(config.dockerBinary, args);
}

/**
 * Sync a host file into a running container.
 */
async function syncFileToContainer(
  config: DindConfig,
  input: { container: string; hostPath: string; containerPath: string },
): Promise<{ ok: boolean; error?: string }> {
  const hostExists = await fs
    .stat(input.hostPath)
    .then(() => true)
    .catch(() => false);

  if (!hostExists) {
    return {
      ok: false,
      error: `Host file ${input.hostPath} not found`,
    };
  }

  const containerDir = path.posix.dirname(input.containerPath);
  if (containerDir && containerDir !== '/') {
    const mkdirResult = await runDockerExec(config, {
      container: input.container,
      command: `mkdir -p "${escapeBash(containerDir)}"`,
    });
    if (!mkdirResult.ok) {
      return {
        ok: false,
        error:
          mkdirResult.stderr ||
          mkdirResult.stdout ||
          'Failed to create container directory',
      };
    }
  }

  const copyResult = await runDocker(config.dockerBinary, [
    'cp',
    input.hostPath,
    `${input.container}:${input.containerPath}`,
  ]);

  if (!copyResult.ok) {
    return {
      ok: false,
      error: copyResult.stderr || copyResult.stdout || 'docker cp failed',
    };
  }

  return { ok: true };
}

/**
 * Build a failure command that surfaces plugin errors in the bash tool.
 */
function buildFailureCommand(message: string): string {
  return `printf "%s\\n" "${escapeBash(message)}"; exit 1`;
}

/**
 * Resolve the root session ID so sub-sessions reuse routing.
 */
async function getRootSessionID(
  client: OpencodeClient,
  sessionID: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(sessionID);
  if (cached) return cached;

  let currentId = sessionID;
  const visited: string[] = [];

  for (let depth = 0; depth < MAX_SESSION_CHAIN_DEPTH; depth += 1) {
    visited.push(currentId);
    const session = await client.session.get({ path: { id: currentId } });
    const parentId = session.data?.parentID;
    if (!parentId) {
      for (const id of visited) {
        cache.set(id, currentId);
      }
      return currentId;
    }
    currentId = parentId;
  }

  for (const id of visited) {
    cache.set(id, currentId);
  }
  return currentId;
}

/**
 * Resolve the session scope key used for routing state.
 */
async function resolveScopeId(
  config: DindConfig,
  client: OpencodeClient,
  sessionID: string,
  cache: Map<string, string>,
): Promise<string> {
  if (config.routing.scope === 'session') return sessionID;
  return getRootSessionID(client, sessionID, cache);
}

/**
 * Check a container's running state.
 */
async function inspectContainer(
  config: DindConfig,
  name: string,
): Promise<{ exists: boolean; running: boolean }> {
  const inspect = await runDocker(config.dockerBinary, [
    'inspect',
    '-f',
    '{{.State.Running}}',
    name,
  ]);

  if (!inspect.ok) {
    return { exists: false, running: false };
  }

  return { exists: true, running: inspect.stdout === 'true' };
}

/**
 * Create a container using the configured defaults.
 */
async function createContainer(
  config: DindConfig,
  input: {
    name: string;
    image: string;
    workdir: string;
    projectPath?: string;
    network?: string;
    env?: Record<string, string>;
    mounts?: string[];
    command?: string[];
    labels?: Record<string, string>;
  },
): Promise<DockerResult> {
  const args = ['run', '-d', '--name', input.name, '--workdir', input.workdir];

  if (input.network) {
    args.push('--network', input.network);
  }

  if (input.labels) {
    for (const [key, value] of Object.entries(input.labels)) {
      args.push('--label', `${key}=${value}`);
    }
  }

  const envEntries = {
    ...config.container.env,
    ...(input.env || {}),
  };

  for (const [key, value] of Object.entries(envEntries)) {
    args.push('-e', `${key}=${value}`);
  }

  if (input.projectPath) {
    args.push('-v', `${input.projectPath}:${input.workdir}`);
  }

  for (const mount of input.mounts || []) {
    args.push('-v', mount);
  }

  args.push(input.image, ...(input.command || config.container.command));

  return runDocker(config.dockerBinary, args);
}

/**
 * Ensure the target container is available and running.
 */
async function ensureContainerRunning(
  config: DindConfig,
  input: {
    name: string;
    image: string;
    workdir: string;
    projectPath?: string;
    network?: string;
    env?: Record<string, string>;
    mounts?: string[];
    command?: string[];
    labels?: Record<string, string>;
  },
  log?: DindLogger,
  options: { allowCreate?: boolean } = {},
): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const allowCreate = options.allowCreate ?? config.container.autoCreate;
  const inspect = await inspectContainer(config, input.name);

  if (!inspect.exists) {
    if (!allowCreate) {
      return {
        ok: false,
        created: false,
        error: `Container ${input.name} does not exist`,
      };
    }

    if (input.projectPath) {
      const exists = await fs
        .stat(input.projectPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return {
          ok: false,
          created: false,
          error: `Project path ${input.projectPath} does not exist`,
        };
      }
    }

    const created = await createContainer(config, input);
    if (!created.ok) {
      return {
        ok: false,
        created: false,
        error: created.stderr || created.stdout || 'Container create failed',
      };
    }

    log?.info(
      `[dind] Container created: ${input.name} (image=${input.image}, workdir=${input.workdir}, projectPath=${input.projectPath ?? 'n/a'})`,
    );

    return { ok: true, created: true };
  }

  if (!inspect.running && config.container.autoStart) {
    const started = await runDocker(config.dockerBinary, ['start', input.name]);
    if (!started.ok) {
      return {
        ok: false,
        created: false,
        error: started.stderr || started.stdout || 'Container start failed',
      };
    }

    log?.info(`[dind] Container started: ${input.name}`);
  }

  return { ok: true, created: false };
}

/**
 * Load the active container mapping for a session scope.
 */
async function getMappedContainer(
  stateFile: string,
  mutex: Mutex,
  scopeId: string,
): Promise<string | null> {
  return mutex.runExclusive(async () => {
    const state = await readState(stateFile);
    return state.sessions[scopeId]?.container || null;
  });
}

/**
 * Persist a container mapping for a session scope.
 */
async function setMappedContainer(
  stateFile: string,
  mutex: Mutex,
  scopeId: string,
  container: string,
): Promise<void> {
  await mutex.runExclusive(async () => {
    const state = await readState(stateFile);
    state.sessions[scopeId] = { container, updatedAt: Date.now() };
    await writeState(stateFile, state);
  });
}

/**
 * Remove a container mapping for a session scope.
 */
async function clearMappedContainer(
  stateFile: string,
  mutex: Mutex,
  scopeId: string,
): Promise<string | null> {
  return mutex.runExclusive(async () => {
    const state = await readState(stateFile);
    const existing = state.sessions[scopeId]?.container || null;
    if (existing) {
      delete state.sessions[scopeId];
      await writeState(stateFile, state);
    }
    return existing;
  });
}

/**
 * Determine whether a command should be routed into a container.
 */
function shouldInterceptCommand(command: string, config: DindConfig): boolean {
  const trimmed = command.trim();
  return !config.bypassPrefixes.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Build label metadata for managed containers.
 */
function buildContainerLabels(
  projectId: string,
  scopeId: string,
): Record<string, string> {
  return {
    'opencode.project': projectId,
    'opencode.scope': scopeId,
  };
}

/**
 * Resolve the host project path used for container mounts.
 */
function resolveProjectPath(config: DindConfig, projectRoot: string): string {
  return config.container.projectPath || projectRoot;
}

/**
 * Normalize a record of env vars into string values.
 */
function normalizeEnvRecord(
  env?: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!env) return undefined;

  const entries = Object.entries(env)
    .filter(([, value]) => value != null)
    .map(([key, value]) => [key, String(value)] as const);

  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

/**
 * Create a container management tool.
 */
function createContainerCreateTool(
  config: DindConfig,
  context: {
    client: OpencodeClient;
    projectId: string;
    projectRoot: string;
    scopeCache: Map<string, string>;
    stateMutex: Mutex;
    log: DindLogger;
  },
) {
  return tool({
    description:
      'Create a Docker container for this session and mount the project directory.',
    args: {
      name: tool.schema.string().optional(),
      image: tool.schema.string().optional(),
      workdir: tool.schema.string().optional(),
      projectPath: tool.schema.string().optional(),
      network: tool.schema.string().optional(),
      mounts: tool.schema.array(tool.schema.string()).optional(),
      command: tool.schema.array(tool.schema.string()).optional(),
      env: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .optional(),
    },
    execute: async (args, toolCtx) => {
      const sessionId = toolCtx.sessionID;
      const scopeId = sessionId
        ? await resolveScopeId(
            config,
            context.client,
            sessionId,
            context.scopeCache,
          )
        : undefined;
      const name =
        args.name ||
        (scopeId
          ? buildContainerName(
              config.container.namePrefix,
              context.projectId,
              scopeId,
            )
          : undefined);

      if (!name) {
        return 'Container name is required when no session is available.';
      }

      const projectPath =
        args.projectPath || resolveProjectPath(config, context.projectRoot);
      const envOverrides = normalizeEnvRecord(
        args.env as Record<string, unknown> | undefined,
      );

      const ensure = await ensureContainerRunning(
        config,
        {
          name,
          image: args.image || config.container.image,
          workdir: args.workdir || config.container.workdir,
          projectPath,
          network: args.network || config.container.network,
          env: envOverrides,
          mounts: args.mounts || config.container.mounts,
          command: args.command || config.container.command,
          labels: scopeId
            ? buildContainerLabels(context.projectId, scopeId)
            : undefined,
        },
        context.log,
        { allowCreate: true },
      );

      if (!ensure.ok) {
        return `Failed to create container: ${ensure.error}`;
      }

      if (scopeId) {
        await setMappedContainer(
          config.stateFile,
          context.stateMutex,
          scopeId,
          name,
        );
        context.log.info(
          `[dind] Session scope ${scopeId} mapped to container ${name}`,
        );
      }

      return ensure.created
        ? `Container ${name} created and ready.`
        : `Container ${name} already exists and is running.`;
    },
  });
}

/**
 * Create a tool to route the current session to an existing container.
 */
function createContainerUseTool(
  config: DindConfig,
  context: {
    client: OpencodeClient;
    scopeCache: Map<string, string>;
    stateMutex: Mutex;
    log: DindLogger;
  },
) {
  return tool({
    description:
      'Route the current session to an existing Docker container by name.',
    args: {
      name: tool.schema.string(),
    },
    execute: async (args, toolCtx) => {
      const sessionId = toolCtx.sessionID;
      if (!sessionId) {
        return 'Session ID is required to set container routing.';
      }

      const scopeId = await resolveScopeId(
        config,
        context.client,
        sessionId,
        context.scopeCache,
      );

      const inspect = await inspectContainer(config, args.name);
      if (!inspect.exists) {
        return `Container ${args.name} does not exist.`;
      }

      await setMappedContainer(
        config.stateFile,
        context.stateMutex,
        scopeId,
        args.name,
      );
      context.log.info(
        `[dind] Session scope ${scopeId} mapped to container ${args.name}`,
      );
      return `Session routed to container ${args.name}.`;
    },
  });
}

/**
 * Create a tool to clear container routing for the current session.
 */
function createContainerClearTool(
  config: DindConfig,
  context: {
    client: OpencodeClient;
    scopeCache: Map<string, string>;
    stateMutex: Mutex;
    log: DindLogger;
  },
) {
  return tool({
    description: 'Clear container routing for the current session.',
    args: {
      stop: tool.schema.boolean().optional(),
      remove: tool.schema.boolean().optional(),
    },
    execute: async (args, toolCtx) => {
      const sessionId = toolCtx.sessionID;
      if (!sessionId) {
        return 'Session ID is required to clear container routing.';
      }

      const scopeId = await resolveScopeId(
        config,
        context.client,
        sessionId,
        context.scopeCache,
      );
      const container = await clearMappedContainer(
        config.stateFile,
        context.stateMutex,
        scopeId,
      );

      if (!container) {
        return 'No container routing configured for this session.';
      }

      if (args.remove) {
        await runDocker(config.dockerBinary, ['rm', '-f', container]);
        context.log.info(`[dind] Removed container ${container}`);
        return `Routing cleared and container ${container} removed.`;
      }

      if (args.stop) {
        await runDocker(config.dockerBinary, ['stop', container]);
        context.log.info(`[dind] Stopped container ${container}`);
        return `Routing cleared and container ${container} stopped.`;
      }

      context.log.info(
        `[dind] Routing cleared for session scope ${scopeId} (container ${container})`,
      );
      return `Routing cleared for container ${container}.`;
    },
  });
}

/**
 * Create a tool to show routing info for the current session.
 */
function createContainerInfoTool(
  config: DindConfig,
  context: {
    client: OpencodeClient;
    scopeCache: Map<string, string>;
    stateMutex: Mutex;
  },
) {
  return tool({
    description: 'Show the container routing for the current session.',
    args: {},
    execute: async (_args, toolCtx) => {
      const sessionId = toolCtx.sessionID;
      if (!sessionId) {
        return 'Session ID is required to read routing state.';
      }

      const scopeId = await resolveScopeId(
        config,
        context.client,
        sessionId,
        context.scopeCache,
      );
      const container = await getMappedContainer(
        config.stateFile,
        context.stateMutex,
        scopeId,
      );

      if (!container) {
        return 'No container routing configured for this session.';
      }

      const inspect = await inspectContainer(config, container);
      const status = inspect.exists
        ? inspect.running
          ? 'running'
          : 'stopped'
        : 'missing';

      return `Container routing: ${container} (${status}).`;
    },
  });
}

/**
 * Create a tool to list managed containers for the project.
 */
function createContainerListTool(
  config: DindConfig,
  context: { projectId: string },
) {
  return tool({
    description: 'List Docker containers created for this project.',
    args: {
      all: tool.schema.boolean().optional(),
    },
    execute: async (args) => {
      const listArgs = ['ps'];
      if (args.all) listArgs.push('-a');
      listArgs.push('--format', '{{.Names}}\t{{.Status}}');
      listArgs.push('--filter', `label=opencode.project=${context.projectId}`);

      const result = await runDocker(config.dockerBinary, listArgs);
      if (!result.ok) {
        return `Failed to list containers: ${result.stderr || result.stdout}`;
      }

      const output = result.stdout.trim();
      if (!output) return 'No containers found.';
      return output;
    },
  });
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

export const DindRouterPlugin: Plugin = async (ctx) => {
  const envDebug = process.env.OPENCODE_DIND_DEBUG;
  const debugEnabled = envDebug ? envDebug !== 'false' : true;
  let log = createLogger(debugEnabled);
  const config = await loadConfig(ctx, log);
  log = createLogger(config.logging.debug);
  const projectRoot = resolveProjectRoot(ctx);
  const projectId = await getProjectId(
    projectRoot,
    ctx.client as OpencodeClient,
  );
  const scopeCache = new Map<string, string>();
  const stateMutex = new Mutex();
  const readRequests = new Map<
    string,
    { container: string; containerPath: string; hostPath: string }
  >();
  const globRequests = new Map<
    string,
    {
      container: string;
      hostRoot: string;
      containerRoot: string;
      pattern: string;
    }
  >();
  const listRequests = new Map<
    string,
    { container: string; hostPath: string; containerPath: string }
  >();
  const grepRequests = new Map<
    string,
    {
      container: string;
      hostRoot: string;
      containerRoot: string;
      pattern: string;
      include?: string;
    }
  >();
  const writeRequests = new Map<
    string,
    { container: string; hostPath: string; containerPath: string }
  >();
  const editRequests = new Map<
    string,
    { container: string; hostPath: string; containerPath: string }
  >();

  return {
    tool: {
      dind_container_create: createContainerCreateTool(config, {
        client: ctx.client as OpencodeClient,
        projectId,
        projectRoot,
        scopeCache,
        stateMutex,
        log,
      }),
      dind_container_use: createContainerUseTool(config, {
        client: ctx.client as OpencodeClient,
        scopeCache,
        stateMutex,
        log,
      }),
      dind_container_clear: createContainerClearTool(config, {
        client: ctx.client as OpencodeClient,
        scopeCache,
        stateMutex,
        log,
      }),
      dind_container_info: createContainerInfoTool(config, {
        client: ctx.client as OpencodeClient,
        scopeCache,
        stateMutex,
      }),
      dind_container_list: createContainerListTool(config, { projectId }),
    },

    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID?: string },
      output: {
        args?: {
          [key: string]: unknown;
          command?: string;
          cwd?: string;
          env?: Record<string, string>;
          filePath?: string;
          pattern?: string;
          path?: string;
          include?: string;
          content?: string;
          text?: string;
          dir?: string;
          directory?: string;
        };
      },
    ) => {
      if (!config.enabled) {
        log.debug('[dind] Skip: plugin disabled');
        return;
      }

      if (!config.toolNames.includes(input.tool)) {
        log.debug(`[dind] Skip: tool not routed (${input.tool})`);
        return;
      }

      if (input.tool === 'read') {
        const filePath =
          typeof output.args?.filePath === 'string' ? output.args.filePath : '';
        if (!filePath) {
          log.debug('[dind] Skip read: missing filePath');
          return;
        }
        if (!input.callID) {
          log.debug('[dind] Skip read: missing callID');
          return;
        }

        const sessionId = input.sessionID;
        if (!sessionId) {
          log.debug('[dind] Skip read: missing sessionID');
          return;
        }

        const scopeId = await resolveScopeId(
          config,
          ctx.client as OpencodeClient,
          sessionId,
          scopeCache,
        );

        let containerName = config.container.name;
        if (!containerName) {
          containerName =
            (await getMappedContainer(config.stateFile, stateMutex, scopeId)) ||
            undefined;
        }

        if (!containerName && config.container.autoCreate) {
          containerName = buildContainerName(
            config.container.namePrefix,
            projectId,
            scopeId,
          );
        }

        if (!containerName) {
          log.debug(`[dind] Skip read: no container for scope ${scopeId}`);
          return;
        }

        const projectPath = resolveProjectPath(config, projectRoot);
        const ensure = await ensureContainerRunning(
          config,
          {
            name: containerName,
            image: config.container.image,
            workdir: config.container.workdir,
            projectPath,
            network: config.container.network,
            mounts: config.container.mounts,
            labels: buildContainerLabels(projectId, scopeId),
          },
          log,
        );

        if (!ensure.ok) {
          log.warn(
            `[dind] Read: container unavailable ${containerName}: ${ensure.error}`,
          );
          if (config.routing.fallbackToHost) return;
          return;
        }

        if (config.container.autoCreate) {
          await setMappedContainer(
            config.stateFile,
            stateMutex,
            scopeId,
            containerName,
          );
          log.info(
            `[dind] Session scope ${scopeId} mapped to container ${containerName}`,
          );
        }

        const mappedPath = mapHostPathToContainer(
          filePath,
          projectRoot,
          config.container.workdir,
        );
        readRequests.set(input.callID, {
          container: containerName,
          containerPath: mappedPath,
          hostPath: filePath,
        });
        log.info(
          `[dind] Routed read to ${containerName} (host=${filePath}, container=${mappedPath})`,
        );
        return;
      }

      if (input.tool === 'write') {
        const filePath = pickFirstStringArg(output.args, [
          'filePath',
          'path',
        ]);
        if (!filePath) {
          log.debug('[dind] Skip write: missing filePath');
          return;
        }
        if (!input.callID) {
          log.debug('[dind] Skip write: missing callID');
          return;
        }

        const sessionId = input.sessionID;
        if (!sessionId) {
          log.debug('[dind] Skip write: missing sessionID');
          return;
        }

        const hostPath = resolveHostPathInProject(projectRoot, filePath);
        if (!hostPath) {
          log.debug(`[dind] Skip write: path outside project (${filePath})`);
          return;
        }

        const scopeId = await resolveScopeId(
          config,
          ctx.client as OpencodeClient,
          sessionId,
          scopeCache,
        );

        let containerName = config.container.name;
        if (!containerName) {
          containerName =
            (await getMappedContainer(config.stateFile, stateMutex, scopeId)) ||
            undefined;
        }

        if (!containerName && config.container.autoCreate) {
          containerName = buildContainerName(
            config.container.namePrefix,
            projectId,
            scopeId,
          );
        }

        if (!containerName) {
          log.debug(`[dind] Skip write: no container for scope ${scopeId}`);
          return;
        }

        const projectPath = resolveProjectPath(config, projectRoot);
        const ensure = await ensureContainerRunning(
          config,
          {
            name: containerName,
            image: config.container.image,
            workdir: config.container.workdir,
            projectPath,
            network: config.container.network,
            mounts: config.container.mounts,
            labels: buildContainerLabels(projectId, scopeId),
          },
          log,
        );

        if (!ensure.ok) {
          log.warn(
            `[dind] Write: container unavailable ${containerName}: ${ensure.error}`,
          );
          if (config.routing.fallbackToHost) return;
          return;
        }

        if (config.container.autoCreate) {
          await setMappedContainer(
            config.stateFile,
            stateMutex,
            scopeId,
            containerName,
          );
          log.info(
            `[dind] Session scope ${scopeId} mapped to container ${containerName}`,
          );
        }

        const containerPath = mapHostPathToContainer(
          hostPath,
          projectRoot,
          config.container.workdir,
        );
        writeRequests.set(input.callID, {
          container: containerName,
          hostPath,
          containerPath,
        });
        log.info(
          `[dind] Routed write to ${containerName} (host=${hostPath}, container=${containerPath})`,
        );
        return;
      }

      if (input.tool === 'edit') {
        const filePath = pickFirstStringArg(output.args, [
          'filePath',
          'path',
        ]);
        if (!filePath) {
          log.debug('[dind] Skip edit: missing filePath');
          return;
        }
        if (!input.callID) {
          log.debug('[dind] Skip edit: missing callID');
          return;
        }

        const sessionId = input.sessionID;
        if (!sessionId) {
          log.debug('[dind] Skip edit: missing sessionID');
          return;
        }

        const hostPath = resolveHostPathInProject(projectRoot, filePath);
        if (!hostPath) {
          log.debug(`[dind] Skip edit: path outside project (${filePath})`);
          return;
        }

        const scopeId = await resolveScopeId(
          config,
          ctx.client as OpencodeClient,
          sessionId,
          scopeCache,
        );

        let containerName = config.container.name;
        if (!containerName) {
          containerName =
            (await getMappedContainer(config.stateFile, stateMutex, scopeId)) ||
            undefined;
        }

        if (!containerName && config.container.autoCreate) {
          containerName = buildContainerName(
            config.container.namePrefix,
            projectId,
            scopeId,
          );
        }

        if (!containerName) {
          log.debug(`[dind] Skip edit: no container for scope ${scopeId}`);
          return;
        }

        const projectPath = resolveProjectPath(config, projectRoot);
        const ensure = await ensureContainerRunning(
          config,
          {
            name: containerName,
            image: config.container.image,
            workdir: config.container.workdir,
            projectPath,
            network: config.container.network,
            mounts: config.container.mounts,
            labels: buildContainerLabels(projectId, scopeId),
          },
          log,
        );

        if (!ensure.ok) {
          log.warn(
            `[dind] Edit: container unavailable ${containerName}: ${ensure.error}`,
          );
          if (config.routing.fallbackToHost) return;
          return;
        }

        if (config.container.autoCreate) {
          await setMappedContainer(
            config.stateFile,
            stateMutex,
            scopeId,
            containerName,
          );
          log.info(
            `[dind] Session scope ${scopeId} mapped to container ${containerName}`,
          );
        }

        const containerPath = mapHostPathToContainer(
          hostPath,
          projectRoot,
          config.container.workdir,
        );
        editRequests.set(input.callID, {
          container: containerName,
          hostPath,
          containerPath,
        });
        log.info(
          `[dind] Routed edit to ${containerName} (host=${hostPath}, container=${containerPath})`,
        );
        return;
      }

      if (input.tool === 'glob') {
        const pattern =
          typeof output.args?.pattern === 'string' ? output.args.pattern : '';
        if (!pattern) {
          log.debug('[dind] Skip glob: missing pattern');
          return;
        }
        if (!input.callID) {
          log.debug('[dind] Skip glob: missing callID');
          return;
        }

        const sessionId = input.sessionID;
        if (!sessionId) {
          log.debug('[dind] Skip glob: missing sessionID');
          return;
        }

        const scopeId = await resolveScopeId(
          config,
          ctx.client as OpencodeClient,
          sessionId,
          scopeCache,
        );

        let containerName = config.container.name;
        if (!containerName) {
          containerName =
            (await getMappedContainer(config.stateFile, stateMutex, scopeId)) ||
            undefined;
        }

        if (!containerName && config.container.autoCreate) {
          containerName = buildContainerName(
            config.container.namePrefix,
            projectId,
            scopeId,
          );
        }

        if (!containerName) {
          log.debug(`[dind] Skip glob: no container for scope ${scopeId}`);
          return;
        }

        const projectPath = resolveProjectPath(config, projectRoot);
        const ensure = await ensureContainerRunning(
          config,
          {
            name: containerName,
            image: config.container.image,
            workdir: config.container.workdir,
            projectPath,
            network: config.container.network,
            mounts: config.container.mounts,
            labels: buildContainerLabels(projectId, scopeId),
          },
          log,
        );

        if (!ensure.ok) {
          log.warn(
            `[dind] Glob: container unavailable ${containerName}: ${ensure.error}`,
          );
          if (config.routing.fallbackToHost) return;
          return;
        }

        if (config.container.autoCreate) {
          await setMappedContainer(
            config.stateFile,
            stateMutex,
            scopeId,
            containerName,
          );
          log.info(
            `[dind] Session scope ${scopeId} mapped to container ${containerName}`,
          );
        }

        const hostRoot =
          typeof output.args?.path === 'string' && output.args.path.length > 0
            ? output.args.path
            : projectRoot;
        const containerRoot = mapHostPathToContainer(
          hostRoot,
          projectRoot,
          config.container.workdir,
        );

        globRequests.set(input.callID, {
          container: containerName,
          hostRoot,
          containerRoot,
          pattern,
        });
        log.info(
          `[dind] Routed glob to ${containerName} (host=${hostRoot}, container=${containerRoot}, pattern=${pattern})`,
        );
        return;
      }

      if (input.tool === 'list') {
        const listPath =
          pickFirstStringArg(output.args, ['path', 'dir', 'directory']) ||
          projectRoot;
        if (!input.callID) {
          log.debug('[dind] Skip list: missing callID');
          return;
        }

        const sessionId = input.sessionID;
        if (!sessionId) {
          log.debug('[dind] Skip list: missing sessionID');
          return;
        }

        const hostPath = resolveHostPathInProject(projectRoot, listPath);
        if (!hostPath) {
          log.debug(`[dind] Skip list: path outside project (${listPath})`);
          return;
        }

        const scopeId = await resolveScopeId(
          config,
          ctx.client as OpencodeClient,
          sessionId,
          scopeCache,
        );

        let containerName = config.container.name;
        if (!containerName) {
          containerName =
            (await getMappedContainer(config.stateFile, stateMutex, scopeId)) ||
            undefined;
        }

        if (!containerName && config.container.autoCreate) {
          containerName = buildContainerName(
            config.container.namePrefix,
            projectId,
            scopeId,
          );
        }

        if (!containerName) {
          log.debug(`[dind] Skip list: no container for scope ${scopeId}`);
          return;
        }

        const projectPath = resolveProjectPath(config, projectRoot);
        const ensure = await ensureContainerRunning(
          config,
          {
            name: containerName,
            image: config.container.image,
            workdir: config.container.workdir,
            projectPath,
            network: config.container.network,
            mounts: config.container.mounts,
            labels: buildContainerLabels(projectId, scopeId),
          },
          log,
        );

        if (!ensure.ok) {
          log.warn(
            `[dind] List: container unavailable ${containerName}: ${ensure.error}`,
          );
          if (config.routing.fallbackToHost) return;
          return;
        }

        if (config.container.autoCreate) {
          await setMappedContainer(
            config.stateFile,
            stateMutex,
            scopeId,
            containerName,
          );
          log.info(
            `[dind] Session scope ${scopeId} mapped to container ${containerName}`,
          );
        }

        const containerPath = mapHostPathToContainer(
          hostPath,
          projectRoot,
          config.container.workdir,
        );
        listRequests.set(input.callID, {
          container: containerName,
          hostPath,
          containerPath,
        });
        log.info(
          `[dind] Routed list to ${containerName} (host=${hostPath}, container=${containerPath})`,
        );
        return;
      }

      if (input.tool === 'grep') {
        const pattern = pickFirstStringArg(output.args, ['pattern']);
        if (!pattern) {
          log.debug('[dind] Skip grep: missing pattern');
          return;
        }
        if (!input.callID) {
          log.debug('[dind] Skip grep: missing callID');
          return;
        }

        const sessionId = input.sessionID;
        if (!sessionId) {
          log.debug('[dind] Skip grep: missing sessionID');
          return;
        }

        const searchPath =
          pickFirstStringArg(output.args, ['path', 'dir', 'directory']) ||
          projectRoot;
        const hostRoot = resolveHostPathInProject(projectRoot, searchPath);
        if (!hostRoot) {
          log.debug(`[dind] Skip grep: path outside project (${searchPath})`);
          return;
        }

        const scopeId = await resolveScopeId(
          config,
          ctx.client as OpencodeClient,
          sessionId,
          scopeCache,
        );

        let containerName = config.container.name;
        if (!containerName) {
          containerName =
            (await getMappedContainer(config.stateFile, stateMutex, scopeId)) ||
            undefined;
        }

        if (!containerName && config.container.autoCreate) {
          containerName = buildContainerName(
            config.container.namePrefix,
            projectId,
            scopeId,
          );
        }

        if (!containerName) {
          log.debug(`[dind] Skip grep: no container for scope ${scopeId}`);
          return;
        }

        const projectPath = resolveProjectPath(config, projectRoot);
        const ensure = await ensureContainerRunning(
          config,
          {
            name: containerName,
            image: config.container.image,
            workdir: config.container.workdir,
            projectPath,
            network: config.container.network,
            mounts: config.container.mounts,
            labels: buildContainerLabels(projectId, scopeId),
          },
          log,
        );

        if (!ensure.ok) {
          log.warn(
            `[dind] Grep: container unavailable ${containerName}: ${ensure.error}`,
          );
          if (config.routing.fallbackToHost) return;
          return;
        }

        if (config.container.autoCreate) {
          await setMappedContainer(
            config.stateFile,
            stateMutex,
            scopeId,
            containerName,
          );
          log.info(
            `[dind] Session scope ${scopeId} mapped to container ${containerName}`,
          );
        }

        const containerRoot = mapHostPathToContainer(
          hostRoot,
          projectRoot,
          config.container.workdir,
        );
        const include = pickFirstStringArg(output.args, ['include', 'glob']);

        grepRequests.set(input.callID, {
          container: containerName,
          hostRoot,
          containerRoot,
          pattern,
          include,
        });
        log.info(
          `[dind] Routed grep to ${containerName} (host=${hostRoot}, container=${containerRoot}, pattern=${pattern})`,
        );
        return;
      }

      if (!output.args?.command) {
        log.debug(`[dind] Skip: no command for tool ${input.tool}`);
        return;
      }
      if (!shouldInterceptCommand(output.args.command, config)) {
        log.debug(
          `[dind] Skip: command bypassed (${formatCommandForLog(output.args.command)})`,
        );
        return;
      }

      const sessionId = input.sessionID;
      if (!sessionId) {
        log.debug('[dind] Skip: missing sessionID');
        return;
      }

      const scopeId = await resolveScopeId(
        config,
        ctx.client as OpencodeClient,
        sessionId,
        scopeCache,
      );

      let containerName = config.container.name;
      if (!containerName) {
        containerName =
          (await getMappedContainer(config.stateFile, stateMutex, scopeId)) ||
          undefined;
      }

      if (!containerName && config.container.autoCreate) {
        containerName = buildContainerName(
          config.container.namePrefix,
          projectId,
          scopeId,
        );
      }

      if (!containerName) {
        log.debug(`[dind] Skip: no container for scope ${scopeId}`);
        return;
      }

      const projectPath = resolveProjectPath(config, projectRoot);
      const ensure = await ensureContainerRunning(
        config,
        {
          name: containerName,
          image: config.container.image,
          workdir: config.container.workdir,
          projectPath,
          network: config.container.network,
          mounts: config.container.mounts,
          labels: buildContainerLabels(projectId, scopeId),
        },
        log,
      );

      if (!ensure.ok) {
        log.warn(
          `[dind] Command: container unavailable ${containerName}: ${ensure.error}`,
        );
        if (config.routing.fallbackToHost) return;
        output.args.command = buildFailureCommand(
          ensure.error || `Container ${containerName} is unavailable`,
        );
        return;
      }

      if (config.container.autoCreate) {
        await setMappedContainer(
          config.stateFile,
          stateMutex,
          scopeId,
          containerName,
        );
        log.info(
          `[dind] Session scope ${scopeId} mapped to container ${containerName}`,
        );
      }

      const originalCommand = output.args.command;
      const hostCwd =
        typeof output.args.cwd === 'string' && output.args.cwd.length > 0
          ? output.args.cwd
          : projectRoot;
      const mappedWorkdir = mapHostPathToContainer(
        hostCwd,
        projectRoot,
        config.container.workdir,
      );
      const envOverrides =
        output.args.env && typeof output.args.env === 'object'
          ? output.args.env
          : undefined;

      log.info(
        `[dind] Routed command to ${containerName} (worktree=${hostCwd}, workdir=${mappedWorkdir}): ${formatCommandForLog(originalCommand)}`,
      );

      output.args.command = buildDockerExecCommand({
        dockerBinary: config.dockerBinary,
        container: containerName,
        command: originalCommand,
        workdir: mappedWorkdir,
        env: {
          ...config.container.env,
          ...(envOverrides || {}),
        },
      });
    },

    'tool.execute.after': async (
      input: { tool: string; callID: string },
      output: { title: string; output: string; metadata: unknown },
    ) => {
      if (input.tool === 'read') {
        const request = readRequests.get(input.callID);
        if (!request) {
          log.debug(
            `[dind] Read after: no pending request for callID ${input.callID}`,
          );
          return;
        }

        readRequests.delete(input.callID);

        const result = await runDockerExec(config, {
          container: request.container,
          command: buildReadCommand(request.containerPath),
        });

        if (!result.ok) {
          log.warn(
            `[dind] Read failed in ${request.container} (host=${request.hostPath}, container=${request.containerPath}): ${result.stderr || result.stdout}`,
          );
          return;
        }

        output.output = result.stdout;
        return;
      }

      if (input.tool === 'write') {
        const request = writeRequests.get(input.callID);
        if (!request) {
          log.debug(
            `[dind] Write after: no pending request for callID ${input.callID}`,
          );
          return;
        }

        writeRequests.delete(input.callID);

        const sync = await syncFileToContainer(config, request);
        if (!sync.ok) {
          log.warn(
            `[dind] Write sync failed in ${request.container} (host=${request.hostPath}, container=${request.containerPath}): ${sync.error}`,
          );
          return;
        }

        log.info(
          `[dind] Synced write to ${request.container} (host=${request.hostPath}, container=${request.containerPath})`,
        );
        return;
      }

      if (input.tool === 'edit') {
        const request = editRequests.get(input.callID);
        if (!request) {
          log.debug(
            `[dind] Edit after: no pending request for callID ${input.callID}`,
          );
          return;
        }

        editRequests.delete(input.callID);

        const sync = await syncFileToContainer(config, request);
        if (!sync.ok) {
          log.warn(
            `[dind] Edit sync failed in ${request.container} (host=${request.hostPath}, container=${request.containerPath}): ${sync.error}`,
          );
          return;
        }

        log.info(
          `[dind] Synced edit to ${request.container} (host=${request.hostPath}, container=${request.containerPath})`,
        );
        return;
      }

      if (input.tool === 'list') {
        const request = listRequests.get(input.callID);
        if (!request) {
          log.debug(
            `[dind] List after: no pending request for callID ${input.callID}`,
          );
          return;
        }

        listRequests.delete(input.callID);

        const result = await runDockerExec(config, {
          container: request.container,
          command: buildListCommand(request.containerPath),
        });

        if (!result.ok) {
          log.warn(
            `[dind] List failed in ${request.container} (host=${request.hostPath}, container=${request.containerPath}): ${result.stderr || result.stdout}`,
          );
          return;
        }

        output.output = result.stdout;
        return;
      }

      if (input.tool === 'grep') {
        const request = grepRequests.get(input.callID);
        if (!request) {
          log.debug(
            `[dind] Grep after: no pending request for callID ${input.callID}`,
          );
          return;
        }

        grepRequests.delete(input.callID);

        const command = buildGrepCommand(request.pattern, request.include);
        if (!command) {
          log.debug('[dind] Grep after: missing command');
          return;
        }

        const result = await runDockerExec(config, {
          container: request.container,
          command,
          workdir: request.containerRoot,
        });

        if (!result.ok && result.exitCode !== 1) {
          log.warn(
            `[dind] Grep failed in ${request.container} (root=${request.containerRoot}, pattern=${request.pattern}): ${result.stderr || result.stdout}`,
          );
          return;
        }

        if (result.exitCode === 1 || !result.stdout) {
          output.output = '';
          return;
        }

        const mappedLines = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [filePath, lineNum, ...rest] = line.split('|');
            if (!filePath || !lineNum) return line;
            const mappedPath = path.isAbsolute(filePath)
              ? mapContainerPathToHost(
                  filePath,
                  request.hostRoot,
                  request.containerRoot,
                )
              : path.join(request.hostRoot, filePath);
            const tail = rest.join('|');
            return [mappedPath, lineNum, tail].filter(Boolean).join('|');
          });

        output.output = mappedLines.join('\n');
        return;
      }

      if (input.tool === 'glob') {
        const request = globRequests.get(input.callID);
        if (!request) {
          log.debug(
            `[dind] Glob after: no pending request for callID ${input.callID}`,
          );
          return;
        }

        globRequests.delete(input.callID);

        const result = await runDockerExec(config, {
          container: request.container,
          command: buildGlobCommand(request.pattern),
          workdir: request.containerRoot,
        });

        if (!result.ok) {
          log.warn(
            `[dind] Glob failed in ${request.container} (root=${request.containerRoot}, pattern=${request.pattern}): ${result.stderr || result.stdout}`,
          );
          return;
        }

        const lines = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 100);

        const mapped = lines.map((line) =>
          path.isAbsolute(line)
            ? mapContainerPathToHost(
                line,
                request.hostRoot,
                request.containerRoot,
              )
            : path.join(request.hostRoot, line),
        );

        output.output = mapped.join('\n');
      }
    },
  };
};

export default DindRouterPlugin;
