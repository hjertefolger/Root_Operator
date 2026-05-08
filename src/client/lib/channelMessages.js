const USER_ECHO_DEDUPE_MS = 45_000;

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function getAttachmentKey(item) {
  if (!Array.isArray(item?.attachments) || item.attachments.length === 0) {
    return '';
  }

  return item.attachments.map((attachment) => {
    if (!attachment || typeof attachment !== 'object') {
      return '';
    }
    return [
      asString(attachment.id),
      asString(attachment.name),
      asString(attachment.sha256),
      asString(attachment.mime || attachment.mimeType),
      Number.isFinite(attachment.size) ? String(attachment.size) : '',
    ].join(':');
  }).join('|');
}

function getMessageTime(item) {
  const value = Date.parse(item?.ts || '');
  return Number.isFinite(value) ? value : null;
}

function getExactMessageKey(item) {
  return [
    asString(item?.role),
    asString(item?.ts),
    asString(item?.external_ref),
    asString(item?.content),
    getAttachmentKey(item),
  ].join('\u001f');
}

function getUserEchoKey(item) {
  if (item?.role !== 'user') {
    return null;
  }
  return [
    'user',
    asString(item.content),
    getAttachmentKey(item),
  ].join('\u001f');
}

function isLikelyUserEcho(existing, candidate) {
  const existingKey = getUserEchoKey(existing);
  const candidateKey = getUserEchoKey(candidate);
  if (!existingKey || existingKey !== candidateKey) {
    return false;
  }

  const existingTime = getMessageTime(existing);
  const candidateTime = getMessageTime(candidate);
  if (existingTime === null || candidateTime === null) {
    return false;
  }

  return Math.abs(existingTime - candidateTime) <= USER_ECHO_DEDUPE_MS;
}

function mergeMessageRecord(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    attachments: Array.isArray(incoming.attachments)
      ? incoming.attachments
      : existing.attachments,
    external_ref: incoming.external_ref || existing.external_ref,
  };
}

function sortMessages(messages) {
  return messages
    .map((message, index) => ({ message, index, time: getMessageTime(message) }))
    .sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) {
        return a.time - b.time;
      }
      if (a.time !== null && b.time === null) {
        return -1;
      }
      if (a.time === null && b.time !== null) {
        return 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.message);
}

export function mergeChannelMessages(prev, incoming) {
  const current = Array.isArray(prev)
    ? prev.filter((item) => item && typeof item === 'object')
    : [];
  const additions = Array.isArray(incoming)
    ? incoming.filter((item) => item && typeof item === 'object')
    : [];

  if (additions.length === 0) {
    return prev;
  }

  const next = [...current];
  const exactSeen = new Set(next.map(getExactMessageKey));
  const pairedEchoIndexes = new Set();
  let changed = false;

  for (const item of additions) {
    const exactKey = getExactMessageKey(item);
    if (exactSeen.has(exactKey)) {
      continue;
    }

    let echoIndex = -1;
    for (let index = 0; index < next.length; index += 1) {
      if (pairedEchoIndexes.has(index)) {
        continue;
      }
      if (!isLikelyUserEcho(next[index], item)) {
        continue;
      }
      echoIndex = index;
      break;
    }

    if (echoIndex >= 0) {
      const oldExactKey = getExactMessageKey(next[echoIndex]);
      next[echoIndex] = mergeMessageRecord(next[echoIndex], item);
      exactSeen.delete(oldExactKey);
      exactSeen.add(getExactMessageKey(next[echoIndex]));
      pairedEchoIndexes.add(echoIndex);
      changed = true;
      continue;
    }

    next.push(item);
    exactSeen.add(exactKey);
    changed = true;
  }

  const sorted = sortMessages(next);
  if (!changed && sorted.length === current.length && sorted.every((item, index) => item === current[index])) {
    return prev;
  }
  return sorted;
}
