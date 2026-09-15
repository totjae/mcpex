import type { FastifyInstance } from 'fastify';

export type RunDetail = {
  id: string;
  status: string;
  output: unknown;
  error: { code?: string; message?: string } | null;
  configSnapshot?: Record<string, unknown> | null;
};

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);

export async function waitForRun(
  app: FastifyInstance,
  headers: Record<string, string>,
  runId: string,
): Promise<RunDetail> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}`, headers });
    const run = JSON.parse(response.body) as RunDetail;
    if (terminalStatuses.has(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${runId} did not reach a terminal state`);
}
