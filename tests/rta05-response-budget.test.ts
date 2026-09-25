import { describe, expect, it } from 'vitest';
import { boundedResponseText, ProviderError } from '@mcpex/providers';
import { runToolLoop } from '@mcpex/runtime';

describe('RTA-05 bounded provider and conversation input', () => {
  it('counts received bytes even when Content-Length is false and preserves multibyte text', async () => {
    expect(await boundedResponseText(new Response('가나'))).toBe('가나');
    const cancelled = { value: false };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled.value = true;
      },
    });
    await expect(
      boundedResponseText(new Response(body, { headers: { 'content-length': '1' } })),
    ).rejects.toMatchObject<ProviderError>({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
    expect(cancelled.value).toBe(true);
  });

  it('stops repeated small model turns at the cumulative budget', async () => {
    await expect(
      runToolLoop({
        initialMessages: [],
        tools: [],
        maxTurns: 20,
        generate: async () => ({
          text: 'a'.repeat(450 * 1024),
          toolCalls: [{ id: 'repeat', name: 'read_file', arguments: {} }],
          finishReason: 'tool_calls',
          usage: null,
          providerRequestId: null,
        }),
        execute: async () => 'ok',
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_LIMIT' });
  });
});
