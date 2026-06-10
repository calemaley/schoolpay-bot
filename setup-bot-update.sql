-- ============================================================
-- SchoolPay bot update (Figma flows 2014-167 / 2014-164)
-- Run this whole script in Supabase SQL Editor → Run.
-- Safe to run more than once (everything is IF NOT EXISTS).
-- ============================================================

-- ── 1. Help requests ─────────────────────────────────────────
-- The bot's Help flows ("X is not my child", "I have another
-- child", "I cannot see my child listed") log here.
create table if not exists public.help_requests (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid,
  phone       text not null,
  issue       text not null,
  status      text not null default 'open',   -- open | resolved
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists help_requests_school_idx
  on public.help_requests (school_id, status, created_at desc);

-- The bot writes with the service key (bypasses RLS).
-- RLS stays on so the anon key cannot read/write this table.
alter table public.help_requests enable row level security;

-- ── 2. Guardian phone audit ──────────────────────────────────
-- Child lookup now works from the guardian's phone number, so
-- every active student needs guardian1_phone (or whatsapp) set.
-- This query lists students the bot will NOT be able to find:
select admission_number,
       first_name || ' ' || last_name as student,
       guardian1_name,
       guardian1_phone,
       guardian1_whatsapp
from   public.students
where  is_active = true
  and  coalesce(nullif(trim(guardian1_phone), ''),
                nullif(trim(guardian1_whatsapp), '')) is null
order  by admission_number;

-- Fix any rows it returns like this (example):
-- update public.students
--   set guardian1_phone = '+254712345678'
--   where admission_number = 'ADM/2025/001';

-- ── 3. Quick sanity checks (optional) ────────────────────────
-- Sessions tables the bot relies on must already exist:
select 'whatsapp_sessions' as tbl, count(*) from public.whatsapp_sessions
union all
select 'ussd_sessions', count(*) from public.ussd_sessions
union all
select 'help_requests', count(*) from public.help_requests;
