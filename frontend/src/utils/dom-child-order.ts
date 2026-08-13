type MoveBefore<T> = (item: T, reference: T | null) => void;
type RemoveItem<T> = (item: T) => void;

export function syncOrderedItems<T>(
  currentItems: readonly T[],
  desiredItems: readonly T[],
  moveBefore: MoveBefore<T>,
  removeItem: RemoveItem<T>,
) {
  const current = [...currentItems];
  const desired = new Set(desiredItems);

  for (let index = current.length - 1; index >= 0; index -= 1) {
    const item = current[index];
    if (desired.has(item)) continue;
    current.splice(index, 1);
    removeItem(item);
  }

  desiredItems.forEach((item, desiredIndex) => {
    if (current[desiredIndex] === item) return;
    const currentIndex = current.indexOf(item);
    if (currentIndex >= 0) current.splice(currentIndex, 1);
    const reference = current[desiredIndex] ?? null;
    moveBefore(item, reference);
    current.splice(desiredIndex, 0, item);
  });
}

export function syncElementChildOrder(parent: HTMLElement, desiredChildren: readonly HTMLElement[]) {
  syncOrderedItems(
    [...parent.children] as HTMLElement[],
    desiredChildren,
    (child, reference) => parent.insertBefore(child, reference),
    (child) => child.remove(),
  );
}
