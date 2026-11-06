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
* The **supplier order number** is free text that staff enter in Admin. It is never inferred from the barcode or the name; leading zeros and letters are kept exactly. Items without one print an em dash, and a notice on the page says how many there are (the printed sheet itself only shows the dash).
* Preparing, printing or exporting changes no stock and sends nothing.
* The draft lives in this browser only (`localStorage`). If the browser refuses to save it, the page says so.
* **Mistakes can be undone, one step.** "Add all low-stock items" and Remove each show a message with **Undo** and **Dismiss** (it sticks to the bottom of the screen while the list is long). Undo takes off only the rows that "Add all" added, or puts the removed row back at its place with its quantity and unit. Typing a quantity or unit in a row that "Add all" added ends that Undo, so an Undo can never delete typed work.
* **Enter in "Add an item" adds the item** when exactly one item matches, or when one of several has exactly the typed barcode (what a handheld scanner sends); it then empties the box and keeps the keyboard in it for the next scan.
* **It never waits for ever.** Reading the inventory and creating the Excel file each give up after 30 seconds and show an error with Retry; the saved draft is untouched.
* **Print / Save as PDF** opens the browser's print dialog. The printed page contains only the sheet (title, date, prepared by, a table with the header repeated on every page, notes, footer), in black and white, for Letter or A4. The notes stay together with the last item row, so the last page always has at least one item. If you press Ctrl/Cmd+P before the inventory has loaded (or after it failed to load), the printout is a one-page "Order sheet not printed" notice that says why, never a blank page. "Page N of M" appears in browsers that support page margin boxes (Chromium).
* **Download Excel (.xlsx)** creates a real workbook on the server from the rows on the sheet (a read-only request). Every text cell is stored as text, so `0092` stays `0092` and a name such as `=HYPERLINK(...)` stays literal text. The workbook prints one page wide with the header row repeated.

## Changes to the existing scanner

The barcode scanner (USB scanner, camera, typed codes, Quick mode, kiosk) still works the way it did, with these deliberate changes. Each one fixes a way the original could save a wrong record or leave a person stuck, and each is covered by the `tests/e2e/existing-*.spec.ts` browser tests (about 140 tests, including a USB-scanner emulation and a fake camera):

* **A failed lookup is no longer reported as "unknown barcode".** The barcode route answers 404 only when no item has the code; a database or network error is an error. Quick mode says "Lookup failed" with "Check the connection and scan again." for those, and the scanner can no longer create a duplicate "needs review" item just because the database was unreachable.
* **The scan lock covers the request only.** In the original, a result card that stayed open made every later scan do nothing, silently. Now a new scan shows the new item, and the quantity and note typed for the previous card are cleared (they must never carry over to another item).
* **The scanner's keystrokes are left alone in editable elements and in the Inventory tab's Sort list, as they already were in text boxes.** A letter and Enter in the Sort list was read as a one-character scan and saved a junk item. The scanner's own Enter no longer also presses whichever button had keyboard focus (for example the tab that was just clicked).
* **The manual barcode box selects its text when entered or after a lookup.** A handheld scanner types into a focused box like a keyboard; without this its digits were glued onto the code that was already there, and the lookup of the two codes together saved a junk item.
* **The camera is released** when you leave the Scan tab or the page, or press Stop; the camera light used to stay on, and pressing Start Camera twice could leave a stream running.
* **Manual mode states the quantity that was recorded** (an emptied quantity box records 1).
* **The kiosk says a new barcode was saved only when it was.** After a refused or failed save it shows "Could not save barcode …" with Try Again; before, it said "Saved for staff review in Admin" whatever the answer. Nothing else in the kiosk changed.

Not tested here: a real USB scanner, a real camera decoding a printed barcode, Safari or iOS. Before merging, do one real check on the preview deployment: receive and dispense one item with the USB scanner, scan one unknown barcode, and scan one barcode with the phone camera.

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
* `npm run test:sql` needs `psql` and a local PostgreSQL 13+ (`TEST_PGHOST` must be a numeric loopback address such as 127.0.0.1, default port 54329, user must be a superuser; see the header of `supabase/tests/run.sh`). It only ever creates and drops databases named `medinv_test_*`. It never touches a real Supabase project. Without `psql` or a local server it prints SKIPPED and exits 0 (a vacuous pass); set `TEST_REQUIRE_DB=1` to make that case fail with exit 2.

All test data is synthetic.

## Troubleshooting

* **The inventory looks empty or a number is missing.** When the database cannot be reached, the pages show an explicit error with a Retry button instead of an empty list. An empty list therefore means the database answered with no items *to this app*: check that `NEXT_PUBLIC_SUPABASE_URL` points at the right project before adding anything new. A Supabase **free-plan project pauses after a period of inactivity** and the app cannot reach it until it is restored from the Supabase dashboard (see Supabase's documentation for the current rule and for how long a paused project can be restored). A read-only write-up of what could and could not be verified about one such report is in [`docs/DATA-PERSISTENCE-INVESTIGATION.md`](docs/DATA-PERSISTENCE-INVESTIGATION.md).
* **A Vercel build fails with "Missing NEXT_PUBLIC_SUPABASE_URL or a Supabase key".** That Vercel project has no Supabase variables for the environment being built. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) in the project's settings for **both Production and Preview**, then redeploy; variables that exist only for Production do not reach branch (Preview) builds. The same build error appears locally if `.env.local` is missing.
* **"Categories cannot be saved yet. This needs a one-time database update…"** (Admin, when creating a category). The migration above has not been applied to that database; the small "Technical details" line under the message says *row-level security* and code 42501. If it says *permission denied for table* instead, it is a missing privilege and the migration alone will not fix it: see "BEFORE YOU APPLY" in the migration header. The item itself can still be saved without a category.
* **"Supplier order numbers cannot be saved yet. This needs a one-time database update…"** The `supplier_order_number` column does not exist yet: apply the migration. Nothing else on the item was changed by that save.
* **The Excel export says items are "no longer in the inventory".** They were deleted after being added to the sheet. Remove them from the sheet and export again.

## Security notes

* The app has **no login**. Anyone who can open the site can use it, and the public key it uses is allowed to read and change medications, to read transactions, and to record stock movements through the `record_transaction()` function (`supabase/rls.sql`). Deleting an item also deletes its movement history (`ON DELETE CASCADE`), and nothing records who did it. This is how the app was built; it is suitable only for a trusted internal network or behind another access control. Adding Supabase Auth and tightening the policies is a separate project.
* The export route only reads. The migration grants `anon` nothing beyond SELECT and INSERT on `categories`.
* The three routes this work added or changed (creating a category, creating an item, the Excel export) refuse a request that is not declared as JSON (415) or that the browser marks as coming from another website (403), so a page on another site cannot post to them. The older routes (stock movements, CSV import, photo upload) still accept such posts, which includes changing stock; adding the same check to the stock-movement route is a small follow-up (every caller in the app already sends JSON).
* Text sent to the item and category routes is limited (counted in characters): name 300, notes 5,000, vendor link and photo address 2,048, unit 40, barcode 1,024, supplier order number 64, category name 60, and a request body of 1,000,000 bytes. The vendor link must be an http(s) address or a plain `shop.example.com/reorder`; the photo address must be an http(s) address. Values already stored are never rewritten.
* The photo upload route (`/api/upload`, not changed by this work) accepts any file the browser calls an image, up to 5 MB each, from anyone who can open the site, into the public `medication-photos` bucket. It can use up the project's storage allowance.
* No security response headers (such as a Content-Security-Policy or `frame-ancestors`) are configured, and Next.js's `X-Powered-By` header is on.
* **Dependencies.** `npm audit` reports known advisories for Next.js 16.2.4 and a few packages that come with it (the same ones as before this work). The features they concern (the image optimizer, Server Actions, `use cache`, middleware, `next/og`) are not used by this app, so the reachable exposure is small. A lockfile-only `npm audit fix` fixes them (Next.js 16.4.5 is inside the existing `^16.2.4` range and `package.json` stays as it is). It was not applied here because it is a framework update that is outside this change and would need the whole test suite run again on the new version; do it as its own change. The test runner (vitest 3.2.7) has advisories that only matter if its UI or browser server is exposed; this repository only runs `vitest run`.

## Known issues and limits

* `npm run lint` reports two errors and one warning in `app/kiosk/page.tsx` and `app/usage/page.tsx`. They existed before this work and those pages were left unchanged.
* `POST /api/import` (CSV import; sample in `public/sample.csv`) is not used by any page and is unchanged. A blank `stock` or `threshold` cell in a re-imported CSV is read as 0.
* The order sheet draft remembers items by their id. If the database is ever re-created or re-imported the items get new ids, so clear the order sheet first.
* The order sheet badge in the top bar and the heading "Items on this sheet" also count rows whose item was deleted in Admin; the sheet itself marks those rows and leaves them out of the print-out and the Excel file.
* On a phone, the Inventory tab shows the category chips above the search box, so the search box starts below the first screen.
* `package.json` lists three packages that nothing imports (`@anthropic-ai/sdk`, `better-sqlite3`, `formidable`). They were there before this work; removing them is a separate, safe change.
* The Usage and Kiosk pages were left as they were (apart from the kiosk's save message, see above): an automated accessibility check finds low-contrast text on both and a scroll area that cannot be reached by keyboard on Usage.
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
