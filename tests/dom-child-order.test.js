const test = require('node:test');
const assert = require('node:assert/strict');

async function loadSubject() {
  return import('../frontend/src/utils/dom-child-order.ts');
}

function createHarness(initialItems) {
  const items = [...initialItems];
  const moves = [];
  const removals = [];
  return {
    items,
    moves,
    removals,
    moveBefore(item, reference) {
      const currentIndex = items.indexOf(item);
      if (currentIndex >= 0) items.splice(currentIndex, 1);
      const referenceIndex = reference == null ? items.length : items.indexOf(reference);
      items.splice(referenceIndex, 0, item);
      moves.push([item, reference]);
    },
    remove(item) {
      const index = items.indexOf(item);
      if (index >= 0) items.splice(index, 1);
      removals.push(item);
    },
  };
}

test('syncOrderedItems preserves attached items when order is already correct', async () => {
  const { syncOrderedItems } = await loadSubject();
  const harness = createHarness(['monitored', 'alerts', 'pumpfun']);

  syncOrderedItems(
    harness.items,
    ['monitored', 'alerts', 'pumpfun'],
    harness.moveBefore,
    harness.remove,
  );

  assert.deepEqual(harness.items, ['monitored', 'alerts', 'pumpfun']);
  assert.deepEqual(harness.moves, []);
  assert.deepEqual(harness.removals, []);
});

test('syncOrderedItems moves existing items only when their order changes', async () => {
  const { syncOrderedItems } = await loadSubject();
  const harness = createHarness(['a', 'b', 'c']);

  syncOrderedItems(harness.items, ['b', 'c', 'a'], harness.moveBefore, harness.remove);

  assert.deepEqual(harness.items, ['b', 'c', 'a']);
  assert.equal(harness.moves.length, 2);
  assert.deepEqual(harness.removals, []);
});

test('syncOrderedItems reconciles removed and newly attached items', async () => {
  const { syncOrderedItems } = await loadSubject();
  const harness = createHarness(['monitored', 'obsolete']);

  syncOrderedItems(
    harness.items,
    ['monitored', 'alerts'],
    harness.moveBefore,
    harness.remove,
  );

  assert.deepEqual(harness.items, ['monitored', 'alerts']);
  assert.deepEqual(harness.moves, [['alerts', null]]);
  assert.deepEqual(harness.removals, ['obsolete']);
});
