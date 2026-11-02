import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../src/board.js';

test('agent claims highest-priority ready task', () => {
  const b = new Board();
  const low = b.create({ title: 'low', priority: 3 });
  const high = b.create({ title: 'high', priority: 1 });
  b.move(low.id, 'ready'); b.move(high.id, 'ready');
  const t = b.claimNext('agent-1');
  assert.equal(t.id, high.id);
  assert.equal(t.column, 'doing');
  assert.equal(t.assignee, 'agent-1');
});

test('WIP limit is enforced', () => {
  const b = new Board();
  for (let i = 0; i < 3; i++) b.move(b.create({ title: `t${i}` }).id, 'doing');
  const extra = b.create({ title: 'extra' });
  assert.throws(() => b.move(extra.id, 'doing'), /WIP limit/);
});

test('standup and metrics are derived from events', () => {
  const b = new Board();
  const t = b.create({ title: 'x' });
  b.move(t.id, 'ready');
  b.claimNext('agent-1');
  b.note(t.id, 'implemented', 'agent-1');
  b.move(t.id, 'done', 'agent-1');
  const s = b.standup();
  assert.deepEqual(s.actors['agent-1'].done, [t.id]);
  assert.equal(b.metrics().throughput7d, 1);
  assert.equal(b.metrics().counts.done, 1);
});
