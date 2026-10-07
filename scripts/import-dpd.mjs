// Converts the Tally "Sundry Debtors" DPD (days past due) exports into the JSON
// the Debtors Collection screen reads, public/debtors-data/dpd-<section>.json:
//
//   npm run dpd:import -- --cd-cf "../CF-CD refer.xlsx" --apmc "../APMC + Non APMC DPD 26 sept.xlsx" \
//                         --contacts "../debtors contact numbers.xlsx" [--as-of YYYY-MM-DD]
//
// Either section can be given on its own; pass --contacts every time, or the
// sections written in that run lose their phone numbers. The report date comes
// from the file name ("26 sept"); --as-of is used for files whose name has none.
//
// Each workbook's first debtors sheet is the report. Every other sheet that
// reads as a debtors list — "Before APMC outlet", "LEGAL", "small Dr",
// "write off" — becomes a set-aside group, kept out of the totals. Sheets with
// no header row are read with the main sheet's column layout, and only if every
// row checks out against it.
//
// A stopgap until the backend owns this data (see src/lib/debtors.ts). The
// output folder is git-ignored ON PURPOSE: this repo is public and these are
// customer balances. Keep it out of commits and out of deploys.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx-js-style";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "debtors-data");

// Header text, lower-cased with spaces, brackets and dots removed → report field.
// "(< 30 days )" becomes "<30days", so the < and > still tell the ends apart.
const COLUMNS = {
  div: "division",
  division: "division",
  customer: "customer",
  salesperson: "salesPerson",
  type: "type",
  broker: "broker",
  pendingbills: "pending",
  "<30days": "lt30",
  "30to60days": "d30to60",
  "60to90days": "d60to90",
  ">90days": "gt90",
  remarks: "remarks",
};
// "Phone", "Mobile No.", "Contact No 1", "Tel" … and "Email id", "E-mail".
const PHONE_HEADER = /^(contact|phone|mobile|mob|tel|telephone)(no|number|nos)?\d*$/;
const EMAIL_HEADER = /^(e-?mail|mail)(id|address)?\d*$/;
const BUCKETS = ["lt30", "d30to60", "d60to90", "gt90"];
const TEXT_FIELDS = ["division", "salesPerson", "type", "broker", "phone"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const headerKey = (v) => String(v ?? "").toLowerCase().replace(/[\s().]/g, "");
const fieldFor = (key) => COLUMNS[key] ?? (PHONE_HEADER.test(key) ? "phone" : undefined);

// Names arrive padded and with embedded "\r\r\n" line breaks.
function text(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

// Remarks keep their line breaks; each line is tidied.
function note(v) {
  const s = String(v ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return s === "" ? null : s;
}

// Blank cells are zero; so is Tally's "-". Anything else unreadable is an error,
// never a silent zero.
function money(v, where) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  const s = String(v).replace(/[,\s₹]/g, "");
  if (s === "" || /^-+$/.test(s)) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`${where}: ${JSON.stringify(v)} is not an amount`);
  return Math.round(n * 100) / 100;
}

function partyFrom(r, col, where) {
  const party = { customer: text(r[col.customer]) };
  for (const f of TEXT_FIELDS) if (f in col) party[f] = text(r[col[f]]);
  party.pending = money(r[col.pending], where);
  party.ageing = Object.fromEntries(BUCKETS.map((b) => [b, money(r[col[b]], where)]));
  if ("remarks" in col) party.remarks = note(r[col.remarks]);
  return party;
}

const bucketGap = (p) => p.pending - BUCKETS.reduce((s, b) => s + p.ageing[b], 0);

/** A sheet's parties and column layout, or null when it has no Customer /
 *  Pending Bills header row. */
function readSheet(wb, name, warnings) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
  const h = rows.findIndex((r) => r.some((c) => headerKey(c) === "customer") && r.some((c) => headerKey(c) === "pendingbills"));
  if (h < 0) return null;

  const col = {};
  rows[h].forEach((c, i) => {
    const field = fieldFor(headerKey(c));
    if (field && !(field in col)) col[field] = i;
  });
  for (const f of ["customer", "pending", ...BUCKETS]) {
    if (!(f in col)) throw new Error(`sheet "${name}": no column for ${f}`);
  }

  const parties = [];
  for (const r of rows.slice(h + 1)) {
    if (!text(r[col.customer])) continue;
    const where = `sheet "${name}", ${text(r[col.customer])}`;
    const party = partyFrom(r, col, where);
    const off = bucketGap(party);
    if (Math.abs(off) >= 1) warnings.push(`${where}: Pending Bills is ${off.toFixed(2)} away from its age buckets`);
    parties.push(party);
  }

  // Some exports carry a totals row just above the header — hold the rows to it.
  const sheetTotal = h > 0 ? rows[h - 1][col.pending] : null;
  if (typeof sheetTotal === "number") {
    const sum = parties.reduce((s, p) => s + p.pending, 0);
    if (Math.abs(sum - sheetTotal) >= 1) {
      warnings.push(`sheet "${name}": rows add up to ${sum.toFixed(2)}, the sheet's own total says ${sheetTotal.toFixed(2)}`);
    }
  }
  return { parties, col };
}

/** A sheet with no header row, read with the main sheet's column layout — but
 *  only when every row fits it: amounts parse and add up, and any division is
 *  one the main sheet uses. Otherwise null, and the sheet is not imported. */
function readHeaderless(wb, name, col, divisions) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
  const parties = [];
  try {
    for (const r of rows) {
      if (!text(r[col.customer])) continue;
      const party = partyFrom(r, col, `sheet "${name}", ${text(r[col.customer])}`);
      if (Math.abs(bucketGap(party)) >= 1) return null;
      if ("division" in col && !divisions.has(party.division)) return null;
      parties.push(party);
    }
  } catch {
    return null;
  }
  return parties.length > 0 ? parties : null;
}

function asOfFromName(file) {
  const m = /(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i.exec(basename(file));
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS.indexOf(m[2].toLowerCase());
  // No year in the name: take the most recent such date that is not in the future.
  const now = new Date();
  let year = now.getFullYear();
  if (new Date(year, month, day) > now) year -= 1;
  const d = new Date(year, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function readReport(section, file, asOfFlag) {
  const asOf = asOfFromName(file) ?? asOfFlag ?? null;
  const wb = XLSX.readFile(file);
  const warnings = [];
  if (!asOf) warnings.push(`no report date in the file name and no --as-of; the screen will show none`);

  let main = null;
  for (const name of wb.SheetNames) {
    const read = readSheet(wb, name, warnings);
    if (read) {
      main = { name, ...read };
      break;
    }
  }
  if (!main) throw new Error(`${basename(file)}: no sheet with Customer and Pending Bills columns`);
  const divisions = new Set(main.parties.map((p) => p.division));

  // Every other debtors sheet is a group the report sets aside.
  const excluded = [];
  for (const name of wb.SheetNames) {
    if (name === main.name) continue;
    const parties = readSheet(wb, name, warnings)?.parties ?? readHeaderless(wb, name, main.col, divisions);
    if (!parties) {
      warnings.push(`sheet "${name}" was not imported: it doesn't read as a debtors list`);
      continue;
    }
    const remarks = [...new Set(parties.map((p) => p.remarks ?? null))];
    excluded.push({ title: text(name), note: remarks.length === 1 ? remarks[0] : null, parties });
  }

  return {
    report: { section, asOf, source: basename(file), generatedAt: new Date().toISOString(), parties: main.parties, excluded },
    warnings,
  };
}

// ── Contacts ────────────────────────────────────────────────────────────────

// Names are matched exactly, give or take case, punctuation and a trailing
// "(Sale)"/"Sales" — never fuzzily: a wrong number is worse than none.
function matchKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/(?:\s+(?:sale|sales))+$/, "")
    .trim();
}

const digitsOf = (n) => n.replace(/\D/g, "");

function readContacts(file) {
  const wb = XLSX.readFile(file);
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    const h = rows.findIndex((r) => r.some((c) => headerKey(c) === "customer") && r.some((c) => PHONE_HEADER.test(headerKey(c))));
    if (h < 0) continue;
    const keys = rows[h].map(headerKey);
    const customerAt = keys.indexOf("customer");
    const divisionAt = keys.findIndex((k) => COLUMNS[k] === "division");
    const phoneAt = keys.flatMap((k, i) => (PHONE_HEADER.test(k) ? [i] : []));
    const emailAt = keys.flatMap((k, i) => (EMAIL_HEADER.test(k) ? [i] : []));
    return rows
      .slice(h + 1)
      .filter((r) => text(r[customerAt]))
      .map((r) => {
        const div = divisionAt >= 0 ? text(r[divisionAt]) : null;
        return {
          customer: text(r[customerAt]),
          key: matchKey(r[customerAt]),
          // "CF+CD" applies to both divisions.
          divisions: div ? new Set(div.toUpperCase().split(/[^A-Z]+/).filter(Boolean)) : null,
          phones: phoneAt.map((i) => text(r[i])).filter(Boolean),
          email: emailAt.map((i) => text(r[i])).find(Boolean) ?? null,
          used: false,
        };
      });
  }
  throw new Error(`${basename(file)}: no sheet with Customer and contact number columns`);
}

/** Put phone numbers and emails on every party a contact row matches. */
function applyContacts(report, contacts, warnings) {
  let phones = 0;
  let emails = 0;
  const all = [...report.parties, ...report.excluded.flatMap((g) => g.parties)];
  for (const p of all) {
    const key = matchKey(p.customer);
    const division = p.division?.toUpperCase() ?? null;
    const hits = contacts.filter((c) => c.key === key && (!division || !c.divisions || c.divisions.has(division)));
    if (hits.length === 0) continue;
    // A list without divisions (APMC) only takes a contact the CF/CD rows agree on.
    const sets = new Set(hits.map((c) => c.phones.map(digitsOf).sort().join(",") + "|" + (c.email ?? "")));
    if (!division && sets.size > 1) {
      warnings.push(`${p.customer}: contact rows disagree, left without a number`);
      continue;
    }
    hits.forEach((c) => (c.used = true));
    const numbers = [];
    for (const n of [...(p.phone ? [p.phone] : []), ...hits.flatMap((c) => c.phones)]) {
      if (!numbers.some((m) => digitsOf(m) === digitsOf(n))) numbers.push(n);
    }
    if (numbers.length > 0) {
      p.phone = numbers.join(" / ");
      phones++;
    }
    const email = p.email ?? hits.map((c) => c.email).find(Boolean);
    if (email) {
      p.email = email;
      emails++;
    }
  }
  return { phones, emails, of: all.length };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--cd-cf" || a === "--apmc" || a === "--as-of" || a === "--contacts") {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (out["as-of"] && !/^\d{4}-\d{2}-\d{2}$/.test(out["as-of"])) throw new Error("--as-of must be YYYY-MM-DD");
  return out;
}

const USAGE =
  "Usage: npm run dpd:import -- [--cd-cf <file>] [--apmc <file>] [--contacts <file>] [--as-of YYYY-MM-DD]";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sections = [["cd-cf", args["cd-cf"]], ["apmc", args.apmc]].filter(([, file]) => file);
  if (args.help || sections.length === 0) {
    console.log(USAGE);
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const contacts = args.contacts ? readContacts(args.contacts) : null;
  mkdirSync(OUT_DIR, { recursive: true });
  const inr = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const sum = (ps) => ps.reduce((s, p) => s + p.pending, 0);

  for (const [section, file] of sections) {
    const { report, warnings } = readReport(section, file, args["as-of"]);
    const stats = contacts ? applyContacts(report, contacts, warnings) : null;
    const out = join(OUT_DIR, `dpd-${section}.json`);
    writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

    const set = report.excluded.map((g) => `${g.title}: ${g.parties.length}, ${inr(sum(g.parties))}`).join("; ");
    console.log(
      `${section}: ${report.parties.length} parties, ${inr(sum(report.parties))}${set ? ` (set aside — ${set})` : ""}, ` +
        `as on ${report.asOf ?? "—"} → ${relative(ROOT, out)}`,
    );
    if (stats) console.log(`  contacts: a number for ${stats.phones} of ${stats.of} parties, an email for ${stats.emails}`);
    for (const w of warnings) console.warn(`  warning: ${w}`);
  }

  if (contacts) {
    const unused = contacts.filter((c) => !c.used);
    if (unused.length > 0) {
      console.warn(`contact rows that matched no party (${unused.length}): ${unused.map((c) => c.customer).join("; ")}`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`dpd:import: ${err instanceof Error ? err.message : err}`);
  console.error(USAGE);
  process.exitCode = 1;
}
