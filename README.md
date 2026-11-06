# MedInventory

An internal web app for a university health center to track its medication supplies: look items up by barcode, receive and dispense stock, browse the inventory by category, keep item details up to date, see usage over time, and prepare a supply order sheet to print or open in Excel.

Built with Next.js 16 (App Router), React 19, Tailwind CSS 4, TypeScript and Supabase (Postgres + Storage).

## Screens

| Route | What it is for |
| --- | --- |
| `/` (Scan tab) | Look up an item by barcode (USB scanner, camera or typed), then receive or dispense stock. An unknown barcode creates a "needs review" item. |
| `/` (Inventory tab, also `/?tab=inventory`) | Browse every item by category: category chips with counts, optional grouped headings, an **Uncategorized** group, search, stock filter, sorting, and "Add to order sheet" ticks. A failed load shows an error with Retry, never an empty list. |
| `/admin` | Add, edit and delete items; assign categories; enter the **supplier order number**; complete items created by scanning; upload photos. |
| `/order-sheet` | Build a supply order by hand and print it (Letter or A4) or download it as a real `.xlsx` file. |
| `/usage` | Usage history and projections. |
| `/kiosk` | Full-screen scanning mode. |

## Getting started

Requirements: Node.js 20.9 or newer and a Supabase project.

```bash
npm install
# create .env.local (see below), then:
npm run dev                  # http://localhost:3000
```

Environment variables (put them in `.env.local`; on Vercel the Supabase integration can set them for you):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your public anon or publishable key>
```

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Your project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` **or** `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The public (anon / publishable) key. The app accepts either name, because the Supabase–Vercel integration may set the second one. If neither is set the app stops at startup with a message naming both. |

Item photos are stored in a Supabase Storage bucket named `medication-photos` (public).

## Database

* `supabase/schema.sql` creates the tables for a fresh install, `supabase/rls.sql` adds the row-level-security policies.
* **Category ids are opaque strings.** `schema.sql` declares `BIGINT` ids, but at least one deployed database uses UUIDs. The app never converts category ids to numbers, so it works with either; do not "fix" a database to match the file or the file to match a database.
* `supabase/migrations/` holds additive migrations for **existing** databases.

### Migration `20261105000000_categories_access_and_supplier_order_number.sql`

What it does (and nothing else): adds the nullable text column `medications.supplier_order_number`, and adds two policies on `categories` for the `anon` role (SELECT and INSERT) so the app can list and create categories where row-level security is on but no policy exists. It is idempotent, runs in one transaction with a 5 second lock timeout, refuses a wrongly typed pre-existing column, and ends with a documented rollback block. The file header contains a read-only **pre-check** query to run first and the exact apply and rollback steps.

**Status: not applied to any project.** Applying it to a real project needs the owner's explicit decision. The app works before and after it: until it is applied, categories still cannot be created or read, and saving a supplier order number answers with a clear "apply the latest migration" message.

## Using the order sheet

The order sheet is a worklist for ordering; it never orders anything.

* Items are added **only by hand** (ticks on the Inventory tab, the search box on the sheet, an explicit "Add all low-stock items" button, or an explicit per-category "Add all" button). Nothing is selected automatically.
* **Order quantity** and **Order unit** are typed by staff and start empty. **On hand** is shown separately, read-only, and is never converted into an order quantity.
* The **supplier order number** is free text that staff enter in Admin. It is never inferred from the barcode or the name; leading zeros and letters are kept exactly. Items without one print an em dash and are listed in a note.
* Preparing, printing or exporting changes no stock and sends nothing.
* The draft lives in this browser only (`localStorage`). If the browser refuses to save it, the page says so.
* **Print / Save as PDF** opens the browser's print dialog. The printed page contains only the sheet (title, date, prepared by, a table with the header repeated on every page, notes, footer), in black and white, for Letter or A4. The notes stay together with the last item row, so the last page always has at least one item. If you press Ctrl/Cmd+P before the inventory has loaded (or after it failed to load), the printout is a one-page "Order sheet not printed" notice that says why, never a blank page. "Page N of M" appears in browsers that support page margin boxes (Chromium).
* **Download Excel (.xlsx)** creates a real workbook on the server from the rows on the sheet (a read-only request). Every text cell is stored as text, so `0092` stays `0092` and a name such as `=HYPERLINK(...)` stays literal text. The workbook prints one page wide with the header row repeated.

## Testing

```bash
npm run typecheck        # TypeScript
npm run lint             # ESLint (see "Known issues")
npm test                 # unit + API route tests (vitest, no database needed)
npm run test:e2e         # browser tests (Playwright, API mocked, no database needed)
npm run test:sql         # migration tests against a LOCAL throwaway PostgreSQL
npm run test:sql:selftest
```

* `npm test` exercises the pure logic and every changed route against an in-memory fake of the Supabase client (`tests/helpers/fake-supabase.ts`). It models row-level security, uuid and bigint ids, row caps and the pre-migration schema. It is a model, not the real PostgREST.
* `npm run test:e2e` starts the app (build + start on port 3100) and intercepts `/api/*` with `tests/e2e/helpers/mock-api.ts`. Set `E2E_BASE_URL` to use a server that is already running and `CHROMIUM_PATH` to point at an installed Chromium. Some print/Excel checks also use `pdfinfo`/`pdftotext` (poppler), `python3` with `openpyxl`, and LibreOffice when present, and skip with a reason when they are not.
* `npm run test:sql` needs `psql` and a local PostgreSQL 13+ (`TEST_PGHOST` must be a local address, default port 54329, user must be a superuser; see the header of `supabase/tests/run.sh`). It only ever creates and drops databases named `medinv_test_*`. It never touches a real Supabase project.

All test data is synthetic.

## Troubleshooting

* **The inventory looks empty or a number is missing.** The pages now show an explicit error with a Retry button when the database cannot be reached; an empty list means the database really returned no items. A Supabase **free-plan project pauses after a period of inactivity** (see Supabase's documentation for the current rule) and the app cannot reach it until it is restored; the data is kept.
* **"Couldn't create the category … row-level security".** The migration above has not been applied to that database. If the message says *permission denied for table*, it is a missing privilege instead and the migration alone will not fix it: see "BEFORE YOU APPLY" in the migration header.
* **"Supplier order numbers aren't available yet".** The `supplier_order_number` column does not exist yet: apply the migration.
* **The Excel export says items are "no longer in the inventory".** They were deleted after being added to the sheet. Remove them from the sheet and export again.

## Security notes

* The app has **no login**. Anyone who can open the site can use it, and the public key it uses is allowed to read and change medications and to read transactions (`supabase/rls.sql`). This is how the app was built; it is suitable only for a trusted internal network or behind another access control. Adding Supabase Auth and tightening the policies is a separate project.
* The export route only reads. The migration grants `anon` nothing beyond SELECT and INSERT on `categories`.

## Known issues and limits

* `npm run lint` reports two errors and one warning in `app/kiosk/page.tsx` and `app/usage/page.tsx`. They existed before this work and those pages were left unchanged.
* `POST /api/import` (CSV import; sample in `public/sample.csv`) is not used by any page and is unchanged. A blank `stock` or `threshold` cell in a re-imported CSV is read as 0.
* Not built: bulk category assignment, importing supplier order numbers from CSV, any ordering or purchasing integration, authentication.
* Real Microsoft Excel, Safari/Firefox printing, real printers, screen readers and a real Supabase/PostgREST were not available when this was tested.

## Project layout

```
app/                 pages and API routes (App Router)
  api/               categories, medications, transactions, analytics, import, upload, order-sheet/xlsx
  components/        shared UI (Notice, ItemThumb, filter chips, empty-state card, combobox, inventory/)
  order-sheet/       the order sheet page, print stylesheet and export client
lib/                 pure logic: ids, supplier order number, inventory view (search/filter/sort/group),
                     order sheet (draft, build, xlsx), API error mapping, Supabase client
supabase/            schema.sql, rls.sql, migrations/, tests/ (SQL suite)
tests/               unit/, api/, e2e/, helpers/
```
