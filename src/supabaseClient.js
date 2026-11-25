import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

// Một client dùng chung cho thư viện công khai và trang admin (một phiên đăng nhập thống nhất).
export const supabase = createClient(SUPABASE_URL || '', SUPABASE_KEY || '', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
})
