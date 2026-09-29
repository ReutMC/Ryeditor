/** Global declarations for the Ryeditor renderer (global script context — no module). */

interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
}

interface ProviderCfg {
  id: string;
  type: 'openai' | 'anthropic' | 'gemini' | 'openai-compatible' | 'ollama';
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

interface RySettings {
  providers: ProviderCfg[];
  agentProviderId?: string;
  autoCompleteProviderId?: string;
  autoCompleteEnabled: boolean;
  theme: 'dark' | 'light' | 'hc';
  permissionLevel: 'standard' | 'elevated';
  agentMaxSteps: number;
  lastWorkspace?: string;
  memory: Record<string, string>;
}

interface Window {
  ry: {
    appInfo(): Promise<{ version: string; electron: string; node: string; platform: string; terminalBackend: string }>;
    settingsLoad(): Promise<RySettings>;
    settingsSave(s: RySettings): Promise<boolean>;
    workspaceOpen(): Promise<string | null>;
    fsList(ws: string, rel: string): Promise<FileEntry[]>;
    fsRead(ws: string, rel: string): Promise<string>;
    fsWrite(ws: string, rel: string, content: string): Promise<boolean>;
    fsMkdir(ws: string, rel: string): Promise<boolean>;
    fsDelete(ws: string, rel: string): Promise<boolean>;
    fsRename(ws: string, a: string, b: string): Promise<boolean>;
    fsExists(ws: string, rel: string): Promise<boolean>;
    checkpointUndo(ws: string): Promise<string | null>;
    checkpointHas(): Promise<boolean>;
    terminalBackend(): Promise<string>;
    terminalCreate(id: string, cwd?: string): Promise<string>;
    terminalWrite(id: string, data: string): void;
    terminalResize(id: string, cols: number, rows: number): void;
    terminalKill(id: string): void;
    onTerminalData(cb: (id: string, d: string) => void): void;
    onTerminalExit(cb: (id: string, code: number) => void): void;
    aiChat(payload: {
      reqId: string;
      providerId: string;
      mode: 'ask' | 'plan' | 'agent';
      history: { role: 'user' | 'assistant'; content: string }[];
      workspace: string | null;
    }): Promise<{ text: string; steps: number }>;
    aiComplete(providerId: string, prefix: string, suffix: string): Promise<string>;
    onAiChunk(cb: (reqId: string, delta: string) => void): void;
    onAiTool(cb: (reqId: string, tool: string, args: Record<string, string>) => void): void;
    approvalRespond(reqId: string, approved: boolean): void;
    onApproval(cb: (reqId: string, kind: string, detail: string) => void): void;
    onFileChanged(cb: (rel: string) => void): void;
  };
  monaco: any;
  require: any;
  Terminal: any;
  FitAddon: any;
  MonacoEnvironment: any;
}
