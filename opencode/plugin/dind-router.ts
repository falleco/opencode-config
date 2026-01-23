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

const DEFAULT_TOOL_NAMES = ['bash'];
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
    routing: {
      scope: process.env.OPENCODE_DIND_SCOPE === 'session' ? 'session' : 'root',
      fallbackToHost: process.env.OPENCODE_DIND_FALLBACK === 'true',
    },
    container: {
      name: process.env.OPENCODE_DIND_CONTAINER || undefined,
      namePrefix: process.env.OPENCODE_DIND_PREFIX || DEFAULT_CONTAINER_PREFIX,
      image: process.env.OPENCODE_DIND_IMAGE || 'ubuntu:22.04',
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
function createLogger(client: OpencodeClient) {
  return {
    debug: (message: string) =>
      client.app.log({
        body: { service: 'dind', level: 'debug', message },
      }),
    info: (message: string) =>
      client.app.log({ body: { service: 'dind', level: 'info', message } }),
    warn: (message: string) =>
      client.app.log({ body: { service: 'dind', level: 'warn', message } }),
    error: (message: string) =>
      client.app.log({ body: { service: 'dind', level: 'error', message } }),
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
        return `Routing cleared and container ${container} removed.`;
      }

      if (args.stop) {
        await runDocker(config.dockerBinary, ['stop', container]);
        return `Routing cleared and container ${container} stopped.`;
      }

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
  const log = createLogger(ctx.client as OpencodeClient);
  const config = await loadConfig(ctx, log);
  const projectRoot = resolveProjectRoot(ctx);
  const projectId = await getProjectId(
    projectRoot,
    ctx.client as OpencodeClient,
  );
  const scopeCache = new Map<string, string>();
  const stateMutex = new Mutex();

  return {
    tool: {
      dind_container_create: createContainerCreateTool(config, {
        client: ctx.client as OpencodeClient,
        projectId,
        projectRoot,
        scopeCache,
        stateMutex,
      }),
      dind_container_use: createContainerUseTool(config, {
        client: ctx.client as OpencodeClient,
        scopeCache,
        stateMutex,
      }),
      dind_container_clear: createContainerClearTool(config, {
        client: ctx.client as OpencodeClient,
        scopeCache,
        stateMutex,
      }),
      dind_container_info: createContainerInfoTool(config, {
        client: ctx.client as OpencodeClient,
        scopeCache,
        stateMutex,
      }),
      dind_container_list: createContainerListTool(config, { projectId }),
    },

    'tool.execute.before': async (
      input: { tool: string; sessionID: string },
      output: {
        args?: { command?: string; cwd?: string; env?: Record<string, string> };
      },
    ) => {
      if (!config.enabled) return;
      if (!config.toolNames.includes(input.tool)) return;
      if (!output.args?.command) return;
      if (!shouldInterceptCommand(output.args.command, config)) return;

      console.log('Command Intercepted', output.args.command);

      const sessionId = input.sessionID;
      if (!sessionId) return;

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

      console.log('DND Container Name', containerName);
      if (!containerName) return;

      const projectPath = resolveProjectPath(config, projectRoot);
      const ensure = await ensureContainerRunning(config, {
        name: containerName,
        image: config.container.image,
        workdir: config.container.workdir,
        projectPath,
        network: config.container.network,
        mounts: config.container.mounts,
        labels: buildContainerLabels(projectId, scopeId),
      });

      console.log('DND Ensure', ensure);

      if (!ensure.ok) {
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
      }

      const originalCommand = output.args.command;
      const mappedWorkdir = mapHostPathToContainer(
        output.args.cwd || projectRoot,
        projectRoot,
        config.container.workdir,
      );
      const envOverrides =
        output.args.env && typeof output.args.env === 'object'
          ? output.args.env
          : undefined;

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
  };
};

export default DindRouterPlugin;
