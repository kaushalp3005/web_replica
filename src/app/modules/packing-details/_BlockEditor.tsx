"use client";

// Block builder for the free-form `details` JSON body. Each "block" is a
// labelled, typed field; together the blocks compose a flat JSON object that is
// embedded as `details` on create/update. Converters go both ways so an
// existing record round-trips into the editor and back.

export type BlockType = "text" | "number" | "boolean" | "date" | "list" | "json";

export interface Block {
  id: string; // stable React key (not persisted)
  label: string; // becomes the JSON key
  type: BlockType;
  value: string; // raw entry; coerced to the typed value on serialize
}

let _seq = 0;
function newId(): string {
  _seq += 1;
  return `blk_${_seq}`;
}

export function emptyBlock(): Block {
  return { id: newId(), label: "", type: "text", value: "" };
}

// ── Serialize: blocks → details JSON object ───────────────────────────────
function coerce(block: Block): unknown {
  const raw = block.value;
  switch (block.type) {
    case "number": {
      if (raw.trim() === "") return null;
      const n = Number(raw);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      return raw === "true";
    case "date":
      return raw; // ISO yyyy-mm-dd from <input type="date">
    case "list":
      return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        return raw; // guarded — callers validate with blocksError() first
      }
    case "text":
    default:
      return raw;
  }
}

export function blocksToDetails(blocks: Block[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const b of blocks) {
    const key = b.label.trim();
    if (!key) continue; // unlabelled blocks are ignored
    out[key] = coerce(b);
  }
  return out;
}

// Returns the first validation error, or null when the blocks are submittable.
export function blocksError(blocks: Block[]): string | null {
  const seen = new Set<string>();
  for (const b of blocks) {
    const key = b.label.trim();
    if (!key) continue;
    if (seen.has(key)) return `Duplicate field name "${key}" — each block needs a unique name.`;
    seen.add(key);
    if (b.type === "number" && b.value.trim() !== "" && Number.isNaN(Number(b.value))) {
      return `Block "${key}": "${b.value}" is not a valid number.`;
    }
    if (b.type === "json") {
      try {
        JSON.parse(b.value);
      } catch {
        return `Block "${key}": value is not valid JSON.`;
      }
    }
  }
  return null;
}

// ── Parse: details JSON object → blocks (for the edit form) ────────────────
function inferType(value: unknown): [BlockType, string] {
  if (typeof value === "number") return ["number", String(value)];
  if (typeof value === "boolean") return ["boolean", value ? "true" : "false"];
  if (Array.isArray(value)) {
    const primitive = value.every((v) => typeof v === "string" || typeof v === "number");
    return primitive ? ["list", value.join(", ")] : ["json", JSON.stringify(value, null, 2)];
  }
  if (value !== null && typeof value === "object") return ["json", JSON.stringify(value, null, 2)];
  return ["text", value == null ? "" : String(value)];
}

export function detailsToBlocks(details: Record<string, unknown> | null | undefined): Block[] {
  if (!details || typeof details !== "object") return [];
  return Object.entries(details).map(([label, value]) => {
    const [type, raw] = inferType(value);
    return { id: newId(), label, type, value: raw };
  });
}

// ── Component ──────────────────────────────────────────────────────────────
function ValueInput({ block, onChange }: { block: Block; onChange: (v: string) => void }) {
  const cls = "form-input flex-1 min-w-[180px]";
  switch (block.type) {
    case "number":
      return <input type="number" value={block.value} onChange={(e) => onChange(e.target.value)} placeholder="0" className={cls} />;
    case "boolean":
      return (
        <select value={block.value || "false"} onChange={(e) => onChange(e.target.value)} className="form-input w-[110px]">
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case "date":
      return <input type="date" value={block.value} onChange={(e) => onChange(e.target.value)} className={cls} />;
    case "list":
      return <input type="text" value={block.value} onChange={(e) => onChange(e.target.value)} placeholder="a, b, c" className={cls} />;
    case "json":
      return (
        <textarea
          value={block.value}
          onChange={(e) => onChange(e.target.value)}
          placeholder='{ "nested": true }'
          rows={3}
          className="flex-1 min-w-[180px] border border-[var(--aws-border-strong)] rounded-[2px] p-2 text-[13px] font-mono outline-none focus:border-[var(--aws-orange)]"
        />
      );
    case "text":
    default:
      return <input type="text" value={block.value} onChange={(e) => onChange(e.target.value)} placeholder="value" className={cls} />;
  }
}

export function BlockEditor({
  blocks,
  onChange,
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
}) {
  function patch(id: string, p: Partial<Block>) {
    onChange(blocks.map((b) => (b.id === id ? { ...b, ...p } : b)));
  }
  function remove(id: string) {
    onChange(blocks.filter((b) => b.id !== id));
  }
  function add() {
    onChange([...blocks, emptyBlock()]);
  }

  return (
    <div>
      <div className="space-y-2">
        {blocks.length === 0 && (
          <p className="text-[12px] text-[var(--text-muted)]">
            No blocks yet — add a block to build the details JSON body.
          </p>
        )}
        {blocks.map((b) => (
          <div key={b.id} className="border border-[var(--aws-border)] rounded p-3 bg-white">
            <div className="flex flex-wrap gap-2 items-start">
              <input
                value={b.label}
                onChange={(e) => patch(b.id, { label: e.target.value })}
                placeholder="Field name (JSON key)"
                className="form-input flex-1 min-w-[160px]"
              />
              <select
                value={b.type}
                onChange={(e) => patch(b.id, { type: e.target.value as BlockType, value: "" })}
                className="form-input w-[110px]"
                aria-label="Block type"
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="boolean">Yes/No</option>
                <option value="date">Date</option>
                <option value="list">List</option>
                <option value="json">JSON</option>
              </select>
              <ValueInput block={b} onChange={(v) => patch(b.id, { value: v })} />
              <button
                type="button"
                onClick={() => remove(b.id)}
                className="h-9 px-2 text-[11px] border border-rose-300 text-rose-700 rounded hover:bg-rose-50"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-3 h-8 px-3 text-[12px] border border-[var(--aws-border)] rounded hover:border-[var(--aws-orange)]"
      >
        + Add block
      </button>
    </div>
  );
}
