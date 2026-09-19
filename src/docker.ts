import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

// Compose-file presence rarely changes during a session (it's a property of the
// project's directory layout), so it's cached per path instead of re-stat'd on
// every tree render. Invalidated explicitly when the set of projects/folders changes.
const composeCache = new Map<string, boolean>();

export function hasDockerCompose(projectPath: string): boolean {
  const cached = composeCache.get(projectPath);
  if (cached !== undefined) {
    return cached;
  }
  const result = COMPOSE_FILENAMES.some((name) => fs.existsSync(path.join(projectPath, name)));
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

// A project can appear in more than one view (Projects, Favorites, Recents) at
// once, so a near-simultaneous click on each one's inline button would otherwise
// fire concurrent `docker compose` calls for the same project — Compose locks
// its project state while running, and the losing call fails with a lock error.
// Sharing one in-flight promise per path avoids that race entirely.
const inFlightOps = new Map<string, Promise<void>>();

function runComposeOp(projectPath: string, command: string, timeout: number): Promise<void> {
  const existing = inFlightOps.get(projectPath);
  if (existing) {
    return existing;
  }
  const promise = execAsync(command, { cwd: projectPath, timeout })
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
  return runComposeOp(projectPath, 'docker compose up -d', 120000);
}

export function stopCompose(projectPath: string): Promise<void> {
  return runComposeOp(projectPath, 'docker compose stop', 60000);
}

export function restartCompose(projectPath: string): Promise<void> {
  return runComposeOp(projectPath, 'docker compose restart', 120000);
}

export function pauseCompose(projectPath: string): Promise<void> {
  return runComposeOp(projectPath, 'docker compose pause', 30000);
}

export interface ContainerInfo {
  id: string;
  name: string;
  service: string;
  image: string;
  /** Raw `docker ps` state: running | paused | exited | created | restarting | dead | … */
  state: string;
  status: string;
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
      'docker ps -a --filter "label=com.docker.compose.project.working_dir" ' +
        '--format "{{.ID}}\\t{{.Names}}\\t{{.State}}\\t{{.Status}}\\t{{.Image}}\\t' +
        '{{.Label \\"com.docker.compose.service\\"}}\\t{{.Label \\"com.docker.compose.project.working_dir\\"}}"',
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
      const [id, name, state, status, image, service, workingDir] = line.split('\t');
      return { id, name, state, status, image, service: service || name, workingDir: workingDir || '' };
    })
    .filter((c) => c.workingDir && normalizeProjectPath(c.workingDir) === target)
    .map(({ workingDir: _workingDir, ...container }) => container);
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

export function pauseContainer(ref: string): Promise<void> {
  return runContainerOp(ref, 'pause', 15000);
}

export function unpauseContainer(ref: string): Promise<void> {
  return runContainerOp(ref, 'unpause', 15000);
}
