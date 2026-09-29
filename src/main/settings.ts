/**
 * Ryeditor — settings persistence.
 * Stored at ~/.ryeditor/settings.json
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'openai-compatible' | 'ollama';

export interface ProviderCfg {
  id: string;
  type: ProviderType;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

export interface Settings {
  providers: ProviderCfg[];
  agentProviderId?: string;
  autoCompleteProviderId?: string;
  autoCompleteEnabled: boolean;
  theme: 'dark' | 'light' | 'hc';
  permissionLevel: 'standard' | 'elevated'; // elevated = allow DANGEROUS after explicit confirm
  agentMaxSteps: number;
  lastWorkspace?: string;
  memory: Record<string, string>; // workspace path -> project memory notes
}

export const DEFAULT_SETTINGS: Settings = {
  providers: [
    {
      id: 'ollama-local',
      type: 'ollama',
      name: 'Ollama (local, free)',
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder:7b'
    },
    {
      id: 'lmstudio-local',
      type: 'openai-compatible',
      name: 'LM Studio (local, free)',
      baseUrl: 'http://localhost:1234/v1',
      model: 'local-model'
    }
  ],
  agentProviderId: 'ollama-local',
  autoCompleteProviderId: 'ollama-local',
  autoCompleteEnabled: true,
  theme: 'dark',
  permissionLevel: 'standard',
  agentMaxSteps: 12,
  memory: {}
};

export function settingsPath(): string {
  return path.join(app.getPath('home'), '.ryeditor', 'settings.json');
}

export function loadSettings(): Settings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
}

/** Project memory for a workspace (used in AI system prompt). */
export function getMemory(s: Settings, workspace: string): string {
  return s.memory[workspace] || '';
}
