-- What a Supabase project does to the public schema by default: the API roles
-- may use the schema, and every table, sequence and function created later
-- starts with ALL privileges for them. Row level security (RLS) is then what
-- decides which rows anon can actually touch, which is exactly what these
-- tests exercise. Loaded into each throwaway database before the schema.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
