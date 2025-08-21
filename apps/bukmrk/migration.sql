-- Migration script to add audiobook support to existing database
-- Run this in your Supabase SQL Editor

-- Add new columns to existing books table
ALTER TABLE public.books 
ADD COLUMN IF NOT EXISTS book_type text NOT NULL DEFAULT 'physical',
ADD COLUMN IF NOT EXISTS total_chapters int,
ADD COLUMN IF NOT EXISTS current_chapter int NOT NULL DEFAULT 0;

-- Drop existing constraints if they exist (to avoid conflicts)
ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_book_type_check;
ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_total_chapters_check;
ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_current_chapter_check;
ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_physical_pages_check;

-- Add constraints
ALTER TABLE public.books 
ADD CONSTRAINT books_book_type_check CHECK (book_type IN ('physical', 'audiobook'));

ALTER TABLE public.books 
ADD CONSTRAINT books_total_chapters_check CHECK (total_chapters > 0);

ALTER TABLE public.books 
ADD CONSTRAINT books_current_chapter_check CHECK (current_chapter >= 0);

-- Add the complex constraint for book types
ALTER TABLE public.books
ADD CONSTRAINT books_physical_pages_check CHECK (
  (book_type = 'physical' and total_pages is not null and total_chapters is null) or 
  (book_type = 'audiobook' and total_chapters is not null and total_pages is null)
);

-- Add new columns to sessions table  
ALTER TABLE public.sessions
ADD COLUMN IF NOT EXISTS chapter int,
ADD COLUMN IF NOT EXISTS minutes_listened int;
