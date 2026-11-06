"use client";

import type { FloorChoice } from "@/lib/floorChoices";

// One floor picker over lib/floorChoices options: floors this person may not use
// are greyed out ("not your floor"), a saved floor is its own option. Free text
// only when the factory lists no floors. Shared by the job-card wizard's process
// rows and the merge-process dialog.
export function FloorPicker({ value, choices, freeText, onChange, className, disabled = false, title }: {
  value: string;
  choices: FloorChoice[];
  freeText: boolean;
  onChange: (floor: string) => void;
  className: string;
  // Shown but not changeable (a finished card's floor); `title` says why.
  disabled?: boolean;
  title?: string;
}) {
  if (freeText) {
    return (
      <input value={value} placeholder="Floor" disabled={disabled} title={title} className={className}
        onChange={(e) => onChange(e.target.value)} />
    );
  }
  return (
    <select value={value} title={title ?? (value || undefined)} disabled={disabled} className={className}
      onChange={(e) => onChange(e.target.value)}>
      <option value="">— Floor —</option>
      {choices.map((c) => (
        <option key={c.value} value={c.value} disabled={c.disabled}>
          {c.reason ? `${c.value} (${c.reason})` : c.value}
        </option>
      ))}
    </select>
  );
}
