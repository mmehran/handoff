import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, normalize } from '../src/store.js';
import { Activity } from '../src/activity.js';

const line = o => JSON.stringify(o) + '\n';
let t0 = Date.parse('2026-01-01T10:00:00Z');
const at = () => new Date((t0 += 60e3)).toISOString();
const use = (id, name, input) => line({ type: 'assistant', timestamp: at(), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, extra = {}) => line({ type: 'user', timestamp: at(), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!extra.error }] }, ...(extra.toolUseResult ? { toolUseResult: extra.toolUseResult } : {}) });
function setup() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-activity-')));
  const id = crypto.randomUUID();
  fs.mkdirSync(path.join(home, 'projects', 'p'), { recursive: true });
  const file = path.join(home, 'projects', 'p', id + '.jsonl');
  return { id, file, activity: new Activity(new Store({ claudeHome: home })) };
}

test('activity: to-do list from TaskCreate / TaskUpdate, kept up to date as the transcript grows', async () => {
  const { id, file, activity } = setup();
  fs.writeFileSync(file,
    line({ type: 'user', timestamp: at(), message: { content: 'Add discount codes' } }) +
    use('c1', 'TaskCreate', { subject: 'Read the code', activeForm: 'Reading the code' }) + result('c1', 'Task #1 created successfully: Read the code') +
    use('c2', 'TaskCreate', { subject: 'Add codes' }) + result('c2', 'Task #2 created successfully: Add codes') +
    use('c3', 'TaskCreate', { subject: 'Will fail' }) + result('c3', 'Error', { error: true }) +
    use('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }) +
    use('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }));
  let a = await activity.of(id);
  assert.deepEqual(a.todos.map(t => [t.id, t.subject, t.status]), [['1', 'Read the code', 'completed'], ['2', 'Add codes', 'in_progress']]);
  assert.equal(a.todos[0].activeForm, 'Reading the code');
  assert.equal(a.prompts, 1);

  // only the new lines are read next time, and a half-written last line waits for its end
  const more = use('c4', 'TaskCreate', { subject: 'Write tests' }) + result('c4', 'Task #3 created successfully: Write tests') + use('u3', 'TaskUpdate', { taskId: '2', status: 'completed' });
  const partial = use('u4', 'TaskUpdate', { taskId: '3', status: 'deleted' });
  fs.appendFileSync(file, more + partial.slice(0, 30));
  a = await activity.of(id);
  assert.deepEqual(a.todos.map(t => [t.id, t.status]), [['1', 'completed'], ['2', 'completed'], ['3', 'pending']]);
  fs.appendFileSync(file, partial.slice(30));
  a = await activity.of(id);
  assert.deepEqual(a.todos.map(t => t.id), ['1', '2'], 'a deleted task leaves the list');

  // older Claude Code: TodoWrite replaces the whole list
  fs.appendFileSync(file, use('w1', 'TodoWrite', { todos: [{ content: 'One', status: 'completed', activeForm: 'Doing one' }, { content: 'Two', status: 'in_progress', activeForm: 'Doing two' }] }));
  a = await activity.of(id);
  assert.deepEqual(a.todos.map(t => [t.subject, t.status]), [['One', 'completed'], ['Two', 'in_progress']]);
});

test('activity: plan, changed files, commands, sub-agents (also in the background) and timing', async () => {
  const { id, file, activity } = setup();
  fs.writeFileSync(file,
    use('p1', 'ExitPlanMode', { plan: '## Plan\n1. Do it' }) + result('p1', 'User has approved your plan. You can now start coding.') +
    use('e1', 'Edit', { file_path: '/w/src/a.js', old_string: 'a', new_string: 'b' }) + result('e1', 'ok') +
    use('e2', 'Write', { file_path: '/w/src/b.js', content: 'x' }) + result('e2', 'ok') +
    use('e3', 'Edit', { file_path: '/w/src/a.js', old_string: 'b', new_string: 'c' }) + result('e3', 'ok') +
    use('b1', 'Bash', { command: 'npm test', description: 'Run tests' }) + result('b1', 'pass') +
    use('b2', 'Bash', { command: 'npm run lint' }) + result('b2', 'lint failed', { error: true }) +
    use('a1', 'Agent', { description: 'Find callers', subagent_type: 'Explore', prompt: 'Find every caller' }) + result('a1', 'Two callers.') +
    use('a2', 'Agent', { description: 'Long audit', prompt: 'Audit it' }) + result('a2', 'Launched', { toolUseResult: { status: 'async_launched', agentId: 'abc123' } }) +
    use('p2', 'ExitPlanMode', { plan: 'Second plan' }) + result('p2', 'The user doesn\'t want to proceed: use SQLite instead', { error: true }));
  let a = await activity.of(id);
  assert.deepEqual(a.plan && [a.plan.text, a.plan.status], ['Second plan', 'rejected']);
  assert.match(a.plan.feedback, /SQLite/);
  assert.deepEqual(a.files.map(f => [f.path, f.changes]), [['/w/src/a.js', 2], ['/w/src/b.js', 1]], 'most recently changed first');
  assert.deepEqual(a.commands.map(c => [c.command, c.ok]), [['npm run lint', false], ['npm test', true]]);
  assert.deepEqual(a.agents.map(x => [x.description, x.type, x.status]), [['Long audit', 'general-purpose', 'background'], ['Find callers', 'Explore', 'done']]);
  assert.equal(a.agents[0].agentId, 'abc123');
  assert.equal(a.last - a.first, 17 * 60e3);
  fs.appendFileSync(file, line({ type: 'user', timestamp: at(), message: { content: '<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>a2</tool-use-id>\n<status>completed</status>\n<summary>Agent "Long audit" finished</summary>\n<result>No problems found.</result>\n</task-notification>' } }));
  a = await activity.of(id);
  assert.deepEqual([a.agents[0].status, a.agents[0].result], ['done', 'No problems found.']);
  assert.equal(a.prompts, 0, 'a task notification is not a prompt');
});

test('a plan shows as a plan event with its text', () => {
  const ev = normalize({ type: 'assistant', uuid: 'u', message: { content: [{ type: 'tool_use', id: 'p', name: 'ExitPlanMode', input: { plan: '# Plan' } }] } });
  assert.deepEqual(ev.map(e => [e.kind, e.id, e.text]), [['plan', 'p', '# Plan']]);
});
