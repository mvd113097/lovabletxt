create or replace function public.novel_progress()
returns table (novel_id uuid, total int, done int, google int, ready int, ready_words bigint, last_error text)
language sql stable security definer set search_path = public
as $$
  with firstgap as (
    select n.id, coalesce((select min(idx) from public.chapters c where c.novel_id = n.id and c.status <> 'done'), n.total_chapters) as gap
    from public.novels n
  )
  select n.id,
    count(c.*)::int,
    count(c.*) filter (where c.status = 'done')::int,
    count(c.*) filter (where c.engine = 'google')::int,
    f.gap::int,
    coalesce(sum(c.word_count) filter (where c.idx < f.gap), 0)::bigint,
    (select c2.last_error from public.chapters c2 where c2.novel_id = n.id and c2.last_error is not null and c2.status <> 'done' limit 1)
  from public.novels n
  join firstgap f on f.id = n.id
  left join public.chapters c on c.novel_id = n.id
  group by n.id, f.gap;
$$;
revoke all on function public.novel_progress() from public, anon, authenticated;
grant execute on function public.novel_progress() to service_role;