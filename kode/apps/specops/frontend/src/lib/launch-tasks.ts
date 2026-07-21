export interface LaunchTask {
  id: string;
  title: string;
  prompt: string;
  verify: string[];
}

export interface ChecklistProgress {
  total: number;
  completed: number;
  remaining: number;
}

interface ChecklistItem {
  checked: boolean;
  title: string;
}

/** Parse top-level task checkboxes without treating their indented detail as tasks. */
function checklistItems(markdown: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  for (const line of lines) {
    const match = /^[-*]\s+\[([ xX])\]\s*(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const title = (match[2] ?? '').replace(/`/g, '').trim();
    if (title.length < 4) continue;
    items.push({ checked: (match[1] ?? ' ') !== ' ', title });
  }
  return items;
}

export function checklistProgress(markdown: string): ChecklistProgress {
  const items = checklistItems(markdown);
  const completed = items.filter((item) => item.checked).length;
  return { total: items.length, completed, remaining: items.length - completed };
}

/** Parse only top-level checklist entries; indented bullets describe their parent task. */
export function buildLaunchTasks(markdown: string, docTitle: string, docPath: string): LaunchTask[] {
  const tasks: LaunchTask[] = [];
  const checklist = checklistItems(markdown);
  for (const item of checklist) {
    if (item.checked) continue;
    const rawTitle = item.title;
    const id = `task-${tasks.length + 1}`;
    tasks.push({
      id,
      title: rawTitle.slice(0, 120),
      prompt: [
        `Implement task: ${rawTitle}`,
        '',
        `SpecOps document: ${docPath}`,
        '',
        'Follow the proposal/design/tasks documents in this change folder. Keep changes scoped to the requested task and update tests when needed.',
      ].join('\n'),
      verify: [],
    });
    if (tasks.length >= 8) break;
  }
  if (tasks.length > 0) return tasks;
  // A checklist with no remaining entries is complete. Do not turn it back
  // into a generic implementation task and accidentally relaunch the change.
  if (checklist.length > 0) return [];
  return [{
    id: 'task-1',
    title: `Implement ${docTitle}`,
    prompt: [
      `Implement the SpecOps change: ${docTitle}`,
      '',
      `SpecOps document: ${docPath}`,
      '',
      markdown.slice(0, 4000),
    ].join('\n'),
    verify: [],
  }];
}
