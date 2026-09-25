-- has_module(): true if the given business's type has the given module
-- assigned in business_type_modules. Used by RLS WITH CHECK policies to
-- gate writes on module-scoped tables.
create or replace function public.has_module(p_business_id uuid, p_module_key text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from businesses b
    join business_type_modules btm on btm.business_type_id = b.business_type_id
    where b.id = p_business_id
      and btm.module_key = p_module_key
  );
$$;

grant execute on function public.has_module(uuid, text) to authenticated;
