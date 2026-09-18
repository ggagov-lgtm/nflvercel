create extension if not exists pgcrypto;

-- ============================================================
-- PROFILES
-- ============================================================

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    name text not null default '',
    email text,
    role text not null default 'user'
        check (role in ('user', 'admin')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- ============================================================
-- LOCKED WEEKLY PREDICTIONS
-- ============================================================

create table if not exists public.predictions (
    id uuid primary key default gen_random_uuid(),

    season integer not null,
    week integer not null,
    event_id text not null,

    game jsonb not null,
    market jsonb not null,
    model jsonb not null,

    model_version text not null default 'v1.0.0',

    prediction_run_at timestamptz not null default now(),
    locked_at timestamptz not null default now(),

    unique (season, week, event_id)
);

create index if not exists predictions_season_week_idx
on public.predictions(season, week);

create index if not exists predictions_event_idx
on public.predictions(event_id);


-- ============================================================
-- FINAL GAME RESULTS
-- ============================================================

create table if not exists public.game_results (
    id uuid primary key default gen_random_uuid(),

    event_id text not null unique,
    season integer not null,
    week integer not null,

    home_score integer,
    away_score integer,

    status text not null default 'pending',

    completed_at timestamptz,
    updated_at timestamptz not null default now()
);

create index if not exists game_results_season_week_idx
on public.game_results(season, week);


-- ============================================================
-- BET / PREDICTION SETTLEMENT
-- ============================================================

create table if not exists public.prediction_settlements (
    id uuid primary key default gen_random_uuid(),

    prediction_id uuid not null
        references public.predictions(id)
        on delete cascade,

    ml_result text,
    spread_result text,
    total_result text,
    top_pick_result text,

    settled_at timestamptz not null default now(),

    unique(prediction_id)
);


-- ============================================================
-- WEEKLY MODEL PERFORMANCE
-- ============================================================

create table if not exists public.model_performance_weekly (
    season integer not null,
    week integer not null,

    games integer not null default 0,

    ml_wins integer not null default 0,
    ml_losses integer not null default 0,

    spread_wins integer not null default 0,
    spread_losses integer not null default 0,
    spread_pushes integer not null default 0,

    total_wins integer not null default 0,
    total_losses integer not null default 0,
    total_pushes integer not null default 0,

    top_pick_wins integer not null default 0,
    top_pick_losses integer not null default 0,
    top_pick_pushes integer not null default 0,

    ml_accuracy double precision,
    spread_accuracy double precision,
    total_accuracy double precision,
    top_pick_accuracy double precision,

    score_mae double precision,
    margin_mae double precision,
    total_mae double precision,

    updated_at timestamptz not null default now(),

    primary key (season, week)
);


-- ============================================================
-- SEASON MODEL PERFORMANCE
-- ============================================================

create table if not exists public.model_performance_season (
    season integer primary key,

    games integer not null default 0,

    ml_accuracy double precision,
    spread_accuracy double precision,
    total_accuracy double precision,
    top_pick_accuracy double precision,

    score_mae double precision,
    margin_mae double precision,
    total_mae double precision,

    updated_at timestamptz not null default now()
);


-- ============================================================
-- PIPELINE RUN HISTORY
-- ============================================================

create table if not exists public.pipeline_runs (
    id bigint generated always as identity primary key,

    run_type text not null default 'weekly',
    season integer,
    week integer,

    started_at timestamptz not null default now(),
    completed_at timestamptz,

    status text not null,
    message text,

    model_version text,

    games_expected integer,
    games_processed integer,

    errors integer not null default 0,
    warnings integer not null default 0
);


-- ============================================================
-- SYSTEM / API HEALTH
-- ============================================================

create table if not exists public.system_health (
    id bigint generated always as identity primary key,

    service text not null,
    status text not null,
    message text,

    response_ms integer,

    checked_at timestamptz not null default now()
);

create index if not exists system_health_service_time_idx
on public.system_health(service, checked_at desc);


-- ============================================================
-- AUTOMATIC PROFILE CREATION
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

    insert into public.profiles (
        id,
        name,
        email,
        role
    )
    values (
        new.id,
        coalesce(new.raw_user_meta_data ->> 'name', ''),
        new.email,
        'user'
    );

    return new;

end;
$$;

drop trigger if exists on_auth_user_created
on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute procedure public.handle_new_user();


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles enable row level security;
alter table public.predictions enable row level security;
alter table public.game_results enable row level security;
alter table public.prediction_settlements enable row level security;
alter table public.model_performance_weekly enable row level security;
alter table public.model_performance_season enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.system_health enable row level security;


-- ============================================================
-- USER READ POLICIES
-- ============================================================

create policy "users read own profile"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);


create policy "authenticated read predictions"
on public.predictions
for select
to authenticated
using (true);


create policy "authenticated read game results"
on public.game_results
for select
to authenticated
using (true);


create policy "authenticated read settlements"
on public.prediction_settlements
for select
to authenticated
using (true);


create policy "authenticated read weekly performance"
on public.model_performance_weekly
for select
to authenticated
using (true);


create policy "authenticated read season performance"
on public.model_performance_season
for select
to authenticated
using (true);


-- ============================================================
-- ATOMIC WEEKLY PREDICTION SAVE
-- ============================================================

create or replace function public.save_weekly_predictions(
    p_season integer,
    p_week integer,
    p_expected_games integer,
    p_predictions jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_count integer;
    v_existing integer;
begin

    -- --------------------------------------------------------
    -- Validate input
    -- --------------------------------------------------------

    if p_predictions is null
       or jsonb_typeof(p_predictions) <> 'array'
    then
        raise exception
            'Predictions payload must be a JSON array';
    end if;

    v_count := jsonb_array_length(p_predictions);

    if v_count <> p_expected_games then
        raise exception
            'Prediction count mismatch: expected %, received %',
            p_expected_games,
            v_count;
    end if;

    -- --------------------------------------------------------
    -- Never overwrite an already-created official week.
    -- Locked historical predictions are immutable.
    -- --------------------------------------------------------

    select count(*)
    into v_existing
    from public.predictions
    where season = p_season
      and week = p_week;

    if v_existing > 0 then
        raise exception
            'Predictions already exist for season % week %',
            p_season,
            p_week;
    end if;

    -- --------------------------------------------------------
    -- Insert the entire prediction set.
    --
    -- The function executes inside a PostgreSQL transaction.
    -- Any failure rolls back the entire function call.
    -- --------------------------------------------------------

    insert into public.predictions (
        season,
        week,
        event_id,
        game,
        market,
        model,
        model_version,
        prediction_run_at,
        locked_at
    )
    select
        (x ->> 'season')::integer,
        (x ->> 'week')::integer,
        x ->> 'event_id',
        x -> 'game',
        x -> 'market',
        x -> 'model',
        x ->> 'model_version',
        (x ->> 'prediction_run_at')::timestamptz,
        (x ->> 'locked_at')::timestamptz
    from jsonb_array_elements(
        p_predictions
    ) as x;

    get diagnostics v_count = row_count;

    if v_count <> p_expected_games then
        raise exception
            'Database inserted % predictions; expected %',
            v_count,
            p_expected_games;
    end if;

    return v_count;

end;
$$;


-- Service-role backend only.
revoke execute
on function public.save_weekly_predictions(
    integer,
    integer,
    integer,
    jsonb
)
from public;

revoke execute
on function public.save_weekly_predictions(
    integer,
    integer,
    integer,
    jsonb
)
from anon;

revoke execute
on function public.save_weekly_predictions(
    integer,
    integer,
    integer,
    jsonb
)
from authenticated;

grant execute
on function public.save_weekly_predictions(
    integer,
    integer,
    integer,
    jsonb
)
to service_role;
