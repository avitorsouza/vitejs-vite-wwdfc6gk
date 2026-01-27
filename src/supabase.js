import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://pdspxnracpvstlgewnds.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkc3B4bnJhY3B2c3RsZ2V3bmRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNTI1MjUsImV4cCI6MjA4NDgyODUyNX0.XNp4OHx6zhfWHYUGnkrZx-eBF-sNpaBjmhMSP4iIk6U";

export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);
