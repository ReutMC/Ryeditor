/**
 * Ryeditor — Electron main process.
 * Window lifecycle, IPC registration, AI orchestration (Ask / Plan / Agent), smoke test.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, Settings, getMemory } from './settings';
import { ChatMessage, completeOnce, streamChat } from './ai/providers';
import {
  ChatMessageLike,
  classifyCommand,
  parseToolBlocks,
  safeJoin,
  systemPrompt,
  toolResultMessage,
  ToolName
} from './ai/tools';
import * as fsapi from './fsapi';
import * as term from './terminal';

let win: BrowserWindow | null = null;
const isSmoke = process.argv.includes('--smoke-test');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    title: 'Ryeditor',
    backgroundColor: '#0B1220',
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isSmoke) {
    let rendererErrors = 0;
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:console] L${level} ${message} (${sourceId}:${line})`);
      if (level >= 3) rendererErrors++;
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        if (rendererErrors > 0) {
          console.error(`RYEDITOR_SMOKE_FAILED renderer_errors=${rendererErrors}`);
          app.exit(2);
        } else {
          console.log('RYEDITOR_SMOKE_OK');
          app.exit(0);
        }
      }, 1500);
    });
    setTimeout(() => {
      console.error('RYEDITOR_SMOKE_TIMEOUT');
      app.exit(1);
    }, 30000);
  }
}

// ---------------------------------------------------------------------------
// Settings / workspace
// ---------------------------------------------------------------------------
ipcMain.handle('settings:load', () => loadSettings());
ipcMain.handle('settings:save', (_e, s: Settings) => {
  saveSettings(s);
  return true;
});

ipcMain.handle('workspace:open', async () => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

// fs
ipcMain.handle('fs:list', (_e, ws: string, rel: string) => fsapi.listDir(ws, rel || '.'));
ipcMain.handle('fs:read', (_e, ws: string, rel: string) => fsapi.readFile(ws, rel));
ipcMain.handle('fs:write', (_e, ws: string, rel: string, content: string) => {
  fsapi.writeFile(ws, rel, content);
  return true;
});
ipcMain.handle('fs:mkdir', (_e, ws: string, rel: string) => {
  fsapi.mkdirp(ws, rel);
  return true;
});
ipcMain.handle('fs:delete', (_e, ws: string, rel: string) => {
  fsapi.deletePath(ws, rel);
  return true;
});
ipcMain.handle('fs:rename', (_e, ws: string, fromRel: string, toRel: string) => {
  fsapi.renamePath(ws, fromRel, toRel);
  return true;
});
ipcMain.handle('fs:exists', (_e, ws: string, rel: string) => fsapi.exists(ws, rel));
ipcMain.handle('checkpoint:undo', (_e, ws: string) => {
  const cp = fsapi.popCheckpoint(ws);
  return cp ? cp.path : null;
});
ipcMain.handle('checkpoint:has', () => fsapi.hasCheckpoints());

// terminal
ipcMain.handle('terminal:backend', () => term.terminalBackendName());
ipcMain.handle('terminal:create', (e, id: string, cwd?: string) => {
  const s = term.createSession(
    id,
    cwd,
    (sid, d) => e.sender.send('terminal:data', sid, d),
    (sid, code) => e.sender.send('terminal:exit', sid, code)
  );
  s.onData((d) => e.sender.send('terminal:data', id, d));
  s.onExit((code) => e.sender.send('terminal:exit', id, code));
  return s.backend;
});
ipcMain.on('terminal:write', (_e, id: string, data: string) => term.getSession(id)?.write(data));
ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) =>
  term.getSession(id)?.resize(cols, rows)
);
ipcMain.on('terminal:kill', (_e, id: string) => term.killSession(id));

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------
function providerById(s: Settings, id?: string) {
  return s.providers.find((p) => p.id === id) || s.providers[0];
}

function readAgentsMd(workspace: string | null): string {
  if (!workspace) return '';
  try {
    const p = safeJoin(workspace, 'AGENTS.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 8000) : '';
  } catch {
    return '';
  }
}

interface ApprovalRequest {
  resolve: (approved: boolean) => void;
}
const pendingApprovals = new Map<string, ApprovalRequest>();

ipcMain.on('approval:respond', (_e, reqId: string, approved: boolean) => {
  pendingApprovals.get(reqId)?.resolve(approved);
  pendingApprovals.delete(reqId);
});

function askApproval(
  winRef: BrowserWindow | null,
  reqId: string,
  kind: string,
  detail: string
): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApprovals.set(reqId, { resolve });
    winRef?.webContents.send('agent:approval', reqId, kind, detail);
    // Safety: auto-deny after 5 minutes of silence.
    setTimeout(() => {
      if (pendingApprovals.has(reqId)) {
        pendingApprovals.get(reqId)!.resolve(false);
        pendingApprovals.delete(reqId);
      }
    }, 5 * 60 * 1000);
  });
}

async function execTool(
  winRef: BrowserWindow | null,
  workspace: string,
  tool: ToolName,
  args: Record<string, string>,
  settings: Settings
): Promise<string> {
  try {
    if (tool === 'read_file') {
      return fsapi.readFile(workspace, String(args.path || ''));
    }
    if (tool === 'list_files') {
      const entries = fsapi.listDir(workspace, String(args.path || '.'));
      return entries.map((e) => `${e.kind === 'dir' ? '[dir] ' : ''}${e.path}`).join('\n') || '(empty)';
    }
    if (tool === 'write_file') {
      const rel = String(args.path || '');
      const content = String(args.content ?? '');
      const detail = `write_file → ${rel}\n${content.length} bytes`;
      const ok = await askApproval(winRef, `ap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, 'Write file', detail);
      if (!ok) return 'DENIED by user.';
      fsapi.pushCheckpoint(workspace, rel);
      fsapi.writeFile(workspace, rel, content);
      winRef?.webContents.send('agent:file-changed', rel);
      return `OK — wrote ${content.length} bytes to ${rel}`;
    }
    if (tool === 'run_command') {
      const cmd = String(args.command || '').trim();
      const cls = classifyCommand(cmd);
      if (cls === 'BLOCKED') return `BLOCKED — command refused by safety policy: ${cmd}`;
      if (cls === 'DANGEROUS' && settings.permissionLevel !== 'elevated')
        return `BLOCKED — DANGEROUS command requires elevated permissions in Settings: ${cmd}`;
      if (cls !== 'SAFE') {
        const ok = await askApproval(winRef, `ap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, 'Run command', cmd);
        if (!ok) return 'DENIED by user.';
      }
      return await new Promise<string>((resolve) => {
        const isWin = process.platform === 'win32';
        const shellCmd = isWin
          ? ['powershell.exe', '-NoProfile', '-Command', cmd]
          : ['bash', '-lc', cmd];
        const { execFile } = require('child_process');
        execFile(shellCmd[0], shellCmd.slice(1), { cwd: workspace, timeout: 120000, maxBuffer: 1024 * 1024 * 4 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (err: any, stdout: string, stderr: string) => {
            const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
            resolve(`exit=${code}\n${(stdout || '') + (stderr || '')}`.slice(0, 24000) || 'exit=0');
          });
      });
    }
    return `Unknown tool: ${tool}`;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

ipcMain.handle(
  'ai:chat',
  async (
    e,
    payload: {
      reqId: string;
      providerId: string;
      mode: 'ask' | 'plan' | 'agent';
      history: ChatMessage[];
      workspace: string | null;
    }
  ) => {
    const settings = loadSettings();
    const provider = providerById(settings, payload.providerId);
    if (!provider) throw new Error('No AI provider configured. Open Settings → AI Providers.');

    const memory = payload.workspace ? getMemory(settings, payload.workspace) : '';
    const sys = systemPrompt(payload.workspace, readAgentsMd(payload.workspace), memory);
    const msgs: ChatMessageLike[] = [{ role: 'system', content: sys }, ...payload.history];

    const onDelta = (d: string) => e.sender.send('ai:chunk', payload.reqId, d);

    // Ask / Plan: single streaming completion.
    if (payload.mode !== 'agent') {
      const { text } = await streamChat(provider, msgs, onDelta);
      return { text, steps: 0 };
    }

    // Agent: multi-step loop with tool execution.
    let steps = 0;
    const maxSteps = Math.max(1, Math.min(30, settings.agentMaxSteps || 12));
    const convo: ChatMessageLike[] = [...msgs];
    let finalText = '';

    for (;;) {
      if (steps >= maxSteps) {
        finalText += `\n\n_(Agent stopped: reached max steps (${maxSteps}).)_`;
        break;
      }
      steps++;
      const { text } = await streamChat(provider, convo, onDelta);
      const { calls, cleaned } = parseToolBlocks(text);
      finalText = cleaned;
      if (!calls.length) break;

      convo.push({ role: 'assistant', content: text });
      for (const c of calls) {
        e.sender.send('ai:tool', payload.reqId, c.tool, c.args);
        const result = await execTool(win, payload.workspace || '.', c.tool, c.args, settings);
        convo.push(toolResultMessage(c.tool, c.args, result));
      }
    }
    return { text: finalText, steps };
  }
);

ipcMain.handle('ai:complete', async (_e, providerId: string, prefix: string, suffix: string) => {
  const settings = loadSettings();
  const provider = providerById(settings, providerId);
  if (!provider) throw new Error('No autocomplete provider configured.');
  const prompt = `You are a code completion engine. Continue the code at <CURSOR>. Output ONLY the raw code that should be inserted at <CURSOR> — no explanations, no markdown fences, no repetition of existing code.\n\n<BEFORE>\n${prefix.slice(-3000)}\n</BEFORE>\n<CURSOR>\n<AFTER>\n${suffix.slice(0, 1500)}\n</AFTER>`;
  const text = await completeOnce(provider, prompt, 96, ['\n\n\n']);
  // Trim leading newline duplication; cap to 4 lines for inline UX.
  const lines = text.replace(/^```[a-zA-Z0-9]*\n?|```$/g, '').split('\n').slice(0, 4);
  return lines.join('\n');
});

// app info
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  platform: process.platform,
  terminalBackend: term.terminalBackendName()
}));

app.whenReady().then(() => {
  loadSettings(); // warm-up, also creates ~/.ryeditor dir on first save
  void DEFAULT_SETTINGS;
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
