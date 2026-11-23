#!/usr/bin/env node
'use strict';
// grace-agent: Grace's coding agent without the IDE window (Auto mode, headless).
//   grace-agent [options] "what to build"
// It works in the current folder (or --dir), with the model CherryCola uses, and prints each step.
// In ToffeeTwirl the same agent runs from the Grace Agents view; this is for terminals, scripts and CI.

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');
const cherrycola = require('../agent/cherrycola');
const P = require('../agent/protocol');
const { Runner, createTask, changeSummary, DEFAULTS } = require('../agent/runner');

const HELP = `Usage: grace-agent [options] "what to build"

Grace plans and builds in this folder with the local model (CherryCola), without asking.
Every file and folder it makes stays inside the folder; commands run only when --run allows them.

Options:
  --dir PATH          the project folder (default: the current folder)
  --plan              only look around and print a plan; change nothing
  --run               allow commands from the allow list (npm test, pytest, cargo test, …)
  --allow CMD         add a command pattern to the allow list ("npm run *"); repeatable
  --any-command       allow every command (careful: the model chooses them)
  --no-create         don't make new folders or files
  --no-edit           don't change existing files
  --model NAME        a CherryCola model for this run (default: CherryCola's current model)
  --preset NAME       code (default), precise, balanced or creative
  --context N         context length in tokens (default ${DEFAULTS.contextLength})
  --max-turns N       give up after N model turns (default ${DEFAULTS.maxTurns})
  --json              print one JSON object per event instead of text
  -h, --help          show this

Exit codes: 0 done, 1 usage, 2 the model server can't be reached, 3 the model isn't downloaded,
4 the task stopped or failed.`;

function parseArgs(argv) {
  const options = { dir: process.cwd(), mode: 'auto', run: false, allow: [], any: false, create: true, edit: true, model: '', preset: 'code', context: DEFAULTS.contextLength, maxTurns: DEFAULTS.maxTurns, json: false, goal: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`${arg} needs a value`);
      }
      return argv[++i];
    };
    switch (arg) {
      case '-h': case '--help': options.help = true; break;
      case '--dir': options.dir = value(); break;
      case '--plan': options.mode = 'plan'; break;
      case '--run': options.run = true; break;
      case '--allow': options.allow.push(value()); options.run = true; break;
      case '--any-command': options.any = true; options.run = true; break;
      case '--no-create': options.create = false; break;
      case '--no-edit': options.edit = false; break;
      case '--model': options.model = value(); break;
      case '--preset': options.preset = value(); break;
      case '--context': options.context = Number(value()); break;
      case '--max-turns': options.maxTurns = Number(value()); break;
      case '--json': options.json = true; break;
      default:
        if (arg.startsWith('-') && arg !== '-') {
          throw new Error(`unknown option ${arg}`);
        }
        options.goal.push(arg);
    }
  }
  if (options.model && !cherrycola.validModel(options.model)) {
    throw new Error(`${options.model} is not a model name`);
  }
  if (!cherrycola.PRESETS.includes(options.preset)) {
    throw new Error(`--preset is one of ${cherrycola.PRESETS.join(', ')}`);
  }
  if (!(options.context >= 2048) || !(options.maxTurns >= 1)) {
    throw new Error('--context needs at least 2048 and --max-turns at least 1');
  }
  return options;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`grace-agent: ${error.message}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  let goal = options.goal.join(' ').trim();
  if (goal === '-') {
    goal = fs.readFileSync(0, 'utf8').trim();
  }
  if (!goal) {
    process.stderr.write('grace-agent: say what to build, e.g. grace-agent "add a --verbose flag"\n');
    return 1;
  }
  const grace = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'grace');
  if (!lib.aiEnabled(readText(path.join(grace, 'desktop.conf')))) {
    process.stderr.write('grace-agent: AI is off in GraceOS Settings → AI & Models.\n');
    return 1;
  }
  const remote = lib.modelServerHost(readText(path.join(grace, 'cherrycola.conf')));
  if (remote) {
    process.stderr.write(`grace-agent: CherryCola is set to use a model server at ${remote}. Grace only uses a model on this computer.\n`);
    return 1;
  }
  let root;
  try {
    root = fs.realpathSync(options.dir);
    if (!fs.statSync(root).isDirectory()) {
      throw new Error();
    }
  } catch {
    process.stderr.write(`grace-agent: ${options.dir} is not a folder\n`);
    return 1;
  }

  const emit = options.json
    ? event => process.stdout.write(JSON.stringify(event) + '\n')
    : event => {
      const line = {
        thought: () => `· ${event.text}`,
        action: () => `${{ done: '✓', failed: '✗', blocked: '⊘', rejected: '✗' }[event.state] || '•'} ${event.title}${event.output && event.state !== 'done' ? ` — ${P.oneLine(event.output, 160)}` : ''}`,
        plan: () => 'Plan:\n' + P.formatPlan(event.steps).replace(/^/gm, '  '),
        summary: () => `\nDone. ${event.text}`,
        error: () => `✗ ${event.text}`,
      }[event.kind];
      if (line) {
        process.stdout.write(line() + '\n');
      }
    };

  const seen = new Set();
  let exitCode = 0;
  const runner = new Runner({
    settings: () => ({ maxTurns: options.maxTurns, contextLength: options.context, autoRunAnyCommand: options.any, autoCommands: [...DEFAULTS.autoCommands, ...options.allow] }),
    ask: (prompt, opts) => cherrycola.ask(prompt, { ...opts, model: options.model, preset: options.preset }),
    failure: (code, stderr) => {
      const failure = lib.failure(code, stderr);
      exitCode = { 'model-missing': 3, unreachable: 2, 'not-installed': 2 }[failure.kind] || 4;
      return failure.message + (failure.kind === 'model-missing' ? ' Run: cherrycola pull' : '');
    },
    // Print each step once it has settled (a live thought or a running command isn't final yet).
    update: task => {
      for (const step of task.timeline) {
        const settled = step.kind !== 'thought' ? !['working', 'pending'].includes(step.state) : !step.live;
        if (!seen.has(step.id) && settled && (step.kind !== 'thought' || step.text)) {
          seen.add(step.id);
          emit(step);
        }
      }
    },
  });
  const task = runner.add(createTask({
    goal, mode: options.mode, root,
    permissions: { create: options.create, edit: options.edit, run: options.run },
  }));
  task.acceptAll = true;
  const stop = () => runner.stop(task);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (options.mode === 'plan') {
    // Plan only: stop at the plan review instead of waiting for a person.
    const watch = setInterval(() => {
      if (task.status === 'waiting') {
        runner.stop(task);
      }
    }, 50);
    await runner.start(task);
    clearInterval(watch);
    if (task.plan.length) {
      if (!options.json) {
        process.stdout.write('\nPlan ready. Run again without --plan to build it.\n');
      }
      return 0;
    }
    return exitCode || 4;
  }

  await runner.start(task);
  const changes = changeSummary(task);
  if (options.json) {
    emit({ kind: 'result', status: task.status, changes, skipped: task.skipped, error: task.error });
  } else {
    if (changes.length) {
      process.stdout.write('\nChanged files:\n' + changes.map(c => `  ${c.created ? 'new ' : ''}${c.path} (+${c.added} −${c.removed})`).join('\n') + '\n');
    }
    if (task.skipped.length) {
      process.stdout.write('\nNot run (not on the allow list; run them yourself if they look right):\n' + task.skipped.map(c => `  ${c}`).join('\n') + '\n');
    }
  }
  if (task.status === 'done') {
    return 0;
  }
  return exitCode || 4;
}

main().then(code => { process.exitCode = code; }, error => {
  process.stderr.write(`grace-agent: ${error && error.stack || error}\n`);
  process.exitCode = 4;
});
