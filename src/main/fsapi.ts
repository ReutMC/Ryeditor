/**
 * Ryeditor — workspace filesystem API (path-guarded).
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeJoin } from './ai/tools';

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
}

export function listDir(workspace: string, rel: string): FileEntry[] {
  const abs = safeJoin(workspace, rel || '.');
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    out.push({
      name: e.name,
      path: path.relative(workspace, path.join(abs, e.name)) || '.',
      kind: e.isDirectory() ? 'dir' : 'file'
    });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return out;
}

export function readFile(workspace: string, rel: string): string {
  const abs = safeJoin(workspace, rel);
  const stat = fs.statSync(abs);
  if (stat.size > 2 * 1024 * 1024) throw new Error('File too large (>2 MB) for the editor.');
  return fs.readFileSync(abs, 'utf8');
}

export function writeFile(workspace: string, rel: string, content: string): void {
  const abs = safeJoin(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

export function mkdirp(workspace: string, rel: string): void {
  safeJoin(workspace, rel);
  fs.mkdirSync(path.resolve(workspace, rel), { recursive: true });
}

export function deletePath(workspace: string, rel: string): void {
  const abs = safeJoin(workspace, rel);
  if (abs === path.resolve(workspace)) throw new Error('Refusing to delete workspace root.');
  fs.rmSync(abs, { recursive: true, force: false });
}

export function renamePath(workspace: string, fromRel: string, toRel: string): void {
  const from = safeJoin(workspace, fromRel);
  const to = safeJoin(workspace, toRel);
  fs.renameSync(from, to);
}

export function exists(workspace: string, rel: string): boolean {
  try {
    safeJoin(workspace, rel);
    return fs.existsSync(path.resolve(workspace, rel));
  } catch {
    return false;
  }
}

/** Snapshot a file's content before AI overwrites it (checkpoint system). */
export interface Checkpoint {
  path: string;
  content: string | null; // null = file did not exist
  ts: number;
}
const checkpoints: Checkpoint[] = [];

export function pushCheckpoint(workspace: string, rel: string): void {
  try {
    const abs = path.resolve(workspace, rel);
    checkpoints.push({
      path: rel,
      content: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null,
      ts: Date.now()
    });
    if (checkpoints.length > 200) checkpoints.shift();
  } catch {
    /* non-fatal */
  }
}

export function popCheckpoint(workspace: string): Checkpoint | null {
  const cp = checkpoints.pop();
  if (!cp) return null;
  const abs = path.resolve(workspace, cp.path);
  if (cp.content === null) {
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* ignore */
    }
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, cp.content, 'utf8');
  }
  return cp;
}

export function hasCheckpoints(): boolean {
  return checkpoints.length > 0;
}
