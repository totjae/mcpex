import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawn } from 'node:child_process';
import type { ToolDefinition } from '@mcpex/providers';

export type ToolLimits = {
  maxReadBytes?: number;
  maxResultBytes?: number;
  maxSearchResults?: number;
  maxListResults?: number;
  maxWriteBytes?: number;
  maxCommandMs?: number;
};
export type CommandSpec = { commandId: string; executable: string; label?: string };
export type ToolObservation = { truncated: boolean; originalBytes?: number };
const defaults = {
  maxReadBytes: 1024 * 1024,
  maxResultBytes: 64 * 1024,
  maxSearchResults: 200,
  maxListResults: 2000,
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
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
export class WorkspaceTools {
  private readonly limits: typeof defaults;
  constructor(
    private readonly root: string,
    limits: ToolLimits = {},
    private readonly commands: CommandSpec[] = [],
  ) {
    this.root = resolve(root);
    this.limits = { ...defaults, ...limits };
  }
  private async safePath(input: string, allowMissing = false): Promise<string> {
    if (!input || isAbsolute(input) || input.includes('\0'))
      throw new ToolError('PATH_FORBIDDEN', '상대 경로만 사용할 수 있습니다.');
    const candidate = resolve(this.root, normalize(input));
    const rel = relative(this.root, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new ToolError('PATH_FORBIDDEN', '작업 폴더 밖의 경로입니다.');
    const parts = rel ? rel.split(/[\\/]/) : [];
    let current = this.root;
    for (const part of parts) {
      current = join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink())
          throw new ToolError('PATH_FORBIDDEN', '심볼릭 링크 경로는 사용할 수 없습니다.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) break;
        throw error;
      }
    }
    return candidate;
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
  private async readBounded(file: string): Promise<Buffer> {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ToolError('BAD_INPUT', '일반 파일만 읽을 수 있습니다.');
      if (stat.size > this.limits.maxReadBytes)
        throw new ToolError('READ_LIMIT', '파일이 읽기 한도를 초과했습니다.');
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= this.limits.maxReadBytes) {
        const remaining = this.limits.maxReadBytes + 1 - total;
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total > this.limits.maxReadBytes)
        throw new ToolError('READ_LIMIT', '파일이 읽기 한도를 초과했습니다.');
      return Buffer.concat(chunks, total);
    } finally {
      await handle.close();
    }
  }
  async listFiles(
    path = '.',
    depth = 1,
  ): Promise<{
    items: Array<{ path: string; type: 'file' | 'directory'; size?: number }>;
    observation: ToolObservation;
  }> {
    const base = await this.safePath(path);
    const items: Array<{ path: string; type: 'file' | 'directory'; size?: number }> = [];
    let resultBytes = 2;
    let originalBytes = 2;
    let truncated = false;
    const walk = async (dir: string, level: number): Promise<void> => {
      if (items.length >= this.limits.maxListResults || truncated) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'dist', 'build', '.vite'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        const rel = relative(this.root, full);
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
        if (entry.isDirectory() && level < depth) await walk(full, level + 1);
        if (truncated) return;
      }
    };
    await walk(base, 0);
    return {
      items,
      observation: { truncated, originalBytes: Math.max(originalBytes, resultBytes) },
    };
  }
  async readFile(
    path: string,
    startLine = 1,
    maxLines?: number,
  ): Promise<{ path: string; content: string; hash: string; observation: ToolObservation }> {
    const file = await this.safePath(path);
    const data = await this.readBounded(file);
    const lines = data.toString('utf8').split(/\r?\n/);
    const selected = lines
      .slice(Math.max(0, startLine - 1), maxLines ? startLine - 1 + maxLines : undefined)
      .join('\n');
    const capped = this.cap(selected);
    return { path, content: capped.value, hash: digest(data), observation: capped.observation };
  }
  async searchText(
    path: string,
    query: string,
  ): Promise<{
    matches: Array<{ path: string; line: number; text: string }>;
    observation: ToolObservation;
  }> {
    if (!query) throw new ToolError('BAD_INPUT', '검색어가 필요합니다.');
    await this.safePath(path);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let resultBytes = 2;
    let originalBytes = 2;
    let truncated = false;
    const listed = await this.listFiles(path, 20);
    const files = listed.items.filter((item) => item.type === 'file');
    truncated ||= listed.observation.truncated;
    let resultLimitReached = false;
    for (const item of files) {
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
        content = (await this.readBounded(join(this.root, item.path))).toString('utf8');
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
  ): Promise<{ path: string; hash: string; bytes: number }> {
    const file = await this.safePath(path, true);
    const data = Buffer.from(content, 'utf8');
    if (data.byteLength > this.limits.maxWriteBytes)
      throw new ToolError('WRITE_LIMIT', '쓰기 한도를 초과했습니다.');
    let existing: Buffer | undefined;
    try {
      existing = await this.readBounded(file);
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
      throw new ToolError('HASH_CONFLICT', '파일 hash가 기대값과 다릅니다.');
    await fs.mkdir(dirname(file), { recursive: true });
    const temp = `${file}.mcpex-${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(temp, data, { flag: 'wx' });
    await fs.rename(temp, file);
    return { path, hash: digest(data), bytes: data.byteLength };
  }
  async replaceText(
    path: string,
    oldText: string,
    newText: string,
    expectedHash?: string,
  ): Promise<{ path: string; hash: string; replacements: number }> {
    if (!expectedHash)
      throw new ToolError(
        'EXPECTED_HASH_REQUIRED',
        '텍스트를 교체하려면 read_file로 확인한 expectedHash가 필요합니다.',
      );
    const file = await this.safePath(path);
    const data = await this.readBounded(file);
    if (digest(data) !== expectedHash)
      throw new ToolError('HASH_CONFLICT', '파일 hash가 기대값과 다릅니다.');
    const content = data.toString('utf8');
    const count = content.split(oldText).length - 1;
    if (count !== 1)
      throw new ToolError('MATCH_COUNT', 'oldText가 정확히 한 번만 일치해야 합니다.');
    const result = await this.writeFile(path, content.replace(oldText, newText), expectedHash);
    return { path, hash: result.hash, replacements: 1 };
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
    const spec = this.commands.find((item) => item.commandId === commandId);
    if (!spec) throw new ToolError('COMMAND_NOT_ALLOWED', '허용되지 않은 commandId입니다.');
    if (args.some((arg) => typeof arg !== 'string'))
      throw new ToolError('BAD_INPUT', 'args는 문자열 배열이어야 합니다.');
    const workdir = await this.safePath(cwd);
    return await new Promise((resolvePromise, reject) => {
      const environment = commandEnvironment();
      const child = spawn(spec.executable, args, {
        cwd: workdir,
        env: environment,
        shell: false,
        windowsHide: true,
      });
      const terminate = () => {
        if (child.pid && process.platform === 'win32')
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            env: environment,
            shell: false,
            windowsHide: true,
          });
        else child.kill();
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
      child.on('error', reject);
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolvePromise({
          commandId,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode,
          observation: {
            truncated: originalBytes > retainedBytes,
            originalBytes,
          },
        });
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
  if (!enabledToolNames.has(name))
    throw new ToolError('TOOL_NOT_ENABLED', `활성화되지 않은 도구입니다: ${name}`);
  validateWorkspaceToolArguments(name, args);
  switch (name) {
    case 'list_files':
      return tools.listFiles(
        typeof args.path === 'string' ? args.path : '.',
        typeof args.depth === 'number' ? args.depth : 1,
      );
    case 'read_file':
      return tools.readFile(
        String(args.path),
        typeof args.startLine === 'number' ? args.startLine : 1,
        typeof args.maxLines === 'number' ? args.maxLines : undefined,
      );
    case 'search_text':
      return tools.searchText(String(args.path), String(args.query));
    case 'write_file':
      return tools.writeFile(
        String(args.path),
        String(args.content),
        typeof args.expectedHash === 'string' ? args.expectedHash : undefined,
        args.createOnly === true,
      );
    case 'replace_text':
      return tools.replaceText(
        String(args.path),
        String(args.oldText),
        String(args.newText),
        typeof args.expectedHash === 'string' ? args.expectedHash : undefined,
      );
    case 'run_command':
      return tools.runCommand(
        String(args.commandId),
        Array.isArray(args.args) ? args.args.map(String) : [],
        typeof args.cwd === 'string' ? args.cwd : '.',
        signal,
      );
    default:
      throw new ToolError('UNKNOWN_TOOL', `알 수 없는 도구입니다: ${name}`);
  }
}
