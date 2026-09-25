import { createHash } from 'node:crypto';
import { lstatSync, promises as fs, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawn } from 'node:child_process';
import {
  processTree,
  stillRunning,
  survivingTree,
  taskkillTree,
  windowsProcessRows,
  type ProcessIdentity,
} from './process-tree.js';
import type { ToolDefinition } from '@mcpex/providers';
export { processTree, stillRunning, survivingTree, windowsProcessRows } from './process-tree.js';
export type { ProcessIdentity } from './process-tree.js';

export type ToolLimits = {
  maxReadBytes?: number;
  maxResultBytes?: number;
  maxSearchResults?: number;
  maxListResults?: number;
  maxTraversalEntries?: number;
  maxWriteBytes?: number;
  maxCommandMs?: number;
};
export type CommandSpec = { commandId: string; executable: string; label?: string };
export type ToolObservation = { truncated: boolean; originalBytes?: number };
export type BoundTarget = { id: string; path: string; access: 'read' | 'write' | 'readwrite' };
export type UnsafeCommandTermination = {
  processes: ProcessIdentity[];
  reason: 'PROCESS_INSPECTION_FAILED' | 'TASKKILL_FAILED' | 'TREE_STILL_RUNNING';
};
const defaults = {
  maxReadBytes: 1024 * 1024,
  maxResultBytes: 64 * 1024,
  maxSearchResults: 200,
  maxListResults: 2000,
  maxTraversalEntries: 10000,
  maxWriteBytes: 1024 * 1024,
  maxCommandMs: 120000,
};
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const commandEnvironmentKeys =
  process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PATH', 'TEMP', 'TMP']
    : ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'];
function commandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const sourceKeys = Object.keys(process.env);
  for (const expected of commandEnvironmentKeys) {
    const sourceKey =
      process.platform === 'win32'
        ? sourceKeys.find((key) => key.toLowerCase() === expected.toLowerCase())
        : sourceKeys.find((key) => key === expected);
    if (sourceKey && process.env[sourceKey] !== undefined)
      environment[expected] = process.env[sourceKey];
  }
  return environment;
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function resolveWorkspaceRoot(input: string): string {
  const root = resolve(input);
  const anchor = parse(root).root;
  let current = anchor;
  try {
    for (const part of relative(anchor, root).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink())
        throw new ToolError(
          'PATH_FORBIDDEN',
          '작업 폴더에 심볼릭 링크가 포함되어 있습니다.',
          'symlink',
        );
    }
    return realpathSync.native(root);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      'PATH_FORBIDDEN',
      '작업 폴더의 실제 경로를 확인할 수 없습니다.',
      'root_unavailable',
    );
  }
}

export class WorkspaceTools {
  private readonly limits: typeof defaults;
  constructor(
    private readonly root: string | null,
    limits: ToolLimits = {},
    private readonly commands: CommandSpec[] = [],
    private readonly onUnsafeTermination?: (failure: UnsafeCommandTermination) => void,
  ) {
    this.root = root === null ? null : resolveWorkspaceRoot(root);
    this.limits = { ...defaults, ...limits };
  }
  pathRecoveryHint(canList: boolean): string {
    if (!canList)
      return this.root === null
        ? '사용자가 제공한 절대 경로와 실제 폴더 위치를 다시 확인하세요.'
        : '설정된 작업 폴더 기준의 상대 경로 또는 범위 내부 절대 경로를 다시 확인하세요.';
    return this.root === null
      ? '사용자가 제공한 경로의 존재하는 상위 폴더를 절대 경로로 지정해 list_files로 확인하세요.'
      : 'list_files의 path를 "."으로 지정해 작업 폴더의 실제 상대 경로를 확인하세요.';
  }
  private async safePath(
    input: string,
    allowMissing = false,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!input || input.includes('\0'))
      throw new ToolError('PATH_FORBIDDEN', '경로가 필요합니다.', 'invalid_path');
    if (
      process.platform === 'win32' &&
      (/^[A-Za-z]:(?:$|[^\\/])/.test(input) || /^[\\/](?![\\/])/.test(input))
    )
      throw new ToolError(
        'AMBIGUOUS_PATH',
        '드라이브 상대 경로와 드라이브 없는 루트 경로는 사용할 수 없습니다. 작업 폴더 기준 상대 경로나 드라이브가 포함된 절대 경로를 지정하세요.',
        'ambiguous_path',
      );
    if (
      /^file:/i.test(input) ||
      /^['"].*['"]$/.test(input) ||
      input.startsWith('~') ||
      /^%(?:[^%]+)%/.test(input) ||
      /^\$(?:\{|env:|[A-Za-z_])/.test(input)
    )
      throw new ToolError(
        'PATH_FORMAT_UNSUPPORTED',
        '경로 문자열을 직접 입력하세요. 따옴표, file URI, ~, 환경변수 표기는 자동 변환하지 않습니다.',
        'unsupported_path_format',
      );
    if (this.root === null && !isAbsolute(input))
      throw new ToolError(
        'PATH_FORBIDDEN',
        '전체 접근에서는 절대 경로가 필요합니다.',
        'absolute_required',
      );
    const root = this.root === null ? null : resolveWorkspaceRoot(this.root);
    const candidate =
      root === null || isAbsolute(input)
        ? resolve(normalize(input))
        : resolve(root, normalize(input));
    const anchor = root ?? parse(candidate).root;
    const rel = relative(anchor, candidate);
    if (root !== null && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
      throw new ToolError('PATH_FORBIDDEN', '작업 폴더 밖의 경로입니다.', 'outside_root');
    const parts = rel ? rel.split(/[\\/]/) : [];
    let current = anchor;
    for (const part of parts) {
      signal?.throwIfAborted();
      current = join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink())
          throw new ToolError(
            'PATH_FORBIDDEN',
            '심볼릭 링크 경로는 사용할 수 없습니다.',
            'symlink',
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) break;
        throw error;
      }
    }
    signal?.throwIfAborted();
    return candidate;
  }
  async resolveTarget(
    path: string,
    access: BoundTarget['access'],
    signal?: AbortSignal,
  ): Promise<string> {
    const file = await this.safePath(path, access === 'write', signal);
    signal?.throwIfAborted();
    try {
      const stat = await fs.stat(file);
      if (access === 'write') throw new ToolError('ALREADY_EXISTS', '대상 파일이 이미 존재합니다.');
      if (!stat.isFile()) throw new ToolError('BAD_INPUT', '대상은 일반 파일이어야 합니다.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && access === 'write') return file;
      throw error;
    }
    return file;
  }
  private displayPath(path: string): string {
    return this.root === null ? path : relative(this.root, path);
  }
  private cap(text: string): { value: string; observation: ToolObservation } {
    const bytes = Buffer.byteLength(text);
    if (bytes <= this.limits.maxResultBytes)
      return { value: text, observation: { truncated: false, originalBytes: bytes } };
    return {
      value: Buffer.from(text).subarray(0, this.limits.maxResultBytes).toString('utf8'),
      observation: { truncated: true, originalBytes: bytes },
    };
  }
  private async readBounded(file: string, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ToolError('BAD_INPUT', '일반 파일만 읽을 수 있습니다.');
      if (stat.size > this.limits.maxReadBytes)
        throw new ToolError('READ_LIMIT', '파일이 읽기 한도를 초과했습니다.');
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= this.limits.maxReadBytes) {
        signal?.throwIfAborted();
        const remaining = this.limits.maxReadBytes + 1 - total;
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total > this.limits.maxReadBytes)
        throw new ToolError('READ_LIMIT', '파일이 읽기 한도를 초과했습니다.');
      signal?.throwIfAborted();
      return Buffer.concat(chunks, total);
    } finally {
      await handle.close();
    }
  }
  async listFiles(
    path = '.',
    depth = 1,
    signal?: AbortSignal,
  ): Promise<{
    items: Array<{ path: string; type: 'file' | 'directory'; size?: number }>;
    observation: ToolObservation;
  }> {
    const base = await this.safePath(path, false, signal);
    const items: Array<{ path: string; type: 'file' | 'directory'; size?: number }> = [];
    let resultBytes = 2;
    let originalBytes = 2;
    let truncated = false;
    let visited = 0;
    const depthCapped = depth > 20;
    const maxDepth = Math.max(0, Math.min(depth, 20));
    const walk = async (dir: string, level: number): Promise<void> => {
      if (
        items.length >= this.limits.maxListResults ||
        visited >= this.limits.maxTraversalEntries
      ) {
        truncated = true;
        return;
      }
      for await (const entry of await fs.opendir(dir)) {
        signal?.throwIfAborted();
        if (++visited > this.limits.maxTraversalEntries) {
          truncated = true;
          return;
        }
        if (['.git', 'node_modules', 'dist', 'build', '.vite'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        const rel = this.displayPath(full);
        let item: { path: string; type: 'file' | 'directory'; size?: number };
        if (entry.isDirectory()) {
          item = { path: rel, type: 'directory' };
        } else if (entry.isFile()) {
          const stat = await fs.stat(full);
          item = { path: rel, type: 'file', size: stat.size };
        } else {
          continue;
        }
        const separatorBytes = items.length ? 1 : 0;
        const itemBytes = Buffer.byteLength(JSON.stringify(item)) + separatorBytes;
        originalBytes += itemBytes;
        if (resultBytes + itemBytes > this.limits.maxResultBytes) {
          truncated = true;
          return;
        }
        items.push(item);
        resultBytes += itemBytes;
        if (items.length >= this.limits.maxListResults) {
          truncated = true;
          return;
        }
        if (entry.isDirectory() && level < maxDepth) await walk(full, level + 1);
        if (truncated) return;
      }
    };
    await walk(base, 0);
    return {
      items,
      observation: {
        truncated: truncated || depthCapped,
        originalBytes: Math.max(originalBytes, resultBytes),
      },
    };
  }
  async readFile(
    path: string,
    startLine = 1,
    maxLines?: number,
    signal?: AbortSignal,
  ): Promise<{ path: string; content: string; hash: string; observation: ToolObservation }> {
    const file = await this.safePath(path, false, signal);
    const data = await this.readBounded(file, signal);
    const lines = data.toString('utf8').split(/\r?\n/);
    const selected = lines
      .slice(Math.max(0, startLine - 1), maxLines ? startLine - 1 + maxLines : undefined)
      .join('\n');
    const capped = this.cap(selected);
    return {
      path: this.displayPath(file),
      content: capped.value,
      hash: digest(data),
      observation: capped.observation,
    };
  }
  async searchText(
    path: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<{
    matches: Array<{ path: string; line: number; text: string }>;
    observation: ToolObservation;
  }> {
    if (!query) throw new ToolError('BAD_INPUT', '검색어가 필요합니다.');
    await this.safePath(path, false, signal);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let resultBytes = 2;
    let originalBytes = 2;
    let truncated = false;
    const listed = await this.listFiles(path, 20, signal);
    const files = listed.items.filter((item) => item.type === 'file');
    truncated ||= listed.observation.truncated;
    let resultLimitReached = false;
    for (const item of files) {
      signal?.throwIfAborted();
      if (matches.length >= this.limits.maxSearchResults || resultLimitReached) {
        truncated = true;
        break;
      }
      if ((item.size ?? 0) > this.limits.maxReadBytes) {
        truncated = true;
        continue;
      }
      let content: string;
      try {
        content = (
          await this.readBounded(
            this.root === null ? item.path : join(this.root, item.path),
            signal,
          )
        ).toString('utf8');
      } catch (error) {
        if (error instanceof ToolError && error.code === 'READ_LIMIT') {
          truncated = true;
          continue;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          truncated = true;
          continue;
        }
        throw error;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        signal?.throwIfAborted();
        const line = lines[index];
        if (!line.includes(query)) continue;
        const candidate = { path: item.path, line: index + 1, text: line };
        const separatorBytes = matches.length ? 1 : 0;
        const candidateBytes = Buffer.byteLength(JSON.stringify(candidate)) + separatorBytes;
        originalBytes += candidateBytes;
        const remaining = this.limits.maxResultBytes - resultBytes - separatorBytes;
        if (candidateBytes - separatorBytes > remaining) {
          const encodedLine = Buffer.from(line);
          let low = 0;
          let high = Math.min(encodedLine.byteLength, Math.max(0, remaining));
          let fitted: string | undefined;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const text = encodedLine.subarray(0, middle).toString('utf8');
            const bytes = Buffer.byteLength(JSON.stringify({ ...candidate, text }));
            if (bytes <= remaining) {
              fitted = text;
              low = middle + 1;
            } else {
              high = middle - 1;
            }
          }
          if (fitted !== undefined) {
            candidate.text = fitted;
            matches.push(candidate);
            resultBytes += Buffer.byteLength(JSON.stringify(candidate)) + separatorBytes;
          }
          truncated = true;
          resultLimitReached = true;
          break;
        }
        matches.push(candidate);
        resultBytes += candidateBytes;
        if (matches.length >= this.limits.maxSearchResults) {
          truncated = true;
          break;
        }
      }
    }
    return {
      matches,
      observation: { truncated, originalBytes: Math.max(originalBytes, resultBytes) },
    };
  }
  async writeFile(
    path: string,
    content: string,
    expectedHash?: string,
    createOnly = false,
    signal?: AbortSignal,
  ): Promise<{ path: string; hash: string; bytes: number }> {
    const file = await this.safePath(path, true, signal);
    const data = Buffer.from(content, 'utf8');
    if (data.byteLength > this.limits.maxWriteBytes)
      throw new ToolError('WRITE_LIMIT', '쓰기 한도를 초과했습니다.');
    let existing: Buffer | undefined;
    try {
      existing = await this.readBounded(file, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (createOnly && existing) throw new ToolError('ALREADY_EXISTS', '파일이 이미 존재합니다.');
    if (existing && !expectedHash)
      throw new ToolError(
        'EXPECTED_HASH_REQUIRED',
        '기존 파일을 수정하려면 read_file로 확인한 expectedHash가 필요합니다.',
      );
    if (expectedHash && (!existing || digest(existing) !== expectedHash))
      throw new ToolError(
        'HASH_CONFLICT',
        '파일이 읽은 뒤 변경되었습니다. 같은 경로를 read_file로 다시 읽고 변경 내용을 검토하세요.',
      );
    await fs.mkdir(dirname(file), { recursive: true });
    signal?.throwIfAborted();
    if (createOnly) {
      const checked = await this.safePath(file, true, signal);
      try {
        signal?.throwIfAborted();
        const handle = await fs.open(checked, 'wx');
        try {
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new ToolError('ALREADY_EXISTS', '파일이 이미 존재합니다.');
        throw error;
      }
      return { path: this.displayPath(checked), hash: digest(data), bytes: data.byteLength };
    }
    const temp = `${file}.mcpex-${process.pid}-${Date.now()}.tmp`;
    try {
      await fs.writeFile(temp, data, { flag: 'wx' });
      signal?.throwIfAborted();
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
    return { path: this.displayPath(file), hash: digest(data), bytes: data.byteLength };
  }
  async replaceText(
    path: string,
    oldText: string,
    newText: string,
    expectedHash?: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; hash: string; replacements: number }> {
    if (!expectedHash)
      throw new ToolError(
        'EXPECTED_HASH_REQUIRED',
        '텍스트를 교체하려면 read_file로 확인한 expectedHash가 필요합니다.',
      );
    const file = await this.safePath(path, false, signal);
    const data = await this.readBounded(file, signal);
    if (digest(data) !== expectedHash)
      throw new ToolError(
        'HASH_CONFLICT',
        '파일이 읽은 뒤 변경되었습니다. 같은 경로를 read_file로 다시 읽고 변경 내용을 검토하세요.',
      );
    const content = data.toString('utf8');
    const count = content.split(oldText).length - 1;
    if (count !== 1)
      throw new ToolError('MATCH_COUNT', 'oldText가 정확히 한 번만 일치해야 합니다.');
    const result = await this.writeFile(
      path,
      content.replace(oldText, newText),
      expectedHash,
      false,
      signal,
    );
    return { path: result.path, hash: result.hash, replacements: 1 };
  }
  async runCommand(
    commandId: string,
    args: string[],
    cwd = '.',
    signal?: AbortSignal,
  ): Promise<{
    commandId: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    observation: ToolObservation;
  }> {
    signal?.throwIfAborted();
    const spec = this.commands.find((item) => item.commandId === commandId);
    if (!spec) throw new ToolError('COMMAND_NOT_ALLOWED', '허용되지 않은 commandId입니다.');
    if (args.some((arg) => typeof arg !== 'string'))
      throw new ToolError('BAD_INPUT', 'args는 문자열 배열이어야 합니다.');
    const workdir = await this.safePath(cwd, false, signal);
    signal?.throwIfAborted();
    return await new Promise((resolvePromise, reject) => {
      const environment = commandEnvironment();
      const child = spawn(spec.executable, args, {
        cwd: workdir,
        env: environment,
        shell: false,
        windowsHide: true,
      });
      let finished = false;
      let closed = false;
      let exitCode: number | null = null;
      let spawnError: Error | undefined;
      let terminationRequested = false;
      let terminationFailure: UnsafeCommandTermination | undefined;
      let stopPending: Promise<void> | undefined;
      const cleanup = () => {
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', terminate);
      };
      const settle = () => {
        if (finished || !closed || stopPending) return;
        cleanup();
        if (terminationFailure) {
          reject(
            new ToolError(
              'COMMAND_TERMINATION_FAILED',
              `명령 프로세스 트리 종료 확인 실패·추가 실행 차단 (${terminationFailure.reason}).`,
            ),
          );
        } else if (spawnError) reject(spawnError);
        else
          resolvePromise({
            commandId,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode,
            observation: { truncated: originalBytes > retainedBytes, originalBytes },
          });
      };
      const terminate = () => {
        if (finished || terminationRequested) return;
        terminationRequested = true;
        if (child.pid && process.platform === 'win32') {
          stopPending = (async () => {
            let processes: ProcessIdentity[] = [];
            let reason: UnsafeCommandTermination['reason'] = 'PROCESS_INSPECTION_FAILED';
            try {
              processes = processTree(await windowsProcessRows(), child.pid!);
              const current = await windowsProcessRows();
              const observed = survivingTree(current, processes);
              processes.push(
                ...observed.filter(
                  (item) =>
                    !processes.some(
                      (known) => known.pid === item.pid && known.started === item.started,
                    ),
                ),
              );
              if (stillRunning(current, processes.slice(0, 1)).length !== 1)
                throw new Error('원 명령 PID가 재사용되었거나 종료되었습니다.');
              reason = 'TASKKILL_FAILED';
              if (!(await taskkillTree(child.pid!, environment)))
                throw new Error('taskkill failed');
              reason = 'TREE_STILL_RUNNING';
              const survivors = survivingTree(await windowsProcessRows(), processes);
              processes.push(
                ...survivors.filter(
                  (item) =>
                    !processes.some(
                      (known) => known.pid === item.pid && known.started === item.started,
                    ),
                ),
              );
              if (survivors.length) throw new Error('트리 프로세스가 남아 있습니다.');
            } catch {
              terminationFailure = { processes, reason };
              try {
                this.onUnsafeTermination?.(terminationFailure);
              } catch {
                console.error('MCPex command safety block could not be persisted.');
              } finally {
                child.kill();
              }
            }
          })().finally(() => {
            stopPending = undefined;
            settle();
          });
        } else child.kill();
      };
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let retainedBytes = 0;
      let originalBytes = 0;
      const collect = (chunks: Buffer[], value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        originalBytes += chunk.byteLength;
        const remaining = this.limits.maxResultBytes - retainedBytes;
        if (remaining <= 0) return;
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        retainedBytes += kept.byteLength;
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdoutChunks, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderrChunks, chunk));
      const timer = setTimeout(terminate, this.limits.maxCommandMs);
      signal?.addEventListener('abort', terminate, { once: true });
      if (signal?.aborted) terminate();
      child.on('error', (error) => {
        spawnError = error;
        closed = true;
        settle();
      });
      child.on('close', (code) => {
        exitCode = code;
        closed = true;
        settle();
      });
    });
  }
}

export const workspaceToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_files',
    description: '작업 폴더의 파일을 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, depth: { type: 'number' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: '작업 폴더의 텍스트 파일을 읽습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        maxLines: { type: 'number' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_text',
    description: '작업 폴더에서 literal 텍스트를 검색합니다.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, query: { type: 'string' } },
      required: ['path', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      '새 파일을 생성하거나 기존 파일을 원자적으로 교체합니다. 기존 파일에는 read_file로 얻은 expectedHash가 필요합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        expectedHash: { type: 'string' },
        createOnly: { type: 'boolean' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_text',
    description:
      'read_file로 얻은 expectedHash가 일치하고 텍스트가 정확히 한 번 나타날 때 교체합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        expectedHash: { type: 'string' },
      },
      required: ['path', 'oldText', 'newText', 'expectedHash'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: '사용자가 허용한 명령을 실행합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
      },
      required: ['commandId', 'args'],
      additionalProperties: false,
    },
  },
];

export const targetToolDefinitions: ToolDefinition[] = [
  {
    name: 'read_target',
    description: '지정된 대상 ID의 파일을 읽고 해시를 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        startLine: { type: 'number' },
        maxLines: { type: 'number' },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_target',
    description:
      'write 대상은 새 파일만 생성합니다. readwrite 대상의 수정에는 read_target의 expectedHash가 필요합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        content: { type: 'string' },
        expectedHash: { type: 'string' },
      },
      required: ['targetId', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_target',
    description: 'readwrite 대상에서 해시가 일치하는 텍스트를 한 번 교체합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        expectedHash: { type: 'string' },
      },
      required: ['targetId', 'oldText', 'newText', 'expectedHash'],
      additionalProperties: false,
    },
  },
];

export async function executeTargetTool(
  tools: WorkspaceTools,
  targets: readonly BoundTarget[],
  enabled: ReadonlySet<string>,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const shape: Record<string, Record<string, 'string' | 'number'>> = {
    read_target: { targetId: 'string', startLine: 'number', maxLines: 'number' },
    write_target: { targetId: 'string', content: 'string', expectedHash: 'string' },
    replace_target: {
      targetId: 'string',
      oldText: 'string',
      newText: 'string',
      expectedHash: 'string',
    },
  };
  if (!enabled.has(name) || !shape[name])
    throw new ToolError('TOOL_NOT_ENABLED', '허용되지 않은 대상 도구입니다.');
  if (
    typeof args.targetId !== 'string' ||
    Object.entries(args).some(([key, value]) => shape[name][key] !== typeof value)
  )
    throw new ToolError('BAD_INPUT', '대상 도구 인자가 올바르지 않습니다.');
  if (
    (name === 'write_target' && typeof args.content !== 'string') ||
    (name === 'replace_target' &&
      ['oldText', 'newText', 'expectedHash'].some((key) => typeof args[key] !== 'string'))
  )
    throw new ToolError('BAD_INPUT', '대상 도구 필수 인자가 없습니다.');
  const target = targets.find((item) => item.id === args.targetId);
  if (!target) throw new ToolError('UNKNOWN_TARGET', '알 수 없는 대상 ID입니다.');
  if (
    (name === 'read_target' && target.access === 'write') ||
    (name === 'replace_target' && target.access !== 'readwrite') ||
    (name === 'write_target' && target.access === 'read')
  )
    throw new ToolError('TARGET_ACCESS_DENIED', '대상 접근 권한이 없습니다.');
  await tools.resolveTarget(target.path, target.access, signal);
  signal?.throwIfAborted();
  if (name === 'read_target') {
    const { path: _path, ...result } = await tools.readFile(
      target.path,
      args.startLine as number | undefined,
      args.maxLines as number | undefined,
      signal,
    );
    return { targetId: target.id, ...result };
  }
  if (name === 'write_target') {
    if (target.access === 'readwrite' && !args.expectedHash)
      throw new ToolError(
        'EXPECTED_HASH_REQUIRED',
        'readwrite 수정에는 expectedHash가 필요합니다.',
      );
    const { path: _path, ...result } = await tools.writeFile(
      target.path,
      args.content as string,
      args.expectedHash as string | undefined,
      target.access === 'write',
      signal,
    );
    return { targetId: target.id, ...result };
  }
  const { path: _path, ...result } = await tools.replaceText(
    target.path,
    args.oldText as string,
    args.newText as string,
    args.expectedHash as string,
    signal,
  );
  return { targetId: target.id, ...result };
}

export function getWorkspaceToolDefinitions(
  fullAccess = false,
  commands: CommandSpec[] = [],
): ToolDefinition[] {
  return workspaceToolDefinitions
    .filter((tool) => tool.name !== 'run_command' || commands.length)
    .map((tool) => {
      const pathField = tool.name === 'run_command' ? 'cwd' : 'path';
      const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      const required = Array.isArray(tool.inputSchema.required)
        ? tool.inputSchema.required.filter((item): item is string => typeof item === 'string')
        : [];
      const commandDescription = commands
        .map((command) =>
          command.label ? `${command.commandId} (${command.label})` : command.commandId,
        )
        .join(', ');
      return {
        ...tool,
        description: [
          tool.description,
          tool.name === 'run_command' ? `사용 가능한 명령: ${commandDescription}.` : '',
          fullAccess
            ? `전체 접근에서는 ${pathField}에 절대 경로를 지정해야 합니다.`
            : `${pathField}는 설정된 작업 폴더 기준 상대 경로 또는 그 범위 내부 절대 경로를 사용할 수 있습니다. 범위 밖 경로는 허용되지 않습니다.`,
        ]
          .filter(Boolean)
          .join(' '),
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...properties,
            ...(tool.name === 'run_command'
              ? {
                  commandId: {
                    ...properties.commandId,
                    enum: commands.map((command) => command.commandId),
                    description: `허용된 명령 ID입니다: ${commandDescription}.`,
                  },
                }
              : {}),
            [pathField]: {
              ...properties[pathField],
              description: fullAccess
                ? '전체 접근에서 필수인 절대 경로입니다.'
                : '설정된 작업 폴더 기준 상대 경로 또는 그 범위 내부 절대 경로입니다. 폴더 자체는 . 으로 지정할 수 있습니다.',
            },
          },
          ...(fullAccess
            ? { required: [...new Set([...required, pathField])] }
            : required.length
              ? { required }
              : {}),
        },
      };
    });
}

const allowedArguments: Record<
  string,
  Record<string, 'string' | 'number' | 'boolean' | 'strings'>
> = {
  list_files: { path: 'string', depth: 'number' },
  read_file: { path: 'string', startLine: 'number', maxLines: 'number' },
  search_text: { path: 'string', query: 'string' },
  write_file: {
    path: 'string',
    content: 'string',
    expectedHash: 'string',
    createOnly: 'boolean',
  },
  replace_text: {
    path: 'string',
    oldText: 'string',
    newText: 'string',
    expectedHash: 'string',
  },
  run_command: { commandId: 'string', args: 'strings', cwd: 'string' },
};
const requiredArguments: Record<string, string[]> = {
  list_files: [],
  read_file: ['path'],
  search_text: ['path', 'query'],
  write_file: ['path', 'content'],
  replace_text: ['path', 'oldText', 'newText', 'expectedHash'],
  run_command: ['commandId', 'args'],
};

function validateWorkspaceToolArguments(name: string, args: Record<string, unknown>): void {
  const shape = allowedArguments[name];
  if (!shape) throw new ToolError('UNKNOWN_TOOL', `알 수 없는 도구입니다: ${name}`);
  for (const key of requiredArguments[name])
    if (!(key in args)) throw new ToolError('BAD_INPUT', `${name}.${key} 인자가 필요합니다.`);
  for (const [key, value] of Object.entries(args)) {
    const expected = shape[key];
    if (!expected) throw new ToolError('BAD_INPUT', `${name}.${key} 인자는 허용되지 않습니다.`);
    const valid =
      expected === 'strings'
        ? Array.isArray(value) && value.every((item) => typeof item === 'string')
        : typeof value === expected && (expected !== 'number' || Number.isFinite(value));
    if (!valid) throw new ToolError('BAD_INPUT', `${name}.${key} 인자의 형식이 올바르지 않습니다.`);
  }
}

export async function executeWorkspaceTool(
  tools: WorkspaceTools,
  enabledToolNames: ReadonlySet<string>,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (!enabledToolNames.has(name))
    throw new ToolError('TOOL_NOT_ENABLED', `활성화되지 않은 도구입니다: ${name}`);
  validateWorkspaceToolArguments(name, args);
  try {
    switch (name) {
      case 'list_files':
        return await tools.listFiles(
          typeof args.path === 'string' ? args.path : '.',
          typeof args.depth === 'number' ? args.depth : 1,
          signal,
        );
      case 'read_file':
        return await tools.readFile(
          String(args.path),
          typeof args.startLine === 'number' ? args.startLine : 1,
          typeof args.maxLines === 'number' ? args.maxLines : undefined,
          signal,
        );
      case 'search_text':
        return await tools.searchText(String(args.path), String(args.query), signal);
      case 'write_file':
        return await tools.writeFile(
          String(args.path),
          String(args.content),
          typeof args.expectedHash === 'string' ? args.expectedHash : undefined,
          args.createOnly === true,
          signal,
        );
      case 'replace_text':
        return await tools.replaceText(
          String(args.path),
          String(args.oldText),
          String(args.newText),
          typeof args.expectedHash === 'string' ? args.expectedHash : undefined,
          signal,
        );
      case 'run_command':
        return await tools.runCommand(
          String(args.commandId),
          Array.isArray(args.args) ? args.args.map(String) : [],
          typeof args.cwd === 'string' ? args.cwd : '.',
          signal,
        );
      default:
        throw new ToolError('UNKNOWN_TOOL', `알 수 없는 도구입니다: ${name}`);
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new ToolError(
        'ENOENT',
        `경로를 찾을 수 없습니다. ${tools.pathRecoveryHint(enabledToolNames.has('list_files'))}`,
        'not_found',
      );
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new ToolError(
        'ACCESS_DENIED',
        '현재 OS 사용자 권한으로 경로에 접근할 수 없습니다. 다른 폴더를 추측해 사용하거나 권한을 높이지 마세요.',
      );
    if (typeof (error as NodeJS.ErrnoException).path === 'string')
      throw new ToolError(
        'PATH_ERROR',
        `경로를 처리할 수 없습니다. ${tools.pathRecoveryHint(enabledToolNames.has('list_files'))}`,
      );
    throw error;
  }
}
