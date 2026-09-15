import { backup, DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from '@mcpex/contracts';

type LockOwner = {
  version?: 1;
  pid: number;
  processStartedAt?: string;
  executable?: string;
  token?: string;
};

function parseLockOwner(value: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<LockOwner>;
    if (Number.isSafeInteger(parsed?.pid) && (parsed.pid as number) > 0)
      return {
        pid: parsed.pid as number,
        ...(parsed.version === 1 ? { version: 1 as const } : {}),
        ...(typeof parsed.processStartedAt === 'string'
          ? { processStartedAt: parsed.processStartedAt }
          : {}),
        ...(typeof parsed.executable === 'string' ? { executable: parsed.executable } : {}),
        ...(typeof parsed.token === 'string' ? { token: parsed.token } : {}),
      };
  } catch {}
  const pid = Number.parseInt(value.trim(), 10);
  if (Number.isSafeInteger(pid) && pid > 0) return { pid };
  return undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function windowsProcessIdentity(
  pid: number,
): { processStartedAt: number; executable?: string } | undefined {
  const script =
    "$targetPid=[int][Console]::In.ReadToEnd(); $process=Get-Process -Id $targetPid -ErrorAction Stop; [Console]::Out.WriteLine($process.StartTime.ToUniversalTime().ToString('o')); [Console]::Out.Write($process.Path)";
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: String(pid), encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) return undefined;
  const [startedAt, ...pathParts] = result.stdout.trim().split(/\r?\n/);
  const processStartedAt = Date.parse(startedAt ?? '');
  if (!Number.isFinite(processStartedAt)) return undefined;
  const executable = pathParts.join('\n').trim();
  return { processStartedAt, ...(executable ? { executable } : {}) };
}

function sameWindowsProcess(owner: LockOwner, lockModifiedAt: number): boolean | undefined {
  if (process.platform !== 'win32') return undefined;
  const identity = windowsProcessIdentity(owner.pid);
  if (!identity) return undefined;
  if (!owner.processStartedAt) return identity.processStartedAt <= lockModifiedAt + 2_000;
  const recordedStart = Date.parse(owner.processStartedAt);
  if (!Number.isFinite(recordedStart)) return false;
  const sameStart = Math.abs(recordedStart - identity.processStartedAt) <= 2_000;
  const sameExecutable =
    !owner.executable ||
    !identity.executable ||
    resolve(owner.executable).toLowerCase() === resolve(identity.executable).toLowerCase();
  return sameStart && sameExecutable;
}

export class DataDirectoryLock {
  private readonly path: string;
  private fd: number | undefined;
  private token: string | undefined;
  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, 'service.lock');
  }
  acquire(): void {
    mkdirSync(this.dataDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.token = randomUUID();
        this.fd = openSync(this.path, 'wx');
        writeFileSync(
          this.fd,
          `${JSON.stringify({
            version: 1,
            pid: process.pid,
            processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
            executable: process.execPath,
            token: this.token,
          } satisfies LockOwner)}\n`,
        );
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (this.fd !== undefined) {
          closeSync(this.fd);
          this.fd = undefined;
          this.token = undefined;
          if (existsSync(this.path)) unlinkSync(this.path);
          throw error;
        }
        if (code !== 'EEXIST' || attempt > 0) throw new Error('DATA_DIR_LOCKED');
        const lockText = readFileSync(this.path, 'utf8');
        const owner = parseLockOwner(lockText);
        let alive = owner ? processIsAlive(owner.pid) : false;
        if (alive && owner) alive = sameWindowsProcess(owner, statSync(this.path).mtimeMs) ?? alive;
        if (alive) throw new Error('DATA_DIR_LOCKED');
        if (readFileSync(this.path, 'utf8') === lockText) unlinkSync(this.path);
      }
    }
  }
  release(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
      if (existsSync(this.path)) {
        const owner = parseLockOwner(readFileSync(this.path, 'utf8'));
        if (this.token && owner?.token === this.token) unlinkSync(this.path);
      }
      this.token = undefined;
    }
  }
}

export class Storage {
  readonly db: DatabaseSync;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'mcpex.db'));
    try {
      this.db.exec(
        'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
      );
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version?: number;
    };
    let version = row.version ?? 0;
    if (version > SCHEMA_VERSION) throw new Error('UNSUPPORTED_DATABASE_VERSION');
    if (version > 0 && version < SCHEMA_VERSION) this.createMigrationBackup(version);
    if (version < 1) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(
          "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('schemaVersion', '1')",
        );
        this.db
          .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
          .run(1, new Date().toISOString());
        this.db.exec('COMMIT');
        version = 1;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter TEXT NOT NULL, location TEXT NOT NULL, config_json TEXT NOT NULL, credential_ref TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT, model_id TEXT NOT NULL, label TEXT NOT NULL, defaults_json TEXT NOT NULL, capabilities_json TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider_id, model_id)); CREATE INDEX IF NOT EXISTS models_provider_id ON models(provider_id);`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, tool_name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, draft_json TEXT NOT NULL, draft_revision INTEGER NOT NULL, applied_version_id TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_versions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT, version INTEGER NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(agent_id, version)); CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, origin TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, config_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT, agent_version_id TEXT, source TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, error_json TEXT, created_at TEXT NOT NULL, finished_at TEXT); CREATE INDEX IF NOT EXISTS runs_agent_id ON runs(agent_id, created_at);`,
    );
    if (version < 2) {
      this.db.exec('BEGIN');
      try {
        this.db.exec('ALTER TABLE runs ADD COLUMN config_snapshot_json TEXT');
        this.db.prepare("UPDATE settings SET value='2' WHERE key='schemaVersion'").run();
        this.db
          .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
          .run(2, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    if (version < 3) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(
          'CREATE TABLE run_events (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id, seq)); CREATE INDEX run_events_created_at ON run_events(created_at)',
        );
        this.db.prepare("UPDATE settings SET value='3' WHERE key='schemaVersion'").run();
        this.db
          .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
          .run(3, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    if (version < 4) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(
          'ALTER TABLE runs ADD COLUMN content_purged_at TEXT; ALTER TABLE runs ADD COLUMN events_expired_at TEXT',
        );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('retentionDays', '30'), ('globalConcurrency', '2'), ('maxPendingRuns', '100')",
          )
          .run();
        this.db.prepare("UPDATE settings SET value='4' WHERE key='schemaVersion'").run();
        this.db
          .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
          .run(4, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }
  private createMigrationBackup(fromVersion: number): void {
    const directory = join(this.dataDir, 'backups');
    mkdirSync(directory, { recursive: true });
    const path = join(
      directory,
      `migration-v${fromVersion}-to-v${SCHEMA_VERSION}-${Date.now()}-${randomUUID()}.db`,
    );
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  }
  listProviders(): ProviderRow[] {
    return this.db.prepare('SELECT * FROM providers ORDER BY name').all() as ProviderRow[];
  }
  getProvider(id: string): ProviderRow | undefined {
    return this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      ProviderRow | undefined;
  }
  createProvider(row: ProviderRow): void {
    this.db
      .prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        row.id,
        row.name,
        row.adapter,
        row.location,
        row.config_json,
        row.credential_ref,
        row.revision,
        row.created_at,
        row.updated_at,
      );
  }
  updateProvider(row: ProviderRow, expectedRevision: number): boolean {
    const result = this.db
      .prepare(
        'UPDATE providers SET name=?, adapter=?, location=?, config_json=?, credential_ref=?, revision=?, updated_at=? WHERE id=? AND revision=?',
      )
      .run(
        row.name,
        row.adapter,
        row.location,
        row.config_json,
        row.credential_ref,
        row.revision,
        row.updated_at,
        row.id,
        expectedRevision,
      ) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }
  deleteProvider(id: string): boolean {
    const result = this.db.prepare('DELETE FROM providers WHERE id=?').run(id) as {
      changes?: number;
    };
    return (result.changes ?? 0) === 1;
  }
  listModels(providerId?: string): ModelRow[] {
    return (
      providerId
        ? this.db.prepare('SELECT * FROM models WHERE provider_id=? ORDER BY label').all(providerId)
        : this.db.prepare('SELECT * FROM models ORDER BY label').all()
    ) as ModelRow[];
  }
  getModel(id: string): ModelRow | undefined {
    return this.db.prepare('SELECT * FROM models WHERE id=?').get(id) as ModelRow | undefined;
  }
  createModel(row: ModelRow): void {
    this.db
      .prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        row.id,
        row.provider_id,
        row.model_id,
        row.label,
        row.defaults_json,
        row.capabilities_json,
        row.revision,
        row.created_at,
        row.updated_at,
      );
  }
  updateModel(row: ModelRow, expectedRevision: number): boolean {
    const result = this.db
      .prepare(
        'UPDATE models SET model_id=?, label=?, defaults_json=?, capabilities_json=?, revision=?, updated_at=? WHERE id=? AND revision=?',
      )
      .run(
        row.model_id,
        row.label,
        row.defaults_json,
        row.capabilities_json,
        row.revision,
        row.updated_at,
        row.id,
        expectedRevision,
      ) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }
  deleteModel(id: string): boolean {
    const result = this.db.prepare('DELETE FROM models WHERE id=?').run(id) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }
  countModels(providerId: string): number {
    return Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM models WHERE provider_id=?')
          .get(providerId) as { count: number }
      ).count,
    );
  }
  countAgentModelReferences(modelId: string): number {
    return Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(DISTINCT agents.id) AS count
             FROM agents
             LEFT JOIN agent_versions ON agent_versions.id = agents.applied_version_id
             WHERE agents.deleted_at IS NULL
               AND (
                 json_extract(agents.draft_json, '$.modelRef') = ?
                 OR json_extract(agent_versions.config_json, '$.modelRef') = ?
                 OR json_extract(agent_versions.config_json, '$.agent.modelRef') = ?
               )`,
          )
          .get(modelId, modelId, modelId) as { count: number }
      ).count,
    );
  }
  listAgents(): AgentRow[] {
    return this.db
      .prepare('SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY display_name')
      .all() as AgentRow[];
  }
  getAgent(id: string): AgentRow | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE id=? AND deleted_at IS NULL').get(id) as
      AgentRow | undefined;
  }
  createAgent(row: AgentRow): void {
    this.db
      .prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        row.id,
        row.display_name,
        row.tool_name,
        row.enabled,
        row.draft_json,
        row.draft_revision,
        row.applied_version_id,
        row.deleted_at,
        row.created_at,
        row.updated_at,
      );
  }
  updateAgentDraft(row: AgentRow, expectedRevision: number): boolean {
    const result = this.db
      .prepare(
        'UPDATE agents SET display_name=?, tool_name=?, draft_json=?, draft_revision=?, updated_at=? WHERE id=? AND draft_revision=? AND deleted_at IS NULL',
      )
      .run(
        row.display_name,
        row.tool_name,
        row.draft_json,
        row.draft_revision,
        row.updated_at,
        row.id,
        expectedRevision,
      ) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }
  softDeleteAgent(id: string): boolean {
    const timestamp = nowText();
    const result = this.db
      .prepare(
        'UPDATE agents SET deleted_at=?, updated_at=? WHERE id=? AND enabled=0 AND deleted_at IS NULL',
      )
      .run(timestamp, timestamp, id) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }
  setAgentApplied(id: string, versionId: string): void {
    this.db
      .prepare('UPDATE agents SET applied_version_id=?, updated_at=? WHERE id=?')
      .run(versionId, nowText(), id);
  }
  setAgentEnabled(id: string, enabled: boolean): boolean {
    const result = this.db
      .prepare(
        'UPDATE agents SET enabled=?, updated_at=? WHERE id=? AND applied_version_id IS NOT NULL AND deleted_at IS NULL',
      )
      .run(enabled ? 1 : 0, nowText(), id) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }
  createAgentVersion(row: AgentVersionRow): void {
    this.db
      .prepare('INSERT INTO agent_versions VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.agent_id, row.version, row.config_json, row.created_at);
  }
  applyAgentVersion(row: AgentVersionRow): void {
    this.db.exec('BEGIN');
    try {
      this.createAgentVersion(row);
      this.setAgentApplied(row.agent_id, row.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  latestAgentVersion(agentId: string): AgentVersionRow | undefined {
    return this.db
      .prepare('SELECT * FROM agent_versions WHERE agent_id=? ORDER BY version DESC LIMIT 1')
      .get(agentId) as AgentVersionRow | undefined;
  }
  getAgentVersion(id: string): AgentVersionRow | undefined {
    return this.db.prepare('SELECT * FROM agent_versions WHERE id=?').get(id) as
      AgentVersionRow | undefined;
  }
  listTemplates(): TemplateRow[] {
    return this.db.prepare('SELECT * FROM templates ORDER BY name').all() as TemplateRow[];
  }
  getTemplate(id: string): TemplateRow | undefined {
    return this.db.prepare('SELECT * FROM templates WHERE id=?').get(id) as TemplateRow | undefined;
  }
  createTemplate(row: TemplateRow): void {
    this.db
      .prepare('INSERT INTO templates VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.origin, row.name, row.version, row.config_json, row.updated_at);
  }
  updateTemplate(row: TemplateRow, expectedVersion: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE templates SET name=?, version=?, config_json=?, updated_at=? WHERE id=? AND version=? AND origin='user'",
      )
      .run(row.name, row.version, row.config_json, row.updated_at, row.id, expectedVersion) as {
      changes?: number;
    };
    return (result.changes ?? 0) === 1;
  }
  deleteTemplate(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM templates WHERE id=? AND origin='user'")
      .run(id) as {
      changes?: number;
    };
    return (result.changes ?? 0) === 1;
  }
  getSetting(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  setSettings(values: Record<string, string>): void {
    this.db.exec('BEGIN');
    try {
      const statement = this.db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      );
      for (const [key, value] of Object.entries(values)) statement.run(key, value);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  applyConfigImport(rows: ConfigImportRows): void {
    this.db.exec('BEGIN');
    try {
      for (const row of rows.providers) this.createProvider(row);
      for (const row of rows.models) this.createModel(row);
      for (const row of rows.agents) this.createAgent(row);
      for (const row of rows.templates) this.createTemplate(row);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private insertRunEvent(runId: string, type: string, payloadJson: string): RunEventRow {
    const seq = Number(
      (
        this.db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id=?')
          .get(runId) as { seq: number }
      ).seq,
    );
    const event = {
      run_id: runId,
      seq,
      type,
      payload_json: payloadJson,
      created_at: nowText(),
    };
    this.db
      .prepare('INSERT INTO run_events VALUES (?, ?, ?, ?, ?)')
      .run(event.run_id, event.seq, event.type, event.payload_json, event.created_at);
    return event;
  }
  appendRunEvent(runId: string, type: string, payloadJson: string): RunEventRow {
    this.db.exec('BEGIN');
    try {
      const event = this.insertRunEvent(runId, type, payloadJson);
      this.db.exec('COMMIT');
      return event;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  createRun(row: RunRow): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO runs (id, agent_id, agent_version_id, source, status, input_json, output_json, error_json, created_at, finished_at, config_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          row.id,
          row.agent_id,
          row.agent_version_id,
          row.source,
          row.status,
          row.input_json,
          row.output_json,
          row.error_json,
          row.created_at,
          row.finished_at,
          row.config_snapshot_json,
        );
      this.insertRunEvent(row.id, 'run.queued', JSON.stringify({ status: row.status }));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  startRun(id: string): boolean {
    this.db.exec('BEGIN');
    try {
      const result = this.db
        .prepare("UPDATE runs SET status='running' WHERE id=? AND status='queued'")
        .run(id) as { changes?: number };
      const changed = (result.changes ?? 0) === 1;
      if (changed) this.insertRunEvent(id, 'run.started', JSON.stringify({ status: 'running' }));
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  finishRun(id: string, status: string, outputJson: string | null, errorJson: string | null): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('UPDATE runs SET status=?, output_json=?, error_json=?, finished_at=? WHERE id=?')
        .run(status, outputJson, errorJson, nowText(), id);
      this.insertRunEvent(id, 'run.finished', JSON.stringify({ status }));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  interruptUnfinishedRuns(): number {
    const unfinished = this.db
      .prepare("SELECT id FROM runs WHERE status IN ('queued', 'running')")
      .all() as Array<{ id: string }>;
    if (!unfinished.length) return 0;
    this.db.exec('BEGIN');
    try {
      const result = this.db
        .prepare(
          "UPDATE runs SET status='interrupted', error_json=?, finished_at=? WHERE status IN ('queued', 'running')",
        )
        .run(
          JSON.stringify({
            code: 'SERVICE_RESTARTED',
            message: '서비스 재시작으로 실행이 중단되었습니다.',
          }),
          nowText(),
        ) as { changes?: number };
      for (const run of unfinished)
        this.insertRunEvent(run.id, 'run.finished', JSON.stringify({ status: 'interrupted' }));
      this.db.exec('COMMIT');
      return result.changes ?? 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  getRun(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as RunRow | undefined;
  }
  listRuns(agentId?: string, limit = 100): RunRow[] {
    return (
      agentId
        ? this.db
            .prepare('SELECT * FROM runs WHERE agent_id=? ORDER BY created_at DESC LIMIT ?')
            .all(agentId, limit)
        : this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as RunRow[];
  }
  listRunEvents(runId: string, afterSeq = 0): RunEventRow[] {
    return this.db
      .prepare('SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq')
      .all(runId, afterSeq) as RunEventRow[];
  }
  purgeExpiredRunContent(cutoff: string): { runs: number; events: number } {
    const rows = this.db
      .prepare(
        "SELECT id FROM runs WHERE status IN ('completed', 'failed', 'cancelled', 'timed_out', 'interrupted') AND finished_at IS NOT NULL AND finished_at < ? AND content_purged_at IS NULL",
      )
      .all(cutoff) as Array<{ id: string }>;
    if (!rows.length) return { runs: 0, events: 0 };
    this.db.exec('BEGIN');
    try {
      const timestamp = nowText();
      const deleteEvents = this.db.prepare('DELETE FROM run_events WHERE run_id=?');
      const purgeRun = this.db.prepare(
        "UPDATE runs SET input_json='{}', output_json=NULL, error_json=NULL, config_snapshot_json=NULL, content_purged_at=?, events_expired_at=? WHERE id=?",
      );
      let events = 0;
      for (const row of rows) {
        events += (deleteEvents.run(row.id) as { changes?: number }).changes ?? 0;
        purgeRun.run(timestamp, timestamp, row.id);
      }
      this.db.exec('COMMIT');
      return { runs: rows.length, events };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async createBackup(): Promise<BackupResult> {
    const directory = join(this.dataDir, 'backups');
    mkdirSync(directory, { recursive: true });
    const fileName = `mcpex-${Date.now()}-${randomUUID()}.db`;
    const path = join(directory, fileName);
    const pages = await backup(this.db, path);
    return { fileName, path, pages, bytes: statSync(path).size, createdAt: nowText() };
  }
  close(): void {
    this.db.close();
  }
}

const nowText = () => new Date().toISOString();

export type ProviderRow = {
  id: string;
  name: string;
  adapter: string;
  location: string;
  config_json: string;
  credential_ref: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
export type ModelRow = {
  id: string;
  provider_id: string;
  model_id: string;
  label: string;
  defaults_json: string;
  capabilities_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
export type AgentRow = {
  id: string;
  display_name: string;
  tool_name: string;
  enabled: number;
  draft_json: string;
  draft_revision: number;
  applied_version_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};
export type AgentVersionRow = {
  id: string;
  agent_id: string;
  version: number;
  config_json: string;
  created_at: string;
};
export type TemplateRow = {
  id: string;
  origin: string;
  name: string;
  version: number;
  config_json: string;
  updated_at: string;
};
export type RunRow = {
  id: string;
  agent_id: string;
  agent_version_id: string | null;
  source: string;
  status: string;
  input_json: string;
  output_json: string | null;
  error_json: string | null;
  created_at: string;
  finished_at: string | null;
  config_snapshot_json: string | null;
  content_purged_at?: string | null;
  events_expired_at?: string | null;
};
export type RunEventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
  created_at: string;
};

export type ConfigImportRows = {
  providers: ProviderRow[];
  models: ModelRow[];
  agents: AgentRow[];
  templates: TemplateRow[];
};

export type BackupResult = {
  fileName: string;
  path: string;
  pages: number;
  bytes: number;
  createdAt: string;
};

export interface SecretStore {
  set(name: string, value: string): void;
  get(name: string): string | undefined;
  delete(name: string): void;
}
export class DpapiSecretStore implements SecretStore {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'secrets.json');
  }
  private transform(mode: 'Protect' | 'Unprotect', value: string, encoded = false): string {
    if (process.platform !== 'win32') throw new Error('DPAPI_REQUIRES_WINDOWS');
    const script = `Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($raw); $out=[Security.Cryptography.ProtectedData]::${mode}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($out))`;
    const input = encoded ? value : Buffer.from(value).toString('base64');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input,
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`DPAPI_${mode.toUpperCase()}_FAILED`);
    return r.stdout.trim();
  }
  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
  }
  set(name: string, value: string): void {
    const all = this.read();
    all[name] = this.transform('Protect', value);
    writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }
  get(name: string): string | undefined {
    const value = this.read()[name];
    return value === undefined
      ? undefined
      : Buffer.from(this.transform('Unprotect', value, true), 'base64').toString('utf8');
  }
  revision(name: string): string | undefined {
    const value = this.read()[name];
    return value === undefined ? undefined : createHash('sha256').update(value).digest('base64url');
  }
  delete(name: string): void {
    const all = this.read();
    delete all[name];
    writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }
}
