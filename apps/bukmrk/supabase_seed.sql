-- Replace UUID below with your Supabase user id (see Authentication → Users)
-- Example seed for one book
do $$
declare
  u uuid := '3136b73d-f947-4e6c-8a07-bfb51160ca5c'; -- 👈 your user id
begin
  insert into public.books (user_id, title, total_pages, current_page, start_date, due_date, reading_days, status)
  values (
    u,
    'The Good and Beautiful God',
    192,
    36,
    current_date,
    current_date + interval '30 days',
    ARRAY[true,true,true,true,true,false,false],
    'active'
  );
end $$;