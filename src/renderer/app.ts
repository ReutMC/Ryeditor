/* global document, window */
/**
 * Ryeditor renderer application (plain script, no imports).
 * Explorer · Monaco tabs · AI (Ask/Plan/Agent) · approvals · real terminal ·
 * inline autocomplete · command palette · settings · themes.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ state
  let settings: RySettings;
  let workspace: string | null = null;
  let editor: any = null;
  let monaco: any = null;
  const openTabs: { path: string; model: any; dirty: boolean }[] = [];
  let activeTabIdx = -1;
  let selectedTreePath: string | null = null;
  const expanded = new Set<string>();

  let aiBusy = false;
  let aiHistory: { role: 'user' | 'assistant'; content: string }[] = [];
  let liveBubble: HTMLDivElement | null = null;
  let liveText = '';
  let ignoreChunks = false;

  const terms = new Map<string, { term: any; fit: any; host: HTMLElement; backend: string }>();
  let termSeq = 0;
  let activeTermId = '';

  const $ = (id: string) => document.getElementById(id) as HTMLElement;

  // ------------------------------------------------------------------ utils
  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toast(msg: string, kind: 'ok' | 'err' | '' = ''): void {
    let host = $('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 3800);
  }

  function relName(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function langFor(path: string): string {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
      json: 'json', css: 'css', scss: 'scss', html: 'html', htm: 'html', md: 'markdown', py: 'python',
      go: 'go', rs: 'rust', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', c: 'cpp', cpp: 'cpp',
      h: 'cpp', hpp: 'cpp', cs: 'csharp', java: 'java', sql: 'sql', xml: 'xml', php: 'php', rb: 'ruby',
      swift: 'swift', kt: 'kotlin', lua: 'lua', toml: 'ini', ini: 'ini', dockerfile: 'dockerfile'
    };
    return map[ext] || 'plaintext';
  }

  function modal(title: string, build: (body: HTMLElement, close: () => void) => void): void {
    const backdrop = $('modal-backdrop');
    const box = $('modal-box');
    box.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'modal-head';
    head.innerHTML = `<span>${esc(title)}</span><button class="mini" aria-label="Close">✕</button>`;
    const body = document.createElement('div');
    body.className = 'modal-body';
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    box.appendChild(head); box.appendChild(body); box.appendChild(foot);
    (head.querySelector('button') as HTMLButtonElement).onclick = () => backdrop.classList.add('hidden');
    const close = () => backdrop.classList.add('hidden');
    build(body, close);
    backdrop.classList.remove('hidden');
  }

  function addFootButton(foot: HTMLElement, label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.onclick = onClick;
    foot.appendChild(b);
    return b;
  }

  // ------------------------------------------------------------------ theme
  function applyTheme(t: 'dark' | 'light' | 'hc'): void {
    document.body.dataset.theme = t;
    if (monaco && editor) {
      monaco.editor.setTheme(t === 'light' ? 'ryeditor-light' : t === 'hc' ? 'ryeditor-hc' : 'ryeditor-dark');
    }
  }

  // ------------------------------------------------------------------ status
  function setStatus(): void {
    $('st-workspace').textContent = workspace ? workspace : 'no workspace';
    $('tb-workspace').textContent = workspace ? workspace.split(/[\\/]/).pop() || workspace : 'no folder open';
    const prov = agentProvider();
    $('st-model').textContent = prov ? `${prov.name} · ${prov.model}` : 'no model';
    $('st-mode').textContent = ($('ai-mode') as HTMLSelectElement).value;
    $('st-app').textContent = `Ryeditor v${appVersion}`;
  }
  let appVersion = '';

  // ------------------------------------------------------------------ tree
  async function refreshTree(): Promise<void> {
    if (!workspace) { $('file-tree').innerHTML = '<div style="padding:10px;color:var(--text-dim)">Open a folder…</div>'; return; }
    const tree = $('file-tree');
    tree.innerHTML = '';
    await renderDir(tree, '.', 0);
  }

  async function renderDir(container: HTMLElement, rel: string, depth: number): Promise<void> {
    let entries: FileEntry[] = [];
    try { entries = await window.ry.fsList(workspace!, rel); }
    catch (err) { container.innerHTML = `<div class="tree-item">⚠ ${esc(String(err))}</div>`; return; }
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'tree-item' + (selectedTreePath === e.path ? ' active' : '');
      row.style.paddingLeft = 8 + depth * 14 + 'px';
      row.setAttribute('role', 'treeitem');
      if (e.kind === 'dir') {
        const isOpen = expanded.has(e.path);
        row.innerHTML = `<span class="twisty">${isOpen ? '▾' : '▸'}</span><span class="icon-dir">▸</span><span class="name">${esc(e.name)}</span>`
          .replace('<span class="icon-dir">▸</span>', `<span class="icon-dir">${isOpen ? '📂' : '📁'}</span>`);
        row.onclick = async () => {
          if (expanded.has(e.path)) expanded.delete(e.path); else expanded.add(e.path);
          await refreshTree();
        };
        row.oncontextmenu = (ev) => { ev.preventDefault(); treeMenu(ev, e); };
        container.appendChild(row);
        if (expanded.has(e.path)) {
          const sub = document.createElement('div');
          container.appendChild(sub);
          await renderDir(sub, e.path, depth + 1);
        }
      } else {
        row.innerHTML = `<span class="twisty"></span><span class="icon-file">📄</span><span class="name">${esc(e.name)}</span>`;
        row.onclick = () => { selectedTreePath = e.path; openFile(e.path); refreshTree(); };
        row.oncontextmenu = (ev) => { ev.preventDefault(); treeMenu(ev, e); };
        container.appendChild(row);
      }
    }
  }

  function treeMenu(ev: MouseEvent, entry: FileEntry): void {
    selectedTreePath = entry.path;
    document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.style.cssText = `position:fixed;z-index:300;background:var(--bg-elev);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);min-width:150px;overflow:hidden`;
    const items: [string, () => void][] = [];
    if (entry.kind === 'file') {
      items.push(['Open', () => openFile(entry.path)]);
    } else {
      items.push(['Toggle folder', async () => { expanded.has(entry.path) ? expanded.delete(entry.path) : expanded.add(entry.path); await refreshTree(); }]);
      items.push(['New file inside…', () => promptNewFile(entry.path)]);
    }
    items.push(['Rename…', async () => {
      const nn = window.prompt('New name/path:', entry.path);
      if (!nn || !workspace) return;
      try { await window.ry.fsRename(workspace, entry.path, nn); await refreshTree(); toast('Renamed', 'ok'); }
      catch (e) { toast(String(e), 'err'); }
    }]);
    items.push(['Delete', async () => {
      if (!window.confirm(`Delete ${entry.path}?`)) return;
      try { await window.ry.fsDelete(workspace!, entry.path); await refreshTree(); toast('Deleted', 'ok'); }
      catch (e) { toast(String(e), 'err'); }
    }]);
    for (const [label, fn] of items) {
      const it = document.createElement('div');
      it.className = 'palette-item';
      it.textContent = label;
      it.onclick = () => { menu.remove(); fn(); };
      menu.appendChild(it);
    }
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 0);
    menu.style.left = Math.min(ev.clientX, window.innerWidth - 170) + 'px';
    menu.style.top = Math.min(ev.clientY, window.innerHeight - 190) + 'px';
  }

  async function promptNewFile(dir: string): Promise<void> {
    const p = window.prompt(`New file path (inside ${dir || 'workspace'}):`, dir ? dir + '/' : '');
    if (!p || !workspace) return;
    try { await window.ry.fsWrite(workspace, p, ''); await refreshTree(); openFile(p); }
    catch (e) { toast(String(e), 'err'); }
  }

  // ------------------------------------------------------------------ tabs/editor
  function currentTab() { return activeTabIdx >= 0 ? openTabs[activeTabIdx] : null; }

  function renderTabs(): void {
    const bar = $('tabs-bar');
    bar.innerHTML = '';
    openTabs.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'tab' + (i === activeTabIdx ? ' active' : '');
      el.setAttribute('role', 'tab');
      el.innerHTML = `<span>${esc(relName(t.path))}${t.dirty ? ' •' : ''}</span><button class="close" title="Close">✕</button>`;
      (el.querySelector('.close') as HTMLButtonElement).onclick = (ev) => { ev.stopPropagation(); closeTab(i); };
      el.onclick = () => activateTab(i);
      bar.appendChild(el);
    });
    $('editor-empty').style.display = openTabs.length ? 'none' : 'flex';
  }

  function activateTab(i: number): void {
    if (i < 0 || i >= openTabs.length) return;
    activeTabIdx = i;
    editor.setModel(openTabs[i].model);
    editor.focus();
    renderTabs();
  }

  function closeTab(i: number): void {
    const t = openTabs[i];
    if (!t) return;
    if (t.dirty && !window.confirm(`${t.path} has unsaved changes. Close anyway?`)) return;
    t.model.dispose();
    openTabs.splice(i, 1);
    activeTabIdx = openTabs.length ? Math.max(0, i - 1) : -1;
    if (activeTabIdx >= 0) editor.setModel(openTabs[activeTabIdx].model);
    else editor.setModel(null);
    renderTabs();
  }

  async function openFile(rel: string): Promise<void> {
    if (!workspace) return;
    const existing = openTabs.findIndex((t) => t.path === rel);
    if (existing >= 0) { activateTab(existing); return; }
    try {
      const content = await window.ry.fsRead(workspace, rel);
      const uri = monaco.Uri.parse(`file:///ws/${rel.replace(/[\\/]+/g, '/')}`);
      const old = monaco.editor.getModel(uri);
      const model = old || monaco.editor.createModel(content, langFor(rel), uri);
      if (old) model.setValue(content);
      const tab = { path: rel, model, dirty: false };
      openTabs.push(tab);
      model.onDidChangeContent(() => { tab.dirty = true; renderTabs(); });
      activateTab(openTabs.length - 1);
    } catch (e) {
      toast(`Cannot open ${rel}: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }

  async function saveActive(): Promise<void> {
    const t = currentTab();
    if (!t || !workspace) return;
    try {
      await window.ry.fsWrite(workspace, t.path, t.model.getValue());
      t.dirty = false;
      renderTabs();
      toast(`Saved ${relName(t.path)}`, 'ok');
    } catch (e) { toast(String(e), 'err'); }
  }

  function defineMonacoThemes(): void {
    monaco.editor.defineTheme('ryeditor-dark', {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '5A6C87', fontStyle: 'italic' },
        { token: 'keyword', foreground: '2F6FED' },
        { token: 'string', foreground: '2BD9C7' },
        { token: 'number', foreground: 'D9A62E' },
        { token: 'type', foreground: '56B6C2' },
        { token: 'function', foreground: '7AA2F7' }
      ],
      colors: {
        'editor.background': '#0B1220',
        'editor.foreground': '#D7E3F4',
        'editorLineNumber.foreground': '#3A4C6E',
        'editorLineNumber.activeForeground': '#2BD9C7',
        'editor.selectionBackground': '#2F6FED55',
        'editorCursor.foreground': '#2BD9C7',
        'editorIndentGuide.background': '#22314E',
        'editorWidget.background': '#101A2C',
        'editorSuggestWidget.background': '#101A2C',
        'editorHoverWidget.background': '#101A2C'
      }
    });
    monaco.editor.defineTheme('ryeditor-light', {
      base: 'vs', inherit: true, rules: [],
      colors: { 'editor.background': '#FFFFFF', 'editorCursor.foreground': '#0E9C8D' }
    });
    monaco.editor.defineTheme('ryeditor-hc', {
      base: 'hc-black', inherit: true, rules: [],
      colors: { 'editor.background': '#000000', 'editorCursor.foreground': '#2BF0DC' }
    });
  }

  function registerInlineAI(): void {
    const langs = ['typescript', 'javascript', 'python', 'json', 'html', 'css', 'go', 'rust', 'java', 'csharp', 'cpp', 'markdown', 'shell', 'yaml', 'plaintext'];
    for (const l of langs) {
      monaco.languages.registerInlineCompletionsProvider(l, {
        async provideInlineCompletions(model: any, position: any) {
          if (!settings.autoCompleteEnabled || aiBusy) return { items: [] };
          const provider = autoCompleteProvider();
          if (!provider) return { items: [] };
          const offset = model.getOffsetAt(position);
          const prefix = model.getValue().slice(0, offset);
          const suffix = model.getValue().slice(offset);
          try {
            const text = await window.ry.aiComplete(provider.id, prefix, suffix);
            if (!text || !text.trim()) return { items: [] };
            return { items: [{ insertText: text.replace(/\r/g, ''), range: undefined }] };
          } catch {
            return { items: [] };
          }
        },
        freeInlineCompletions() { /* no resources */ }
      });
    }
  }

  /** Alt+\ — direct inline AI insert at cursor (ghost text stays auto-triggered). */
  async function inlineInsert(): Promise<void> {
    const t = currentTab();
    const provider = autoCompleteProvider();
    if (!t || !provider) { toast('Open a file and configure an autocomplete provider first.', 'err'); return; }
    const model = t.model;
    const pos = editor.getPosition();
    const offset = model.getOffsetAt(pos);
    try {
      const text = await window.ry.aiComplete(provider.id, model.getValue().slice(0, offset), model.getValue().slice(offset));
      if (!text) { toast('No suggestion returned.'); return; }
      editor.executeEdits('ry-ai', [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text, forceMoveMarkers: true }]);
      toast('Inline AI inserted', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  }

  // ------------------------------------------------------------------ providers
  function agentProvider(): ProviderCfg | null {
    return settings.providers.find((p) => p.id === settings.agentProviderId) || settings.providers[0] || null;
  }
  function autoCompleteProvider(): ProviderCfg | null {
    return settings.providers.find((p) => p.id === settings.autoCompleteProviderId) || settings.providers[0] || null;
  }
  function refreshProviderSelect(): void {
    const sel = $('ai-provider') as HTMLSelectElement;
    sel.innerHTML = '';
    for (const p of settings.providers) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.name} — ${p.model}`;
      sel.appendChild(o);
    }
    if (settings.agentProviderId) sel.value = settings.agentProviderId;
  }

  // ------------------------------------------------------------------ AI panel
  function aiAppendBubble(role: 'user' | 'assistant', html: string): HTMLDivElement {
    const log = $('ai-log');
    const b = document.createElement('div');
    b.className = 'ai-msg ' + role;
    b.innerHTML = `<div class="role">${role === 'user' ? 'YOU' : 'RYEDITOR AI'}</div><div class="content">${html}</div>`;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function mdLite(text: string): string {
    let s = esc(text);
    s = s.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code}</code></pre>`);
    s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/\n/g, '<br/>');
    return s;
  }

  async function aiSend(): Promise<void> {
    if (aiBusy) return;
    const input = $('ai-input') as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text) return;
    const mode = ($('ai-mode') as HTMLSelectElement).value as 'ask' | 'plan' | 'agent';
    const provider = agentProvider();
    if (!provider) { toast('Configure an AI provider in Settings first.', 'err'); return; }

    aiHistory.push({ role: 'user', content: text });
    aiAppendBubble('user', mdLite(text));
    input.value = '';
    setAiBusy(true);

    const reqId = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    currentLiveReqId = reqId;
    liveText = '';
    liveBubble = aiAppendBubble('assistant', '<span style="color:var(--text-dim)">thinking…</span>');
    ignoreChunks = false;

    try {
      const res = await window.ry.aiChat({
        reqId, providerId: provider.id, mode,
        history: aiHistory.slice(-24),
        workspace
      });
      if (!ignoreChunks && liveBubble) {
        const content = liveBubble.querySelector('.content') as HTMLElement;
        content.innerHTML = mdLite(res.text || '(empty response)');
        if (mode === 'plan' && res.text) {
          const box = document.createElement('div');
          box.className = 'plan-box';
          box.innerHTML = `<b>PLAN READY</b><br/><span style="color:var(--text-dim)">Review above, then execute with Agent.</span>`;
          const btn = document.createElement('button');
          btn.className = 'primary';
          btn.style.marginTop = '6px';
          btn.textContent = 'Approve & Execute';
          btn.onclick = () => executePlan(res.text);
          box.appendChild(btn);
          content.appendChild(box);
        }
        if (res.steps > 0) {
          const note = document.createElement('span');
          note.className = 'tool-note';
          note.textContent = `agent finished · ${res.steps} step(s)`;
          content.appendChild(document.createElement('br'));
          content.appendChild(note);
        }
        aiHistory.push({ role: 'assistant', content: res.text });
      }
    } catch (e) {
      if (liveBubble) {
        (liveBubble.querySelector('.content') as HTMLElement).innerHTML =
          `<span style="color:var(--danger)">⚠ ${esc(e instanceof Error ? e.message : String(e))}</span>`;
        liveBubble.classList.add('error');
      }
    } finally {
      liveBubble = null;
      setAiBusy(false);
    }
  }

  async function executePlan(plan: string): Promise<void> {
    aiHistory.push({ role: 'assistant', content: plan });
    aiHistory.push({ role: 'user', content: 'Plan approved by the user. Execute it now step by step using tools. Start immediately.' });
    aiAppendBubble('user', mdLite('✅ Plan approved — execute now.'));
    setAiBusy(true);
    const reqId = 'req-' + Date.now() + '-plan';
    currentLiveReqId = reqId;
    liveText = '';
    liveBubble = aiAppendBubble('assistant', '<span style="color:var(--text-dim)">executing plan…</span>');
    ignoreChunks = false;
    const provider = agentProvider();
    try {
      const res = await window.ry.aiChat({
        reqId, providerId: provider!.id, mode: 'agent',
        history: aiHistory.slice(-24), workspace
      });
      if (liveBubble) {
        (liveBubble.querySelector('.content') as HTMLElement).innerHTML = mdLite(res.text || '(done)');
        const note = document.createElement('span');
        note.className = 'tool-note';
        note.textContent = `plan executed · ${res.steps} step(s)`;
        (liveBubble.querySelector('.content') as HTMLElement).appendChild(document.createElement('br'));
        (liveBubble.querySelector('.content') as HTMLElement).appendChild(note);
        aiHistory.push({ role: 'assistant', content: res.text });
      }
    } catch (e) {
      if (liveBubble) (liveBubble.querySelector('.content') as HTMLElement).innerHTML = `<span style="color:var(--danger)">⚠ ${esc(String(e))}</span>`;
    } finally {
      liveBubble = null;
      setAiBusy(false);
    }
  }

  function setAiBusy(b: boolean): void {
    aiBusy = b;
    ($('ai-send') as HTMLButtonElement).disabled = b;
    $('ai-send').classList.toggle('hidden', b);
    $('ai-stop').classList.toggle('hidden', !b);
    setStatus();
  }

  function wireIpcEvents(): void {
    window.ry.onAiChunk((reqId, delta) => {
      if (reqId !== liveText_reqId()) return;
      if (ignoreChunks || !liveBubble) return;
      liveText += delta;
      (liveBubble.querySelector('.content') as HTMLElement).innerHTML = mdLite(liveText) + '<span class="ai-status">▍</span>';
      const log = $('ai-log');
      log.scrollTop = log.scrollHeight;
    });
    window.ry.onAiTool((_reqId, tool, args) => {
      if (!liveBubble) return;
      const note = document.createElement('span');
      note.className = 'tool-note';
      const argStr = tool === 'write_file' ? String(args.path || '') : String(args.command || args.path || '');
      note.textContent = `⚙ ${tool} ${argStr.slice(0, 60)}`;
      (liveBubble.querySelector('.content') as HTMLElement).appendChild(document.createElement('br'));
      (liveBubble.querySelector('.content') as HTMLElement).appendChild(note);
    });
    window.ry.onApproval((reqId, kind, detail) => {
      modal(`${kind} — approval required`, (body, close) => {
        body.innerHTML = `<div>Ryeditor AI requests permission for the following action:</div><div class="approval-detail">${esc(detail)}</div>
        <div style="color:var(--text-dim);font-size:11.5px">DANGEROUS-classified commands additionally require elevated permissions in Settings.</div>`;
        addFootButton(body.parentElement as HTMLElement, 'Deny', 'btn-secondary', () => { window.ry.approvalRespond(reqId, false); close(); });
        addFootButton(body.parentElement as HTMLElement, 'Approve', 'primary', () => { window.ry.approvalRespond(reqId, true); close(); });
      });
    });
    window.ry.onFileChanged(async (rel) => {
      const t = openTabs.find((x) => x.path === rel || x.path.replace(/[\\/]/g, '/') === rel.replace(/[\\/]/g, '/'));
      if (t && workspace) {
        try {
          const fresh = await window.ry.fsRead(workspace, t.path);
          t.model.setValue(fresh);
          t.dirty = false;
          renderTabs();
        } catch { /* ignore */ }
      }
      await refreshTree();
      toast(`AI modified ${rel}`, 'ok');
    });
  }

  // unique live request id for chunk routing
  let currentLiveReqId = '';
  function liveText_reqId(): string { return currentLiveReqId; }

  // ------------------------------------------------------------------ terminal
  function terminalIds(): string[] { return Array.from(terms.keys()); }

  async function newTerminal(): Promise<void> {
    const id = 't' + (++termSeq);
    const host = document.createElement('div');
    host.className = 'term-host';
    $('term-hosts').appendChild(host);
    const term = new window.Terminal({
      fontSize: 12.5,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      cursorBlink: true,
      theme: {
        background: '#0B1220', foreground: '#D7E3F4',
        cursor: '#2BD9C7', selectionBackground: '#2F6FED55',
        black: '#0B1220', blue: '#2F6FED', cyan: '#2BD9C7', green: '#3FB950',
        magenta: '#B48EAD', red: '#E5534B', white: '#D7E3F4', yellow: '#D9A62E'
      }
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    let backend = 'child_process';
    try { backend = await window.ry.terminalCreate(id, workspace || undefined); } catch (e) { term.write('failed to start shell: ' + String(e)); }
    term.options.convertEol = backend === 'child_process';
    term.onData((d: string) => window.ry.terminalWrite(id, d));
    terms.set(id, { term, fit, host, backend });
    try { fit.fit(); window.ry.terminalResize(id, term.cols, term.rows); } catch { /* hidden */ }
    const tab = document.createElement('div');
    tab.className = 'term-tab';
    tab.textContent = `shell ${id}`;
    tab.onclick = () => activateTerm(id);
    tab.id = 'tab-' + id;
    $('term-tabs').appendChild(tab);
    activateTerm(id);
    toast(`Terminal ${id} started (${backend})`, 'ok');
  }

  function activateTerm(id: string): void {
    activeTermId = id;
    for (const [tid, t] of terms) {
      t.host.classList.toggle('active', tid === id);
      const tabEl = $('tab-' + tid);
      if (tabEl) tabEl.classList.toggle('active', tid === id);
    }
    const t = terms.get(id);
    if (t) { try { t.fit.fit(); window.ry.terminalResize(id, t.term.cols, t.term.rows); t.term.focus(); } catch { /* ignore */ } }
    $('term-backend').textContent = t ? t.backend : '';
  }

  function toggleTerminal(): void {
    const p = $('panel-terminal');
    const show = p.classList.contains('hidden');
    p.classList.toggle('hidden', !show);
    if (show) {
      if (terms.size === 0) void newTerminal();
      else { const first = terminalIds()[0]; if (first) { setTimeout(() => activateTerm(first), 30); } }
    }
  }

  // ------------------------------------------------------------------ workspace
  async function openFolderFlow(): Promise<void> {
    const dir = await window.ry.workspaceOpen();
    if (!dir) return;
    workspace = dir;
    settings.lastWorkspace = dir;
    expanded.clear();
    await window.ry.settingsSave(settings);
    await refreshTree();
    await newTerminalIfNone();
    setStatus();
    toast(`Workspace: ${dir}`, 'ok');
  }

  async function newTerminalIfNone(): Promise<void> {
    if (terms.size === 0) {
      $('panel-terminal').classList.remove('hidden');
      await newTerminal();
    }
  }

  async function restoreWorkspace(): Promise<void> {
    if (settings.lastWorkspace && workspace !== settings.lastWorkspace) {
      try {
        await window.ry.fsList(settings.lastWorkspace, '.');
        workspace = settings.lastWorkspace;
        await refreshTree();
        await newTerminalIfNone();
        setStatus();
      } catch { /* last workspace vanished */ }
    } else {
      setStatus();
    }
  }

  function initEditor(): void {
    defineMonacoThemes();
    editor = monaco.editor.create($('monaco-host'), {
      theme: settings.theme === 'light' ? 'ryeditor-light' : settings.theme === 'hc' ? 'ryeditor-hc' : 'ryeditor-dark',
      automaticLayout: true,
      fontSize: 13.5,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontLigatures: true,
      minimap: { enabled: true },
      inlineSuggest: { enabled: true },
      tabSize: 2,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'phase'
    });
    editor.onDidChangeCursorPosition((e: any) => {
      $('st-cursor').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveActive());
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Backslash, () => void inlineInsert());
    registerInlineAI();
  }

  // ------------------------------------------------------------------ settings UI
  function openSettings(): void {
    modal('Settings', (body, close) => {
      body.innerHTML = `
        <h3 style="margin:4px 0 2px">AI Providers</h3>
        <div id="prov-list"></div>
        <button class="btn-secondary" id="prov-add" style="margin-top:8px">＋ Add provider</button>

        <h3 style="margin:18px 0 2px">Model assignment</h3>
        <label>Agent / Chat model</label>
        <select id="set-agent">${providerOptions(settings.agentProviderId)}</select>
        <label>Autocomplete model (ghost text)</label>
        <select id="set-ac">${providerOptions(settings.autoCompleteProviderId)}</select>
        <label><input type="checkbox" id="set-ac-en" ${settings.autoCompleteEnabled ? 'checked' : ''}/> Enable inline autocomplete</label>
        <label>Agent max steps</label>
        <input type="text" id="set-maxsteps" value="${settings.agentMaxSteps}" />

        <h3 style="margin:18px 0 2px">Permissions</h3>
        <label><input type="radio" name="perm" value="standard" ${settings.permissionLevel === 'standard' ? 'checked' : ''}/> Standard — DANGEROUS commands are blocked</label>
        <label><input type="radio" name="perm" value="elevated" ${settings.permissionLevel === 'elevated' ? 'checked' : ''}/> Elevated — allow DANGEROUS after explicit approval</label>
        <div style="color:var(--text-dim);font-size:11.5px;margin-top:6px">
          Commands are classified: SAFE (auto-run) · CONFIRMATION (ask) · DANGEROUS (ask + elevated) · BLOCKED (never).
        </div>

        <h3 style="margin:18px 0 2px">Appearance</h3>
        <label>Theme</label>
        <select id="set-theme">
          <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Dark (brand)</option>
          <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Light</option>
          <option value="hc" ${settings.theme === 'hc' ? 'selected' : ''}>High Contrast</option>
        </select>
      `;
      renderProvRows(body.querySelector('#prov-list') as HTMLElement);

      (body.querySelector('#prov-add') as HTMLButtonElement).onclick = () => editProvider(null, async () => {
        (body.querySelector('#prov-list') as HTMLElement).innerHTML = '';
        renderProvRows(body.querySelector('#prov-list') as HTMLElement);
      });

      addFootButton(body.parentElement as HTMLElement, 'Cancel', 'btn-secondary', close);
      addFootButton(body.parentElement as HTMLElement, 'Save', 'primary', async () => {
        settings.agentProviderId = (body.querySelector('#set-agent') as HTMLSelectElement).value;
        settings.autoCompleteProviderId = (body.querySelector('#set-ac') as HTMLSelectElement).value;
        settings.autoCompleteEnabled = (body.querySelector('#set-ac-en') as HTMLInputElement).checked;
        settings.agentMaxSteps = Math.max(1, parseInt((body.querySelector('#set-maxsteps') as HTMLInputElement).value || '12', 10) || 12);
        const perm = (body.querySelector('input[name="perm"]:checked') as HTMLInputElement);
        settings.permissionLevel = (perm ? perm.value : 'standard') as 'standard' | 'elevated';
        settings.theme = (body.querySelector('#set-theme') as HTMLSelectElement).value as RySettings['theme'];
        await window.ry.settingsSave(settings);
        applyTheme(settings.theme);
        refreshProviderSelect();
        setStatus();
        close();
        toast('Settings saved', 'ok');
      });
    });
  }

  function providerOptions(selected?: string): string {
    return settings.providers.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} — ${esc(p.model)}</option>`).join('');
  }

  function renderProvRows(host: HTMLElement): void {
    for (const p of settings.providers) {
      const row = document.createElement('div');
      row.className = 'prov-row';
      row.innerHTML = `<span class="pname">${esc(p.name)}</span><span class="ptype">${esc(p.type)}</span><span class="pmodel">${esc(p.model)}</span>`;
      const btns = document.createElement('span');
      const be = document.createElement('button'); be.className = 'mini'; be.textContent = 'Edit';
      be.onclick = () => editProvider(p, () => { row.innerHTML = `<span class="pname">${esc(p.name)}</span><span class="ptype">${esc(p.type)}</span><span class="pmodel">${esc(p.model)}</span>`; });
      const bd = document.createElement('button'); bd.className = 'mini'; bd.textContent = 'Delete';
      bd.onclick = async () => {
        settings.providers = settings.providers.filter((x) => x.id !== p.id);
        await window.ry.settingsSave(settings);
        row.remove();
        refreshProviderSelect();
      };
      btns.appendChild(be); btns.appendChild(bd);
      row.appendChild(btns);
      host.appendChild(row);
    }
  }

  function editProvider(existing: ProviderCfg | null, onSave: () => void): void {
    const p: ProviderCfg = existing || { id: 'p' + Date.now(), type: 'openai-compatible', name: '', baseUrl: '', apiKey: '', model: '' };
    modal(existing ? 'Edit provider' : 'Add provider', (body, close) => {
      body.innerHTML = `
        <label>Type</label>
        <select id="ep-type">
          ${['openai', 'anthropic', 'gemini', 'openai-compatible', 'ollama'].map((t) => `<option value="${t}" ${p.type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <label>Display name</label>
        <input type="text" id="ep-name" value="${esc(p.name)}" placeholder="My provider" />
        <label>Base URL (leave empty for official APIs; local: http://localhost:11434 for Ollama, http://localhost:1234/v1 for LM Studio)</label>
        <input type="text" id="ep-url" value="${esc(p.baseUrl || '')}" />
        <label>API key (not required for local providers)</label>
        <input type="password" id="ep-key" value="${esc(p.apiKey || '')}" />
        <label>Model</label>
        <input type="text" id="ep-model" value="${esc(p.model)}" placeholder="e.g. qwen2.5-coder:7b / gpt-4o-mini / claude-3-5-sonnet-latest" />
      `;
      addFootButton(body.parentElement as HTMLElement, 'Cancel', 'btn-secondary', close);
      addFootButton(body.parentElement as HTMLElement, 'Save', 'primary', async () => {
        p.type = (body.querySelector('#ep-type') as HTMLSelectElement).value as ProviderCfg['type'];
        p.name = (body.querySelector('#ep-name') as HTMLInputElement).value || p.type;
        p.baseUrl = (body.querySelector('#ep-url') as HTMLInputElement).value;
        p.apiKey = (body.querySelector('#ep-key') as HTMLInputElement).value;
        p.model = (body.querySelector('#ep-model') as HTMLInputElement).value || 'default';
        if (!settings.providers.some((x) => x.id === p.id)) settings.providers.push(p);
        if (!settings.agentProviderId) settings.agentProviderId = p.id;
        if (!settings.autoCompleteProviderId) settings.autoCompleteProviderId = p.id;
        await window.ry.settingsSave(settings);
        refreshProviderSelect();
        close();
        onSave();
        toast('Provider saved', 'ok');
      });
    });
  }

  function openMemory(): void {
    if (!workspace) { toast('Open a folder first.', 'err'); return; }
    modal('Project memory (injected into every AI request)', (body, close) => {
      const val = (settings.memory || {})[workspace!] || '';
      body.innerHTML = `<label>Notes about this project the AI should always know:</label>
        <textarea id="mem-ta" rows="10" placeholder="Stack, commands, conventions…">${esc(val)}</textarea>`;
      addFootButton(body.parentElement as HTMLElement, 'Cancel', 'btn-secondary', close);
      addFootButton(body.parentElement as HTMLElement, 'Save', 'primary', async () => {
        settings.memory = settings.memory || {};
        settings.memory[workspace!] = (body.querySelector('#mem-ta') as HTMLTextAreaElement).value;
        await window.ry.settingsSave(settings);
        close();
        toast('Project memory saved', 'ok');
      });
    });
  }

  // ------------------------------------------------------------------ palette
  const commands: { title: string; key: string; run: () => void }[] = [];
  function initCommands(): void {
    commands.push(
      { title: 'File: Open Folder…', key: 'Ctrl+O', run: () => void openFolderFlow() },
      { title: 'File: Save', key: 'Ctrl+S', run: () => void saveActive() },
      { title: 'File: New File…', key: '', run: () => promptNewFile(selectedTreePath || '') },
      { title: 'View: Toggle Terminal', key: 'Ctrl+`', run: toggleTerminal },
      { title: 'View: Toggle Theme', key: '', run: async () => {
          settings.theme = settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'hc' : 'dark';
          await window.ry.settingsSave(settings);
          applyTheme(settings.theme);
          toast(`Theme: ${settings.theme}`, 'ok');
        } },
      { title: 'AI: Insert suggestion at cursor', key: 'Alt+\\', run: () => void inlineInsert() },
      { title: 'AI: Toggle autocomplete', key: '', run: async () => {
          settings.autoCompleteEnabled = !settings.autoCompleteEnabled;
          await window.ry.settingsSave(settings);
          toast(`Inline autocomplete ${settings.autoCompleteEnabled ? 'enabled' : 'disabled'}`, 'ok');
        } },
      { title: 'AI: Undo last AI file change', key: '', run: () => undoAiChange() },
      { title: 'AI: Project memory…', key: '', run: openMemory },
      { title: 'Preferences: Open Settings', key: '', run: openSettings },
      { title: 'Explorer: Refresh', key: '', run: () => void refreshTree() },
      { title: 'Editor: Close active tab', key: '', run: () => { if (activeTabIdx >= 0) closeTab(activeTabIdx); } }
    );
  }

  async function undoAiChange(): Promise<void> {
    if (!workspace) { toast('No workspace.', 'err'); return; }
    const path = await window.ry.checkpointUndo(workspace);
    if (!path) { toast('No AI checkpoints to undo.'); return; }
    await refreshTree();
    const t = openTabs.find((x) => x.path === path);
    if (t && workspace) {
      try {
        const fresh = await window.ry.fsRead(workspace, t.path);
        t.model.setValue(fresh);
        t.dirty = false;
        renderTabs();
      } catch {
        const idx = openTabs.indexOf(t);
        if (idx >= 0) closeTab(idx);
      }
    }
    toast(`Reverted: ${path}`, 'ok');
  }

  function openPalette(): void {
    modal('Command Palette', (body, close) => {
      body.innerHTML = `<input type="text" id="pal-q" placeholder="Type a command…" /><div id="palette-list"></div>`;
      const q = body.querySelector('#pal-q') as HTMLInputElement;
      const list = body.querySelector('#palette-list') as HTMLElement;
      let filtered = commands.slice();
      let sel = 0;
      const draw = () => {
        list.innerHTML = '';
        filtered.forEach((c, i) => {
          const el = document.createElement('div');
          el.className = 'palette-item' + (i === sel ? ' sel' : '');
          el.innerHTML = `<span>${esc(c.title)}</span><span class="k">${esc(c.key)}</span>`;
          el.onclick = () => { close(); c.run(); };
          el.onmousemove = () => { sel = i; draw(); };
          list.appendChild(el);
        });
      };
      q.oninput = () => {
        const v = q.value.toLowerCase();
        filtered = commands.filter((c) => c.title.toLowerCase().includes(v));
        sel = 0;
        draw();
      };
      q.onkeydown = (ev) => {
        if (ev.key === 'ArrowDown') { sel = Math.min(sel + 1, filtered.length - 1); draw(); ev.preventDefault(); }
        else if (ev.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); ev.preventDefault(); }
        else if (ev.key === 'Enter' && filtered[sel]) { close(); filtered[sel].run(); }
        else if (ev.key === 'Escape') close();
      };
      addFootButton(body.parentElement as HTMLElement, 'Close', 'btn-secondary', close);
      draw();
      setTimeout(() => q.focus(), 30);
    });
  }

  // ------------------------------------------------------------------ boot
  function wireChrome(): void {
    $('btn-open-folder').onclick = () => void openFolderFlow();
    $('btn-settings').onclick = openSettings;
    $('btn-palette').onclick = openPalette;
    $('btn-memory').onclick = openMemory;
    $('ai-send').onclick = () => void aiSend();
    $('ai-stop').onclick = () => { ignoreChunks = true; setAiBusy(false); toast('Detached from AI response.'); };
    $('ai-input').addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void aiSend(); }
    });
    $('btn-new-file').onclick = () => promptNewFile(selectedTreePath || '');
    $('btn-new-folder').onclick = async () => {
      const p = window.prompt('New folder path:', selectedTreePath || '');
      if (!p || !workspace) return;
      try { await window.ry.fsMkdir(workspace, p); await refreshTree(); } catch (e) { toast(String(e), 'err'); }
    };
    $('btn-refresh').onclick = () => void refreshTree();
    $('act-undo-ai').onclick = () => void undoAiChange();
    $('btn-term-new').onclick = () => void newTerminal();
    $('btn-term-clear').onclick = () => { const t = terms.get(activeTermId); if (t) t.term.clear(); };
    $('btn-term-close').onclick = toggleTerminal;
    $('ai-mode').onchange = setStatus;
    $('ai-provider').onchange = async (ev) => {
      settings.agentProviderId = (ev.target as HTMLSelectElement).value;
      await window.ry.settingsSave(settings);
      setStatus();
    };

    document.querySelectorAll('.act-btn[data-panel]').forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const panel = (b as HTMLElement).dataset.panel;
        document.querySelectorAll('.act-btn[data-panel]').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        $('sidebar-explorer').classList.toggle('hidden', panel !== 'explorer');
        $('sidebar-ai').classList.toggle('hidden', panel !== 'ai');
        if (panel === 'terminal') toggleTerminal();
      };
    });

    window.addEventListener('keydown', (ev) => {
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ctrl && ev.shiftKey && ev.key.toLowerCase() === 'p') { ev.preventDefault(); openPalette(); }
      else if (ctrl && !ev.shiftKey && ev.key.toLowerCase() === 'o') { ev.preventDefault(); void openFolderFlow(); }
      else if (ctrl && !ev.shiftKey && ev.key === '`') { ev.preventDefault(); toggleTerminal(); }
      else if (ctrl && !ev.shiftKey && ev.key.toLowerCase() === 's') { ev.preventDefault(); void saveActive(); }
      else if (ev.altKey && ev.key === '\\') { ev.preventDefault(); void inlineInsert(); }
    });

    window.ry.onTerminalData((id, d) => {
      const t = terms.get(id);
      if (t) t.term.write(d);
    });
    window.ry.onTerminalExit((id) => {
      const t = terms.get(id);
      if (t) { t.term.writeln('\r\n\x1b[33m[process exited]\x1b[0m'); }
    });

    const ro = new ResizeObserver(() => {
      const t = terms.get(activeTermId);
      if (t && !$('panel-terminal').classList.contains('hidden')) {
        try { t.fit.fit(); window.ry.terminalResize(activeTermId, t.term.cols, t.term.rows); } catch { /* ignore */ }
      }
    });
    ro.observe($('term-hosts'));
  }

  async function main(): Promise<void> {
    settings = await window.ry.settingsLoad();
    applyTheme(settings.theme || 'dark');
    const info = await window.ry.appInfo();
    appVersion = info.version;
    $('term-backend').textContent = info.terminalBackend;
    initCommands();
    wireChrome();
    refreshProviderSelect();
    setStatus();
    wireIpcEvents();
    $('st-app').textContent = `Ryeditor v${info.version} · electron ${info.electron}`;

    window.require.config({ paths: { vs: './vs' } });
    const assetBase = window.location.href.replace(/[^/]*(\?.*)?$/, '');
    window.MonacoEnvironment = {
      getWorkerUrl: () => URL.createObjectURL(new Blob([
        `self.MonacoEnvironment={baseUrl:${JSON.stringify(assetBase)}};importScripts(${JSON.stringify(assetBase + 'vs/base/worker/workerMain.js')});`
      ], { type: 'text/javascript' }))
    };
    window.require(['vs/editor/editor.main'], () => {
      monaco = window.monaco;
      initEditor();
      void restoreWorkspace();
    });
  }

  void main();
})();
