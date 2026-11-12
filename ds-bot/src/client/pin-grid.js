// Helpers for the sidebar pin grid: pinned chats sit as tiles at the top,
// and a drop onto the grid or back onto the list updates flags.

export function pinnedEntriesOf(order) {
  return order.filter(entry => entry.item.pinned === true)
}

export function listedEntriesOf(order, wide) {
  return wide ? order.filter(entry => entry.item.pinned !== true) : order
}

export function flagsForPinDrop({ id, mainBotId, entry }) {
  if (!id || id === mainBotId) return null
  if (entry?.item?.pinned === true) return null
  return { pinned: true }
}

export function flagsForListDrop({ secId, entry }) {
  const flags = { sectionId: secId }
  if (entry?.item?.pinned === true) flags.pinned = false
  return flags
}
