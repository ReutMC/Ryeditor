/**
 * Ryeditor — real terminal sessions.
 * Backend 1: node-pty (proper PTY) when the native module loads.
 * Backend 2: child_process fallback (real shell process, no TTY emulation).
 * The active backend is reported to the renderer honestly.
 */
import { app } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TermSession {
  id: string;
  backend: 'node-pty' | 'child_process';
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pty: any | null = null;
let ptyTried = false;

function loadPty(): boolean {
  if (ptyTried) return pty !== null;
  ptyTried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    pty = require('node-pty');
    return true;
  } catch {
    pty = null;
    return false;
  }
}

export function defaultShell(): string {
  if (process.platform === 'win32') {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(ps)) return ps;
    return process.env.ComSpec || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

const sessions = new Map<string, TermSession>();

export function terminalBackendName(): 'node-pty' | 'child_process' {
  return loadPty() ? 'node-pty' : 'child_process';
}

export function createSession(
  id: string,
  cwd: string | undefined,
  onData: (id: string, d: string) => void,
  onExit: (id: string, code: number) => void
): TermSession {
  const workdir =
    cwd && fs.existsSync(cwd) ? cwd : (app.getPath('home'));
  const shell = defaultShell();

  const sess: TermSession = {
    id,
    backend: 'child_process',
    write() {},
    resize() {},
    kill() {},
    onData() {},
    onExit() {}
  };

  if (loadPty()) {
    try {
      const isWin = process.platform === 'win32';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = pty.spawn(shell, isWin ? [] : ['-l'], {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: workdir,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
      });
      sess.backend = 'node-pty';
      sess.onData = (cb) => p.onData((d: string) => cb(d));
      sess.onExit = (cb) => p.onExit(({ exitCode }: { exitCode: number }) => cb(exitCode));
      sess.write = (d) => p.write(d);
      sess.resize = (c, r) => {
        try {
          p.resize(Math.max(2, c | 0), Math.max(2, r | 0));
        } catch {
          /* window too small */
        }
      };
      sess.kill = () => {
        try {
          p.kill();
        } catch {
          /* already dead */
        }
      };
      sessions.set(id, sess);
      return sess;
    } catch {
      // fall through to child_process backend
    }
  }

  // child_process fallback — a REAL shell, just without a TTY.
  const args = process.platform === 'win32' ? [] : ['--norc', '-i'];
  const child: ChildProcess = spawn(shell, args, {
    cwd: workdir,
    env: { ...process.env, TERM: 'dumb', PS1: '$ ' } as Record<string, string>,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  sess.backend = 'child_process';
  sess.onData = (cb) => {
    child.stdout?.on('data', (d) => cb(d.toString()));
    child.stderr?.on('data', (d) => cb(d.toString()));
  };
  sess.onExit = (cb) => child.on('exit', (code) => cb(code ?? 0));
  sess.write = (d) => {
    if (!child.stdin) return;
    // In non-TTY mode the shell waits for EOF; for a single line we can exec it.
    const line = d.replace(/\r$/, '');
    if (line.length > 0) child.stdin.write(line + '\n');
  };
  sess.resize = () => {};
  sess.kill = () => {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
  };
  sessions.set(id, sess);
  return sess;
}

export function getSession(id: string): TermSession | undefined {
  return sessions.get(id);
}

export function killSession(id: string): void {
  sessions.get(id)?.kill();
  sessions.delete(id);
}

export function homeDir(): string {
  return os.homedir();
}
