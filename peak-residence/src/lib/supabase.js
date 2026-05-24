import { createClient } from '@supabase/supabase-js';

// 從環境變數讀取 Supabase 設定
// 部署時這些值會在 Vercel 後台填入
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('⚠️ Supabase 環境變數未設定。請檢查 .env.local 或 Vercel 環境變數。');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
