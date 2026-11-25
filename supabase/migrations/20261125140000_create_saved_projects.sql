begin;

create table public.c_atlas_projects (
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    repository text collate "C" not null,
    created_at timestamptz not null default now(),
    primary key (user_id, repository),
    constraint c_atlas_projects_repository_slug check (
        repository ~ '^[a-z0-9_-]{1,100}/[a-z0-9_.-]{1,100}$'
        and split_part(repository, '/', 2) not in ('.', '..')
    )
);

alter table public.c_atlas_projects enable row level security;

revoke all privileges on table public.c_atlas_projects from public, anon, authenticated;
grant select, delete on table public.c_atlas_projects to authenticated;
grant insert (repository) on table public.c_atlas_projects to authenticated;

create policy "Read own projects" on public.c_atlas_projects
    for select to authenticated using (user_id = (select auth.uid()));

create policy "Add own projects" on public.c_atlas_projects
    for insert to authenticated with check (user_id = (select auth.uid()));

create policy "Remove own projects" on public.c_atlas_projects
    for delete to authenticated using (user_id = (select auth.uid()));

commit;
