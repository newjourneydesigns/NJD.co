-- Fix the books_physical_pages_check constraint to allow hybrid tracking
-- The app is designed to use chapters as primary tracking for both book types
-- Pages are optional for physical books (used for pacing calculations only)

-- First, let's see what data we have that might be violating the constraint
-- (Run this to check your current data)
-- SELECT id, book_type, total_pages, total_chapters FROM public.books;

-- Step 1: Drop the existing constraint
ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_physical_pages_check;

-- Step 2: Fix existing data to comply with the new constraint
-- For physical books: ensure they have total_chapters
UPDATE public.books 
SET total_chapters = COALESCE(total_chapters, CASE 
  WHEN total_pages IS NOT NULL AND total_pages > 0 THEN GREATEST(1, total_pages / 20) -- Estimate chapters from pages
  ELSE 10 -- Default fallback
END)
WHERE book_type = 'physical' AND (total_chapters IS NULL OR total_chapters <= 0);

-- For audiobooks: ensure they have total_chapters and no total_pages
UPDATE public.books 
SET total_chapters = COALESCE(total_chapters, 10),
    total_pages = NULL
WHERE book_type = 'audiobook' AND (total_chapters IS NULL OR total_chapters <= 0 OR total_pages IS NOT NULL);

-- Step 3: Add the new constraint that matches the app's design:
-- - Physical books: must have total_chapters > 0, can optionally have total_pages
-- - Audiobooks: must have total_chapters > 0, total_pages must be null
ALTER TABLE public.books ADD CONSTRAINT books_physical_pages_check CHECK (
  (book_type = 'physical' and total_chapters is not null and total_chapters > 0) or 
  (book_type = 'audiobook' and total_chapters is not null and total_chapters > 0 and total_pages is null)
);
