// Unsaved entries on the job card page. Each tab is unmounted when another is
// opened, so anything typed but not saved on it is lost; the page tracks which
// tabs have such entries (a successful save clears the tab) and asks before
// switching tabs, jumping to another card, or leaving the page.
// Pure, so it is tested without a browser (job-card-unsaved.test.ts).

export function unsavedPrompt(tabLabels: string[]): string {
  const labels = [...new Set(tabLabels)];
  const where = labels.length === 0
    ? ""
    : labels.length === 1
      ? ` on ${labels[0]}`
      : ` on ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `You have unsaved entries${where}. Leave without saving them?`;
}
