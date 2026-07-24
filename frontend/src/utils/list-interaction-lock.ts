export type ListInteractionLockContext = {
  insideBroadList: boolean;
  insideScopedList: boolean;
  insideInteractiveZone: boolean;
};

export function shouldLockListInteraction(context: ListInteractionLockContext) {
  return context.insideBroadList
    || (context.insideScopedList && context.insideInteractiveZone);
}
