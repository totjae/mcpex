import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { DataDirectoryLock, DpapiSecretStore, Storage } from '@mcpex/storage';
import { DatabaseSync } from 'node:sqlite';

describe('P0 storage and local auth', () => {
  it('creates schema v7 and preserves it after reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-'));
    const first = new Storage(dir);
    first.close();
    const second = new Storage(dir);
    expect(
      second.db.prepare('SELECT value FROM settings WHERE key = ?').get('schemaVersion'),
    ).toEqual({ value: '7' });
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a schema v1 runs table with a backup to snapshots, events, and retention', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-v1-'));
    const legacy = new DatabaseSync(join(dir, 'mcpex.db'));
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, '2026-01-01T00:00:00.000Z'); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('schemaVersion', '1'); CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_version_id TEXT, source TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, error_json TEXT, created_at TEXT NOT NULL, finished_at TEXT);",
    );
    legacy.close();
    const migrated = new Storage(dir);
    expect(
      migrated.db.prepare("SELECT value FROM settings WHERE key='schemaVersion'").get(),
    ).toEqual({ value: '7' });
    expect(
      migrated.db
        .prepare("SELECT name FROM pragma_table_info('runs') WHERE name='config_snapshot_json'")
        .get(),
    ).toEqual({ name: 'config_snapshot_json' });
    expect(
      migrated.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_events'")
        .get(),
    ).toEqual({ name: 'run_events' });
    expect(
      migrated.db
        .prepare("SELECT name FROM pragma_table_info('runs') WHERE name='events_expired_at'")
        .get(),
    ).toEqual({ name: 'events_expired_at' });
    expect(
      migrated.db
        .prepare("SELECT name FROM pragma_table_info('runs') WHERE name='started_at'")
        .get(),
    ).toEqual({ name: 'started_at' });
    expect(
      readdirSync(join(dir, 'backups')).some((name) => name.startsWith('migration-v1-to-v7-')),
    ).toBe(true);
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates v5 agents without losing historical run and version references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-v5-agents-'));
    const legacy = new DatabaseSync(join(dir, 'mcpex.db'));
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (5, '2026-01-01T00:00:00.000Z');
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('schemaVersion', '5');
      CREATE TABLE agents (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, tool_name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, draft_json TEXT NOT NULL, draft_revision INTEGER NOT NULL, applied_version_id TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_versions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT, version INTEGER NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(agent_id, version));
      CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT, agent_version_id TEXT, source TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, error_json TEXT, created_at TEXT NOT NULL, finished_at TEXT);
      INSERT INTO agents VALUES ('old-agent', 'Old', 'reusable_name', 0, '{}', 1, 'old-version', '2026-01-02', '2026-01-01', '2026-01-02');
      INSERT INTO agent_versions VALUES ('old-version', 'old-agent', 1, '{}', '2026-01-01');
      INSERT INTO runs VALUES ('old-run', 'old-agent', 'old-version', 'ui', 'completed', '{}', NULL, NULL, '2026-01-01', '2026-01-01');
    `);
    legacy.close();
    const migrated = new Storage(dir);
    expect(migrated.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(migrated.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(migrated.db.prepare('SELECT agent_id FROM runs WHERE id=?').get('old-run')).toEqual({
      agent_id: 'old-agent',
    });
    expect(
      migrated.db.prepare('SELECT agent_id FROM agent_versions WHERE id=?').get('old-version'),
    ).toEqual({ agent_id: 'old-agent' });
    const timestamp = new Date().toISOString();
    migrated.createAgent({
      id: 'new-agent',
      display_name: 'New',
      tool_name: 'reusable_name',
      enabled: 0,
      draft_json: '{}',
      draft_revision: 1,
      applied_version_id: null,
      deleted_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    expect(migrated.listAgents().map((agent) => agent.id)).toEqual(['new-agent']);
    expect(() =>
      migrated.createAgent({
        id: 'collision',
        display_name: 'Collision',
        tool_name: 'reusable_name',
        enabled: 0,
        draft_json: '{}',
        draft_revision: 1,
        applied_version_id: null,
        deleted_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      }),
    ).toThrow();
    expect(
      readdirSync(join(dir, 'backups')).some((name) => name.startsWith('migration-v5-to-v7-')),
    ).toBe(true);
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exchanges a one-time bootstrap token into an HttpOnly session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-'));
    const service = await createServer(dir);
    const deniedBootstrap = await service.app.inject({ method: 'POST', url: '/auth/bootstrap' });
    expect(deniedBootstrap.statusCode).toBe(401);
    const bootstrap = await service.app.inject({
      method: 'POST',
      url: '/auth/bootstrap',
      headers: { authorization: `Bearer ${getLocalAccessToken(dir)}` },
    });
    expect(bootstrap.statusCode).toBe(200);
    const token = JSON.parse(bootstrap.body).token as string;
    const exchange = await service.app.inject({
      method: 'POST',
      url: '/auth/exchange',
      headers: { host: 'localhost', origin: 'http://localhost', 'x-mcpex-csrf': '1' },
      payload: { token },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.headers['set-cookie']).toContain('mcpex_session=');
    const replay = await service.app.inject({
      method: 'POST',
      url: '/auth/exchange',
      headers: { host: 'localhost', origin: 'http://localhost', 'x-mcpex-csrf': '1' },
      payload: { token },
    });
    expect(replay.statusCode).toBe(401);
    const unauthenticated = await service.app.inject({ method: 'GET', url: '/api/v1/providers' });
    expect(unauthenticated.statusCode).toBe(401);
    const cookie = exchange.headers['set-cookie']?.split(';', 1)[0];
    const authenticated = await service.app.inject({
      method: 'GET',
      url: '/api/v1/providers',
      headers: { cookie: cookie ?? '' },
    });
    expect(authenticated.statusCode).toBe(200);
    const csrfRejected = await service.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { cookie: cookie ?? '' },
      payload: {},
    });
    expect(csrfRejected.statusCode).toBe(403);
    const hostRejected = await service.app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'attacker.example' },
    });
    expect(hostRejected.statusCode).toBe(403);
    const originalToken = getLocalAccessToken(dir);
    const rotatedToken = 'rotated-local-access-token';
    new DpapiSecretStore(dir).set('mcpex:local-access-token', rotatedToken);
    const staleToken = await service.app.inject({
      method: 'POST',
      url: '/auth/bootstrap',
      headers: { authorization: `Bearer ${originalToken}` },
    });
    expect(staleToken.statusCode).toBe(401);
    const refreshedToken = await service.app.inject({
      method: 'POST',
      url: '/auth/bootstrap',
      headers: { authorization: `Bearer ${rotatedToken}` },
    });
    expect(refreshedToken.statusCode).toBe(200);
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the built web UI and blocks path traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-web-'));
    const webDist = join(dir, 'web');
    mkdirSync(webDist);
    writeFileSync(join(webDist, 'index.html'), '<main>MCPex UI</main>');
    const service = await createServer(join(dir, 'data'), { webDist });
    const page = await service.app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('MCPex UI');
    const escaped = await service.app.inject({
      method: 'GET',
      url: '/%2e%2e%5csecrets.json',
    });
    expect(escaped.statusCode).toBe(404);
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('recovers stale locks, rejects live owners, and releases locks after initialization failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-lock-'));
    writeFileSync(join(dir, 'service.lock'), '2147483647\n');
    const recovered = new DataDirectoryLock(dir);
    recovered.acquire();
    const contender = new DataDirectoryLock(dir);
    expect(() => contender.acquire()).toThrow('DATA_DIR_LOCKED');
    recovered.release();

    if (process.platform === 'win32') {
      const reusedPidLock = join(dir, 'service.lock');
      writeFileSync(reusedPidLock, `${process.pid}\n`);
      const beforeCurrentProcess = new Date('2000-01-01T00:00:00.000Z');
      utimesSync(reusedPidLock, beforeCurrentProcess, beforeCurrentProcess);
      const reusedPidRecovery = new DataDirectoryLock(dir);
      reusedPidRecovery.acquire();
      expect(JSON.parse(readFileSync(reusedPidLock, 'utf8'))).toMatchObject({
        version: 1,
        pid: process.pid,
        executable: process.execPath,
      });
      expect(() => new DataDirectoryLock(dir).acquire()).toThrow('DATA_DIR_LOCKED');
      reusedPidRecovery.release();
    }

    const storage = new Storage(dir);
    storage.db
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(999, new Date().toISOString());
    storage.close();
    await expect(createServer(dir)).rejects.toThrow('UNSUPPORTED_DATABASE_VERSION');
    expect(existsSync(join(dir, 'service.lock'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks unfinished runs as interrupted when the service restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-restart-'));
    const storage = new Storage(dir);
    const createdAt = new Date().toISOString();
    storage.createAgent({
      id: 'agent-restart',
      display_name: 'Restart agent',
      tool_name: 'restart_agent',
      enabled: 0,
      draft_json: '{}',
      draft_revision: 1,
      applied_version_id: null,
      deleted_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    });
    storage.createRun({
      id: 'run-restart',
      agent_id: 'agent-restart',
      agent_version_id: null,
      source: 'ui',
      status: 'running',
      input_json: '{}',
      output_json: null,
      error_json: null,
      created_at: createdAt,
      finished_at: null,
      config_snapshot_json: null,
    });
    storage.close();

    const service = await createServer(dir);
    const detail = await service.app.inject({
      method: 'GET',
      url: '/api/v1/runs/run-restart',
      headers: { authorization: `Bearer ${getLocalAccessToken(dir)}` },
    });
    expect(JSON.parse(detail.body)).toMatchObject({
      status: 'interrupted',
      error: { code: 'SERVICE_RESTARTED' },
    });
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
