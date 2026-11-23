'use strict';
// The Grace agent loop. No `vscode` import: the IDE and the headless `grace-agent` runner both
// drive it. A task is plain JSON (saved between sessions); the runner turns model replies into
// actions in the project folder, asks the person where the mode says so, and records every change
// so the whole task can be undone.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const P = require('./protocol');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', 'out', '.next', '.cache']);
const TERMINAL = new Set(['done', 'stopped', 'failed']);
const DEFAULTS = {
  maxTurns: 30,
  commandTimeout: 120000,
  autoCommands: ['npm test', 'npm run *', 'npm install', 'pnpm test', 'yarn test', 'pytest*', 'python -m pytest*', 'cargo build*', 'cargo test*', 'cargo check*', 'go build*', 'go test*', 'make', 'make test', 'ls*', 'git status', 'git diff*'],
  autoRunAnyCommand: false,
  contextLength: 16384,
};

let counter = 0;
function newId(prefix) {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/** A fresh task. mode: plan | build | auto. permissions: { create, edit, run }. */
function createTask({ goal, mode = 'build', permissions = {}, context = '', contextLabel = '', root, projectName }) {
  return {
    id: newId('t'),
    goal: String(goal || '').trim(),
    mode: P.MODES[mode] ? mode : 'build',
    permissions: { create: permissions.create !== false, edit: permissions.edit !== false, run: Boolean(permissions.run) },
    context: String(context || ''),
    contextLabel: String(contextLabel || ''),
    root,
    projectName: projectName || path.basename(root || ''),
    phase: mode === 'plan' ? 'plan' : 'build',
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plan: [],
    timeline: [],
    history: [],
    changes: [],
    skipped: [],
    read: [],
    acceptAll: mode === 'auto',
    turns: 0,
    summary: '',
    error: '',
  };
}

/** The project folder as Grace sees it: every path checked to stay inside, symlinks too. */
class Workspace {
  constructor(root) {
    this.root = fs.realpathSync(root);
  }

  resolve(relative, { mustExist = false } = {}) {
    const safe = P.safeRelative(relative);
    if (safe.error) {
      return safe;
    }
    const full = path.join(this.root, safe.path);
    // The deepest part of the path that exists must still be inside the project.
    let probe = full;
    while (!fs.existsSync(probe) && probe !== this.root) {
      probe = path.dirname(probe);
    }
    let real;
    try {
      real = fs.realpathSync(probe);
    } catch {
      return { error: `can't open ${safe.path}` };
    }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) {
      return { error: `${safe.path} points outside the project` };
    }
    if (mustExist && probe !== full) {
      return { error: `${safe.path} doesn't exist` };
    }
    return { path: safe.path, full };
  }

  list(relative) {
    const target = this.resolve(relative || '.', { mustExist: true });
    if (target.error) {
      return target.error;
    }
    const entries = fs.readdirSync(target.full, { withFileTypes: true })
      .filter(entry => entry.name !== '.git')
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    if (!entries.length) {
      return '(empty folder)';
    }
    const lines = entries.slice(0, 200).map(entry => entry.name + (entry.isDirectory() ? '/' : ''));
    if (entries.length > 200) {
      lines.push(`… and ${entries.length - 200} more`);
    }
    return lines.join('\n');
  }

  readText(relative) {
    const target = this.resolve(relative, { mustExist: true });
    if (target.error) {
      return target;
    }
    const stat = fs.statSync(target.full);
    if (stat.isDirectory()) {
      return { error: `${target.path} is a folder; use <list>` };
    }
    if (stat.size > 2 * 1024 * 1024) {
      return { error: `${target.path} is too big to read (${Math.round(stat.size / 1024)} KB)` };
    }
    const buffer = fs.readFileSync(target.full);
    if (buffer.includes(0)) {
      return { error: `${target.path} is a binary file` };
    }
    return { path: target.path, full: target.full, text: buffer.toString('utf8') };
  }

  search(query) {
    query = String(query || '').trim();
    if (query.length < 2) {
      return 'search needs at least two characters';
    }
    const needle = query.toLowerCase();
    const hits = [];
    let files = 0;
    const walk = dir => {
      if (hits.length >= 60 || files > 4000) {
        return;
      }
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.isSymbolicLink()) {
            walk(full);
          }
        } else if (entry.isFile()) {
          files++;
          let text;
          try {
            if (fs.statSync(full).size > 1024 * 1024) {
              continue;
            }
            const buffer = fs.readFileSync(full);
            if (buffer.includes(0)) {
              continue;
            }
            text = buffer.toString('utf8');
          } catch {
            continue;
          }
          if (!text.toLowerCase().includes(needle)) {
            continue;
          }
          const rel = path.relative(this.root, full).split(path.sep).join('/');
          text.split('\n').forEach((line, i) => {
            if (hits.length < 60 && line.toLowerCase().includes(needle)) {
              hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        }
        if (hits.length >= 60) {
          return;
        }
      }
    };
    walk(this.root);
    return hits.length ? hits.join('\n') : `no matches for “${query}”`;
  }
}

/** Runs tasks. host: { ask(prompt, { signal, onChunk, contextLength }), update(task), settings() }. */
class Runner {
  constructor(host) {
    this.host = host;
    this.tasks = new Map();
    this.controllers = new Map();
    this.waiters = new Map();   // taskId → resolve() for the step that waits on the person
    this.modelQueue = Promise.resolve();
  }

  settings() {
    return { ...DEFAULTS, ...(this.host.settings ? this.host.settings() : {}) };
  }

  add(task) {
    this.tasks.set(task.id, task);
    return task;
  }

  changed(task) {
    task.updatedAt = Date.now();
    this.host.update?.(task);
  }

  step(task, fields) {
    const step = { id: newId('s'), at: Date.now(), ...fields };
    task.timeline.push(step);
    this.changed(task);
    return step;
  }

  /** Start (or continue) a task in the background. Resolves when it stops for any reason. */
  start(task) {
    if (this.controllers.has(task.id)) {
      return this.controllers.get(task.id).done;
    }
    const controller = new AbortController();
    const entry = { controller };
    this.controllers.set(task.id, entry);
    entry.done = this.loop(task, controller.signal)
      .catch(error => {
        task.status = 'failed';
        task.error = String(error && error.message || error);
        this.step(task, { kind: 'error', text: task.error });
      })
      .finally(() => {
        this.controllers.delete(task.id);
        this.changed(task);
        this.host.finished?.(task);
      });
    return entry.done;
  }

  stop(task) {
    const entry = this.controllers.get(task.id);
    if (entry) {
      entry.controller.abort();
    }
    const waiter = this.waiters.get(task.id);
    if (waiter) {
      waiter({ approved: false, stop: true });
    }
    if (!entry && !TERMINAL.has(task.status)) {
      task.status = 'stopped';
      this.changed(task);
    }
  }

  /** The person's answer to the step that waits: { approved, note, acceptAll }. */
  respond(task, stepId, answer) {
    const waiter = this.waiters.get(task.id);
    const step = task.timeline.find(item => item.id === stepId);
    if (!waiter || !step || step.state !== 'pending') {
      return false;
    }
    if (answer.acceptAll) {
      task.acceptAll = true;
    }
    waiter(answer);
    return true;
  }

  /** A message from the person: steers a running task, or reopens a finished one. */
  say(task, text) {
    text = String(text || '').trim();
    if (!text) {
      return;
    }
    task.history.push({ user: text });
    this.step(task, { kind: 'user', text });
    const waiter = this.waiters.get(task.id);
    if (waiter) {
      waiter({ approved: false, note: text, feedback: true });
    }
    if (!this.controllers.has(task.id)) {
      task.turnBase = task.turns; // a new message gets a fresh turn budget
      if (task.phase === 'plan' && task.status === 'done') {
        task.phase = 'build';
      }
      task.status = 'queued';
      task.error = '';
      this.start(task);
    }
  }

  waitFor(task, step) {
    task.status = 'waiting';
    step.state = 'pending';
    this.changed(task);
    return new Promise(resolve => {
      this.waiters.set(task.id, answer => {
        this.waiters.delete(task.id);
        resolve(answer);
      });
    });
  }

  /** One model call at a time: local models share the machine. */
  async callModel(task, prompt, signal) {
    let release;
    const turn = new Promise(resolve => { release = resolve; });
    const previous = this.modelQueue;
    this.modelQueue = previous.then(() => turn);
    task.status = 'queued';
    this.changed(task);
    await previous;
    try {
      if (signal.aborted) {
        return { stopped: true, text: '' };
      }
      task.status = 'thinking';
      const live = this.step(task, { kind: 'thought', text: '', live: true });
      let last = 0;
      const result = await this.host.ask(prompt, {
        signal,
        contextLength: this.settings().contextLength,
        onChunk: (_chunk, text) => {
          live.text = P.parseReply(text).thought || '…';
          if (Date.now() - last > 150) {
            last = Date.now();
            this.changed(task);
          }
        },
      });
      live.live = false;
      return { ...result, live };
    } finally {
      release();
    }
  }

  async loop(task, signal) {
    const workspace = new Workspace(task.root);
    const settings = this.settings();
    let nudges = 0;
    while (!signal.aborted) {
      if (task.turns - (task.turnBase || 0) >= settings.maxTurns) {
        task.status = 'failed';
        task.error = `Grace stopped after ${settings.maxTurns} turns without finishing.`;
        this.step(task, { kind: 'error', text: task.error });
        return;
      }
      const budget = Math.max(6000, Math.floor(settings.contextLength * 2.6));
      const prompt = P.buildTurn({
        phase: task.phase, permissions: task.permissions, projectName: task.projectName, goal: task.goal,
        context: task.context, plan: task.plan, history: task.history, budget,
      });
      const reply = await this.callModel(task, prompt, signal);
      if (reply.stopped || signal.aborted) {
        if (reply.live && !reply.live.text) {
          task.timeline = task.timeline.filter(item => item !== reply.live);
        }
        task.status = 'stopped';
        return;
      }
      task.turns++;
      if (reply.code !== 0) {
        task.timeline = task.timeline.filter(item => item !== reply.live);
        task.status = 'failed';
        task.error = this.host.failure ? this.host.failure(reply.code, reply.stderr) : `CherryCola stopped with exit code ${reply.code}.`;
        this.step(task, { kind: 'error', text: task.error });
        return;
      }
      const parsed = P.parseReply(reply.text);
      reply.live.text = parsed.thought;
      if (!parsed.thought) {
        task.timeline = task.timeline.filter(item => item !== reply.live);
      }
      if (!parsed.actions.length) {
        nudges++;
        if (nudges >= 2 && parsed.thought) {
          // The model answered in prose: take it as the result.
          return this.finish(task, parsed.thought);
        }
        task.history.push({ reply: reply.text, results: ['No tags found. Reply with tags such as <list path="."/>, <read path="..."/> or <done>…</done>.'] });
        continue;
      }
      nudges = 0;
      const results = [];
      let finished = null;
      let planReady = false;
      for (const action of parsed.actions) {
        if (signal.aborted) {
          break;
        }
        if (action.type === 'plan') {
          if (action.steps.length) {
            task.plan = action.steps;
            this.step(task, { kind: 'plan', steps: action.steps });
            results.push('[plan] saved.');
            if (task.phase === 'plan') {
              planReady = true;
            }
          } else {
            results.push('[plan] had no steps; write them as "- [ ] step" lines.');
          }
          continue;
        }
        if (action.type === 'done') {
          if (task.phase === 'plan') {
            if (task.plan.length) {
              planReady = true;
            } else {
              results.push('[done] Send a <plan> first; this is the planning phase.');
            }
            continue;
          }
          finished = action.summary || parsed.thought || 'Done.';
          break;
        }
        const result = await this.act(task, workspace, action, signal);
        results.push(`[${P.describe(action)}]\n${P.clipMiddle(result, P.RESULT_LIMIT)}`);
        if (task.status === 'stopped') {
          break;
        }
      }
      task.history.push({ reply: reply.text, results });
      if (signal.aborted || task.status === 'stopped') {
        task.status = 'stopped';
        return;
      }
      if (finished !== null) {
        return this.finish(task, finished);
      }
      if (planReady) {
        if (task.mode !== 'plan') {
          task.phase = 'build';
          continue;
        }
        const review = this.step(task, { kind: 'review-plan', steps: task.plan });
        const answer = await this.waitFor(task, review);
        if (answer.stop) {
          review.state = 'rejected';
          task.status = 'stopped';
          return;
        }
        if (answer.approved) {
          review.state = 'approved';
          if (Array.isArray(answer.plan) && answer.plan.length) {
            task.plan = answer.plan; // edited by the person
          }
          task.phase = 'build';
          task.history.push({ user: 'I approved the plan. Build it now, step by step, and mark steps [x] as you finish them.' });
        } else {
          review.state = 'rejected';
          if (!answer.feedback) {
            task.history.push({ user: answer.note || 'Change the plan, then send it again.' });
          }
        }
      }
    }
    task.status = 'stopped';
  }

  finish(task, summary) {
    task.summary = summary;
    task.status = 'done';
    task.plan = task.plan.map(step => ({ ...step, done: true }));
    this.step(task, { kind: 'summary', text: summary, changes: task.changes.length, skipped: [...task.skipped] });
  }

  /** May this action happen without asking? 'yes', 'ask', or a reason it can't happen at all. */
  policy(task, action) {
    const kind = P.KIND[action.type];
    if (kind === 'look') {
      return 'yes';
    }
    if (task.phase === 'plan') {
      return 'This is the planning phase: send your <plan> first. Nothing can change yet.';
    }
    if (kind === 'create' && !task.permissions.create) {
      return 'Making folders is turned off for this task.';
    }
    if (kind === 'run') {
      if (!task.permissions.run) {
        return 'Running commands is turned off for this task. Tell the person which command to run in <done>.';
      }
      if (task.mode === 'auto') {
        const settings = this.settings();
        if (settings.autoRunAnyCommand || P.commandAllowed(action.command, settings.autoCommands)) {
          return 'yes';
        }
        task.skipped.push(action.command);
        return {
          model: `Auto mode only runs the commands on its allow list, and “${P.oneLine(action.command, 120)}” isn't one. It was not run; list it in <done> for the person.`,
          person: "Not on Auto mode's allow list, so Grace didn't run it. It's listed at the end for you.",
        };
      }
    }
    return task.acceptAll ? 'yes' : 'ask';
  }

  async act(task, workspace, action, signal) {
    switch (action.type) {
      case 'list': {
        const result = workspace.list(action.path);
        this.step(task, { kind: 'action', type: 'list', title: P.describe(action), state: 'done', output: result });
        return result;
      }
      case 'read': {
        const file = workspace.readText(action.path);
        if (file.error) {
          this.step(task, { kind: 'action', type: 'read', title: P.describe(action), state: 'failed', output: file.error });
          return file.error;
        }
        if (!task.read.includes(file.path)) {
          task.read.push(file.path);
        }
        const lines = file.text.split('\n').length;
        this.step(task, { kind: 'action', type: 'read', title: P.describe(action), path: file.path, state: 'done', output: `${lines} lines` });
        return P.clipMiddle(file.text, P.READ_LIMIT);
      }
      case 'search': {
        const result = workspace.search(action.query);
        this.step(task, { kind: 'action', type: 'search', title: P.describe(action), state: 'done', output: result });
        return result;
      }
      case 'mkdir':
        return this.mkdir(task, workspace, action);
      case 'write':
      case 'edit':
        return this.write(task, workspace, action);
      case 'run':
        return this.runCommand(task, action, signal);
      default:
        return `unknown action ${action.type}`;
    }
  }

  /** Ask (where the mode says so), then do. Returns the result text for the model. */
  async gate(task, action, fields, perform) {
    const decision = this.policy(task, action);
    const step = this.step(task, { kind: 'action', type: action.type, title: P.describe(action), ...fields, state: 'working' });
    if (decision !== 'yes' && decision !== 'ask') {
      step.state = 'blocked';
      step.output = decision.person || decision;
      this.changed(task);
      return decision.model || decision;
    }
    if (decision === 'ask') {
      const answer = await this.waitFor(task, step);
      if (answer.stop) {
        step.state = 'rejected';
        task.status = 'stopped';
        return 'The person stopped the task.';
      }
      if (!answer.approved) {
        step.state = 'rejected';
        task.status = 'acting';
        this.changed(task);
        return answer.feedback ? 'The person did not accept this; see their message.' : `The person said no${answer.note ? `: ${answer.note}` : '.'}`;
      }
    }
    task.status = 'acting';
    step.state = 'working';
    this.changed(task);
    try {
      const output = await perform(step);
      step.state = 'done';
      this.changed(task);
      return output;
    } catch (error) {
      step.state = 'failed';
      step.output = String(error && error.message || error);
      this.changed(task);
      return `failed: ${step.output}`;
    }
  }

  async mkdir(task, workspace, action) {
    const target = workspace.resolve(action.path);
    if (target.error) {
      this.step(task, { kind: 'action', type: 'mkdir', title: P.describe(action), state: 'failed', output: target.error });
      return target.error;
    }
    if (fs.existsSync(target.full)) {
      return fs.statSync(target.full).isDirectory() ? `${target.path} already exists.` : `${target.path} is a file.`;
    }
    return this.gate(task, action, { path: target.path }, () => {
      // Record each folder that didn't exist, outermost first, so undo removes them all.
      const made = [];
      let probe = target.full;
      while (!fs.existsSync(probe)) {
        made.unshift(probe);
        probe = path.dirname(probe);
      }
      fs.mkdirSync(target.full, { recursive: true });
      for (const dir of made) {
        task.changes.push({ kind: 'dir', path: path.relative(workspace.root, dir).split(path.sep).join('/'), before: null, after: null });
      }
      return `Made ${target.path}/`;
    });
  }

  async write(task, workspace, action) {
    const target = workspace.resolve(action.path);
    const fail = message => {
      this.step(task, { kind: 'action', type: action.type, title: P.describe(action), state: 'failed', output: message });
      return message;
    };
    if (target.error) {
      return fail(target.error);
    }
    const exists = fs.existsSync(target.full);
    if (exists && fs.statSync(target.full).isDirectory()) {
      return fail(`${target.path} is a folder`);
    }
    let before = null;
    let after;
    if (exists) {
      const file = workspace.readText(target.path);
      if (file.error) {
        return fail(file.error);
      }
      before = file.text;
      if (!task.read.includes(target.path)) {
        return fail(`Read ${target.path} with <read path="${target.path}"/> before you change it.`);
      }
      if (!task.permissions.edit) {
        return fail('Changing existing files is turned off for this task.');
      }
    } else if (!task.permissions.create) {
      return fail('Making new files is turned off for this task.');
    }
    if (action.type === 'edit') {
      if (!exists) {
        return fail(`${target.path} doesn't exist; use <write> to create it`);
      }
      if (!action.ok) {
        return fail('An <edit> needs <find>…</find> and <replace>…</replace>.');
      }
      const edited = P.applyEdit(before, action.find, action.replace);
      if (edited.error) {
        return fail(edited.error);
      }
      after = edited.text;
    } else {
      after = action.content.endsWith('\n') || !action.content ? action.content : action.content + '\n';
    }
    if (before !== null && before.replace(/\r\n/g, '\n') === after) {
      return `${target.path} already has that content.`;
    }
    const stats = P.lineStats(before, after);
    const fields = { path: target.path, before, after, created: before === null, added: stats.added, removed: stats.removed };
    return this.gate(task, action, fields, () => {
      fs.mkdirSync(path.dirname(target.full), { recursive: true });
      fs.writeFileSync(target.full, after);
      task.changes.push({ kind: 'file', path: target.path, before, after });
      if (!task.read.includes(target.path)) {
        task.read.push(target.path);
      }
      return before === null ? `Created ${target.path} (${stats.added} lines).` : `Changed ${target.path} (+${stats.added} −${stats.removed}).`;
    });
  }

  async runCommand(task, action, signal) {
    if (!action.command) {
      return 'the <run> tag had no command';
    }
    return this.gate(task, action, { command: action.command, output: '' }, step => new Promise(resolve => {
      const settings = this.settings();
      let output = '';
      const child = childProcess.spawn('/bin/sh', ['-c', action.command], {
        cwd: task.root,
        env: { ...process.env, GRACE_AGENT: '1', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const append = chunk => {
        output = (output + chunk).slice(-20000);
        step.output = output;
        this.changed(task);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const kill = () => child.kill('SIGTERM');
      const timer = setTimeout(() => {
        append(`\n(stopped after ${Math.round(settings.commandTimeout / 1000)} seconds)`);
        kill();
      }, settings.commandTimeout);
      signal.addEventListener('abort', kill, { once: true });
      child.on('error', error => append(String(error.message)));
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', kill);
        step.exitCode = code;
        resolve(`exit code ${code === null ? sig : code}\n${output.trim() || '(no output)'}`);
      });
    }));
  }

  /**
   * Undo every change the task made, newest first. A file someone changed since is left alone.
   * Returns { undone, kept: [paths] }.
   */
  undo(task) {
    const workspace = new Workspace(task.root);
    let undone = 0;
    const kept = [];
    for (const change of [...task.changes].reverse()) {
      const target = workspace.resolve(change.path);
      if (target.error) {
        kept.push(change.path);
        continue;
      }
      try {
        if (change.kind === 'dir') {
          if (fs.existsSync(target.full) && !fs.readdirSync(target.full).length) {
            fs.rmdirSync(target.full);
            undone++;
          } else if (fs.existsSync(target.full)) {
            kept.push(change.path + '/');
          }
          continue;
        }
        const now = fs.existsSync(target.full) ? fs.readFileSync(target.full, 'utf8') : null;
        if (now !== change.after) {
          kept.push(change.path);
          continue;
        }
        if (change.before === null) {
          fs.unlinkSync(target.full);
        } else {
          fs.writeFileSync(target.full, change.before);
        }
        undone++;
      } catch {
        kept.push(change.path);
      }
    }
    task.changes = [];
    this.step(task, { kind: 'undo', text: `Undid ${undone} change${undone === 1 ? '' : 's'}.` + (kept.length ? ` Left alone because they changed since: ${kept.join(', ')}.` : '') });
    return { undone, kept };
  }
}

/** What a task's file changes add up to: [{ path, created, added, removed }]. */
function changeSummary(task) {
  const files = new Map();
  for (const change of task.changes) {
    if (change.kind !== 'file') {
      continue;
    }
    const first = files.get(change.path);
    files.set(change.path, { path: change.path, before: first ? first.before : change.before, after: change.after });
  }
  return [...files.values()].map(file => ({ path: file.path, created: file.before === null, ...P.lineStats(file.before, file.after) }));
}

module.exports = { Runner, Workspace, createTask, changeSummary, DEFAULTS, TERMINAL };
