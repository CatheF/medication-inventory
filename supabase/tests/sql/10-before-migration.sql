-- Stage "before-migration": runs after the seed data is loaded, before the
-- migration. Records the "before" snapshot that every later "nothing changed"
-- check compares against, then shows the defect the migration exists to fix.
select medinv_t.stage('before-migration');

do $$ begin perform medinv_t.save_snapshot('before'); end $$;

do $$
declare
  e medinv_t.expectations := medinv_t.exp();
  r record;
  n_cat bigint;
  v text;
begin
  select count(*) into n_cat from public.categories;

  if e.categories_rls and e.policies_before = 0 then
    -- ── The access defect (root cause 1): RLS on, no policy ────────────────
    select * into r from medinv_t.run_as('anon', $q$insert into public.categories (name) values ('Before-X')$q$);
    perform medinv_t.ok('BEFORE: anon cannot INSERT a category: SQLSTATE 42501 (what staff hit when typing a new category)',
                        r.state = '42501', r.state || ' ' || coalesce(r.message, ''));

    select * into r from medinv_t.run_as('anon', $q$insert into public.categories (name) values ('Before-X') returning id, name$q$);
    perform medinv_t.ok('BEFORE: INSERT ... RETURNING (the exact call supabase-js makes) fails the same way: 42501',
                        r.state = '42501', r.state || ' ' || coalesce(r.message, ''));

    select * into r from medinv_t.run_as('anon', 'select * from public.categories');
    perform medinv_t.ok(format('BEFORE: anon sees 0 categories although %s exist, and gets no error (the API answers 200 with an empty list)', n_cat),
                        r.state = '00000' and r.affected = 0 and n_cat > 0,
                        'state=' || r.state || ' rows=' || coalesce(r.affected::text, 'null') || ' existing=' || n_cat);

    v := medinv_t.scalar_as('anon', $q$select c.name from public.medications m join public.categories c on c.id = m.category_id where m.barcode = '0006'$q$);
    perform medinv_t.ok('BEFORE: an item that already has a category cannot resolve its name for anon (it could only show as unknown)',
                        v is null, coalesce(v, '<null>'));
  else
    -- ── Shapes without RLS on categories: there is no access defect here ───
    perform medinv_t.eq('BEFORE: RLS is off on categories in this shape, so anon already has table-level access (no access defect to demonstrate)',
                        medinv_t.probe('anon', $q$insert into public.categories (name) values ('Before-X')$q$), 'ok:some');
    v := medinv_t.scalar_as('anon', $q$select c.name from public.medications m join public.categories c on c.id = m.category_id where m.barcode = '0006'$q$);
    perform medinv_t.eq('BEFORE: an item with a category resolves its name for anon', v, 'Legacy Antibiotics');
  end if;

  -- ── The old client bug (root cause 2), on every shape ───────────────────
  -- app/admin/page.tsx did Number(selectValue): NaN for a uuid, and
  -- JSON.stringify(NaN) is null, so the PUT carried category_id: null.
  perform medinv_t.eq('NaN: writing the string "NaN" into category_id raises 22P02, so the DB would have complained had the client sent it',
                      medinv_t.probe('anon', $q$update public.medications set category_id = 'NaN' where barcode = '0002'$q$), 'err:22P02');
  perform medinv_t.eq('NaN: writing the string "undefined" into category_id raises 22P02',
                      medinv_t.probe('anon', $q$update public.medications set category_id = 'undefined' where barcode = '0002'$q$), 'err:22P02');
  perform medinv_t.eq('NaN: but an explicit NULL is accepted silently, which is why the old save looked successful while clearing the category',
                      medinv_t.probe('anon', $q$update public.medications set category_id = null where barcode = '0006'$q$), 'ok:some');
  perform medinv_t.eq('NaN: an id sent as a string is accepted whatever this shape''s id type (the fix sends ids as strings)',
                      medinv_t.probe('anon', format($q$update public.medications set category_id = %L where barcode = '0002'$q$,
                                     (select id::text from public.categories where name = 'Legacy Pain relief'))),
                      'ok:some');
end $$;
