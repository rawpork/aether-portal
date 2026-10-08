// Human-readable names for what the engine reports in machine form: SCREAMING_SNAKE statuses, bp_<hex>_<time> ids, task ids
// like "site-launch" and agent ids like "master-brain". Views show these labels; the raw value stays in data attributes and
// behind a "Copy id" control for anyone who needs it. Nothing here changes what is sent to the engine.

// The master brain's agent id. workforce.js re-exports it, so the rest of the engine UI is unchanged.
export const ELARION_AGENT_ID = 'master-brain';

// Statuses the engine and the blueprint compiler use. Anything not listed is humanized, so a new one still reads as words.
const STATUS_LABELS = {
  APPROVED_FOR_EXECUTION: 'Approved',
  DRAFT: 'Draft',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  HALTED: 'Stopped',
  QUEUED: 'Queued',
  ERROR: 'Error',
};

// "site-launch" -> "Site launch", "PENDING_REVIEW" -> "Pending review", "dev_task" -> "Dev task".
export function humanize(text) {
  const words = String(text == null ? '' : text).trim().replace(/[-_\s]+/g, ' ').toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export const statusLabel = (status) => STATUS_LABELS[status] || humanize(status);

export const agentName = (agentId) => (agentId === ELARION_AGENT_ID ? 'Elarion' : humanize(agentId));

export const projectTitle = (artifact) => (artifact && artifact.project_name) || 'Untitled project';

// Groups consecutive items that share a key (newest first, as the engine lists them): [{ key, lead, rest }]. The lead is the
// first of a run of identical items and `rest` the repeats after it, so a long list of the same thing reads once, not five times.
export function groupConsecutive(items, keyOf) {
  const groups = [];
  for (const item of items) {
    const key = keyOf(item);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rest.push(item);
    else groups.push({ key, lead: item, rest: [] });
  }
  return groups;
}

// "3 earlier runs with the same name" and so on; one noun, singular or plural by count.
export const repeatsText = (count, noun) => count + ' earlier ' + (count === 1 ? noun : noun + 's') + ' with the same name';

// A task's display title. A deploy task is "deploy-<blueprint id>": name the project when it is known.
// `projectNameFor(blueprintId)` returns the project name or ''.
export function taskTitle(taskId, projectNameFor = () => '') {
  const id = String(taskId || '');
  const deploy = /^deploy-(bp_[a-z0-9_]+)$/i.exec(id);
  if (deploy) {
    const name = projectNameFor(deploy[1]);
    return name ? 'Deploy: ' + name : 'Deploy project';
  }
  return humanize(id);
}

// A small "Copy id" button. The id itself is never shown; it is copied on demand and the button says so for a moment.
export function createCopyIdButton(doc, id, { label = 'Copy id', copiedLabel = 'Copied' } = {}) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'copy-id';
  button.textContent = label;
  button.title = 'Copy the technical id to the clipboard';
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const win = doc.defaultView || globalThis;
    try {
      await win.navigator.clipboard.writeText(id);
      button.textContent = copiedLabel;
    } catch {
      // No clipboard permission: show the id so it can be selected by hand.
      button.textContent = id;
    }
    win.setTimeout(() => {
      button.textContent = label;
    }, 1600);
  });
  return button;
}
