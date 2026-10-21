'use strict';
// Grace in ToffeeTwirl: explain or ask about code with GraceOS's local AI (`cherrycola ask -`).
// Nothing is read or sent until a command runs; answers are plain text in the "Grace" output.

const vscode = require('vscode');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const COMMAND = 'cherrycola';

function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'grace');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const output = vscode.window.createOutputChannel('Grace');
  const status = vscode.window.createStatusBarItem('grace.status', vscode.StatusBarAlignment.Right, 100);
  status.name = 'Grace';
  status.text = '$(sparkle) Grace';
  status.tooltip = 'Ask Grace: the local AI on this computer (CherryCola)';
  status.command = 'grace.ask';
  context.subscriptions.push(output, status);

  let aiOn = true;
  let running = null; // the cherrycola child process while one runs

  function refreshAi() {
    aiOn = lib.aiEnabled(readText(path.join(configDir(), 'desktop.conf')));
    vscode.commands.executeCommand('setContext', 'grace.ai', aiOn);
    if (aiOn) {
      status.show();
    } else {
      status.hide();
    }
  }
  refreshAi();
  // GraceOS Settings rewrites desktop.conf; watch the folder, since editors replace the file.
  try {
    let timer;
    const watcher = fs.watch(configDir(), () => {
      clearTimeout(timer);
      timer = setTimeout(refreshAi, 200);
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    // No ~/.config/grace (not GraceOS): AI stays on, and nothing changes it.
  }

  async function run(action, { code = '', fileName = '', language = '', question = '', where = '' }) {
    if (!aiOn) {
      vscode.window.showInformationMessage('AI is off in GraceOS Settings → AI & Models.');
      return;
    }
    if (running) {
      vscode.window.showInformationMessage('Grace is still answering. Cancel it from the notification first.');
      return;
    }
    const remote = lib.modelServerHost(readText(path.join(configDir(), 'cherrycola.conf')));
    if (remote) {
      vscode.window.showErrorMessage(`CherryCola is set to use a model server at ${remote}. Grace in ToffeeTwirl only uses a model on this computer: change ollama_url or lmstudio_url in ~/.config/grace/cherrycola.conf.`);
      return;
    }
    const clipped = lib.clip(code);
    const prompt = lib.buildPrompt(action, { code: clipped.text, fileName, language, question });

    output.clear();
    const subject = { explain: `Explain ${where}`, ask: `“${question}” about ${where}`, question: `“${question}”` }[action];
    output.appendLine(`Grace · ${subject}`);
    if (clipped.truncated) {
      output.appendLine(`(Grace read the first ${clipped.text.length.toLocaleString()} characters.)`);
    }
    output.appendLine('');
    output.show(true);

    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Grace is answering…',
      cancellable: true,
    }, (_progress, token) => new Promise(resolve => {
      let stderr = '';
      let started = true;
      const child = childProcess.spawn(COMMAND, ['ask', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      running = child;
      token.onCancellationRequested(() => child.kill());
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => output.append(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      // ENOENT, or EACCES when an unreadable directory on PATH hides it: no usable cherrycola either way.
      child.on('error', () => { started = false; });
      child.on('close', (code, signal) => {
        running = null;
        if (!started) {
          resolve(lib.failure(null, ''));
        } else if (token.isCancellationRequested || signal) {
          resolve({ kind: 'stopped', message: 'Stopped.' });
        } else if (code === 0) {
          resolve(null);
        } else {
          resolve(lib.failure(code, stderr));
        }
      });
      child.stdin.on('error', () => { /* the process may exit before reading everything */ });
      child.stdin.end(prompt);
    }));

    output.appendLine('');
    if (result === null) {
      output.appendLine('— Made on this computer by CherryCola. Code goes to the model as data, and Grace only writes text here: it can\'t edit, open or run anything.');
      return;
    }
    output.appendLine(`— ${result.message}`);
    if (result.kind === 'model-missing') {
      const choice = await vscode.window.showErrorMessage(result.message, 'Download the model');
      if (choice) {
        // Downloading is the user's call; the terminal shows its progress.
        const terminal = vscode.window.createTerminal('CherryCola');
        terminal.show();
        terminal.sendText(`${COMMAND} pull`);
      }
    } else if (result.kind !== 'stopped') {
      vscode.window.showErrorMessage(result.message);
    }
  }

  function editorTarget(editor, wholeFile) {
    const document = editor.document;
    const selection = editor.selection;
    const name = vscode.workspace.asRelativePath(document.uri, false) || path.basename(document.fileName);
    if (!wholeFile && !selection.isEmpty) {
      const first = selection.start.line + 1;
      const last = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
      return { code: document.getText(selection), fileName: name, language: document.languageId, where: `${name}, lines ${first}–${last}` };
    }
    return { code: document.getText(), fileName: name, language: document.languageId, where: name };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('grace.explainSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Open a file, and select the code you want explained.');
        return;
      }
      return run('explain', editorTarget(editor, false));
    }),
    vscode.commands.registerCommand('grace.askAboutFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Open a file to ask Grace about it.');
        return;
      }
      const target = editorTarget(editor, editor.selection.isEmpty);
      const question = await vscode.window.showInputBox({
        title: `Ask Grace about ${target.where}`,
        prompt: 'Grace answers on this computer (CherryCola). The code goes to the model as data.',
        placeHolder: 'What does this do? Where is the bug?',
      });
      if (question && question.trim()) {
        return run('ask', { ...target, question });
      }
    }),
    vscode.commands.registerCommand('grace.ask', async () => {
      const question = await vscode.window.showInputBox({
        title: 'Ask Grace',
        prompt: 'Grace answers on this computer (CherryCola). No code is sent with this question.',
        placeHolder: 'How do I read a file line by line in Rust?',
      });
      if (question && question.trim()) {
        return run('question', { question });
      }
    }),
    { dispose: () => running && running.kill() },
  );
}

function deactivate() { }

module.exports = { activate, deactivate };
