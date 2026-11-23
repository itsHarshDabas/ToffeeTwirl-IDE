#!/usr/bin/env node
'use strict';
// A stand-in for `cherrycola` in tests: `ask -` answers with the next reply from the JSON list in
// $FAKE_REPLIES (a file it rewrites as it goes) and logs each prompt to $FAKE_LOG; `status --json`
// prints a fixed status. It never runs a model.
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'status') {
  process.stdout.write(JSON.stringify({ backend: 'ollama', configured_backend: 'auto', reachable: true, model: 'qwen3:4b', installed: true, running: 'qwen3:4b', models: ['qwen3:4b', 'qwen2.5-coder:7b'], search: 'duckduckgo' }) + '\n');
  process.exit(0);
}
if (args[0] === 'use' || args[0] === 'backend' || args[0] === 'start' || args[0] === 'stop') {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args }) + '\n');
  process.stdout.write(`ok ${args.join(' ')}\n`);
  process.exit(0);
}
if (args[0] !== 'ask') {
  process.stderr.write('CherryCola: unknown command\n');
  process.exit(1);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const file = process.env.FAKE_REPLIES;
  const replies = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, prompt: input }) + '\n');
  const reply = replies.length ? replies.shift() : '<done>\nNothing left to do.\n</done>';
  fs.writeFileSync(file, JSON.stringify(replies));
  if (reply === '__EXIT3__') {
    process.stderr.write("CherryCola: the model qwen3:4b isn't downloaded yet (about 2.6 GB). Run: cherrycola pull\n");
    process.exit(3);
  }
  // Stream it in pieces, as the real CLI does.
  const delay = Number(process.env.FAKE_DELAY || 0);
  let i = 0;
  const tick = () => {
    if (i >= reply.length) { process.stdout.write('\n'); return; }
    process.stdout.write(reply.slice(i, i + 40));
    i += 40;
    setTimeout(tick, delay);
  };
  tick();
});
