'use strict';
// Grace Agents in ToffeeTwirl: the Agent Home tab, the Grace Agents side bar, diff review, and the
// CherryCola model controls. The agent loop itself is in runner.js (shared with `grace-agent`).

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const lib = require('../lib');
const P = require('./protocol');
const cherrycola = require('./cherrycola');
const { Runner, createTask, changeSummary, TERMINAL } = require('./runner');

const STATE_KEY = 'grace.agent.tasks';
const PENDING_KEY = 'grace.agent.pendingProject';
const KEEP_TASKS = 40;
const SCHEME = 'grace-agent';
const TEMPLATES = [
  { label: 'Scaffold a project', mode: 'build', goal: 'Set up a new project here: ', permissions: { create: true, edit: true, run: false } },
  { label: 'Write tests', mode: 'build', goal: 'Write tests for ', permissions: { create: true, edit: true, run: true } },
  { label: 'Fix what fails', mode: 'auto', goal: 'Run the tests, find why they fail, and fix it.', permissions: { create: false, edit: true, run: true } },
  { label: 'Map this codebase', mode: 'plan', goal: 'Read this project and explain how it is organised, then suggest the three most useful improvements.', permissions: { create: false, edit: false, run: false } },
];

function nonce() {
  return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

// @param {vscode.ExtensionContext} context
// @param {{ aiOn: () => boolean, onAiChange: (fn: () => void) => void, configDir: () => string, readText: (f: string) => string, status: vscode.StatusBarItem }} grace
function registerAgents(context, grace) {
  const clients = new Set();     // { webview, layout, selected }
  let home = null;               // the Agent Home WebviewPanel
  let cherry = { loading: true };
  let broadcastTimer = null;

  const config = () => vscode.workspace.getConfiguration('grace.agent');
  const folder = () => vscode.workspace.workspaceFolders?.[0];

  // ---- tasks -------------------------------------------------------------------------------
  const runner = new Runner({
    settings: () => {
      const c = config();
      return {
        maxTurns: c.get('maxTurns', 30),
        contextLength: c.get('contextLength', 16384),
        autoCommands: c.get('autoCommands'),
        autoRunAnyCommand: c.get('autoRunAnyCommand', false),
        commandTimeout: Math.max(5, c.get('commandTimeoutSeconds', 120)) * 1000,
      };
    },
    ask: (prompt, options) => {
      const model = config().get('model', '');
      return cherrycola.ask(prompt, { ...options, model: cherrycola.validModel(model) ? model : '', preset: config().get('preset', 'code') });
    },
    failure: (code, stderr) => lib.failure(code, stderr).message,
    update: () => scheduleBroadcast(),
    finished: task => {
      save();
      const watching = home && home.active && home.client.selected === task.id;
      if (task.status === 'done' && !watching) {
        vscode.window.showInformationMessage(`Grace finished: ${P.oneLine(task.goal, 80)}`, 'Open').then(choice => {
          if (choice) {
            openHome(task.id);
          }
        });
      } else if (task.status === 'failed') {
        vscode.window.showErrorMessage(`Grace stopped: ${task.error}`, 'Open').then(choice => {
          if (choice) {
            openHome(task.id);
          }
        });
      }
    },
  });

  // Tasks of this workspace, newest first. Ones that were running when the window closed are stopped;
  // a message or Continue picks them up again.
  for (const task of context.workspaceState.get(STATE_KEY, [])) {
    if (!TERMINAL.has(task.status)) {
      task.status = 'stopped';
      for (const step of task.timeline) {
        if (step.state === 'pending' || step.state === 'working') {
          step.state = 'rejected';
        }
        step.live = false;
      }
    }
    runner.add(task);
  }

  function tasks() {
    return [...runner.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const keep = tasks().slice(0, KEEP_TASKS);
      for (const task of tasks().slice(KEEP_TASKS)) {
        if (!runner.controllers.has(task.id)) {
          runner.tasks.delete(task.id);
        }
      }
      context.workspaceState.update(STATE_KEY, keep);
    }, 500);
  }

  function updateStatusBar() {
    const busy = tasks().filter(task => !TERMINAL.has(task.status) && task.status !== 'waiting').length;
    const waiting = tasks().filter(task => task.status === 'waiting').length;
    const model = config().get('model', '') || cherry.model || '';
    let text = '$(sparkle) Grace';
    if (waiting) {
      text = `$(bell-dot) Grace · ${waiting} waiting`;
    } else if (busy) {
      text = `$(loading~spin) Grace · ${busy} working`;
    } else if (model) {
      text = `$(sparkle) Grace · ${model}`;
    }
    grace.status.text = text;
  }

  // ---- what the webviews see ---------------------------------------------------------------
  function listItem(task) {
    return {
      id: task.id, goal: task.goal, mode: task.mode, status: task.status, phase: task.phase,
      createdAt: task.createdAt, updatedAt: task.updatedAt,
      planDone: task.plan.filter(step => step.done).length, planTotal: task.plan.length,
    };
  }

  function detail(task) {
    if (!task) {
      return null;
    }
    return {
      ...listItem(task),
      permissions: task.permissions, contextLabel: task.contextLabel, plan: task.plan, acceptAll: task.acceptAll,
      summary: task.summary, error: task.error, skipped: task.skipped, running: runner.controllers.has(task.id),
      changes: changeSummary(task), canUndo: task.changes.length > 0,
      timeline: task.timeline.slice(-200).map(step => {
        const out = { ...step };
        delete out.before;
        delete out.after;
        if (step.type === 'write' || step.type === 'edit') {
          out.diff = P.diffLines(step.before, step.after, { limit: step.state === 'pending' ? 400 : 80 });
        }
        if (typeof out.output === 'string') {
          out.output = P.clipMiddle(out.output, 6000);
        }
        return out;
      }),
    };
  }

  function stateFor(client) {
    const ws = folder();
    if (client.selected && !runner.tasks.has(client.selected)) {
      client.selected = null;
    }
    const c = config();
    return {
      layout: client.layout,
      aiOn: grace.aiOn(),
      folder: ws ? ws.name : '',
      trusted: vscode.workspace.isTrusted,
      tasks: tasks().map(listItem),
      selected: detail(runner.tasks.get(client.selected)),
      cherry,
      defaults: { mode: c.get('defaultMode', 'build'), model: c.get('model', ''), preset: c.get('preset', 'code') },
      modes: P.MODES,
      templates: TEMPLATES,
      presets: cherrycola.PRESETS,
      engines: cherrycola.ENGINES,
      editor: activeEditorLabel(),
    };
  }

  function post(client) {
    client.webview.postMessage({ type: 'state', state: stateFor(client) });
  }

  function scheduleBroadcast() {
    if (broadcastTimer) {
      return;
    }
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      updateStatusBar();
      save();
      for (const client of clients) {
        post(client);
      }
    }, 80);
  }

  function activeEditorLabel() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return '';
    }
    const name = vscode.workspace.asRelativePath(editor.document.uri, false);
    if (!editor.selection.isEmpty) {
      return `${name}, lines ${editor.selection.start.line + 1}–${editor.selection.end.line + 1}`;
    }
    return name;
  }

  function editorContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return { context: '', label: '' };
    }
    const label = activeEditorLabel();
    const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
    const clipped = lib.clip(text);
    return {
      label,
      context: [`File: ${P.oneLine(label, 200)}`, lib.CODE_START, clipped.text.split(lib.CODE_START).join('').split(lib.CODE_END).join(''), lib.CODE_END].join('\n'),
    };
  }

  // ---- CherryCola --------------------------------------------------------------------------
  async function refreshCherry() {
    const result = await cherrycola.status();
    cherry = result.error ? { error: result.error, detail: result.detail || '' } : result;
    scheduleBroadcast();
  }

  async function cherryControl(action, value) {
    cherry = { ...cherry, busy: action };
    scheduleBroadcast();
    const result = await cherrycola.control(action, value);
    if (!result.ok) {
      vscode.window.showErrorMessage(`CherryCola: ${result.message || 'that did not work.'}`);
    }
    await refreshCherry();
  }

  // ---- checks before a task starts -----------------------------------------------------------
  function blocker() {
    if (!grace.aiOn()) {
      return 'AI is off in GraceOS Settings → AI & Models.';
    }
    if (!folder()) {
      return 'Open a folder first: Grace works inside one project folder.';
    }
    if (!vscode.workspace.isTrusted) {
      return 'Grace Agents only work in a trusted folder, because they can change files and run commands. Trust this folder to use them.';
    }
    const remote = lib.modelServerHost(grace.readText(path.join(grace.configDir(), 'cherrycola.conf')));
    if (remote) {
      return `CherryCola is set to use a model server at ${remote}. Grace only uses a model on this computer: change ollama_url or lmstudio_url in ~/.config/grace/cherrycola.conf.`;
    }
    if (folder().uri.scheme !== 'file') {
      return 'Grace Agents work on folders on this computer.';
    }
    return null;
  }

  function startTask({ goal, mode, permissions, includeEditor }, client) {
    const problem = blocker();
    if (problem) {
      vscode.window.showWarningMessage(problem);
      return null;
    }
    goal = String(goal || '').trim().slice(0, 8000);
    if (!goal) {
      return null;
    }
    const ws = folder();
    const editorBits = includeEditor ? editorContext() : { context: '', label: '' };
    const task = runner.add(createTask({
      goal, mode, permissions: permissions || {}, root: ws.uri.fsPath, projectName: ws.name,
      context: editorBits.context, contextLabel: editorBits.label,
    }));
    if (client) {
      client.selected = task.id;
    }
    runner.start(task);
    scheduleBroadcast();
    return task;
  }

  // ---- diffs in the editor -------------------------------------------------------------------
  const contents = new Map(); // uri string → text
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent: uri => contents.get(uri.toString()) ?? '',
  }));

  function virtual(label, file, text) {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${label}/${file}`, query: nonce() });
    contents.set(uri.toString(), text ?? '');
    if (contents.size > 200) {
      contents.delete(contents.keys().next().value);
    }
    return uri;
  }

  function openStepDiff(task, step) {
    if (!step || step.after === undefined) {
      return;
    }
    const left = virtual('before', step.path, step.before);
    const right = step.state === 'pending' ? virtual('proposed', step.path, step.after) : virtual('after', step.path, step.after);
    const title = `${step.path} (${step.state === 'pending' ? 'Grace proposes' : 'Grace changed'})`;
    vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  function openFileDiff(task, file) {
    // Everything the task did to one file: its first "before" against what is on disk now.
    const first = task.changes.find(change => change.kind === 'file' && change.path === file);
    if (!first) {
      return openFile(task, file);
    }
    const target = path.join(task.root, file);
    const left = virtual('before', file, first.before);
    vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(target), `${file} (Grace's changes)`, { preview: true });
  }

  function openFile(task, file) {
    const safe = P.safeRelative(file);
    if (safe.error) {
      return;
    }
    const target = vscode.Uri.file(path.join(task.root, safe.path));
    vscode.commands.executeCommand('vscode.open', target);
  }

  // ---- messages from the webviews ------------------------------------------------------------
  async function onMessage(client, message) {
    const task = message.taskId ? runner.tasks.get(message.taskId) : null;
    switch (message.type) {
      case 'ready':
        post(client);
        if (cherry.loading) {
          refreshCherry();
        }
        return;
      case 'start':
        startTask(message, client);
        return;
      case 'select':
        client.selected = message.taskId || null;
        post(client);
        return;
      case 'openHome':
        openHome(message.taskId || client.selected);
        return;
      case 'respond': {
        if (!task) {
          return;
        }
        const plan = Array.isArray(message.plan) ? message.plan.map(text => ({ text: P.oneLine(text, 300), done: false })).filter(step => step.text) : undefined;
        runner.respond(task, message.stepId, { approved: Boolean(message.approved), note: P.oneLine(message.note, 1000), acceptAll: Boolean(message.acceptAll), plan });
        scheduleBroadcast();
        return;
      }
      case 'say':
        if (task) {
          const problem = blocker();
          if (problem && !runner.controllers.has(task.id)) {
            vscode.window.showWarningMessage(problem);
            return;
          }
          runner.say(task, String(message.text || '').slice(0, 4000));
          scheduleBroadcast();
        }
        return;
      case 'continue':
        if (task && !runner.controllers.has(task.id)) {
          runner.say(task, 'Continue where you stopped.');
        }
        return;
      case 'stop':
        if (task) {
          runner.stop(task);
        }
        return;
      case 'undo':
        if (task && !runner.controllers.has(task.id)) {
          const choice = await vscode.window.showWarningMessage(`Undo every change Grace made in “${P.oneLine(task.goal, 60)}”?`, { modal: true, detail: 'Files you changed yourself since then are left alone.' }, 'Undo');
          if (choice) {
            const { undone, kept } = runner.undo(task);
            vscode.window.showInformationMessage(`Grace undid ${undone} change${undone === 1 ? '' : 's'}.` + (kept.length ? ` ${kept.length} left alone because they changed since.` : ''));
            scheduleBroadcast();
          }
        }
        return;
      case 'remove':
        if (task) {
          runner.stop(task);
          runner.tasks.delete(task.id);
          scheduleBroadcast();
        }
        return;
      case 'openDiff':
        if (task) {
          openStepDiff(task, task.timeline.find(step => step.id === message.stepId));
        }
        return;
      case 'openFileDiff':
        if (task) {
          openFileDiff(task, String(message.path || ''));
        }
        return;
      case 'openFile':
        if (task) {
          openFile(task, String(message.path || ''));
        }
        return;
      case 'runInTerminal':
        if (task && task.skipped.includes(message.command)) {
          // The person chose to run it, in a terminal they can see and stop.
          const terminal = vscode.window.createTerminal({ name: 'Grace', cwd: task.root });
          terminal.show();
          terminal.sendText(message.command, false);
        }
        return;
      case 'cherry':
        if (message.action === 'refresh') {
          refreshCherry();
        } else if (message.action === 'model') {
          // Grace Agents' own model; empty follows CherryCola's.
          await config().update('model', cherrycola.validModel(message.value) ? message.value : '', vscode.ConfigurationTarget.Global);
          scheduleBroadcast();
        } else if (message.action === 'preset' && cherrycola.PRESETS.includes(message.value)) {
          await config().update('preset', message.value, vscode.ConfigurationTarget.Global);
          scheduleBroadcast();
        } else if (message.action === 'pull') {
          const terminal = vscode.window.createTerminal('CherryCola');
          terminal.show();
          terminal.sendText(`${cherrycola.COMMAND} pull`);
        } else if (message.action === 'app') {
          try {
            require('child_process').spawn('cherrycola-chat', [], { detached: true, stdio: 'ignore' }).on('error', () => {
              vscode.window.showErrorMessage('The CherryCola app is not installed.');
            }).unref();
          } catch {
            vscode.window.showErrorMessage('The CherryCola app is not installed.');
          }
        } else if (['use', 'backend', 'start', 'stop'].includes(message.action)) {
          cherryControl(message.action, message.value);
        }
        return;
      case 'openFolder':
        vscode.commands.executeCommand('workbench.action.files.openFolder');
        return;
      case 'newProject':
        newProject(message);
        return;
      case 'trust':
        vscode.commands.executeCommand('workbench.trust.manage');
        return;
      case 'settings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'grace.agent');
        return;
    }
  }

  /** Make a new project folder, open it, and start the task there once it opens. */
  async function newProject({ goal, mode, permissions }) {
    const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Make the project here', title: 'Where should the new project go?' });
    if (!parent?.length) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'Name the new project folder',
      validateInput: value => /^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/.test(value.trim()) ? null : 'Letters, numbers, spaces, dots, dashes and underscores',
    });
    if (!name) {
      return;
    }
    const target = path.join(parent[0].fsPath, name.trim());
    if (fs.existsSync(target)) {
      vscode.window.showErrorMessage(`${target} already exists.`);
      return;
    }
    fs.mkdirSync(target);
    await context.globalState.update(PENDING_KEY, { path: target, goal, mode, permissions: { ...permissions, create: true }, at: Date.now() });
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceReuseWindow: !folder() });
  }

  // ---- webviews ------------------------------------------------------------------------------
  function html(webview, layout) {
    const media = name => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name));
    const n = nonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('agent.css')}" rel="stylesheet">
<title>Grace Agents</title>
</head>
<body class="layout-${layout}">
<div id="app" aria-live="polite"></div>
<script nonce="${n}" src="${media('agent.js')}"></script>
</body>
</html>`;
  }

  function attach(webview, layout, onDispose) {
    const client = { webview, layout, selected: null };
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
    webview.html = html(webview, layout);
    clients.add(client);
    const sub = webview.onDidReceiveMessage(message => onMessage(client, message));
    onDispose(() => {
      clients.delete(client);
      sub.dispose();
    });
    return client;
  }

  function openHome(taskId) {
    if (home) {
      home.reveal(vscode.ViewColumn.One);
    } else {
      home = vscode.window.createWebviewPanel('grace.agentHome', 'Grace Agents', vscode.ViewColumn.One, { retainContextWhenHidden: true });
      home.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'grace-agents.svg');
      const client = attach(home.webview, 'home', fn => home.onDidDispose(() => { fn(); home = null; }));
      home.client = client;
    }
    if (taskId) {
      home.client.selected = taskId;
      post(home.client);
    }
  }

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('grace.agents', {
    resolveWebviewView: view => {
      attach(view.webview, 'side', fn => view.onDidDispose(fn));
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));

  // Keep "Include the open file" labels current.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => scheduleBroadcast()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => scheduleBroadcast()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('grace.agent')) {
        scheduleBroadcast();
      }
    }),
  );
  grace.onAiChange(() => {
    if (!grace.aiOn()) {
      // AI was switched off in GraceOS Settings: nothing keeps running.
      for (const task of tasks()) {
        runner.stop(task);
      }
    }
    scheduleBroadcast();
  });

  // ---- commands ------------------------------------------------------------------------------
  const ask = async mode => {
    const goal = await vscode.window.showInputBox({
      title: `Grace Agents · ${P.MODES[mode].label}`,
      prompt: P.MODES[mode].blurb,
      placeHolder: 'Add a dark mode toggle to the settings page',
    });
    if (goal && goal.trim()) {
      const c = config();
      const task = startTask({ goal, mode, permissions: { create: true, edit: true, run: c.get('allowCommands', false) }, includeEditor: false });
      if (task) {
        if (mode === 'auto') {
          vscode.window.showInformationMessage('Grace is working on it in the background. You get a notification when it is done.', 'Watch').then(choice => {
            if (choice) {
              openHome(task.id);
            }
          });
        } else {
          openHome(task.id);
        }
      }
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('grace.agent.open', () => openHome()),
    vscode.commands.registerCommand('grace.agent.plan', () => ask('plan')),
    vscode.commands.registerCommand('grace.agent.build', () => ask('build')),
    vscode.commands.registerCommand('grace.agent.auto', () => ask('auto')),
    vscode.commands.registerCommand('grace.agent.stopAll', () => {
      for (const task of tasks()) {
        runner.stop(task);
      }
    }),
    vscode.commands.registerCommand('grace.agent.chooseModel', async () => {
      await refreshCherry();
      if (cherry.error) {
        vscode.window.showErrorMessage("CherryCola isn't installed or didn't answer.");
        return;
      }
      const current = config().get('model', '');
      const picks = [
        { label: `Follow CherryCola (${cherry.model || 'its default'})`, value: '', picked: !current },
        ...cherry.models.map(model => ({ label: model, value: model, description: model === cherry.running ? 'loaded' : '', picked: model === current })),
      ];
      const pick = await vscode.window.showQuickPick(picks, { title: 'Model for Grace Agents' });
      if (pick) {
        await config().update('model', pick.value, vscode.ConfigurationTarget.Global);
      }
    }),
    { dispose: () => { for (const task of tasks()) { runner.stop(task); } } },
  );

  // ---- agent-first start -----------------------------------------------------------------------
  const pending = context.globalState.get(PENDING_KEY);
  const ws = folder();
  if (pending && ws && ws.uri.fsPath === pending.path && Date.now() - pending.at < 10 * 60 * 1000) {
    context.globalState.update(PENDING_KEY, undefined);
    setTimeout(() => {
      openHome();
      const task = startTask(pending, home?.client);
      if (task) {
        openHome(task.id);
      }
    }, 500);
  } else if (config().get('openHomeOnStartup', true) && grace.aiOn()) {
    // Open the Agent Home when the window has nothing else to show.
    setTimeout(() => {
      const editors = vscode.window.tabGroups.all.reduce((n, group) => n + group.tabs.length, 0);
      if (!editors) {
        openHome();
      }
    }, 800);
  }
  refreshCherry();
  updateStatusBar();
  return { runner, refreshCherry };
}

module.exports = { registerAgents };
