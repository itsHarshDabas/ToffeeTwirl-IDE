// Grace Agents webview: the Agent Home tab and the side bar share this file.
// Everything from the extension is data: the DOM is built with textContent, never HTML strings.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let state = null;
  // What the person is typing survives re-renders (and the webview being hidden).
  const draft = Object.assign({
    goal: '', mode: null, create: true, edit: true, run: false, includeEditor: false,
    say: {}, notes: {}, planEdits: {}, showModel: false, showAll: false,
  }, saved.draft || {});

  function remember() {
    vscode.setState({ draft });
  }

  function send(type, data) {
    vscode.postMessage(Object.assign({ type }, data || {}));
  }

  /** h('div.class', { attrs, on: { click } }, children…) */
  function h(spec, props, ...children) {
    const [tag, ...classes] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) {
      el.className = classes.join(' ');
    }
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key === 'on') {
        for (const [event, fn] of Object.entries(value)) {
          el.addEventListener(event, fn);
        }
      } else if (key === 'text') {
        el.textContent = value;
      } else if (key === 'value') {
        el.value = value;
      } else if (key === 'checked') {
        el.checked = Boolean(value);
      } else if (key === 'width') {
        el.style.width = value; // CSSOM, which the webview's CSP allows (style attributes it doesn't)
      } else if (key === 'class') {
        el.className += ' ' + value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  const ICON = {
    list: '▤', read: '◱', search: '⌕', mkdir: '▣', write: '✎', edit: '✎', run: '❯',
  };
  const STATUS = {
    queued: 'Waiting for the model', thinking: 'Thinking', acting: 'Working', waiting: 'Needs you',
    done: 'Done', stopped: 'Stopped', failed: 'Stopped with a problem',
  };

  function ago(time) {
    const s = Math.max(0, (Date.now() - time) / 1000);
    if (s < 60) {
      return 'just now';
    }
    if (s < 3600) {
      return `${Math.floor(s / 60)} min ago`;
    }
    if (s < 86400) {
      return `${Math.floor(s / 3600)} h ago`;
    }
    return new Date(time).toLocaleDateString();
  }

  function dot(status) {
    return h('span.dot', { class: `dot-${status}`, 'aria-hidden': 'true' });
  }

  function button(label, onClick, kind, extra) {
    return h(`button.btn${kind ? '.btn-' + kind : ''}`, Object.assign({ type: 'button', on: { click: onClick } }, extra || {}), label);
  }

  // ---- composer --------------------------------------------------------------------------------
  function composer() {
    const mode = draft.mode || state.defaults.mode;
    const modes = state.modes;
    const goal = h('textarea.goal', {
      id: 'goal', rows: state.layout === 'home' ? 4 : 3, value: draft.goal,
      placeholder: 'Describe what to build or change. Grace plans it, makes the folders and files, and checks its work.',
      'aria-label': 'What should Grace build?',
      on: {
        input: event => { draft.goal = event.target.value; remember(); },
        keydown: event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            start();
          }
        },
      },
    });
    const toggle = (key, label, hint) => h('label.toggle', { title: hint },
      h('input', { type: 'checkbox', checked: draft[key], on: { change: event => { draft[key] = event.target.checked; remember(); } } }),
      h('span', { text: label }));
    const blockers = [];
    if (!state.folder) {
      blockers.push(h('div.notice', {},
        h('span', { text: 'Grace works inside a project folder.' }),
        button('Open a folder', () => send('openFolder'), 'quiet'),
        button('New project…', () => send('newProject', { goal: draft.goal, mode, permissions: perms() }), 'quiet', { title: 'Make a new folder, open it, and start this task there' })));
    } else if (!state.trusted) {
      blockers.push(h('div.notice', {}, h('span', { text: 'Grace can change files and run commands, so it only works in a folder you trust.' }), button('Trust this folder…', () => send('trust'), 'quiet')));
    }
    return h('section.composer', {},
      h('h1.title', {}, h('span.spark', { 'aria-hidden': 'true', text: '✦' }), state.layout === 'home' ? 'What should Grace build?' : 'New task'),
      state.layout === 'home' && state.folder ? h('p.sub', { text: `In ${state.folder}, with ${modelLabel()} on this computer.` }) : null,
      blockers,
      goal,
      h('div.modes', { role: 'radiogroup', 'aria-label': 'Mode' },
        Object.entries(modes).map(([key, info]) => h('button.mode', {
          type: 'button', role: 'radio', 'aria-checked': String(mode === key), class: mode === key ? 'on' : '',
          title: info.blurb, on: { click: () => { draft.mode = key; remember(); render(); } },
        }, h('span.mode-name', { text: info.label })))),
      h('p.blurb', { text: modes[mode].blurb }),
      h('div.toggles', {},
        toggle('create', 'Make folders & files', 'Grace may create new folders and files in this project'),
        toggle('edit', 'Edit files', 'Grace may change files that already exist (after reading them)'),
        toggle('run', 'Run commands', mode === 'auto' ? 'In Auto mode only commands on the allow list run (Settings → Grace Agents)' : 'Grace may run commands; you approve each one'),
        state.editor ? toggle('includeEditor', `Include ${state.editor}`, 'Send the open file (or the selection) with the task, as data') : null),
      h('div.row', {},
        h('span.hint', { text: 'Ctrl+Enter to start' }),
        button(mode === 'plan' ? 'Make a plan' : mode === 'auto' ? 'Start in Auto' : 'Start building', start, 'primary', { disabled: !state.folder || !state.trusted || !state.aiOn ? true : undefined })),
      h('div.templates', {}, state.templates.map(t => h('button.chip', {
        type: 'button', title: t.goal,
        on: { click: () => { draft.goal = t.goal; draft.mode = t.mode; Object.assign(draft, t.permissions); remember(); render(); focus('goal', true); } },
      }, t.label))));
  }

  function perms() {
    return { create: draft.create, edit: draft.edit, run: draft.run };
  }

  function start() {
    const goal = draft.goal.trim();
    if (!goal) {
      focus('goal');
      return;
    }
    send('start', { goal, mode: draft.mode || state.defaults.mode, permissions: perms(), includeEditor: draft.includeEditor });
    draft.goal = '';
    remember();
  }

  function modelLabel() {
    const c = state.cherry;
    return state.defaults.model || (c && c.model) || 'the local model';
  }

  // ---- CherryCola card -------------------------------------------------------------------------
  function modelCard() {
    const c = state.cherry || {};
    const open = draft.showModel || state.layout === 'home';
    const header = h('button.card-head', {
      type: 'button', 'aria-expanded': String(open),
      on: { click: () => { draft.showModel = !draft.showModel; remember(); render(); } },
    }, dot(c.error ? 'failed' : c.reachable ? (c.running ? 'done' : 'idle') : c.loading ? 'queued' : 'stopped'),
    h('span.card-title', { text: 'CherryCola' }),
    h('span.muted', { text: c.loading ? 'checking…' : c.error ? (c.error === 'not-installed' ? 'not installed' : 'not answering') : `${c.backend || '?'} · ${modelLabel()}` }));
    if (!open) {
      return h('section.card.model', {}, header);
    }
    if (c.loading) {
      return h('section.card.model', {}, header);
    }
    if (c.error) {
      return h('section.card.model', {}, header,
        h('p.muted', { text: c.error === 'not-installed' ? 'Grace runs models through CherryCola. Install the cherrycola package (and Ollama or llama.cpp) to use it.' : `CherryCola didn't answer: ${c.detail || 'unknown error'}.` }),
        button('Check again', () => send('cherry', { action: 'refresh' }), 'quiet'));
    }
    const models = Array.isArray(c.models) ? c.models : [];
    const select = (label, value, options, onChange, hint) => h('label.field', { title: hint }, h('span', { text: label }),
      h('select', { on: { change: event => onChange(event.target.value) } },
        options.map(([v, text]) => h('option', { value: v, selected: v === value ? true : undefined, text }))));
    const engineNames = { auto: 'Automatic', ollama: 'Ollama', llamacpp: 'llama.cpp', lmstudio: 'LM Studio' };
    return h('section.card.model', {}, header,
      h('div.fields', {},
        select('Engine', c.configuredBackend || 'auto', state.engines.map(e => [e, engineNames[e] || e]), value => send('cherry', { action: 'backend', value }), 'Which engine CherryCola runs models with (cherrycola backend)'),
        select('Model', state.defaults.model, [['', `Follow CherryCola (${c.model || 'default'})`], ...models.map(m => [m, m + (m === c.running ? ' · loaded' : '')])], value => send('cherry', { action: 'model', value }), 'The model Grace Agents use. CherryCola\'s own default stays as it is.'),
        select('Preset', state.defaults.preset, state.presets.map(p => [p, p[0].toUpperCase() + p.slice(1)]), value => send('cherry', { action: 'preset', value }), 'Sampling preset for agent turns; "Code" keeps answers focused')),
      h('div.row.wrap', {},
        h('span.muted', { text: c.reachable ? (c.running ? `Loaded: ${c.running}` : 'Engine ready, no model loaded') : 'Engine not running' }),
        c.busy ? h('span.muted', { text: `${c.busy}…` }) : null,
        !c.reachable ? button('Start engine', () => send('cherry', { action: 'start' }), 'quiet', { title: 'cherrycola start: starts Ollama, or loads the model in llama.cpp' }) : button('Stop engine', () => send('cherry', { action: 'stop' }), 'quiet', { title: 'cherrycola stop' }),
        c.installed === false && (c.backend === 'ollama') ? button('Download model', () => send('cherry', { action: 'pull' }), 'quiet') : null,
        state.defaults.model && state.defaults.model !== c.model ? button('Make it CherryCola\'s default', () => send('cherry', { action: 'use', value: state.defaults.model }), 'quiet') : null,
        button('CherryCola app', () => send('cherry', { action: 'app' }), 'quiet', { title: 'Open CherryCola for model downloads and every engine setting' }),
        button('↻', () => send('cherry', { action: 'refresh' }), 'icon', { title: 'Check again', 'aria-label': 'Check CherryCola again' })));
  }

  // ---- task list -------------------------------------------------------------------------------
  function taskList() {
    const groups = [
      ['Needs you', state.tasks.filter(t => t.status === 'waiting')],
      ['Working', state.tasks.filter(t => ['queued', 'thinking', 'acting'].includes(t.status))],
      ['Earlier', state.tasks.filter(t => ['done', 'stopped', 'failed'].includes(t.status))],
    ];
    const selectedId = state.selected && state.selected.id;
    const limit = draft.showAll ? 1000 : 8;
    return h('nav.tasks', { 'aria-label': 'Tasks' },
      state.layout === 'home' ? button('＋ New task', () => send('select', { taskId: null }), selectedId ? 'quiet' : 'primary', { class: 'new' }) : null,
      state.tasks.length ? null : h('p.muted.empty', { text: 'Tasks you start show up here. Several can wait in line; Grace runs one model turn at a time.' }),
      groups.filter(([, items]) => items.length).map(([label, items]) => h('div.group', {},
        h('h2.group-title', { text: `${label} · ${items.length}` }),
        items.slice(0, label === 'Earlier' ? limit : 100).map(t => h('button.task', {
          type: 'button', class: t.id === selectedId ? 'on' : '', title: t.goal,
          on: { click: () => send('select', { taskId: t.id }) },
        }, dot(t.status),
        h('span.task-goal', { text: t.goal }),
        h('span.task-meta', {}, h('span.badge', { class: `badge-${t.mode}`, text: state.modes[t.mode].label }),
          t.planTotal ? h('span', { text: `${t.planDone}/${t.planTotal}` }) : null,
          h('span', { text: ago(t.updatedAt) })))),
        label === 'Earlier' && items.length > 8 ? button(draft.showAll ? 'Show fewer' : `Show all ${items.length}`, () => { draft.showAll = !draft.showAll; remember(); render(); }, 'link') : null)));
  }

  // ---- one task --------------------------------------------------------------------------------
  function diffView(step) {
    if (!step.diff || !step.diff.length) {
      return null;
    }
    return h('pre.diff', { 'aria-label': `Changes to ${step.path}` }, step.diff.map(line => h('span.dl', { class: { '+': 'add', '-': 'del', '…': 'fold', ' ': 'ctx' }[line.type] },
      h('span.sign', { text: line.type === '…' ? '⋯' : line.type }), line.text, '\n')));
  }

  function approval(task, step) {
    const key = step.id;
    const note = h('input.note', {
      id: `note-${key}`, value: draft.notes[key] || '', placeholder: 'Say why, or what to do instead (optional)',
      on: { input: event => { draft.notes[key] = event.target.value; remember(); } },
    });
    const answer = (approved, acceptAll) => {
      send('respond', { taskId: task.id, stepId: step.id, approved, acceptAll, note: draft.notes[key] || '' });
      delete draft.notes[key];
      remember();
    };
    const what = step.type === 'run' ? 'Run this command?' : step.type === 'mkdir' ? 'Make this folder?' : step.created ? 'Create this file?' : 'Make this change?';
    return h('div.approval', {},
      h('div.approval-q', { text: what }),
      note,
      h('div.row.wrap', {},
        button(step.type === 'run' ? 'Run' : 'Accept', () => answer(true, false), 'primary'),
        step.type === 'write' || step.type === 'edit' ? button('Review in editor', () => send('openDiff', { taskId: task.id, stepId: step.id }), 'quiet') : null,
        button('Reject', () => answer(false, false), 'quiet'),
        button('Accept all for this task', () => answer(true, true), 'link', { title: 'Grace stops asking for the rest of this task. You can still undo everything afterwards.' })));
  }

  function planReview(task, step) {
    const key = step.id;
    const lines = draft.planEdits[key] !== undefined ? draft.planEdits[key] : step.steps.map(s => s.text).join('\n');
    const editor = h('textarea.plan-edit', {
      id: `plan-${key}`, rows: Math.min(14, step.steps.length + 2), value: lines, 'aria-label': 'The plan, one step per line',
      on: { input: event => { draft.planEdits[key] = event.target.value; remember(); } },
    });
    const note = h('input.note', {
      id: `note-${key}`, value: draft.notes[key] || '', placeholder: 'Or tell Grace what to change in the plan',
      on: { input: event => { draft.notes[key] = event.target.value; remember(); } },
    });
    const done = (approved, acceptAll) => {
      const plan = (draft.planEdits[key] !== undefined ? draft.planEdits[key] : lines).split('\n').map(l => l.replace(/^\s*(?:[-*]|\d+[.)])?\s*(?:\[[ xX]\])?\s*/, '').trim()).filter(Boolean);
      send('respond', { taskId: task.id, stepId: step.id, approved, acceptAll, plan, note: draft.notes[key] || '' });
      delete draft.planEdits[key];
      delete draft.notes[key];
      remember();
    };
    return h('div.approval.plan-review', {},
      h('div.approval-q', { text: 'Grace has a plan. Edit it if you like, then let Grace build it.' }),
      editor, note,
      h('div.row.wrap', {},
        button('Approve and build', () => done(true, false), 'primary', { title: 'You review each change as Grace makes it' }),
        button('Approve, build without asking', () => done(true, true), 'quiet', { title: 'Grace makes the changes without asking; you can undo them all afterwards' }),
        button('Send back', () => done(false, false), 'quiet', { title: 'Grace changes the plan using your note' })));
  }

  function stepView(task, step) {
    switch (step.kind) {
      case 'thought':
        return step.text ? h('div.thought', { class: step.live ? 'live' : '' }, h('span.who', { text: 'Grace' }), h('p', { text: step.text })) : (step.live ? h('div.thought.live', {}, h('span.who', { text: 'Grace' }), h('p.muted', { text: 'Thinking…' })) : null);
      case 'user':
        return h('div.user', {}, h('span.who', { text: 'You' }), h('p', { text: step.text }));
      case 'plan':
        return h('div.event', {}, h('span.ico', { text: '☰' }), h('span', { text: `Plan updated · ${step.steps.length} steps` }));
      case 'review-plan':
        return step.state === 'pending' ? planReview(task, step) : h('div.event', {}, h('span.ico', { text: step.state === 'approved' ? '✓' : '↺' }), h('span', { text: step.state === 'approved' ? 'You approved the plan' : 'You sent the plan back' }));
      case 'summary':
        return null; // shown in the wrap-up card
      case 'undo':
        return h('div.event', {}, h('span.ico', { text: '↶' }), h('span', { text: step.text }));
      case 'error':
        return h('div.error', { role: 'alert', text: step.text });
      case 'action': {
        const open = step.state === 'pending' || step.type === 'run' || ((step.type === 'write' || step.type === 'edit') && step.state === 'done') || step.state === 'failed' || step.state === 'blocked';
        const title = h('div.action-head', {},
          h('span.ico', { text: ICON[step.type] || '•' }),
          step.path && (step.type === 'read' || step.type === 'write' || step.type === 'edit') && step.state === 'done'
            ? h('button.linkish', { type: 'button', on: { click: () => send(step.type === 'read' ? 'openFile' : 'openDiff', { taskId: task.id, path: step.path, stepId: step.id }) }, text: step.title })
            : h('span.action-title', { text: step.title }),
          step.added !== undefined ? h('span.stat', {}, h('span.plus', { text: `+${step.added}` }), ' ', h('span.minus', { text: `−${step.removed}` })) : null,
          h('span.state', { class: `state-${step.state}`, text: { done: '', working: '…', pending: 'needs you', failed: 'failed', blocked: 'not allowed', rejected: 'rejected' }[step.state] || '' }));
        const body = [];
        if (open && step.type === 'run' && step.output) {
          body.push(h('pre.output', { text: step.output }));
        } else if (open && (step.state === 'failed' || step.state === 'blocked') && step.output) {
          body.push(h('p.muted.small', { text: step.output }));
        }
        if (open && (step.type === 'write' || step.type === 'edit') && step.state !== 'failed') {
          body.push(diffView(step));
        }
        if (step.state === 'pending') {
          body.push(approval(task, step));
        }
        return h('div.action', { class: `action-${step.state}` }, title, body);
      }
      default:
        return null;
    }
  }

  function planCard(task) {
    if (!task.plan.length) {
      return null;
    }
    const done = task.plan.filter(s => s.done).length;
    return h('section.card.plan', {},
      h('div.card-head.static', {}, h('span.card-title', { text: 'Plan' }), h('span.muted', { text: `${done} of ${task.plan.length}` })),
      h('div.progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(task.plan.length), 'aria-valuenow': String(done) }, h('span', { width: `${Math.round(100 * done / task.plan.length)}%` })),
      h('ol.steps', {}, task.plan.map(s => h('li', { class: s.done ? 'done' : '' }, h('span.check', { 'aria-hidden': 'true', text: s.done ? '✓' : '' }), h('span', { text: s.text })))));
  }

  function wrapUp(task) {
    if (task.status !== 'done' && !task.changes.length && !task.skipped.length) {
      return null;
    }
    return h('section.card.wrap-up', {},
      h('div.card-head.static', {}, h('span.card-title', { text: task.status === 'done' ? 'Wrap-up' : 'Changes so far' }),
        task.changes.length ? h('span.muted', { text: `${task.changes.length} file${task.changes.length === 1 ? '' : 's'}` }) : null),
      task.summary ? h('p.summary', { text: task.summary }) : null,
      task.changes.length ? h('ul.files', {}, task.changes.map(c => h('li', {},
        h('button.linkish', { type: 'button', on: { click: () => send('openFileDiff', { taskId: task.id, path: c.path }) }, text: c.path }),
        c.created ? h('span.badge.badge-new', { text: 'new' }) : null,
        h('span.stat', {}, h('span.plus', { text: `+${c.added}` }), ' ', h('span.minus', { text: `−${c.removed}` }))))) : null,
      task.skipped.length ? h('div.skipped', {},
        h('p.muted.small', { text: 'Not run, because Auto mode only runs commands on its allow list:' }),
        task.skipped.map(command => h('div.row', {}, h('code', { text: command }), button('Run in terminal', () => send('runInTerminal', { taskId: task.id, command }), 'quiet', { title: 'Opens a terminal with the command typed in; press Enter there to run it' })))) : null);
  }

  function taskView(task) {
    const say = h('textarea.say', {
      id: `say-${task.id}`, rows: 2, value: draft.say[task.id] || '',
      placeholder: task.running ? 'Steer Grace while it works…' : 'Ask for a follow-up or a fix…',
      'aria-label': 'Message to Grace',
      on: {
        input: event => { draft.say[task.id] = event.target.value; remember(); },
        keydown: event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const text = (draft.say[task.id] || '').trim();
            if (text) {
              send('say', { taskId: task.id, text });
              draft.say[task.id] = '';
              remember();
            }
          }
        },
      },
    });
    const perms = [task.permissions.create && 'folders & files', task.permissions.edit && 'edits', task.permissions.run && 'commands'].filter(Boolean).join(', ') || 'look only';
    return h('section.task-view', {},
      h('header.task-head', {},
        state.layout === 'side' ? button('‹ Tasks', () => send('select', { taskId: null }), 'link') : null,
        h('h1.task-title', { text: task.goal }),
        h('div.row.wrap.meta', {},
          dot(task.status), h('span', { text: STATUS[task.status] || task.status }),
          h('span.badge', { class: `badge-${task.mode}`, text: state.modes[task.mode].label }),
          task.phase === 'plan' && task.mode === 'plan' ? h('span.muted', { text: 'planning' }) : null,
          h('span.muted', { text: `May use: ${perms}` }),
          task.contextLabel ? h('span.muted', { text: `With ${task.contextLabel}` }) : null),
        h('div.row.wrap', {},
          task.running ? button('Stop', () => send('stop', { taskId: task.id }), 'quiet') : null,
          !task.running && task.status !== 'done' ? button('Continue', () => send('continue', { taskId: task.id }), 'quiet') : null,
          task.canUndo && !task.running ? button('Undo all changes', () => send('undo', { taskId: task.id }), 'quiet') : null,
          state.layout === 'side' ? button('Open in Agent Home', () => send('openHome', { taskId: task.id }), 'link') : null,
          !task.running ? button('Remove', () => send('remove', { taskId: task.id }), 'link', { title: 'Remove this task from the list (its changes stay)' }) : null)),
      task.error ? h('div.error', { role: 'alert', text: task.error }) : null,
      planCard(task),
      h('div.timeline', {}, h('div.user', {}, h('span.who', { text: 'You' }), h('p', { text: task.goal })), task.timeline.map(step => stepView(task, step))),
      wrapUp(task),
      h('div.say-box', {}, say, h('span.hint', { text: 'Enter sends · Shift+Enter for a new line' })));
  }

  // ---- page --------------------------------------------------------------------------------------
  function render() {
    if (!state) {
      return;
    }
    const scroller = document.scrollingElement;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    const keepScroll = scroller.scrollTop;
    const active = document.activeElement;
    const focusId = active && active.id;
    const sel = focusId && active.selectionStart !== undefined ? [active.selectionStart, active.selectionEnd] : null;

    let page;
    if (!state.aiOn) {
      page = h('section.off', {}, h('h1.title', { text: 'AI is off' }), h('p.muted', { text: 'Turn AI on in GraceOS Settings → AI & Models to use Grace Agents. The rest of ToffeeTwirl works as usual.' }));
    } else if (state.layout === 'home') {
      page = h('div.home', {},
        h('aside.left', {}, taskList()),
        h('main.main', {}, state.selected ? taskView(state.selected) : h('div.start', {}, composer(), modelCard())));
    } else {
      page = state.selected ? taskView(state.selected) : h('div.side', {}, composer(), modelCard(), taskList());
    }
    app.replaceChildren(page);

    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus();
        if (sel && el.setSelectionRange) {
          el.setSelectionRange(sel[0], sel[1]);
        }
      }
    }
    const lastSelected = render.lastSelected;
    render.lastSelected = state.selected && state.selected.id;
    if (state.selected && (atBottom || lastSelected !== render.lastSelected)) {
      scroller.scrollTop = scroller.scrollHeight;
    } else {
      scroller.scrollTop = keepScroll;
    }
  }

  function focus(id, end) {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      if (end && el.setSelectionRange) {
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (message && message.type === 'state') {
      state = message.state;
      render();
    }
  });
  setInterval(() => state && !document.activeElement?.matches?.('textarea, input, select') && render(), 30000); // "x min ago"
  send('ready');
}());
