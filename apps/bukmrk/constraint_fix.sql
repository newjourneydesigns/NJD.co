-- URGENT: Fix the constraint for audiobooks
-- Run this in your Supabase SQL Editor RIGHT NOW

-- Drop the old constraint
ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_physical_pages_check;

-- Add the correct constraint that allows NULL values
ALTER TABLE public.books
ADD CONSTRAINT books_physical_pages_check CHECK (
  (book_type = 'physical' and total_pages is not null and total_chapters is null) or 
  (book_type = 'audiobook' and total_chapters is not null and total_pages is null)
);

-- Also make sure the columns allow NULL values
ALTER TABLE public.books ALTER COLUMN total_pages DROP NOT NULL;
ALTER TABLE public.books ALTER COLUMN total_chapters DROP NOT NULL;

-- FIX SESSIONS TABLE for audiobook progress logging
-- Make sure page-related columns allow NULL for audiobooks
ALTER TABLE public.sessions ALTER COLUMN start_page DROP NOT NULL;
ALTER TABLE public.sessions ALTER COLUMN end_page DROP NOT NULL;
ALTER TABLE public.sessions ALTER COLUMN pages_read DROP NOT NULL;
