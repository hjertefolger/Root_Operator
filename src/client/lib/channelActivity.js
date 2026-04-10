function completeActiveActivities(items, completedAt) {
  return items.map((item) => (
    item.active
      ? { ...item, active: false, done: true, completedAt }
      : item
  ));
}

export function buildChannelActivityKey(activity = {}) {
  return [
    activity.toolUseId || '',
    activity.phase || 'idle',
    activity.label || 'Idle',
    activity.toolName || '',
    activity.filePath || '',
  ].join(':');
}

export function buildChannelActivityItem(activity = {}) {
  const markerTs = activity.ts || new Date().toISOString();
  const isActive = activity.active !== false;
  const key = buildChannelActivityKey(activity);

  return {
    id: `${markerTs}:${key}`,
    key,
    label: activity.label || 'Idle',
    detail: activity.detail || '',
    filePath: activity.filePath || '',
    fileLabel: activity.fileLabel || '',
    active: isActive,
    done: !isActive,
    ts: markerTs,
    completedAt: !isActive ? markerTs : undefined,
  };
}

export function mergeChannelActivity(items, activity) {
  const markerTs = activity?.ts || new Date().toISOString();

  if (activity?.phase === 'idle') {
    return completeActiveActivities(items, markerTs).slice(-4);
  }

  const nextItem = buildChannelActivityItem(activity);
  const next = completeActiveActivities(items, markerTs).filter((item, index, list) => {
    if (index !== list.length - 1) {
      return true;
    }

    return item.key !== nextItem.key || item.active;
  });

  next.push(nextItem);
  return next.slice(-4);
}
