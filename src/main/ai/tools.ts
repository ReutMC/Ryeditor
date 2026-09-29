/**
 * Ryeditor — command safety classifier + path guard + agent tool loop.
 *
 * Command classes:
 *  - SAFE          → run automatically
 *  - CONFIRMATION  → requires explicit user approval
 *  - DANGEROUS     → requires "elevated" permission AND explicit approval
 *  - BLOCKED       → never runs
 */

export type CommandClass = 'SAFE' | 'CONFIRMATION' | 'DANGEROUS' | 'BLOCKED';

const SAFE_RE: RegExp[] = [
  /^(ls|dir|pwd|cat|type|head|tail|wc|echo|whoami|hostname)\b/i,
  /^(git)\s+(status|log|diff|branch|show|remote|add|commit)\b/i,
  /^(node|npm|bun|pnpm|yarn|python|python3|pip)\s+(-v|--version)\b/i,
  /^(npm|pnpm|yarn|bun)\s+(run|test|lint|typecheck|tsc)\b/i,
  /^(tsc|eslint|prettier)\b/i,
  /^(cd)\b/i,
  /^(get-childitem|get-content|get-location|write-output)\b/i
];

const CONFIRMATION_RE: RegExp[] = [
  /^(npm|pnpm|yarn|bun|pip|pip3|cargo|dotnet|mvn|gradle)\s+(install|i|add|publish|build|start|dev|create)\b/i,
  /^(git)\s+(push|pull|fetch|clone|checkout|merge|rebase|reset|restore|rm|mv|init|tag)\b/i,
  /^(mkdir|mkdir|rmdir|cp|copy|mv|move|touch|rm|del|remove-item|new-item)\b/i,
  /^(node|python|python3|bun|deno)\s+\S+\.(js|ts|mjs|cjs|py)\b/i,
  /^(npx|bunx)\b/i,
  /^(start|open|code|xdg-open)\b/i,
  /^(curl|wget|invoke-webrequest|invoke-restmethod)\b/i
];

const DANGEROUS_RE: RegExp[] = [
  /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/i,
  /remove-item\s+.*-recurse.*-force/i,
  /rmdir\s+\/s/i,
  /(rd|del)\s+\/s\s+\/q/i,
  /\bformat\b.*:/i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /\bmkfs\b|\bdd\s+if=/i,
  /\b(volumes?|diskpart)\b/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i,
  /\bschtasks\b/i,
  /\btaskkill\b.*\/f/i,
  /chmod\s+-r\s+777/i,
  /\bgit\s+push\s+.*--force\b/i
];

const BLOCKED_RE: RegExp[] = [
  /rm\s+-[a-z]*r[a-z]*f\s+\/(\s|$)/i,
  /format\s+c:/i,
  /\bdd\s+if=.*of=\/dev\/[sh]d[a-z]/i,
  /:\(\)\{.*\};:/i, // fork bomb
  /\bdel\s+\/[fq]\s+c:\\(windows|users)\\?\s*$/i,
  /remove-item\s+c:\\(windows|users)/i
];

export function classifyCommand(cmd: string): CommandClass {
  const c = cmd.trim();
  if (!c) return 'SAFE';
  for (const re of BLOCKED_RE) if (re.test(c)) return 'BLOCKED';
  for (const re of DANGEROUS_RE) if (re.test(c)) return 'DANGEROUS';
  for (const re of SAFE_RE) if (re.test(c)) return 'SAFE';
  for (const re of CONFIRMATION_RE) if (re.test(c)) return 'CONFIRMATION';
  // Unknown commands default to CONFIRMATION (never silently run).
  return 'CONFIRMATION';
}

/** Resolve path and ensure it stays inside the workspace. Throws otherwise. */
export function safeJoin(workspace: string, rel: string): string {
  const path = require('path') as typeof import('path');
  const resolved = path.resolve(workspace, rel);
  const normWs = path.resolve(workspace);
  if (resolved !== normWs && !resolved.startsWith(normWs + path.sep)) {
    throw new Error(`Path escapes workspace: ${rel}`);
  }
  return resolved;
}

export type ToolName = 'read_file' | 'list_files' | 'write_file' | 'run_command';

export interface ToolCall {
  tool: ToolName;
  args: Record<string, string>;
}

/** Parse ```rytool {...}``` blocks emitted by the model. */
export function parseToolBlocks(text: string): { calls: ToolCall[]; cleaned: string } {
  const calls: ToolCall[] = [];
  const re = /```rytool\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      const j = JSON.parse(m[1].trim());
      if (j && typeof j.tool === 'string' && ['read_file', 'list_files', 'write_file', 'run_command'].includes(j.tool)) {
        calls.push({ tool: j.tool, args: j.args || {} });
      }
    } catch {
      /* malformed tool block — ignored */
    }
  }
  const cleaned = text.replace(/```rytool\s*[\s\S]*?```/g, '').trim();
  return { calls, cleaned };
}

export function systemPrompt(workspace: string | null, agentsMd: string, memory: string): string {
  const toolGuide = `You are Ryeditor Agent, an AI coding assistant inside the Ryeditor editor (workspace: ${workspace || 'none'}).

You can act on the workspace using tool blocks. To invoke a tool, emit EXACTLY this fenced block:
\`\`\`rytool
{"tool":"read_file","args":{"path":"src/index.ts"}}
\`\`\`
Available tools:
- read_file {path}            — read a workspace file
- list_files {path}           — list directory entries
- write_file {path, content}  — create/overwrite a file (requires user approval)
- run_command {command}       — run a shell command in the workspace (permission-classified)

Rules:
- Use one tool per block; you may emit multiple blocks.
- After tool results are provided, continue the task.
- Keep answers concise; use markdown code blocks for code.`;
  const extra = [agentsMd ? `# AGENTS.md (project instructions)\n${agentsMd}` : '', memory ? `# Project memory\n${memory}` : '']
    .filter(Boolean)
    .join('\n\n');
  return extra ? `${toolGuide}\n\n${extra}` : toolGuide;
}

export function toolResultMessage(tool: ToolName, args: Record<string, string>, result: string): ChatMessageLike {
  return {
    role: 'user',
    content: `TOOL RESULT for ${tool} ${JSON.stringify(args)}:\n${result.slice(0, 24000)}\n(Continue the task. If finished, summarize.)`
  };
}

export interface ChatMessageLike {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
