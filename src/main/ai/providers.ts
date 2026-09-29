/**
 * Ryeditor — AI provider abstraction.
 * Uniform streaming / non-streaming chat over:
 *  - OpenAI            (api.openai.com)
 *  - Anthropic         (api.anthropic.com)
 *  - Google Gemini     (generativelanguage.googleapis.com)
 *  - OpenAI-compatible (LM Studio, vLLM, LiteLLM, custom gateways)
 *  - Ollama            (local, free)
 */
import type { ProviderCfg } from '../settings';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamResult {
  text: string;
}

function baseUrlFor(p: ProviderCfg): string {
  const b = (p.baseUrl || '').trim();
  if (b) return b.replace(/\/+$/, '');
  switch (p.type) {
    case 'openai':
    case 'openai-compatible':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com';
    case 'ollama':
      return 'http://localhost:11434';
  }
}

function authHeaders(p: ProviderCfg): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (p.type === 'anthropic') {
    h['x-api-key'] = p.apiKey || '';
    h['anthropic-version'] = '2023-06-01';
  } else if (p.type === 'openai' || p.type === 'openai-compatible') {
    if (p.apiKey) h['Authorization'] = `Bearer ${p.apiKey}`;
  }
  return h;
}

/** Extract SSE "data:" payloads incrementally. */
class SSEParser {
  private buf = '';
  feed(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (line.startsWith('data:')) out.push(line.slice(5).trim());
    }
    return out;
  }
}

async function readSSE(
  res: Response,
  onEvent: (data: string) => void
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
      if (ev && ev !== '[DONE]') onEvent(ev);
    }
  }
}

async function readNDJSON(res: Response, onLine: (line: string) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  }
}

function jsonErrorContext(status: number, body: string): string {
  const trimmed = body.slice(0, 400);
  return `HTTP ${status} from AI provider: ${trimmed}`;
}

/** Streaming chat. Calls onDelta for each text chunk; resolves with full text. */
export async function streamChat(
  provider: ProviderCfg,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<StreamResult> {
  const base = baseUrlFor(provider);
  let full = '';

  const push = (t: string | undefined | null) => {
    if (t) {
      full += t;
      onDelta(t);
    }
  };

  if (provider.type === 'openai' || provider.type === 'openai-compatible') {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(provider),
      signal,
      body: JSON.stringify({ model: provider.model, messages, stream: true })
    });
    if (!res.ok) throw new Error(jsonErrorContext(res.status, await res.text()));
    await readSSE(res, (data) => {
      try {
        const j = JSON.parse(data);
        push(j.choices?.[0]?.delta?.content);
      } catch {
        /* ignore keepalives */
      }
    });
  } else if (provider.type === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(provider),
      signal,
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 4096,
        system: system || undefined,
        messages: rest,
        stream: true
      })
    });
    if (!res.ok) throw new Error(jsonErrorContext(res.status, await res.text()));
    await readSSE(res, (data) => {
      try {
        const j = JSON.parse(data);
        if (j.type === 'content_block_delta') push(j.delta?.text);
      } catch {
        /* ignore */
      }
    });
  } else if (provider.type === 'gemini') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const url = `${base}/v1beta/models/${encodeURIComponent(provider.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(provider.apiKey || '')}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ contents, systemInstruction: system ? { parts: [{ text: system }] } : undefined })
    });
    if (!res.ok) throw new Error(jsonErrorContext(res.status, await res.text()));
    await readSSE(res, (data) => {
      try {
        const j = JSON.parse(data);
        const parts = j.candidates?.[0]?.content?.parts || [];
        for (const p of parts) push(p.text);
      } catch {
        /* ignore */
      }
    });
  } else {
    // ollama — NDJSON streaming
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model: provider.model, messages, stream: true })
    });
    if (!res.ok) throw new Error(jsonErrorContext(res.status, await res.text()));
    await readNDJSON(res, (line) => {
      try {
        const j = JSON.parse(line);
        push(j.message?.content);
      } catch {
        /* ignore */
      }
    });
  }

  return { text: full };
}

/** Single-shot completion (non-streaming) — used for inline autocomplete. */
export async function completeOnce(
  provider: ProviderCfg,
  prompt: string,
  maxTokens: number,
  stops: string[],
  signal?: AbortSignal
): Promise<string> {
  const base = baseUrlFor(provider);
  const out = '';

  if (provider.type === 'openai' || provider.type === 'openai-compatible') {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(provider),
      signal,
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.2,
        stop: stops.length ? stops : undefined,
        stream: false
      })
    });
    if (!res.ok) throw new Error(jsonErrorContext(res.status, await res.text()));
    const j: any = await res.json();
    return (j.choices?.[0]?.message?.content as string) || out;
  }
  if (provider.type === 'anthropic') {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(provider),
      signal,
      body: JSON.stringify({
        model: provider.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        stop_sequences: stops.length ? stops : undefined
      })
    });
    if (!res.ok) throw new Error(jsonErrorContext(res.status, await res.text()));
    const j: any = await res.json();
    return (j.content?.map((c: { text?: string }) => c.text || '').join('') as string) || out;
  }
  if (provider.type === 'gemini') {
    const url = `${base}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey || '')}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2, stopSequences: stops.length ? stops : undefined }
      })
    });
    if (!res.ok) throw new Error(jsonErrorContext(res.status, await res.text()));
    const j: any = await res.json();
    const parts = j.candidates?.[0]?.content?.parts || [];
    return parts.map((p: { text?: string }) => p.text || '').join('');
  }
  // ollama
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { num_predict: maxTokens, temperature: 0.2, stop: stops.length ? stops : undefined }
    })
  });
  if (!res.ok) throw new Error(jsonErrorContext(res.status, await res.text()));
  const j: any = await res.json();
  return (j.message?.content as string) || out;
}
