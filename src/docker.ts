import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

// Docker Compose also supports project-specific files such as
// `docker-compose.dev.yml` or `compose.test.yaml`. Keep the conventional base
// files first because Compose applies later files as overrides.
const COMPOSE_FILE_RE = /^(?:docker-compose|compose)(?:\..+)?\.(?:yml|yaml)$/i;

export function getDockerComposeFiles(projectPath: string): string[] {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(projectPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && COMPOSE_FILE_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const conventionalOrder = new Map(COMPOSE_FILENAMES.map((name, index) => [name, index]));
  return filenames
    .sort((a, b) => {
      const orderA = conventionalOrder.get(a.toLowerCase()) ?? COMPOSE_FILENAMES.length;
      const orderB = conventionalOrder.get(b.toLowerCase()) ?? COMPOSE_FILENAMES.length;
      return orderA - orderB || a.localeCompare(b);
    })
    .map((filename) => path.join(projectPath, filename));
}

// Compose-file presence rarely changes during a session (it's a property of the
// project's directory layout), so it's cached per path instead of re-stat'd on
// every tree render. Invalidated explicitly when the set of projects/folders changes.
const composeCache = new Map<string, boolean>();

export function hasDockerCompose(projectPath: string): boolean {
  const cached = composeCache.get(projectPath);
  if (cached !== undefined) {
    return cached;
  }
  const result = getDockerComposeFiles(projectPath).length > 0;
  composeCache.set(projectPath, result);
  return result;
}

export function invalidateDockerComposeCache(projectPath?: string): void {
  if (projectPath) {
    composeCache.delete(projectPath);
  } else {
    composeCache.clear();
  }
}

// `docker ps` reports each container's working_dir label as the OS resolved it
// (symlinks followed), which can differ byte-for-byte from a project's configured
// path. Resolving both sides through the same real path keeps the comparison
// reliable instead of relying on exact string equality.
// The resolved value is cached per input path: it only depends on the on-disk
// symlink target, which doesn't change while the extension is running.
const realpathCache = new Map<string, string>();

export function normalizeProjectPath(projectPath: string): string {
  const cached = realpathCache.get(projectPath);
  if (cached !== undefined) {
    return cached;
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(projectPath);
  } catch {
    resolved = path.resolve(projectPath);
  }
  // macOS and Windows use case-insensitive filesystems by default. Docker can
  // preserve the casing from the shell invocation in its working_dir label,
  // while VS Code may provide the path with different casing.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    resolved = resolved.toLowerCase();
  }
  realpathCache.set(projectPath, resolved);
  return resolved;
}

// Populated by refreshDockerState(); read synchronously by ProjectTreeItem so
// tree building never has to wait on a docker CLI call.
let runningWorkingDirs = new Set<string>();
let dockerAvailable = true;

export function isDockerRunning(projectPath: string): boolean {
  return runningWorkingDirs.has(normalizeProjectPath(projectPath));
}

export function isDockerAvailable(): boolean {
  return dockerAvailable;
}

export function startDockerEngine(): Promise<void> {
  if (process.platform !== 'darwin') {
    return Promise.reject(new Error('Automatic Docker engine startup is currently supported on macOS only.'));
  }

  return (async () => {
    const context = (await execAsync('docker context show', { timeout: 5000 }).catch(() => '')).trim().toLowerCase();
    const candidates: string[] = [];

    if (context.includes('orbstack')) {
      candidates.push('open -a OrbStack');
    } else if (context.includes('desktop')) {
      candidates.push('open -a Docker');
    } else if (context.includes('colima')) {
      candidates.push('colima start');
    } else if (context.includes('rancher')) {
      candidates.push('open -a "Rancher Desktop"');
    }

    candidates.push('docker desktop start', 'open -a OrbStack', 'open -a Docker', 'open -a "Rancher Desktop"', 'colima start');

    const errors: string[] = [];
    for (const command of [...new Set(candidates)]) {
      try {
        await execAsync(command, { timeout: 30000 });
        return;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    throw new Error(`No supported Docker engine could be started${errors.length ? `: ${errors[errors.length - 1]}` : '.'}`);
  })();
}

export function getRunningWorkingDirs(): string[] {
  return [...runningWorkingDirs];
}

function execAsync(command: string, options: { cwd?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: options.timeout ?? 4000, cwd: options.cwd }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

// Polls the docker daemon for containers started via `docker compose` and
// records which project working directories currently have one running.
// Returns whether the known state changed, so callers only refresh the UI when needed.
// If a previous poll is still in flight (e.g. the daemon is slow to respond),
// callers get that same promise back instead of piling up concurrent `docker ps` calls.
let inFlightRefresh: Promise<boolean> | undefined;

export function refreshDockerState(): Promise<boolean> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }
  const promise = doRefreshDockerState().finally(() => {
    if (inFlightRefresh === promise) {
      inFlightRefresh = undefined;
    }
  });
  inFlightRefresh = promise;
  return promise;
}

async function doRefreshDockerState(): Promise<boolean> {
  try {
    const output = await execAsync(
      'docker ps --filter "label=com.docker.compose.project.working_dir" --format "{{.Label \\"com.docker.compose.project.working_dir\\"}}"'
    );
    const next = new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(normalizeProjectPath)
    );
    const changed =
      !dockerAvailable ||
      next.size !== runningWorkingDirs.size ||
      [...next].some((dir) => !runningWorkingDirs.has(dir));
    dockerAvailable = true;
    runningWorkingDirs = next;
    return changed;
  } catch {
    const changed = dockerAvailable || runningWorkingDirs.size > 0;
    dockerAvailable = false;
    runningWorkingDirs = new Set();
    return changed;
  }
}

// A project can appear in more than one view (Projects, Favorites) at
// once, so a near-simultaneous click on each one's inline button would otherwise
// fire concurrent `docker compose` calls for the same project — Compose locks
// its project state while running, and the losing call fails with a lock error.
// Sharing one in-flight promise per path avoids that race entirely.
const inFlightOps = new Map<string, Promise<void>>();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function composeFilesForSelection(projectPath: string, selectedFile: string): string[] {
  const allFiles = getDockerComposeFiles(projectPath);
  const baseFile = allFiles.find((file) => COMPOSE_FILENAMES.includes(path.basename(file).toLowerCase()));
  if (baseFile && path.resolve(baseFile) !== path.resolve(selectedFile)) {
    return [baseFile, selectedFile];
  }
  return [selectedFile];
}

function composeCommand(projectPath: string, command: string, composeFiles = getDockerComposeFiles(projectPath)): string {
  const fileArguments = composeFiles.map((file) => `-f ${shellQuote(file)}`).join(' ');
  return `docker compose${fileArguments ? ` ${fileArguments}` : ''} ${command}`;
}

function runComposeOp(projectPath: string, command: string, timeout: number): Promise<void> {
  const existing = inFlightOps.get(projectPath);
  if (existing) {
    return existing;
  }
  const promise = execAsync(composeCommand(projectPath, command), { cwd: projectPath, timeout })
    .then(() => undefined)
    .finally(() => {
      if (inFlightOps.get(projectPath) === promise) {
        inFlightOps.delete(projectPath);
      }
    });
  inFlightOps.set(projectPath, promise);
  return promise;
}

export function startCompose(projectPath: string): Promise<void> {
  return runComposeOp(projectPath, 'up -d', 120000);
}

export function startComposeFile(projectPath: string, composeFile: string): Promise<void> {
  return execAsync(composeCommand(projectPath, 'up -d', composeFilesForSelection(projectPath, composeFile)), { cwd: projectPath, timeout: 120000 })
    .then(() => undefined);
}

export function stopCompose(projectPath: string): Promise<void> {
  return runComposeOp(projectPath, 'stop', 60000);
}

export function restartCompose(projectPath: string): Promise<void> {
  return runComposeOp(projectPath, 'restart', 120000);
}

export function pauseCompose(projectPath: string): Promise<void> {
  return runComposeOp(projectPath, 'pause', 30000);
}

export interface ContainerInfo {
  id: string;
  name: string;
  service: string;
  image: string;
  /** Published host/container ports reported by Docker, e.g. 0.0.0.0:18080->80/tcp. */
  ports: string;
  /** Raw `docker ps` state: running | paused | exited | created | restarting | dead | … */
  state: string;
  status: string;
  /** Compose project name, useful when multiple Compose files run independently. */
  composeProject?: string;
}

// Same working_dir mismatch problem as isDockerRunning(): the label is read from
// every compose-managed container on the host and matched against the project
// path via normalizeProjectPath() rather than filtered server-side, so symlinked
// paths still line up.
export async function listContainersForProject(projectPath: string): Promise<ContainerInfo[]> {
  const target = normalizeProjectPath(projectPath);
  let output: string;
  try {
    output = await execAsync(
      'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.State}}\\t{{.Status}}\\t{{.Image}}\\t' +
        '{{.Label \\"com.docker.compose.service\\"}}\\t{{.Ports}}\\t' +
        '{{.Label \\"com.docker.compose.project.working_dir\\"}}\\t' +
        '{{.Label \\"com.docker.compose.project\\"}}"',
      { timeout: 5000 }
    );
  } catch {
    return [];
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, state, status, image, service, ports, workingDir, composeProject] = line.split('\t');
      return {
        id,
        name,
        state,
        status,
        image,
        service: service || name,
        ports: ports || '',
        workingDir: workingDir || '',
        composeProject: composeProject || undefined,
      };
    })
    .filter((c) => c.workingDir && normalizeProjectPath(c.workingDir) === target)
    .map(({ workingDir: _workingDir, ...container }) => container);
}

/**
 * Lists only the services declared by one Compose file. This matters when a
 * folder contains independent dev/prod/stack Compose files that share the
 * same Docker working directory.
 */
export async function listContainersForComposeFile(
  projectPath: string,
  composeFile: string
): Promise<ContainerInfo[]> {
  let projectName: string | undefined;
  let services: Set<string> | undefined;
  try {
    const config = await execAsync(
      composeCommand(projectPath, 'config --format json', composeFilesForSelection(projectPath, composeFile)),
      { cwd: projectPath, timeout: 5000 }
    );
    const parsed = JSON.parse(config) as { name?: string; services?: Record<string, unknown> };
    projectName = parsed.name;
    services = parsed.services ? new Set(Object.keys(parsed.services)) : undefined;
  } catch {
    // Keep the file visible even when its configuration is incomplete; an
    // empty result is preferable to hiding the Compose file entirely.
  }

  const containers = await listContainersForProject(projectPath);
  return containers.filter((container) => {
    if (projectName && container.composeProject && container.composeProject !== projectName) {
      return false;
    }
    return !services || services.has(container.service);
  });
}

// Container IDs/names from `docker ps` are always alphanumeric (plus - and _),
// so this guards against shell injection from any unexpected input reaching
// these before they're interpolated into a command string.
const CONTAINER_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function assertContainerRef(ref: string): void {
  if (!CONTAINER_REF_RE.test(ref)) {
    throw new Error(`Invalid container reference: ${ref}`);
  }
}

function runContainerOp(ref: string, command: string, timeout: number): Promise<void> {
  assertContainerRef(ref);
  return execAsync(`docker ${command} ${ref}`, { timeout }).then(() => undefined);
}

export function startContainer(ref: string): Promise<void> {
  return runContainerOp(ref, 'start', 30000);
}

export function stopContainer(ref: string): Promise<void> {
  return runContainerOp(ref, 'stop', 30000);
}

export function restartContainer(ref: string): Promise<void> {
  return runContainerOp(ref, 'restart', 30000);
}

export function pauseContainer(ref: string): Promise<void> {
  return runContainerOp(ref, 'pause', 15000);
}

export function unpauseContainer(ref: string): Promise<void> {
  return runContainerOp(ref, 'unpause', 15000);
}

export function removeContainer(ref: string): Promise<void> {
  return runContainerOp(ref, 'rm -f', 30000);
}

export function removeContainers(refs: string[]): Promise<void> {
  if (refs.length === 0) {
    return Promise.resolve();
  }
  refs.forEach(assertContainerRef);
  return execAsync(`docker rm -f ${refs.join(' ')}`, { timeout: 60000 }).then(() => undefined);
}
