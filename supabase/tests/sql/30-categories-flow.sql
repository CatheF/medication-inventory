-- Stage "categories-flow": the sequence the app performs, executed as role anon
-- (the anon key), after the migration. Ids are only ever handled as text, so the
-- same file runs on the uuid shape and the bigint shape.
select medinv_t.stage('categories-flow');

do $$
declare
  e medinv_t.expectations := medinv_t.exp();
  r record;
  n_before bigint;
  cat_new text;
  cat_pain text;
  cat_abx text;
  med text;
  v text;
  id_ok boolean;
begin
  select count(*) into n_before from public.categories;

  -- ── Read: GET /api/categories ───────────────────────────────────────────
  perform medinv_t.eq(format('AFTER: anon sees all %s categories that already existed (a plain SELECT, as GET /api/categories does)', n_before),
                      medinv_t.scalar_as('anon', 'select count(*) from public.categories'), n_before::text);

  -- ── Create: POST /api/categories ────────────────────────────────────────
  select * into r from medinv_t.run_as('anon', $q$insert into public.categories (name) values ('Allergy & Cold') returning id, name$q$);
  perform medinv_t.ok('AFTER: anon creates a category with INSERT ... RETURNING (what supabase-js sends)',
                      r.state = '00000' and r.affected = 1, r.state || ' ' || coalesce(r.message, ''));
  cat_new := medinv_t.scalar_as('anon', $q$select id::text from public.categories where name = 'Allergy & Cold'$q$);
  id_ok := case e.id_type
             when 'uuid' then cat_new ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             else cat_new ~ '^[0-9]+$' end;
  perform medinv_t.ok('AFTER: the new category is visible to anon on re-read, and its id is a ' || e.id_type || ' that travels as a plain string',
                      coalesce(id_ok, false), cat_new);

  select * into r from medinv_t.run_as('anon', $q$insert into public.categories (name) values ('Allergy & Cold')$q$);
  perform medinv_t.eq('AFTER: creating the same name again is rejected with 23505 (the API turns that into "return the existing one")', r.state, '23505');
  perform medinv_t.eq('AFTER: ...and no duplicate row exists',
                      medinv_t.scalar_as('anon', $q$select count(*) from public.categories where name = 'Allergy & Cold'$q$), '1');

  -- ── Assign: PUT /api/medications/[id] with category_id ──────────────────
  med := (select id::text from public.medications where barcode = '0002');
  select * into r from medinv_t.run_as('anon',
    format($q$update public.medications set category_id = %L where id = %L returning category_id$q$, cat_new, med));
  perform medinv_t.ok('AFTER: assigning a category to an item succeeds as anon (UPDATE ... RETURNING, the read-after-write check)',
                      r.state = '00000' and r.affected = 1, r.state || ' ' || coalesce(r.message, ''));
  perform medinv_t.eq('AFTER: after a reload the assignment is still there (category_id read back as anon)',
                      medinv_t.scalar_as('anon', format($q$select category_id::text from public.medications where id = %L$q$, med)), cat_new);
  perform medinv_t.eq('AFTER: the item groups under its category name (anon can join items to categories)',
                      medinv_t.scalar_as('anon', format($q$select c.name from public.medications m join public.categories c on c.id = m.category_id where m.id = %L$q$, med)),
                      'Allergy & Cold');

  -- ── Unrelated edit must not clear it ────────────────────────────────────
  select * into r from medinv_t.run_as('anon',
    format($q$update public.medications set name = 'Test B (edited)', notes = 'edited note', stock = stock + 1, threshold = 6 where id = %L$q$, med));
  perform medinv_t.ok('AFTER: an edit of name, notes, stock and threshold succeeds', r.state = '00000' and r.affected = 1, r.state || ' ' || coalesce(r.message, ''));
  perform medinv_t.eq('AFTER: ...and the unrelated edit did not clear the category',
                      medinv_t.scalar_as('anon', format($q$select category_id::text from public.medications where id = %L$q$, med)), cat_new);

  -- ── Change category ─────────────────────────────────────────────────────
  cat_pain := medinv_t.scalar_as('anon', $q$select id::text from public.categories where name = 'Legacy Pain relief'$q$);
  perform medinv_t.ok('AFTER: a category that existed before the migration is now selectable by anon', cat_pain is not null and cat_pain not like 'ERR:%', cat_pain);
  perform medinv_t.run_as('anon', format($q$update public.medications set category_id = %L where id = %L$q$, cat_pain, med));
  perform medinv_t.eq('AFTER: changing an item to another category persists after reload',
                      medinv_t.scalar_as('anon', format($q$select category_id::text from public.medications where id = %L$q$, med)), cat_pain);

  -- ── Only an explicit NULL uncategorizes ─────────────────────────────────
  perform medinv_t.run_as('anon', format($q$update public.medications set category_id = null where id = %L$q$, med));
  perform medinv_t.ok('AFTER: an explicit NULL uncategorizes the item (so the API must treat an omitted category_id as "leave alone", never as null)',
                      medinv_t.scalar_as('anon', format($q$select category_id::text from public.medications where id = %L$q$, med)) is null);

  -- ── Legacy / uncategorized items stay accessible and editable ───────────
  perform medinv_t.eq('AFTER: uncategorized items stay readable by anon (same count as the superuser sees)',
                      medinv_t.scalar_as('anon', 'select count(*) from public.medications where category_id is null'),
                      (select count(*)::text from public.medications where category_id is null));
  select * into r from medinv_t.run_as('anon', $q$update public.medications set name = 'Reviewed unnamed item' where barcode = '0004'$q$);
  perform medinv_t.ok('AFTER: an unnamed legacy item can still be edited by anon', r.state = '00000' and r.affected = 1, r.state);
  perform medinv_t.eq('AFTER: ...and the edit and its (still empty) category read back',
                      medinv_t.scalar_as('anon', $q$select name || '/' || coalesce(category_id::text, 'none') from public.medications where barcode = '0004'$q$),
                      'Reviewed unnamed item/none');

  -- ── Foreign key behaviour is unchanged ──────────────────────────────────
  cat_abx := (select id::text from public.categories where name = 'Legacy Antibiotics');
  v := medinv_t.probe_then(null, $q$delete from public.categories where name = 'Legacy Antibiotics'$q$,
                           $q$select category_id::text from public.medications where barcode = '0006'$q$);
  if e.fk_delete_rule = 'a' then
    perform medinv_t.eq('FK: deleting a category that items use is refused (23503) and the item keeps its category (NO ACTION, as deployed)',
                        v, 'err:23503 / ' || cat_abx);
  else
    perform medinv_t.eq('FK: deleting a category that items use succeeds and the item becomes uncategorized (ON DELETE SET NULL, as in schema.sql)',
                        v, 'ok:some / <null>');
  end if;
end $$;
