-- Synthetic seed data (no real inventory), loaded as the superuser, so it
-- bypasses RLS the way rows created earlier through the Supabase dashboard
-- would. Written to run unchanged on both the uuid and the bigint shape: ids
-- are never typed, only looked up. Barcodes are the stable keys the
-- assertions use.

insert into public.categories (name) values
  ('Legacy Antibiotics'),
  ('Legacy Pain relief'),
  ('Legacy Spare (unused)');

insert into public.medications (name, barcode, stock, threshold, unit, notes) values
  ('Test A, "quoted" tablets',                 '0001', 10,  5, 'units', 'note, with comma'),
  ('Test B',                                   '0002',  3,  5, 'units', null),
  ('Test C',                                   'ABC-3', 0,  5, 'units', null),
  (null,                                       '0004',  0, 10, 'units', null),
  ('Crème antiseptique 1 %',                   '0005', 50, 20, 'units', null),
  ('Test D (categorized before the change)',   '0006',  7,  5, 'boxes', null);

update public.medications set is_unnamed = true where barcode = '0004';
update public.medications
   set category_id = (select id from public.categories where name = 'Legacy Antibiotics')
 where barcode = '0006';

-- Real stock movements through the real RPC, so the transactions table has
-- history and the function's plan is already cached in this session before the
-- migration is applied.
select public.record_transaction((select id from public.medications where barcode = '0001'), 'dispense', 2, 'seed');
select public.record_transaction((select id from public.medications where barcode = '0005'), 'receive',  5, 'seed');
