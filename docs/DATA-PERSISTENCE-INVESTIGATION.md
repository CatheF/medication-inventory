# Investigation: "inventory disappeared / data doesn't persist"

**Scope.** A bounded, **read-only** look at the Health Center Supabase project and at the app's code, done on 2026-11-06 (the first look was on 2026-11-05). Only `SELECT` statements and project-status reads were run. Nothing was changed, no keep-alive or any other object was created, and no billing, authentication or provider setting was touched.

**Short answer.** The inventory is **there**: 128 items and 104 stock movements. What I can say about the report that items "disappeared" is below, split into what I verified, what is plausible but unproven, and what I could not see. I did not find proof that rows were lost recently, and the original app had a defect that makes an unreachable database *look* like an empty inventory.

## Verified facts (read directly from the database or the code)

| Fact | Value |
| --- | --- |
| Items in `medications` | **128** (first created 2026-05-06, last created 2026-09-11, last updated 2026-10-28 16:02 UTC) |
| Rows in `transactions` | **104** (first 2026-07-13, last 2026-10-28 16:02 UTC) |
| Categories | **0** rows, and **0 of 128** items have a category (so "categories disappeared" cannot be a data loss: none were ever stored; see the bug below) |
| Unnamed items waiting for review | 1 |
| Project status | `ACTIVE_HEALTHY` |
| Postgres last (re)started | **2026-10-15 17:54:48 UTC** |
| Quiet period in the movement history | last movement before it **2026-10-08 17:06:05 UTC**, first after it **2026-10-28 16:01:31 UTC**; no movement recorded between |
| Missing `transactions` ids | ids 1–123 would be 123 rows; **19 ids are absent**: **1–8 and 11–21** (two contiguous runs, no duplicates) |
| A `keepalive` table | exists, 1 row: "pinged by GitHub Actions to keep this project from pausing". **Found, not created by this work.** |
| What the original app did with a failed load | It swallowed every API error into an empty list and showed "No medications yet" / zeros (read in the original code, reproduced in a browser). So an unreachable or paused database looked exactly like an empty inventory. |
| Authentication | None. The app uses the public anon key and `supabase/rls.sql` lets that key change medications, so anyone who can open the site can edit or delete items. |
| Deleting an item | Deletes its transactions too (`ON DELETE CASCADE`), and nothing records who deleted what. |

## Plausible, but not proven

1. **The project was paused and restored.** Postgres restarted on 2026-10-15 at 17:54 UTC, about 7 days and 48 minutes after the last recorded movement (2026-10-08 17:06). Supabase's documentation says free-plan projects pause after a period of inactivity (7 days when this was checked); a restore would restart Postgres. This fits, but the last *activity* could also have been reads that leave no trace, so the arithmetic is suggestive, not conclusive. While the project is paused the app cannot reach the database, and the original UI would have shown an empty inventory.
2. **The missing transaction ids come from early test data being removed.** Two contiguous runs (1–8 and 11–21) look like a batch deletion of the first records (deleting an item cascades to its transactions) or a rolled-back bulk insert (a rolled-back insert still uses up id numbers). Either leaves exactly this kind of gap; I cannot tell which, or when.
3. **A deployment pointed at the wrong database or without its settings.** A preview or second deployment whose environment variables name a different project would show different (or no) data. I could not see the hosting settings (below), so this is unchecked.

## What I could not see

* Vercel projects, their environment variables and logs (the Vercel connection available here belongs to a different account and cannot see the team). What GitHub's commit statuses show: two Vercel projects are attached to this repository. `medication-inventory` builds and deploys every push of the work branch successfully. `medication-inventory-dsav` has failed on every push of this branch (it does not appear on the commits before it), so its failure points at that project's own settings, not at the code. The most likely cause, reproduced locally: a build with no Supabase variables set stops at "Collecting page data" with "Missing NEXT_PUBLIC_SUPABASE_URL or a Supabase key", for the original commit and for this branch alike. So that project probably lacks `NEXT_PUBLIC_SUPABASE_URL` and a key variable for the **Preview** environment (variables that exist only for Production do not reach branch builds). This is a hypothesis; its build log is not readable from here; `npx vercel inspect dpl_Bm7AHUd98gxGiNzXeQJzQynD8AUx --logs` (run by someone signed in to that Vercel team) prints it.
* Supabase billing, plan and pause/restore history, and any backups (free plans have no downloadable backups).
* Whether the GitHub Action that pings the `keepalive` table still runs, and how often (the workflow is not in this repository).
* API and database logs older than the retention window, so who deleted what cannot be reconstructed.

## What this work changed because of it

* A failed load is now an explicit error with a **Retry** button on every screen (Scan, Inventory, Order sheet, Admin); it is never shown as an empty inventory. The Inventory empty state says to check that the app is connected to the right database.
* The barcode lookup answers "not found" only when the item really is absent. A database error is reported as an error, so the scanner can no longer create a duplicate "unknown" item just because the database was unreachable.
* The medication list API returns the **complete** list (it pages through any row cap) and reports errors instead of an empty list.
* The categories fix (see `supabase/migrations/`) addresses the separate "categories don't persist" cause.

## Read-only queries you can rerun

```sql
select (select count(*) from public.medications)  as items,
       (select count(*) from public.transactions) as movements,
       (select max(created_at) from public.transactions) as last_movement,
       pg_postmaster_start_time() as postgres_started_at;

select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)
  from public.transactions group by 1 order by 1;

select i as missing_transaction_id
  from generate_series(1, (select max(id) from public.transactions)) i
 where i not in (select id from public.transactions);
```

## Recommendations (none applied)

1. Keep the existing keep-alive, and confirm in GitHub that it still runs on a schedule.
2. Consider a paid plan (or a scheduled export) if losing this data would matter: a free plan has no downloadable backups.
3. Add authentication before the app is exposed beyond staff, and an audit trail of deletes.
