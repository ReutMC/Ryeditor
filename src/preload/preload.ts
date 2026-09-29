/**
 * Ryeditor — preload bridge. Exposes a minimal, typed API on window.ry.
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  appInfo: () => ipcRenderer.invoke('app:info'),

  settingsLoad: () => ipcRenderer.invoke('settings:load'),
  settingsSave: (s: unknown) => ipcRenderer.invoke('settings:save', s),

  workspaceOpen: () => ipcRenderer.invoke('workspace:open'),

  fsList: (ws: string, rel: string) => ipcRenderer.invoke('fs:list', ws, rel),
  fsRead: (ws: string, rel: string) => ipcRenderer.invoke('fs:read', ws, rel),
  fsWrite: (ws: string, rel: string, content: string) => ipcRenderer.invoke('fs:write', ws, rel, content),
  fsMkdir: (ws: string, rel: string) => ipcRenderer.invoke('fs:mkdir', ws, rel),
  fsDelete: (ws: string, rel: string) => ipcRenderer.invoke('fs:delete', ws, rel),
  fsRename: (ws: string, a: string, b: string) => ipcRenderer.invoke('fs:rename', ws, a, b),
  fsExists: (ws: string, rel: string) => ipcRenderer.invoke('fs:exists', ws, rel),

  checkpointUndo: (ws: string) => ipcRenderer.invoke('checkpoint:undo', ws),
  checkpointHas: () => ipcRenderer.invoke('checkpoint:has'),

  terminalBackend: () => ipcRenderer.invoke('terminal:backend'),
  terminalCreate: (id: string, cwd?: string) => ipcRenderer.invoke('terminal:create', id, cwd),
  terminalWrite: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
  terminalKill: (id: string) => ipcRenderer.send('terminal:kill', id),
  onTerminalData: (cb: (id: string, d: string) => void) => {
    ipcRenderer.on('terminal:data', (_e, id, d) => cb(id, d));
  },
  onTerminalExit: (cb: (id: string, code: number) => void) => {
    ipcRenderer.on('terminal:exit', (_e, id, code) => cb(id, code));
  },

  aiChat: (payload: unknown) => ipcRenderer.invoke('ai:chat', payload),
  aiComplete: (providerId: string, prefix: string, suffix: string) =>
    ipcRenderer.invoke('ai:complete', providerId, prefix, suffix),
  onAiChunk: (cb: (reqId: string, delta: string) => void) => {
    ipcRenderer.on('ai:chunk', (_e, reqId, delta) => cb(reqId, delta));
  },
  onAiTool: (cb: (reqId: string, tool: string, args: Record<string, string>) => void) => {
    ipcRenderer.on('ai:tool', (_e, reqId, tool, args) => cb(reqId, tool, args));
  },
  approvalRespond: (reqId: string, approved: boolean) => ipcRenderer.send('approval:respond', reqId, approved),
  onApproval: (cb: (reqId: string, kind: string, detail: string) => void) => {
    ipcRenderer.on('agent:approval', (_e, reqId, kind, detail) => cb(reqId, kind, detail));
  },
  onFileChanged: (cb: (rel: string) => void) => {
    ipcRenderer.on('agent:file-changed', (_e, rel) => cb(rel));
  }
};

contextBridge.exposeInMainWorld('ry', api);
