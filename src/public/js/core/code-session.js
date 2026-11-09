// Page-memory only. This map stores returned IDs, never bodies or credentials.
function createCodeSession() {
  const returned = new Map();
  const revisions = new Map();
  let generation = 0;
  const capture = inboxId => ({ inboxId, generation, revision: revisions.get(inboxId) || 0 });
  const current = ticket => ticket.generation === generation && ticket.revision === (revisions.get(ticket.inboxId) || 0);
  const ids = inboxId => [...(returned.get(inboxId) || [])];
  function remember(ticket, messageId) {
    if (!current(ticket) || typeof messageId !== 'string' || !messageId) return false;
    const values = returned.get(ticket.inboxId) || new Set();
    if (!values.has(messageId) && values.size >= 20) return false;
    values.add(messageId);
    returned.set(ticket.inboxId, values);
    return true;
  }
  function reset(inboxId) {
    returned.delete(inboxId);
    revisions.set(inboxId, (revisions.get(inboxId) || 0) + 1);
  }
  function clear() { generation++; returned.clear(); revisions.clear(); }
  return { capture, current, ids, remember, reset, clear };
}
const codeSession = createCodeSession();
export { codeSession, createCodeSession };
