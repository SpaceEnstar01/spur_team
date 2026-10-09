import { assertAudioAgentHttpsForRelease, AUDIO_AGENT_BASE_URL } from '@/config/api';

/**
 * 悬浮窗听写：云端大模型流式 STT（sauc/bigmodel）→ 文字意图。
 * 不做 Typeless 清洗；不是 S2S。
 */
export async function captureVoiceIntent(input: {
  uri: string;
  name?: string;
  signal?: AbortSignal;
}): Promise<{ transcript: string; intent: string }> {
  const name = input.name || 'dictation.m4a';
  const body = new FormData();
  body.append('audio', {
    uri: input.uri,
    name,
    type: mimeTypeForAudioName(name)
  } as unknown as Blob);

  assertAudioAgentHttpsForRelease();
  const payload = await postJsonOrForm(`${AUDIO_AGENT_BASE_URL}/api/assistant/voice-intent`, {
    method: 'POST',
    body,
    signal: input.signal,
    timeoutMs: 180_000
  });
  const record = payload as { transcript?: unknown; intent?: unknown };
  const intent =
    (typeof record.intent === 'string' && record.intent.trim()) ||
    (typeof record.transcript === 'string' && record.transcript.trim()) ||
    '';
  if (!intent) {
    throw new Error('Cloud response missing voice intent text');
  }
  return {
    transcript: typeof record.transcript === 'string' ? record.transcript : intent,
    intent
  };
}

/** 按用户文字意图改写当前卡片结果（文字或图片）。 */
export async function rewriteCardResult(input: {
  instruction: string;
  transcript?: string;
  previousOutput?: string;
  title?: string;
  rewriteImage?: boolean;
}): Promise<{ output: string; imageUrl?: string }> {
  assertAudioAgentHttpsForRelease();
  const body = {
    instruction: input.instruction,
    transcript: input.transcript,
    previousOutput: input.previousOutput,
    title: input.title,
    rewriteImage: Boolean(input.rewriteImage),
    hasImage: Boolean(input.rewriteImage)
  };

  try {
    const payload = await postJsonOrForm(`${AUDIO_AGENT_BASE_URL}/api/assistant/rewrite-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 300_000
    });
    return readRewritePayload(payload, Boolean(input.rewriteImage));
  } catch (error) {
    if (!isMissingRouteError(error)) throw error;
  }

  // Older cloud without rewriteImage: fall back to skill-refine image / document.
  const payload = await postJsonOrForm(`${AUDIO_AGENT_BASE_URL}/api/assistant/skill-refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instruction: input.instruction,
      transcript: input.transcript,
      previousOutput: input.previousOutput,
      title: input.title,
      skill: input.rewriteImage ? 'image' : 'document'
    }),
    timeoutMs: 300_000
  });
  return readRewritePayload(payload, Boolean(input.rewriteImage));
}

async function postJsonOrForm(
  url: string,
  init: {
    method: 'POST';
    headers?: Record<string, string>;
    body: FormData | string;
    timeoutMs: number;
    signal?: AbortSignal;
  }
): Promise<unknown> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener('abort', onAbort);
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120);
      throw new Error(
        `Cloud returned non-JSON (HTTP ${response.status})${snippet ? `: ${snippet}` : ''}`
      );
    }
    if (!response.ok) {
      throw new HttpApiError(
        response.status,
        readError(payload) || `Cloud request failed (HTTP ${response.status})`
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (init.signal?.aborted) throw new Error('Request cancelled');
      throw new Error('Cloud request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

function readRewritePayload(
  payload: unknown,
  expectImage: boolean
): { output: string; imageUrl?: string } {
  const record = payload as { output?: unknown; imageUrl?: unknown };
  const output = typeof record.output === 'string' ? record.output : '';
  const imageUrl = typeof record.imageUrl === 'string' ? record.imageUrl : undefined;
  if (expectImage) {
    if (!imageUrl) throw new Error('Cloud response missing rewritten image');
    return { output: output.trim() || 'Image updated', imageUrl };
  }
  if (!output.trim()) throw new Error('Cloud response missing rewritten output');
  return { output, imageUrl };
}

function isMissingRouteError(error: unknown): boolean {
  if (error instanceof HttpApiError && error.status === 404) return true;
  if (!(error instanceof Error)) return false;
  return /non-JSON \(HTTP 404\)/i.test(error.message) || /\bNot found\b/i.test(error.message);
}

class HttpApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpApiError';
  }
}

function mimeTypeForAudioName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4') || lower.endsWith('.aac')) return 'audio/mp4';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.webm')) return 'audio/webm';
  return 'audio/mp4';
}

function readError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' ? error : null;
}
