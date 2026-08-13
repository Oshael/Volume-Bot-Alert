export type ListInteractionLockContext = {
  insideBroadList: boolean;
  insideScopedList: boolean;
  insideInteractiveZone: boolean;
  insideMonitoredList: boolean;
  monitoredPinDragActive: boolean;
};

export function shouldLockListInteraction(context: ListInteractionLockContext) {
  return context.monitoredPinDragActive
    || context.insideBroadList
    || (!context.insideMonitoredList && context.insideScopedList && context.insideInteractiveZone);
}
