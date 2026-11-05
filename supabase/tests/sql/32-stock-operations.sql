-- Stage "stock-operations": the record_transaction RPC (what /api/transactions
-- and the barcode scanner call) must behave exactly as before. This runs in the
-- SAME database session that already executed the function before the migration
-- (the seed did), so it also proves the function keeps working after
-- ALTER TABLE ... ADD COLUMN with a plan already cached.
select medinv_t.stage('stock-operations');

do $$
declare
  r record;
  med text := (select id::text from public.medications where barcode = '0005');
  s0 int;
  s1 int;
  t0 bigint;
  t1 bigint;
  v text;
begin
  -- ── receive ─────────────────────────────────────────────────────────────
  select stock into s0 from public.medications where id = med::bigint;
  select count(*) into t0 from public.transactions;
  select * into r from medinv_t.run_as('anon',
    format($q$select * from public.record_transaction(%L::bigint, 'receive', 5, 'sql-test receive')$q$, med));
  perform medinv_t.ok('STOCK: receive works for anon, including in a session that cached the function before the migration',
                      r.state = '00000' and r.affected = 1, r.state || ' ' || coalesce(r.message, ''));
  select stock into s1 from public.medications where id = med::bigint;
  select count(*) into t1 from public.transactions;
  perform medinv_t.ok(format('STOCK: receive 5 raised stock %s -> %s and logged exactly one transaction', s0, s1), s1 = s0 + 5 and t1 = t0 + 1);
  perform medinv_t.eq('STOCK: the logged transaction has type receive, quantity 5 and the note',
                      (select type || '/' || quantity || '/' || note from public.transactions order by id desc limit 1), 'receive/5/sql-test receive');

  -- ── dispense ────────────────────────────────────────────────────────────
  s0 := s1; t0 := t1;
  select * into r from medinv_t.run_as('anon',
    format($q$select * from public.record_transaction(%L::bigint, 'dispense', 3, 'sql-test dispense')$q$, med));
  perform medinv_t.ok('STOCK: dispense works for anon', r.state = '00000' and r.affected = 1, r.state || ' ' || coalesce(r.message, ''));
  select stock into s1 from public.medications where id = med::bigint;
  select count(*) into t1 from public.transactions;
  perform medinv_t.ok(format('STOCK: dispense 3 lowered stock %s -> %s and logged exactly one transaction', s0, s1), s1 = s0 - 3 and t1 = t0 + 1);

  -- ── the returned row ────────────────────────────────────────────────────
  v := medinv_t.scalar_as('anon', format(
    $q$select (to_jsonb(t) ? 'supplier_order_number')::text || '/' || (to_jsonb(t) ? 'category_id')::text || '/' || t.stock
         from public.record_transaction(%L::bigint, 'receive', 1, 'sql-test row') t$q$, med));
  perform medinv_t.eq('STOCK: the row the RPC returns now carries supplier_order_number as well as category_id, with the new stock',
                      v, 'true/true/' || (s1 + 1));

  -- ── insufficient stock ──────────────────────────────────────────────────
  select stock into s0 from public.medications where id = med::bigint;
  select count(*) into t0 from public.transactions;
  select * into r from medinv_t.run_as('anon',
    format($q$select * from public.record_transaction(%L::bigint, 'dispense', %s, 'sql-test too many')$q$, med, s0 + 1000));
  perform medinv_t.eq('STOCK: dispensing more than is in stock is refused with the original message', r.message, 'Insufficient stock. Current stock: ' || s0);
  perform medinv_t.eq('STOCK: ...with SQLSTATE P0001', r.state, 'P0001');
  select stock into s1 from public.medications where id = med::bigint;
  select count(*) into t1 from public.transactions;
  perform medinv_t.ok('STOCK: ...and neither stock nor the transaction log changed', s1 = s0 and t1 = t0);

  -- ── unknown item ────────────────────────────────────────────────────────
  select * into r from medinv_t.run_as('anon', $q$select * from public.record_transaction(-1::bigint, 'receive', 1, 'sql-test missing')$q$);
  perform medinv_t.eq('STOCK: an unknown medication id is refused with "Medication not found"', r.message, 'Medication not found');
  perform medinv_t.eq('STOCK: ...with SQLSTATE P0001', r.state, 'P0001');

  -- ── invalid input still rejected by the table checks, atomically ────────
  select stock into s0 from public.medications where id = med::bigint;
  select count(*) into t0 from public.transactions;
  select * into r from medinv_t.run_as('anon',
    format($q$select * from public.record_transaction(%L::bigint, 'receive', 0, 'sql-test zero')$q$, med));
  perform medinv_t.eq('STOCK: a quantity of 0 is still rejected by the quantity > 0 check (23514)', r.state, '23514');
  select * into r from medinv_t.run_as('anon',
    format($q$select * from public.record_transaction(%L::bigint, 'adjust', 1, 'sql-test bad type')$q$, med));
  perform medinv_t.eq('STOCK: an unknown transaction type is still rejected by the type check (23514)', r.state, '23514');
  select stock into s1 from public.medications where id = med::bigint;
  select count(*) into t1 from public.transactions;
  perform medinv_t.ok('STOCK: ...and those rejected calls left stock and the log unchanged', s1 = s0 and t1 = t0, format('stock %s vs %s, tx %s vs %s', s1, s0, t1, t0));
end $$;
