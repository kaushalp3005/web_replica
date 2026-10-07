# Debtors Collection — DPD view

**Date:** 2026-09-30 (updated 2026-10-05: CF-CD reference, contacts, set-aside sheets)
**Status:** Built, frontend only. The data comes from Excel files until the backend exists.

## What it is

`/modules/debtors-collection` (admin-only, like its tile) shows what customers owe, split by
how long it has been outstanding (DPD, days past due). It has two sections, shown as tabs, and
the open tab is kept in the URL (`?section=apmc`):

| Section | Source file | Text columns (filter + breakdown) |
|---|---|---|
| CD-CF | `CF-CD refer.xlsx` (Sheet1, plus side sheets) | CD - CF (the `Div` column), Sales person |
| APMC + Non-APMC | `APMC + Non APMC DPD <date>.xlsx` | Type (APMC / Non APMC / Debtors (APMC)), Broker |

The same customer can appear twice in CD-CF, once under each division (20 do), so the
division is part of every row.

Each section shows, top to bottom:

1. **Summary.** Total outstanding, the share over 90 days, a stacked ageing bar, and one tile
   per bucket (< 30, 30–60, 60–90, > 90 days). Pressing a tile filters the list to that bucket
   and sorts by it. It also shows the report date, or "Report date not given" when the file
   has none. The date is never guessed.
2. **Breakdown.** One stacked bar per group: CD - CF or sales person for CD-CF (sales person
   first), type or broker for APMC. Each bar's length is the group's outstanding. Pressing a
   row filters the list to that group.
3. **Parties.** Search, a filter per text column, an ageing filter, sortable columns, a
   sticky totals row and a **Call now** column. It is a table from `xl` (1280px) up and cards
   below that. Remarks show under the customer name: a one-word flag like "LEGAL" as a red
   badge, a longer note as text cut to two lines (the full note is on hover and in the call
   sheet).
4. **Set-aside groups.** Every other debtors sheet in the workbook is a collapsed list kept
   out of the totals: "LEGAL", "small Dr" and "write off" for CD-CF, and "Before APMC outlet"
   for APMC.

**Call now** opens a call sheet with the party's number(s), email, full remarks and dues,
oldest bucket first. The main action is a `tel:` link to the first number, and each extra
number gets its own link. A bare 10-digit number is dialled as +91. Parties with no number on
file say so.

The age buckets are drawn in a single-hue maroon ramp, light to dark as dues get older. It was
checked with the dataviz ordinal validator against the white card surface.

## Data flow today

```
Excel files ──npm run dpd:import──▶ public/debtors-data/dpd-<section>.json ──fetchDpdReport()──▶ page
            (scripts/import-dpd.mjs)        (git-ignored)                    (src/lib/debtors.ts)
```

```bash
npm run dpd:import -- --cd-cf "../CF-CD refer.xlsx" --apmc "../APMC + Non APMC DPD 26 sept.xlsx" \
                      --contacts "../debtors contact numbers.xlsx" [--as-of YYYY-MM-DD]
```

- **Report sheet.** The first sheet with a Customer / Pending Bills header row is the report.
  The import cleans the Tally padding and line breaks out of names, and keeps line breaks
  in remarks.
- **Set-aside sheets.** Every other sheet that reads as a debtors list becomes a set-aside
  group. A sheet with no header row (LEGAL, small Dr, write off) is read with the report
  sheet's column layout, but only if every row fits it: the amounts parse and add up, and
  the division is one the report uses. Otherwise it is skipped with a warning.
- **Contacts.** These come from `debtors contact numbers.xlsx`: Div, Customer, contact no 1
  and 2, and email id. They are matched on division and customer name, ignoring case,
  punctuation and a trailing "(Sale)". Names are never matched fuzzily: a wrong number is
  worse than none. A `CF+CD` row applies to both divisions. APMC rows have no division and
  only take a contact when every row with that name agrees. The import lists the contact
  rows that matched no party.
- **Report date.** This is read from the file name ("26 sept"). `--as-of` covers files whose
  name has none, such as `CF-CD refer.xlsx`.
- **Warnings.** The import warns when a row's buckets don't add up to its Pending Bills, or
  when the rows don't add up to the sheet's own total row.

Pass `--contacts` on every run. A section imported without it loses its numbers.

`public/debtors-data/` is git-ignored because **this repo is public** and the files hold
customer balances and contact details. Anything under `public/` is also served to anyone on
a deployed site, logged in or not. Netlify builds from git, so a deploy there shows "No
report yet" instead of the data.

## Report contract

`fetchDpdReport(section)` resolves to this shape, or to `null` when no report exists:

```jsonc
{
  "section": "cd-cf",                // "cd-cf" | "apmc"
  "asOf": null,                      // report date, YYYY-MM-DD, or null when not given
  "source": "CF-CD refer.xlsx",
  "parties": [
    {
      "customer": "Bigbasket",
      "division": "CF",              // "CF" | "CD"; CD-CF only
      "salesPerson": "Prashant Pal", // CD-CF only
      "type": null,                  // APMC only
      "broker": null,                // APMC only
      "pending": 2960823,            // the report's Pending Bills
      "ageing": { "lt30": 87014, "d30to60": 0, "d60to90": 79, "gt90": 2873730 },
      "remarks": "due after 2 nov",  // free text; may hold line breaks
      "phone": "99805 42121 / 96112 74235",  // or null; several numbers allowed
      "email": "paymentqueries@bigbasket.com" // or null
    }
  ],
  "excluded": [                      // set-aside groups, one per sheet; [] when none
    { "title": "LEGAL", "note": null, "parties": [ /* same party shape */ ] }
  ]
}
```

`normalizeDpdReport` accepts numbers or numeric strings (FastAPI's Decimal-as-string
included), trims text, and drops rows without a customer name. A missing `pending` falls back
to the sum of the buckets. `excluded` may also be a single group object, as older files have.

## Moving to the backend

1. Serve the contract above from an endpoint, e.g. `GET /api/v1/debtors/dpd?section=cd-cf`,
   with phones and emails from the customer master. Return 404 when no report exists, which
   the page shows as "No report yet".
2. Change `fetchDpdReport` in `src/lib/debtors.ts` to call it through `apiFetch`. Nothing
   else in the screen reads the data source.
3. Gate the endpoint server-side, then open the tile in `src/lib/modules.tsx` to the roles
   that work collections. It is `adminOnly` today.
4. Delete `scripts/import-dpd.mjs`, the `dpd:import` npm script, and the
   `/public/debtors-data/` line in `.gitignore`.

## Not shown yet

`CF-CD refer.xlsx` also has TARGET, EXPECTED and PURCHASE AMT columns. 40 parties have a
target and expected amount, and 9 have a purchase amount. The import ignores them for now.

## Tests

`node src/lib/debtors.test.ts` covers:
- totals, grouping, filtering, sorting, and rupee and share formatting;
- phone splitting and `tel:` links;
- report normalising, including division, email, multi-line remarks and set-aside groups.
