-- Stage "supplier-order-number": codes are saved and read back through the anon
-- role (as the API does) and must come back exactly as typed.
select medinv_t.stage('supplier-order-number');

do $$
declare
  k record;
  r record;
  id1 text := (select id::text from public.medications where barcode = '0001');
  id2 text := (select id::text from public.medications where barcode = '0002');
  v text;
  row_before jsonb;
  row_after jsonb;
begin
  -- ── Exactness: byte-identical round trip ────────────────────────────────
  for k in
    select * from (values
      ('leading zeros',                         '0092'),
      ('letters and a dash',                    '00417-B'),
      ('slash and dash',                        'AX-1182/4'),
      ('64 characters, the app maximum',        'SUP-' || repeat('0123456789', 6)),
      ('unicode accents, numero sign, omega',   'Ünï-№7·Ω'),
      ('unicode full-width characters',         'ＡＢＣ-００１２'),
      ('unicode CJK',                           '日本語-0042'),
      ('unicode combining accent',              'e' || chr(769) || '-77'),
      ('quotes, backslash, percent, semicolon', $s$O'Brien "B" \ 50% ; -- x$s$),
      ('mixed case and inner spaces',           'aB-cD  12 34'),
      ('digits that look like a number',        '1E5'),
      ('starts like a spreadsheet formula',     '=1+1')
    ) t(label, code)
  loop
    select * into r from medinv_t.run_as('anon',
      format($q$update public.medications set supplier_order_number = %L where id = %L$q$, k.code, id1));
    v := medinv_t.scalar_as('anon', format($q$select supplier_order_number from public.medications where id = %L$q$, id1));
    perform medinv_t.ok(format('SUPPLIER: kept exactly after save and reload - %s (%s chars)', k.label, char_length(k.code)),
                        r.state = '00000' and r.affected = 1 and v is not distinct from k.code and octet_length(v) = octet_length(k.code),
                        format('state=%s sent=%L got=%L', r.state, k.code, v));
  end loop;

  perform medinv_t.run_as('anon', format($q$update public.medications set supplier_order_number = %L where id = %L$q$,
                                         'SUP-' || repeat('0123456789', 6), id1));
  perform medinv_t.eq('SUPPLIER: the 64-character code is stored in full: 64 characters read back from the database',
                      medinv_t.scalar_as('anon', format($q$select char_length(supplier_order_number) from public.medications where id = %L$q$, id1)), '64');

  -- ── Independence from barcode and name ──────────────────────────────────
  perform medinv_t.run_as('anon', format($q$update public.medications set supplier_order_number = '00417-B' where id = %L$q$, id1));
  select to_jsonb(m) - 'supplier_order_number' - 'updated_at' into row_before from public.medications m where id = id1::bigint;
  perform medinv_t.run_as('anon', format($q$update public.medications set supplier_order_number = '99-CHANGED' where id = %L$q$, id1));
  select to_jsonb(m) - 'supplier_order_number' - 'updated_at' into row_after from public.medications m where id = id1::bigint;
  perform medinv_t.ok('SUPPLIER: changing only the supplier number changes no other column (name, barcode, stock, category, ... all identical)',
                      row_before = row_after, row_before::text || ' vs ' || row_after::text);

  perform medinv_t.run_as('anon', format($q$update public.medications set supplier_order_number = '0002' where id = %L$q$, id1));
  perform medinv_t.run_as('anon', format($q$update public.medications set supplier_order_number = '0002' where id = %L$q$, id2));
  perform medinv_t.eq('SUPPLIER: separate from the barcode: it may equal another item''s barcode, and two items may share one number',
                      (select string_agg(barcode || '=' || supplier_order_number, ',' order by barcode) from public.medications where barcode in ('0001', '0002')),
                      '0001=0002,0002=0002');

  perform medinv_t.run_as('anon', format($q$update public.medications set supplier_order_number = '00417-B' where id = %L$q$, id1));
  perform medinv_t.run_as('anon', format($q$update public.medications set supplier_order_number = '0092' where id = %L$q$, id2));
  perform medinv_t.run_as('anon', $q$update public.medications set supplier_order_number = 'AX-1182/4' where barcode = 'ABC-3'$q$);

  -- ── Survives an unrelated edit ──────────────────────────────────────────
  perform medinv_t.run_as('anon', format($q$update public.medications set stock = stock + 1, notes = 'restocked', name = 'Test A (edited)' where id = %L$q$, id1));
  perform medinv_t.eq('SUPPLIER: an unrelated edit of name, notes and stock does not clear it',
                      medinv_t.scalar_as('anon', format($q$select supplier_order_number from public.medications where id = %L$q$, id1)), '00417-B');

  -- ── Items without a number stay "Not set" ───────────────────────────────
  perform medinv_t.eq('SUPPLIER: items nobody entered a number for stay NULL ("Not set"), not empty text',
                      medinv_t.scalar_as('anon', $q$select count(*) from public.medications where supplier_order_number is null and barcode in ('0004', '0005', '0006')$q$), '3');
  perform medinv_t.eq('SUPPLIER: 3 numbers entered on 3 items; the other items are untouched',
                      medinv_t.scalar_as('anon', 'select count(*) from public.medications where supplier_order_number is not null'),
                      (select count(*)::text from public.medications where barcode in ('0001', '0002', 'ABC-3')));

  -- ── Create path and clearing ────────────────────────────────────────────
  select * into r from medinv_t.run_as('anon',
    $q$insert into public.medications (barcode, name, supplier_order_number) values ('NEW-1', 'New item with number', '000123') returning id$q$);
  perform medinv_t.ok('SUPPLIER: a new item can be created with a number', r.state = '00000' and r.affected = 1, r.state || ' ' || coalesce(r.message, ''));
  perform medinv_t.eq('SUPPLIER: ...and "000123" reads back with its leading zeros',
                      medinv_t.scalar_as('anon', $q$select supplier_order_number from public.medications where barcode = 'NEW-1'$q$), '000123');
  select * into r from medinv_t.run_as('anon', $q$insert into public.medications (barcode, name) values ('NEW-2', 'New item without number')$q$);
  perform medinv_t.ok('SUPPLIER: a new item created without a number has NULL, not an empty string',
                      r.state = '00000' and (select supplier_order_number is null from public.medications where barcode = 'NEW-2'));
  perform medinv_t.run_as('anon', $q$update public.medications set supplier_order_number = null where barcode = 'NEW-1'$q$);
  perform medinv_t.ok('SUPPLIER: a number can be cleared back to NULL',
                      (select supplier_order_number is null from public.medications where barcode = 'NEW-1'));
end $$;
