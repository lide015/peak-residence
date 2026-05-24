import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { supabase } from './lib/supabase';
import {
  LayoutDashboard, Building2, UserCircle2, Users, Target, Eye,
  Handshake, CheckSquare, Plus, Search, X, ChevronRight, ChevronLeft,
  MapPin, Phone, AlertTriangle, Clock, Sparkles, ArrowLeft,
  BarChart3, MessageCircle, CheckCircle2, Flame, Bed, Maximize2,
  Mail, MessageSquare, Lock, LogOut, Upload, Image as ImageIcon,
  Camera, Trash2, Settings, Palette, Building, Edit3, Archive, RotateCcw, Home, Square
} from 'lucide-react';

// ============================================================
// 常數
// ============================================================

const TW_CITIES = {
  '直轄市': ['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市'],
  '省轄市': ['基隆市', '新竹市', '嘉義市'],
  '北部縣': ['新竹縣', '苗栗縣', '宜蘭縣'],
  '中部縣': ['彰化縣', '南投縣', '雲林縣'],
  '南部縣': ['嘉義縣', '屏東縣'],
  '東部縣': ['花蓮縣', '台東縣'],
  '離島': ['澎湖縣', '金門縣', '連江縣'],
};

const PROPERTY_TYPES = ['電梯大樓', '公寓', '透天厝', '套房', '別墅', '商辦', '店面'];

// 認證改用 Supabase Auth（email + password），不再需要寫死的帳密

// ============================================================
// 演算法層（同 v3，省略註解）
// ============================================================

function calculateMatchScore(req, property) {
  if (property.sale_type === 'rent') return null;
  if (req.must_districts.length > 0 && !req.must_districts.includes(property.district)) return null;
  if (req.must_types.length > 0 && !req.must_types.includes(property.property_type)) return null;
  if (req.must_have.includes('需電梯') && !property.has_elevator) return null;
  if (req.reject_conditions.includes('凶宅') && property.features.includes('凶宅')) return null;
  if (property.total_price > req.budget_max * 1.1) return null;

  let score = 0;
  const reasons = [];
  const concerns = [];

  if (property.total_price <= req.budget_max) { score += 30; reasons.push(`總價 ${property.total_price} 萬，落在預算內`); }
  else if (property.total_price <= req.budget_max * 1.05) { score += 25; concerns.push(`總價 ${property.total_price} 萬，略超出預算 5% 內`); }
  else { score += 15; concerns.push(`總價 ${property.total_price} 萬，超出預算約 ${Math.round((property.total_price / req.budget_max - 1) * 100)}%`); }

  if (req.must_districts.includes(property.district)) { score += 25; reasons.push(`位於指定區域 ${property.district}`); }
  if (req.must_types.includes(property.property_type)) score += 10;
  if (property.layout_room >= req.min_rooms) { score += 10; reasons.push(`${property.layout_room} 房格局，符合需求`); }
  else concerns.push(`僅 ${property.layout_room} 房，少於期望的 ${req.min_rooms} 房`);
  if (property.main_area >= req.min_area) score += 10;
  else { score += 5; concerns.push(`室內 ${property.main_area} 坪，略小於期望`); }
  if (property.age <= req.max_age) score += 5;
  else if (property.age <= req.max_age + 10) { score += 2; concerns.push(`屋齡 ${property.age} 年，略高於期望`); }
  else concerns.push(`屋齡 ${property.age} 年，明顯高於期望`);
  if (!req.need_parking || (req.need_parking && property.has_parking)) { score += 5; if (property.has_parking) reasons.push('附車位'); }
  else concerns.push('無車位（買方需求）');
  const matchedNice = req.nice_to_have.filter(n => property.features.includes(n));
  if (matchedNice.length > 0) { score += Math.min(5, matchedNice.length * 2); reasons.push(`符合加分項：${matchedNice.join('、')}`); }
  const matchedReject = req.reject_conditions.filter(r => property.features.includes(r));
  if (matchedReject.length > 0) { score -= 20; concerns.push(`觸碰排斥條件：${matchedReject.join('、')}`); }

  let level;
  if (score >= 90) level = '強烈推薦';
  else if (score >= 80) level = '優先推薦';
  else if (score >= 70) level = '可推薦';
  else if (score >= 60) level = '備選';
  else level = '不推薦';
  return { score, level, reasons, concerns };
}

function calculateBuyerScore(buyer, showings, negotiations, notes) {
  let score = 0;
  if (buyer.budget_min && buyer.budget_max) score += 10;
  if (buyer.loan_status === 'approved' || buyer.loan_status === 'pre_approved') score += 10;
  if (buyer.urgency === 'high') score += 10;
  const buyerShowings = showings.filter(s => s.buyer_id === buyer.id && s.status === 'completed');
  if (buyerShowings.length >= 1) score += 15;
  if (buyerShowings.length >= 2) score += 5;
  if (negotiations.filter(n => n.buyer_id === buyer.id).length > 0) score += 25;
  if (buyer.family_visited) score += 10;
  const lastNote = notes.filter(n => n.related_type === 'buyer' && n.related_id === buyer.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  if (lastNote) {
    const daysSince = Math.floor((Date.now() - new Date(lastNote.created_at)) / 86400000);
    if (daysSince > 14) score -= 20;
  }
  let tier;
  if (score >= 80) tier = { label: '高機率成交', color: 'emerald' };
  else if (score >= 60) tier = { label: '積極追蹤', color: 'amber' };
  else if (score >= 40) tier = { label: '需要培養', color: 'sky' };
  else tier = { label: '低優先級', color: 'slate' };
  return { score: Math.max(0, Math.min(100, score)), tier };
}

function generateAutoTasks(data) {
  const tasks = [];
  const now = Date.now();
  const DAY = 86400000;

  data.buyers.forEach(buyer => {
    if (buyer.status === 'inactive' || buyer.status === 'lost') return;
    const lastNote = data.notes.filter(n => n.related_type === 'buyer' && n.related_id === buyer.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const lastTime = lastNote ? new Date(lastNote.created_at).getTime() : new Date(buyer.created_at).getTime();
    if ((now - lastTime) > 7 * DAY) {
      tasks.push({ id: `auto-buyer-${buyer.id}`, type: 'follow_up_buyer', priority: 'medium', title: `追蹤買方 ${buyer.name}（超過 7 天未聯繫）`, related_type: 'buyer', related_id: buyer.id, auto: true });
    }
  });
  data.properties.forEach(prop => {
    if (prop.status === 'closed' || prop.status === 'paused') return;
    const daysUntil = Math.ceil((new Date(prop.commission_end_date).getTime() - now) / DAY);
    if (daysUntil <= 14 && daysUntil > 0) {
      tasks.push({ id: `auto-prop-${prop.id}`, type: 'commission_expiring', priority: 'high', title: `委託 ${daysUntil} 天到期：${prop.title}`, related_type: 'property', related_id: prop.id, auto: true });
    }
  });
  data.showings.forEach(showing => {
    if (showing.status !== 'completed') return;
    const hoursSince = (now - new Date(showing.showing_time).getTime()) / 3600000;
    if (hoursSince >= 24 && hoursSince <= 72 && !showing.next_action) {
      const buyer = data.buyers.find(b => b.id === showing.buyer_id);
      tasks.push({ id: `auto-showing-${showing.id}`, type: 'showing_followup', priority: 'high', title: `帶看後追蹤：${buyer?.name || '客戶'}`, related_type: 'showing', related_id: showing.id, auto: true });
    }
  });
  data.buyers.forEach(buyer => {
    if (!buyer.requirement) return;
    data.properties.forEach(prop => {
      if (prop.status === 'closed' || prop.status === 'paused') return;
      const match = calculateMatchScore(buyer.requirement, prop);
      if (match && match.score >= 85) {
        const alreadyRecommended = data.showings.some(s => s.buyer_id === buyer.id && s.property_id === prop.id);
        if (!alreadyRecommended) {
          tasks.push({ id: `auto-match-${buyer.id}-${prop.id}`, type: 'high_match', priority: 'high', title: `高分媒合 ${match.score} 分：${buyer.name} ↔ ${prop.title}`, related_type: 'match', related_id: `${buyer.id}-${prop.id}`, auto: true });
        }
      }
    });
  });
  return tasks;
}

async function compressImage(file, maxWidth = 1200, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, maxWidth / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Logo 用 PNG（保留透明度），不能用 JPEG
async function compressLogo(file, maxWidth = 600) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, maxWidth / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // 用 PNG 而非 JPEG，保留透明背景
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ============================================================
// SVG Logo Icon（fallback，使用者沒上傳真實 logo 時用）
// 山峰 + 房子的抽象幾何，致敬而非複製
// ============================================================

function PeakLogoIcon({ className = 'w-8 h-8' }) {
  return (
    <svg className={className} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      {/* 大山峰：深色 */}
      <path d="M2 54 L18 26 L26 36 L36 14 L48 34 L62 54 Z" fill="#334155" />
      {/* 金色山頂 */}
      <path d="M30 24 L36 14 L42 24 L36 32 Z" fill="#c89e3c" />
      {/* 房子（深色屋頂） */}
      <path d="M18 54 L32 38 L46 54 L46 58 L18 58 Z" fill="#334155" />
      {/* 房子（金色內層） */}
      <path d="M21 53 L32 41 L43 53 L43 57 L21 57 Z" fill="#c89e3c" />
      {/* 窗戶 */}
      <rect x="29" y="48" width="6" height="6" fill="#fff" />
      <line x1="32" y1="48" x2="32" y2="54" stroke="#334155" strokeWidth="0.8" />
      <line x1="29" y1="51" x2="35" y2="51" stroke="#334155" strokeWidth="0.8" />
    </svg>
  );
}

// 品牌 Logo 組合：圖 + 文字（會根據 agency.logo 自動切換）
function BrandLogo({ agency, size = 'md', dark = false, showText = true }) {
  const sizes = {
    sm: { logo: 'w-7 h-7', text: 'text-sm', gap: 'gap-2' },
    md: { logo: 'w-9 h-9', text: 'text-base', gap: 'gap-3' },
    lg: { logo: 'w-12 h-12', text: 'text-lg', gap: 'gap-3' },
  };
  const s = sizes[size];

  return (
    <div className={`flex items-center ${s.gap}`}>
      <div className={`${s.logo} flex-shrink-0 flex items-center justify-center`}>
        {agency.logo ? (
          <img src={agency.logo} alt={agency.name} className="w-full h-full object-contain" />
        ) : (
          <PeakLogoIcon className="w-full h-full" />
        )}
      </div>
      {showText && (
        <div className="min-w-0">
          <h1 className={`font-semibold tracking-wide ${dark ? 'text-white' : 'text-slate-900'} ${s.text}`} style={{ fontFamily: '"Noto Serif TC", "Cormorant Garamond", serif', letterSpacing: '0.02em' }}>
            {agency.name}
          </h1>
          {agency.tagline && (
            <p className={`text-xs ${dark ? 'text-slate-400' : 'text-slate-500'} truncate`}>{agency.tagline}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 示範資料
// ============================================================

const SEED_DATA = {
  agency: {
    name: 'PEAK RESIDENCE',
    agent_name: '張守諒',
    agent_phone: '0912-345-678',
    agent_line: 'zhang_sl',
    agent_email: 'zhang@peakresidence.tw',
    tagline: '',
    logo: null,  // 沒上傳時 fallback 到 PeakLogoIcon
  },
  owners: [
    { id: 'o1', name: '王國華', phone: '0912-345-678', line_id: 'wkh1980', motivation: '換屋', urgency: 'medium', personality_tag: '好溝通', decision_power: '夫妻共同', note: '小孩要上小學，希望年底前處理掉' },
    { id: 'o2', name: '林淑芬', phone: '0922-111-222', line_id: 'lin_sf', motivation: '投資出場', urgency: 'low', personality_tag: '價格硬', decision_power: '本人', note: '不急著賣，價格沒到位不考慮' },
    { id: 'o3', name: '陳大明', phone: '0933-555-666', line_id: '', motivation: '繼承處分', urgency: 'high', personality_tag: '保守', decision_power: '家族共同', note: '兄弟姊妹三人共同決定' },
    { id: 'o4', name: '吳麗華', phone: '0966-888-999', line_id: 'wuwu_lh', motivation: '出租收益', urgency: 'low', personality_tag: '理性', decision_power: '本人', note: '名下兩間都委託出租' },
  ],
  properties: [
    { id: 'p1', owner_id: 'o1', sale_type: 'sale', title: '文山興隆 電梯三房', cover_theme: 'emerald', images: [], description: '近捷運萬芳醫院站步行 8 分鐘，興隆市場、學區皆在 5 分鐘內。社區管理乾淨、住戶單純，採光面南，全天日照充足。', property_type: '電梯大樓', city: '台北市', district: '文山區', address: '興隆路二段', total_price: 1280, min_price: 1220, market_price: 1250, main_area: 28, layout_room: 3, layout_living: 2, layout_bathroom: 2, floor: 7, total_floor: 12, age: 18, has_parking: true, has_elevator: true, features: ['近捷運', '採光佳', '近學區', '格局方正'], status: 'active', commission_end_date: '2026-07-15', exclusive: true },
    { id: 'p2', owner_id: 'o1', sale_type: 'sale', title: '板橋江翠 低總價套房', cover_theme: 'sky', images: [], description: '板橋江子翠站附近，近文化路商圈，生活機能完整。屋況單純可立即入住，適合首購或投資出租。', property_type: '電梯大樓', city: '新北市', district: '板橋區', address: '文化路一段', total_price: 580, min_price: 540, market_price: 560, main_area: 9, layout_room: 1, layout_living: 1, layout_bathroom: 1, floor: 5, total_floor: 14, age: 12, has_parking: false, has_elevator: true, features: ['近捷運', '可寵物', '低總價'], status: 'active', commission_end_date: '2026-06-10', exclusive: false },
    { id: 'p3', owner_id: 'o2', sale_type: 'sale', title: '信義精品 兩房景觀戶', cover_theme: 'amber', images: [], description: '信義計畫區精品社區，18 樓視野遼闊。屋齡僅 8 年，飯店式管理，附 24 小時健身房與接待大廳。', property_type: '電梯大樓', city: '台北市', district: '信義區', address: '松仁路', total_price: 2280, min_price: 2180, market_price: 2200, main_area: 32, layout_room: 2, layout_living: 2, layout_bathroom: 2, floor: 18, total_floor: 22, age: 8, has_parking: true, has_elevator: true, features: ['採光佳', '高樓層', '近捷運', '邊間', '景觀戶'], status: 'negotiating', commission_end_date: '2026-08-20', exclusive: true },
    { id: 'p4', owner_id: 'o3', sale_type: 'sale', title: '中和南勢角 老公寓', cover_theme: 'stone', images: [], description: '南勢角捷運站走路 10 分鐘，鄰中和市場、興南夜市，生活機能極佳。', property_type: '公寓', city: '新北市', district: '中和區', address: '中和路', total_price: 850, min_price: 800, market_price: 820, main_area: 22, layout_room: 3, layout_living: 1, layout_bathroom: 1, floor: 4, total_floor: 4, age: 38, has_parking: false, has_elevator: false, features: ['近市場', '生活機能成熟'], status: 'active', commission_end_date: '2026-06-05', exclusive: false },
    { id: 'p5', owner_id: 'o3', sale_type: 'sale', title: '新店安坑 透天厝', cover_theme: 'rose', images: [], description: '安坑一路靜巷透天，前後院、地下車庫，適合三代同堂或在家工作族。', property_type: '透天厝', city: '新北市', district: '新店區', address: '安坑一路', total_price: 2580, min_price: 2480, market_price: 2500, main_area: 62, layout_room: 5, layout_living: 2, layout_bathroom: 3, floor: 1, total_floor: 4, age: 22, has_parking: true, has_elevator: false, features: ['前後院', '車庫', '安靜'], status: 'active', commission_end_date: '2026-09-30', exclusive: true },
    { id: 'p6', owner_id: 'o2', sale_type: 'sale', title: '大安師大 學區小套房', cover_theme: 'violet', images: [], description: '師大商圈內，台電大樓站步行 6 分鐘。文教氣息濃，學區佳，租金穩定。', property_type: '電梯大樓', city: '台北市', district: '大安區', address: '師大路', total_price: 980, min_price: 940, market_price: 960, main_area: 11, layout_room: 1, layout_living: 1, layout_bathroom: 1, floor: 6, total_floor: 12, age: 15, has_parking: false, has_elevator: true, features: ['近捷運', '近學區', '可寵物', '低總價'], status: 'active', commission_end_date: '2026-07-01', exclusive: false },
    { id: 'r1', owner_id: 'o4', sale_type: 'rent', title: '大安溫州 雅致兩房', cover_theme: 'teal', images: [], description: '溫州街靜巷內，鄰近台大、師大商圈。屋況新整理，附全套家具家電，可立即入住。', property_type: '電梯大樓', city: '台北市', district: '大安區', address: '溫州街', monthly_rent: 45000, deposit_months: 2, main_area: 24, layout_room: 2, layout_living: 1, layout_bathroom: 1, floor: 5, total_floor: 7, age: 16, has_parking: false, has_elevator: true, features: ['近捷運', '近學區', '附家具', '附家電', '採光佳'], status: 'active', commission_end_date: '2026-12-31', exclusive: false },
    { id: 'r2', owner_id: 'o4', sale_type: 'rent', title: '信義永春 電梯三房', cover_theme: 'sky', images: [], description: '永春捷運站步行 5 分鐘，松山家商旁。三房格局完整，附車位，適合小家庭或合租。', property_type: '電梯大樓', city: '台北市', district: '信義區', address: '永春街', monthly_rent: 58000, deposit_months: 2, main_area: 32, layout_room: 3, layout_living: 2, layout_bathroom: 2, floor: 9, total_floor: 14, age: 13, has_parking: true, has_elevator: true, features: ['近捷運', '附車位', '附家具'], status: 'active', commission_end_date: '2026-12-31', exclusive: false },
    { id: 'r3', owner_id: 'o1', sale_type: 'rent', title: '板橋府中 文青套房', cover_theme: 'amber', images: [], description: '府中捷運站步行 3 分鐘，鄰林家花園、府中商圈。屋主精心設計，木質調與綠植。', property_type: '電梯大樓', city: '新北市', district: '板橋區', address: '府中路', monthly_rent: 22000, deposit_months: 2, main_area: 10, layout_room: 1, layout_living: 1, layout_bathroom: 1, floor: 8, total_floor: 12, age: 10, has_parking: false, has_elevator: true, features: ['近捷運', '附家具', '附家電', '可寵物'], status: 'active', commission_end_date: '2026-12-31', exclusive: false },
    { id: 'r4', owner_id: 'o3', sale_type: 'rent', title: '中和景平 平價公寓', cover_theme: 'emerald', images: [], description: '景平路上公寓二樓，鄰近南勢角商圈，生活便利。空屋出租，租金實惠。', property_type: '公寓', city: '新北市', district: '中和區', address: '景平路', monthly_rent: 18000, deposit_months: 2, main_area: 20, layout_room: 2, layout_living: 1, layout_bathroom: 1, floor: 2, total_floor: 4, age: 32, has_parking: false, has_elevator: false, features: ['近市場', '低租金'], status: 'active', commission_end_date: '2026-12-31', exclusive: false },
  ],
  buyers: [
    { id: 'b1', name: '張先生', phone: '0911-222-333', line_id: 'mr_chang', buying_purpose: '自住', urgency: 'high', loan_status: 'pre_approved', family_visited: false, status: 'active', created_at: '2026-05-10', requirement: { must_districts: ['文山區', '新店區'], must_types: ['電梯大樓'], budget_min: 1000, budget_max: 1300, min_rooms: 2, min_area: 20, max_age: 25, need_parking: false, must_have: ['需電梯'], nice_to_have: ['近捷運', '採光佳', '近學區'], reject_conditions: ['凶宅', '頂樓加蓋'] } },
    { id: 'b2', name: '李小姐', phone: '0988-444-555', line_id: 'lily_invest', buying_purpose: '投資', urgency: 'medium', loan_status: 'approved', family_visited: false, status: 'active', created_at: '2026-05-15', requirement: { must_districts: ['大安區', '信義區', '中正區'], must_types: ['電梯大樓'], budget_min: 500, budget_max: 1000, min_rooms: 1, min_area: 8, max_age: 30, need_parking: false, must_have: ['需電梯'], nice_to_have: ['近捷運', '可寵物', '低總價'], reject_conditions: ['凶宅'] } },
    { id: 'b3', name: '黃醫師', phone: '0966-777-888', line_id: 'dr_huang', buying_purpose: '換屋', urgency: 'medium', loan_status: 'approved', family_visited: true, status: 'active', created_at: '2026-04-20', requirement: { must_districts: ['信義區', '大安區'], must_types: ['電梯大樓'], budget_min: 1800, budget_max: 2400, min_rooms: 2, min_area: 28, max_age: 15, need_parking: true, must_have: ['需電梯'], nice_to_have: ['採光佳', '高樓層', '景觀戶'], reject_conditions: ['凶宅', '頂樓加蓋'] } },
    { id: 'b4', name: '周太太', phone: '0955-666-777', line_id: '', buying_purpose: '自住', urgency: 'low', loan_status: 'unknown', family_visited: false, status: 'active', created_at: '2026-03-05', requirement: { must_districts: ['新店區', '中和區', '永和區'], must_types: ['公寓', '電梯大樓', '透天厝'], budget_min: 700, budget_max: 1000, min_rooms: 3, min_area: 22, max_age: 40, need_parking: false, must_have: [], nice_to_have: ['近市場', '生活機能成熟'], reject_conditions: ['凶宅'] } },
  ],
  showings: [
    { id: 's1', buyer_id: 'b1', property_id: 'p1', showing_time: '2026-05-20T14:00', status: 'completed', buyer_reaction: 'interested', like_points: '採光好、格局喜歡', dislike_points: '主臥比想像中小', next_action: '考慮二看', note: '帶老婆來看過' },
    { id: 's2', buyer_id: 'b3', property_id: 'p3', showing_time: '2026-05-22T10:30', status: 'completed', buyer_reaction: 'very_interested', like_points: '景觀絕佳、高樓層', dislike_points: '預算稍微緊繃', next_action: '進入議價', note: '當場詢問可議空間' },
    { id: 's3', buyer_id: 'b4', property_id: 'p4', showing_time: '2026-05-26T16:00', status: 'scheduled', buyer_reaction: null, like_points: '', dislike_points: '', next_action: '', note: '' },
  ],
  negotiations: [{ id: 'n1', property_id: 'p3', buyer_id: 'b3', owner_price: 2280, buyer_offer: 2100, counter_offer: 2200, status: 'in_progress', updated_at: '2026-05-23' }],
  tasks: [
    { id: 't1', title: '聯絡王國華確認週六帶看時間', priority: 'high', due_date: '2026-05-25', note: '', completed: false, created_at: '2026-05-23T10:00:00' },
    { id: 't2', title: '準備信義精品物件議價策略簡報', priority: 'medium', due_date: '2026-05-26', note: '參考類似成交案', completed: false, created_at: '2026-05-22T14:00:00' },
  ],
  notes: [
    { id: 'note1', related_type: 'buyer', related_id: 'b1', contact_method: 'phone', content: '電話確認帶看時間', created_at: '2026-05-19' },
    { id: 'note2', related_type: 'buyer', related_id: 'b3', contact_method: 'line', content: '討論議價策略', created_at: '2026-05-23' },
    { id: 'note3', related_type: 'buyer', related_id: 'b4', contact_method: 'phone', content: '預約週日下午看屋', created_at: '2026-05-20' },
  ],
  inquiries: []
};

// ============================================================
// 共用元件
// ============================================================

function StatusBadge({ status, type, saleType }) {
  const styles = {
    property: { active: 'bg-emerald-50 text-emerald-700 border-emerald-200', negotiating: 'bg-amber-50 text-amber-700 border-amber-200', closed: 'bg-slate-100 text-slate-600 border-slate-200', paused: 'bg-slate-100 text-slate-500 border-slate-200' },
    urgency: { high: 'bg-rose-50 text-rose-700 border-rose-200', medium: 'bg-amber-50 text-amber-700 border-amber-200', low: 'bg-slate-100 text-slate-600 border-slate-200' },
    priority: { high: 'bg-rose-50 text-rose-700 border-rose-200', medium: 'bg-amber-50 text-amber-700 border-amber-200', low: 'bg-slate-100 text-slate-600 border-slate-200' }
  };
  const labels = {
    property: {
      active: saleType === 'rent' ? '招租中' : '銷售中',
      negotiating: '議價中',
      closed: saleType === 'rent' ? '已出租' : '已成交',
      paused: '已下架'
    },
    urgency: { high: '高急迫', medium: '中急迫', low: '低急迫' },
    priority: { high: '高優先', medium: '中優先', low: '低優先' }
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${styles[type]?.[status] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>{labels[type]?.[status] || status}</span>;
}

function PropertyCover({ property, size = 'md', showBadge = true }) {
  const themes = {
    emerald: 'from-emerald-200 via-emerald-100 to-teal-50',
    sky: 'from-sky-200 via-sky-100 to-blue-50',
    amber: 'from-amber-200 via-amber-100 to-orange-50',
    rose: 'from-rose-200 via-rose-100 to-pink-50',
    violet: 'from-violet-200 via-violet-100 to-purple-50',
    stone: 'from-stone-200 via-stone-100 to-stone-50',
    teal: 'from-teal-200 via-teal-100 to-cyan-50',
  };
  const heights = { sm: 'h-24', md: 'h-48', lg: 'h-80' };
  const hasImage = property.images && property.images.length > 0;

  return (
    <div className={`relative ${heights[size]} overflow-hidden ${!hasImage ? `bg-gradient-to-br ${themes[property.cover_theme] || themes.stone}` : 'bg-stone-100'}`}>
      {hasImage ? (
        <img src={property.images[0]} alt={property.title} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Building className="w-16 h-16 text-white/60" strokeWidth={1.2} />
        </div>
      )}
      {showBadge && (
        <>
          {property.sale_type === 'rent' && <span className="absolute top-3 left-3 px-2 py-1 bg-teal-600 text-white text-xs font-medium rounded shadow-sm">出租</span>}
          {property.sale_type === 'sale' && <span className="absolute top-3 left-3 px-2 py-1 bg-rose-600 text-white text-xs font-medium rounded shadow-sm">出售</span>}
        </>
      )}
    </div>
  );
}

function ImageGallery({ images, property }) {
  const [activeIdx, setActiveIdx] = useState(0);
  if (!images || images.length === 0) return <PropertyCover property={property} size="lg" showBadge={true} />;

  return (
    <div>
      <div className="relative h-80 md:h-[28rem] bg-stone-900 rounded-2xl overflow-hidden mb-3">
        <img src={images[activeIdx]} alt={`${property.title} ${activeIdx + 1}`} className="w-full h-full object-contain" />
        {property.sale_type === 'rent' && <span className="absolute top-3 left-3 px-2 py-1 bg-teal-600 text-white text-xs font-medium rounded">出租</span>}
        {property.sale_type === 'sale' && <span className="absolute top-3 left-3 px-2 py-1 bg-rose-600 text-white text-xs font-medium rounded">出售</span>}
        {images.length > 1 && (
          <>
            <button onClick={() => setActiveIdx((activeIdx - 1 + images.length) % images.length)} className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/80 hover:bg-white rounded-full flex items-center justify-center backdrop-blur"><ChevronLeft className="w-5 h-5" /></button>
            <button onClick={() => setActiveIdx((activeIdx + 1) % images.length)} className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/80 hover:bg-white rounded-full flex items-center justify-center backdrop-blur"><ChevronRight className="w-5 h-5" /></button>
            <span className="absolute bottom-3 right-3 px-2 py-1 bg-black/60 text-white text-xs rounded">{activeIdx + 1} / {images.length}</span>
          </>
        )}
      </div>
      {images.length > 1 && (
        <div className="grid grid-cols-6 gap-2">
          {images.map((src, i) => (
            <button key={i} onClick={() => setActiveIdx(i)} className={`aspect-square rounded-lg overflow-hidden ring-2 ${i === activeIdx ? 'ring-stone-900' : 'ring-transparent opacity-70 hover:opacity-100'}`}>
              <img src={src} alt={`縮圖 ${i + 1}`} className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ImageUpload({ images, onChange, max = 6 }) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const handleFiles = async (files) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const remainingSlots = max - images.length;
    const toUpload = Array.from(files).slice(0, remainingSlots);
    const newImages = [];
    for (const file of toUpload) {
      try {
        if (!file.type.startsWith('image/')) continue;
        newImages.push(await compressImage(file));
      } catch (e) { console.error(e); }
    }
    onChange([...images, ...newImages]);
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (idx) => onChange(images.filter((_, i) => i !== idx));
  const setCover = (idx) => {
    const newImages = [...images];
    const [cover] = newImages.splice(idx, 1);
    newImages.unshift(cover);
    onChange(newImages);
  };

  return (
    <div>
      <div className="grid grid-cols-3 gap-2 mb-2">
        {images.map((src, i) => (
          <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-slate-200 group">
            <img src={src} alt={`照片 ${i + 1}`} className="w-full h-full object-cover" />
            {i === 0 && <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-amber-500 text-white text-xs rounded font-medium">封面</span>}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100">
              {i !== 0 && <button onClick={() => setCover(i)} className="px-2 py-1 bg-white text-slate-900 text-xs rounded font-medium">設封面</button>}
              <button onClick={() => removeImage(i)} className="p-1.5 bg-rose-600 text-white rounded"><Trash2 className="w-3 h-3" /></button>
            </div>
          </div>
        ))}
        {images.length < max && (
          <label className={`aspect-square border-2 border-dashed rounded-lg flex flex-col items-center justify-center cursor-pointer ${uploading ? 'border-amber-400 bg-amber-50' : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50'}`}>
            <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={(e) => handleFiles(e.target.files)} className="hidden" disabled={uploading} />
            {uploading ? <><Upload className="w-6 h-6 text-amber-600 animate-pulse mb-1" /><span className="text-xs text-amber-700">壓縮中</span></> : <><Camera className="w-6 h-6 text-slate-400 mb-1" /><span className="text-xs text-slate-500">新增照片</span></>}
          </label>
        )}
      </div>
      <p className="text-xs text-slate-500">最多 {max} 張，第一張為封面 · 已選 {images.length} / {max}</p>
    </div>
  );
}

// ============================================================
// 共用：自製確認對話框（替代 window.confirm，後者在 iframe 環境被禁用）
// ============================================================

function ConfirmDialog({ config, onClose }) {
  if (!config) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-[70] p-4">
      <style>{`
        @keyframes confirmFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes confirmScaleIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        .confirm-overlay { animation: confirmFadeIn 0.15s ease-out; }
        .confirm-box { animation: confirmScaleIn 0.18s ease-out; }
      `}</style>
      <div className="bg-white rounded-lg max-w-sm w-full shadow-2xl confirm-box">
        <div className="p-6">
          <div className="flex items-start gap-3">
            {config.danger && (
              <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-rose-600" />
              </div>
            )}
            <div className="flex-1 pt-1">
              <h3 className="font-semibold text-slate-900">{config.title}</h3>
              {config.message && (
                <div className="text-sm text-slate-600 whitespace-pre-line mt-2 leading-relaxed">
                  {config.message}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50/50 rounded-b-lg">
          <button onClick={() => { onClose(); config.onCancel?.(); }} className="px-4 py-2 text-sm text-slate-700 hover:bg-slate-200 rounded-lg font-medium">
            {config.cancelText || '取消'}
          </button>
          <button
            onClick={() => { onClose(); config.onConfirm?.(); }}
            className={`px-4 py-2 text-sm text-white rounded-lg font-medium shadow-sm ${
              config.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-slate-900 hover:bg-slate-800'
            }`}
            autoFocus
          >
            {config.confirmText || '確定'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 登入頁
// ============================================================

function LoginPage({ onBack, agency }) {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    const cleanEmail = email.trim().toLowerCase();
    const cleanPwd = password.trim();

    if (!cleanEmail || !cleanPwd) {
      setError('請輸入 Email 與密碼');
      setLoading(false);
      return;
    }
    if (cleanPwd.length < 6) {
      setError('密碼至少 6 個字元');
      setLoading(false);
      return;
    }

    try {
      if (mode === 'signup') {
        const { error: err } = await supabase.auth.signUp({
          email: cleanEmail,
          password: cleanPwd,
        });
        if (err) throw err;
        setMessage('註冊成功！請去 ' + cleanEmail + ' 信箱點驗證連結，然後回來登入。');
        setMode('signin');
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password: cleanPwd,
        });
        if (err) throw err;
        // 登入成功會由主應用的 auth state 監聽自動切換到後台
      }
    } catch (err) {
      // 把 Supabase 的英文錯誤翻成中文
      const msg = err.message || '發生錯誤';
      if (msg.includes('Invalid login credentials')) setError('Email 或密碼錯誤');
      else if (msg.includes('Email not confirmed')) setError('請先去信箱點驗證連結');
      else if (msg.includes('User already registered')) setError('這個 Email 已經註冊過了');
      else if (msg.includes('rate limit')) setError('嘗試太頻繁，請稍後再試');
      else setError(msg);
      setShake(true);
      setTimeout(() => setShake(false), 500);
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4" style={{ fontFamily: '-apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;600&display=swap');
        @keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
        .shake { animation: shake 0.4s ease-in-out; }
      `}</style>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(200,158,60,0.08),transparent_60%)]" />

      <div className="relative w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 items-center justify-center mb-4 border border-slate-700 shadow-xl">
            {agency.logo ? (
              <img src={agency.logo} alt={agency.name} className="w-10 h-10 object-contain" />
            ) : (
              <PeakLogoIcon className="w-10 h-10" />
            )}
          </div>
          <h1 className="text-xl font-semibold text-white mb-1 tracking-wider" style={{ fontFamily: '"Noto Serif TC", serif', letterSpacing: '0.05em' }}>
            {agency.name}
          </h1>
          <p className="text-xs text-slate-500">{mode === 'signup' ? '建立帳號' : '後台登入'}</p>
        </div>

        <form onSubmit={submit} className={`bg-slate-800/50 backdrop-blur border border-slate-700 rounded-2xl p-6 shadow-2xl ${shake ? 'shake' : ''}`}>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoFocus autoComplete="email" className="w-full px-3 py-2.5 bg-slate-900/50 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-amber-600/50" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">密碼 <span className="text-slate-600">（至少 6 字元）</span></label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} className="w-full px-3 py-2.5 bg-slate-900/50 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-amber-600/50" />
            </div>

            {error && (
              <div className="flex items-start gap-2 text-xs text-rose-400 bg-rose-950/30 border border-rose-900/50 rounded-lg p-2.5">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {message && (
              <div className="flex items-start gap-2 text-xs text-emerald-400 bg-emerald-950/30 border border-emerald-900/50 rounded-lg p-2.5">
                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{message}</span>
              </div>
            )}

            <button type="submit" disabled={loading} onClick={submit} className="w-full bg-amber-600 hover:bg-amber-500 active:bg-amber-700 disabled:bg-amber-800 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg text-sm shadow-lg shadow-amber-900/30 transition-colors">
              {loading ? '處理中...' : (mode === 'signup' ? '註冊' : '登入')}
            </button>

            <button type="button" onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(''); setMessage(''); }} className="w-full text-xs text-slate-400 hover:text-slate-200 py-1">
              {mode === 'signup' ? '已經有帳號了？回到登入' : '第一次來？建立新帳號'}
            </button>
          </div>
        </form>

        <div className="text-center mt-4">
          <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-300">← 返回前台</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 前台
// ============================================================

// 篩選列：標籤 + 內容（標籤固定寬度，視覺對齊）
function FilterRow({ label, children }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs text-stone-500 w-12 flex-shrink-0 pt-2 font-medium">{label}</span>
      <div className="flex-1 flex flex-wrap gap-2 items-center">
        {children}
      </div>
    </div>
  );
}

// 篩選 chip：可點擊的圓角標籤
function FilterChip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-1.5 rounded-full text-sm transition-all whitespace-nowrap ${
        active
          ? 'bg-stone-900 text-white shadow-sm'
          : 'bg-white border border-stone-200 text-stone-700 hover:border-stone-400 hover:text-stone-900'
      }`}
    >
      {children}
    </button>
  );
}

function Storefront({ data, setData }) {
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState({ saleType: 'sale', city: 'all', type: 'all', priceRange: 'all', keyword: '' });
  const [showInquiry, setShowInquiry] = useState(false);

  const publicProperties = data.properties.filter(p => p.status === 'active');

  const filtered = publicProperties.filter(p => {
    if (p.sale_type !== filter.saleType) return false;
    if (filter.city !== 'all' && p.city !== filter.city) return false;
    if (filter.type !== 'all' && p.property_type !== filter.type) return false;
    if (filter.keyword && !p.title.includes(filter.keyword) && !p.district.includes(filter.keyword)) return false;
    if (filter.priceRange !== 'all') {
      const price = p.sale_type === 'rent' ? p.monthly_rent : p.total_price * 10000;
      const ranges = { rent_low: [0, 25000], rent_mid: [25000, 50000], rent_high: [50000, Infinity], sale_low: [0, 10000000], sale_mid: [10000000, 20000000], sale_high: [20000000, Infinity] };
      const r = ranges[filter.priceRange];
      if (r && (price < r[0] || price >= r[1])) return false;
    }
    return true;
  });

  // 全店出現過的所有縣市與類型（不分租售）
  const allCities = Array.from(new Set(publicProperties.map(p => p.city)));
  const allTypes = Array.from(new Set(publicProperties.map(p => p.property_type)));

  // 當前 tab（租/售）下，各縣市與各類型的物件數
  const cityCounts = {};
  const typeCounts = {};
  publicProperties.forEach(p => {
    if (p.sale_type === filter.saleType) {
      cityCounts[p.city] = (cityCounts[p.city] || 0) + 1;
      typeCounts[p.property_type] = (typeCounts[p.property_type] || 0) + 1;
    }
  });

  // 類型只列當前 tab 下實際有的（chip 介面不適合放灰選項）
  const types = allTypes.filter(t => typeCounts[t] > 0);
  const saleCount = publicProperties.filter(p => p.sale_type === 'sale').length;
  const rentCount = publicProperties.filter(p => p.sale_type === 'rent').length;

  if (selected) {
    return <PropertyPublicDetail property={selected} agency={data.agency} onBack={() => setSelected(null)} onInquire={() => setShowInquiry(selected)} />;
  }

  return (
    <div className="min-h-screen bg-stone-50" style={{ fontFamily: '-apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif' }}>
      <header className="bg-white/80 backdrop-blur border-b border-stone-200 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <BrandLogo agency={data.agency} size="md" />
          <a href={`tel:${data.agency.agent_phone}`} className="hidden sm:flex items-center gap-1.5 text-sm text-stone-700 hover:text-stone-900">
            <Phone className="w-4 h-4" />{data.agency.agent_phone}
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-12 pb-6">
        <h2 className="text-3xl md:text-4xl font-semibold text-stone-900 mb-2 tracking-tight" style={{ fontFamily: '"Noto Serif TC", serif' }}>
          想找個家？從這裡開始。
        </h2>
        <p className="text-stone-600 text-sm">
          精選 {publicProperties.length} 件物件，{data.agency.agent_name} 親自為你服務
        </p>
      </section>

      {/* 大型 Tab 切換：售 / 租 */}
      <section className="max-w-6xl mx-auto px-6">
        <div className="border-b border-stone-200 flex gap-1">
          <button
            onClick={() => setFilter({ ...filter, saleType: 'sale', priceRange: 'all', type: 'all', city: 'all' })}
            className={`relative px-6 py-3 text-base transition-colors flex items-center gap-2 ${
              filter.saleType === 'sale'
                ? 'text-stone-900 font-semibold'
                : 'text-stone-500 hover:text-stone-700'
            }`}
            style={{ fontFamily: '"Noto Serif TC", serif' }}
          >
            <Home className="w-4 h-4" />
            出售
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${filter.saleType === 'sale' ? 'bg-rose-100 text-rose-700' : 'bg-stone-100 text-stone-500'}`}>
              {saleCount}
            </span>
            {filter.saleType === 'sale' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-stone-900" />
            )}
          </button>
          <button
            onClick={() => setFilter({ ...filter, saleType: 'rent', priceRange: 'all', type: 'all', city: 'all' })}
            className={`relative px-6 py-3 text-base transition-colors flex items-center gap-2 ${
              filter.saleType === 'rent'
                ? 'text-stone-900 font-semibold'
                : 'text-stone-500 hover:text-stone-700'
            }`}
            style={{ fontFamily: '"Noto Serif TC", serif' }}
          >
            <Building className="w-4 h-4" />
            出租
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${filter.saleType === 'rent' ? 'bg-teal-100 text-teal-700' : 'bg-stone-100 text-stone-500'}`}>
              {rentCount}
            </span>
            {filter.saleType === 'rent' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-stone-900" />
            )}
          </button>
        </div>
      </section>

      {/* 精緻篩選列 */}
      <section className="max-w-6xl mx-auto px-6 py-6">
        <div className="space-y-3">

          {/* 縣市（dropdown，列全店有的縣市，依當前 tab 顯示數量；無物件的灰掉） */}
          <FilterRow label="縣市">
            <select
              value={filter.city}
              onChange={e => setFilter({ ...filter, city: e.target.value })}
              className="px-3 py-1.5 border border-stone-200 rounded-full text-sm bg-white hover:border-stone-300 focus:outline-none focus:border-stone-400"
            >
              <option value="all">全部縣市（{filter.saleType === 'rent' ? rentCount : saleCount} 件）</option>
              {allCities.map(c => {
                const count = cityCounts[c] || 0;
                return (
                  <option key={c} value={c} disabled={count === 0}>
                    {c} {count > 0 ? `（${count} 件）` : '（目前無）'}
                  </option>
                );
              })}
            </select>
          </FilterRow>

          {/* 類型 chips */}
          <FilterRow label="類型">
            <FilterChip active={filter.type === 'all'} onClick={() => setFilter({ ...filter, type: 'all' })}>
              全部
            </FilterChip>
            {types.map(t => (
              <FilterChip key={t} active={filter.type === t} onClick={() => setFilter({ ...filter, type: t })}>
                {t} <span className="text-xs opacity-60 ml-0.5">{typeCounts[t]}</span>
              </FilterChip>
            ))}
          </FilterRow>

          {/* 價格 chips（依租/售動態） */}
          <FilterRow label={filter.saleType === 'rent' ? '月租' : '總價'}>
            <FilterChip active={filter.priceRange === 'all'} onClick={() => setFilter({ ...filter, priceRange: 'all' })}>不限</FilterChip>
            {filter.saleType === 'rent' ? (
              <>
                <FilterChip active={filter.priceRange === 'rent_low'} onClick={() => setFilter({ ...filter, priceRange: 'rent_low' })}>$25,000 以下</FilterChip>
                <FilterChip active={filter.priceRange === 'rent_mid'} onClick={() => setFilter({ ...filter, priceRange: 'rent_mid' })}>$25,000 - $50,000</FilterChip>
                <FilterChip active={filter.priceRange === 'rent_high'} onClick={() => setFilter({ ...filter, priceRange: 'rent_high' })}>$50,000 以上</FilterChip>
              </>
            ) : (
              <>
                <FilterChip active={filter.priceRange === 'sale_low'} onClick={() => setFilter({ ...filter, priceRange: 'sale_low' })}>1,000 萬以下</FilterChip>
                <FilterChip active={filter.priceRange === 'sale_mid'} onClick={() => setFilter({ ...filter, priceRange: 'sale_mid' })}>1,000 - 2,000 萬</FilterChip>
                <FilterChip active={filter.priceRange === 'sale_high'} onClick={() => setFilter({ ...filter, priceRange: 'sale_high' })}>2,000 萬以上</FilterChip>
              </>
            )}
          </FilterRow>

          {/* 關鍵字搜尋 */}
          <FilterRow label="關鍵字">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400" />
              <input
                value={filter.keyword}
                onChange={e => setFilter({ ...filter, keyword: e.target.value })}
                placeholder="區域、社區名⋯"
                className="w-full pl-8 pr-3 py-1.5 border border-stone-200 rounded-full text-sm bg-white hover:border-stone-300 focus:outline-none focus:border-stone-400"
              />
            </div>
          </FilterRow>

          {/* 已選條件提示 + 清除按鈕 */}
          {(filter.city !== 'all' || filter.type !== 'all' || filter.priceRange !== 'all' || filter.keyword) && (
            <div className="flex items-center gap-2 pt-2 border-t border-stone-100">
              <button
                onClick={() => setFilter({ ...filter, city: 'all', type: 'all', priceRange: 'all', keyword: '' })}
                className="text-xs text-stone-500 hover:text-stone-900 flex items-center gap-1"
              >
                <X className="w-3 h-3" /> 清除所有條件
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 pb-16">
        <div className="text-sm text-stone-500 mb-4">符合條件 {filtered.length} 件</div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map(p => (
            <article key={p.id} onClick={() => setSelected(p)} className="bg-white rounded-2xl overflow-hidden border border-stone-200 shadow-sm hover:shadow-md transition-all cursor-pointer group">
              <PropertyCover property={p} size="md" />
              <div className="p-5">
                <h3 className="font-semibold text-stone-900 mb-1 group-hover:text-stone-700" style={{ fontFamily: '"Noto Serif TC", serif' }}>{p.title}</h3>
                <div className="text-xs text-stone-500 mb-3 flex items-center gap-1"><MapPin className="w-3 h-3" />{p.city}{p.district}</div>
                <div className="mb-3">
                  {p.sale_type === 'sale' ? (
                    <div className="flex items-baseline gap-1"><span className="text-2xl font-semibold text-stone-900">{p.total_price}</span><span className="text-stone-500 text-sm">萬</span></div>
                  ) : (
                    <div className="flex items-baseline gap-1"><span className="text-2xl font-semibold text-teal-700">{p.monthly_rent.toLocaleString()}</span><span className="text-stone-500 text-sm">/ 月</span></div>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-stone-600 pb-3 border-b border-stone-100">
                  <span className="flex items-center gap-1"><Bed className="w-3 h-3" />{p.layout_room} 房</span>
                  <span className="flex items-center gap-1"><Maximize2 className="w-3 h-3" />{p.main_area} 坪</span>
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{p.age} 年</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-3">
                  {p.features.slice(0, 3).map(f => <span key={f} className="text-xs px-2 py-0.5 bg-stone-100 text-stone-600 rounded">{f}</span>)}
                </div>
              </div>
            </article>
          ))}
        </div>
        {filtered.length === 0 && <div className="text-center py-20 text-stone-400">沒有符合條件的物件</div>}
      </section>

      <Footer agency={data.agency} />
      {showInquiry && <InquiryModal property={showInquiry} agency={data.agency} setData={setData} onClose={() => setShowInquiry(false)} />}
    </div>
  );
}

function Footer({ agency }) {
  const [clickCount, setClickCount] = useState(0);
  const lastClickRef = useRef(0);

  // 連點門檻調整：從 5 次/1.5 秒 → 3 次/3 秒（更友善）
  const handleSecretClick = useCallback(() => {
    const now = Date.now();
    if (now - lastClickRef.current > 3000) setClickCount(1);
    else setClickCount(c => c + 1);
    lastClickRef.current = now;
  }, []);

  useEffect(() => {
    if (clickCount >= 3) {
      window.dispatchEvent(new CustomEvent('admin-secret-trigger'));
      setClickCount(0);
    }
  }, [clickCount]);

  return (
    <footer className="bg-stone-900 text-stone-300 py-10">
      <div className="max-w-6xl mx-auto px-6">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
          {/* 隱藏入口：logo + 店名連點 5 次 */}
          <div onClick={handleSecretClick} className="cursor-default select-none">
            <BrandLogo agency={agency} size="md" dark={true} />
          </div>
          <div className="text-sm space-y-1.5">
            <div className="flex items-center gap-2"><UserCircle2 className="w-3.5 h-3.5" />{agency.agent_name}</div>
            <div className="flex items-center gap-2"><Phone className="w-3.5 h-3.5" />{agency.agent_phone}</div>
            {agency.agent_line && <div className="flex items-center gap-2"><MessageSquare className="w-3.5 h-3.5" />Line: {agency.agent_line}</div>}
            {agency.agent_email && <div className="flex items-center gap-2"><Mail className="w-3.5 h-3.5" />{agency.agent_email}</div>}
          </div>
        </div>
      </div>
    </footer>
  );
}

function PropertyPublicDetail({ property, agency, onBack, onInquire }) {
  return (
    <div className="min-h-screen bg-stone-50" style={{ fontFamily: '-apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif' }}>
      <header className="bg-white/80 backdrop-blur border-b border-stone-200 sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <button onClick={onBack} className="text-sm text-stone-600 hover:text-stone-900 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> 回到列表</button>
          <BrandLogo agency={agency} size="sm" />
        </div>
      </header>

      <article className="max-w-4xl mx-auto px-6 py-8">
        <ImageGallery images={property.images} property={property} />

        <div className="mb-8 mt-6">
          <div className="flex items-start justify-between mb-2 gap-4 flex-wrap">
            <h2 className="text-2xl md:text-3xl font-semibold text-stone-900" style={{ fontFamily: '"Noto Serif TC", serif' }}>{property.title}</h2>
            {property.sale_type === 'sale' ? (
              <div className="text-right">
                <div className="flex items-baseline gap-1"><span className="text-3xl font-semibold text-stone-900">{property.total_price}</span><span className="text-stone-500">萬</span></div>
                <div className="text-xs text-stone-500">總價</div>
              </div>
            ) : (
              <div className="text-right">
                <div className="flex items-baseline gap-1"><span className="text-3xl font-semibold text-teal-700">{property.monthly_rent.toLocaleString()}</span><span className="text-stone-500">/ 月</span></div>
                <div className="text-xs text-stone-500">押金 {property.deposit_months} 個月</div>
              </div>
            )}
          </div>
          <p className="text-stone-600 flex items-center gap-1.5"><MapPin className="w-4 h-4" />{property.city}{property.district} · {property.address}</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {[
            { icon: Bed, label: '格局', value: `${property.layout_room}房${property.layout_living}廳${property.layout_bathroom}衛` },
            { icon: Maximize2, label: '坪數', value: `${property.main_area} 坪` },
            { icon: Building2, label: '樓層', value: `${property.floor}/${property.total_floor} 樓` },
            { icon: Clock, label: '屋齡', value: `${property.age} 年` },
          ].map((item, i) => (
            <div key={i} className="bg-white border border-stone-200 rounded-xl p-4">
              <item.icon className="w-4 h-4 text-stone-400 mb-2" />
              <div className="text-xs text-stone-500 mb-0.5">{item.label}</div>
              <div className="text-stone-900 font-medium">{item.value}</div>
            </div>
          ))}
        </div>

        <div className="bg-white border border-stone-200 rounded-2xl p-6 mb-6">
          <h3 className="font-semibold text-stone-900 mb-3" style={{ fontFamily: '"Noto Serif TC", serif' }}>物件介紹</h3>
          <p className="text-stone-700 leading-relaxed">{property.description}</p>
        </div>

        <div className="bg-white border border-stone-200 rounded-2xl p-6 mb-6">
          <h3 className="font-semibold text-stone-900 mb-3" style={{ fontFamily: '"Noto Serif TC", serif' }}>物件特色</h3>
          <div className="flex flex-wrap gap-2">
            {property.features.map(f => <span key={f} className="px-3 py-1 bg-stone-100 text-stone-700 text-sm rounded-full">{f}</span>)}
            {property.has_elevator && <span className="px-3 py-1 bg-sky-50 text-sky-700 text-sm rounded-full">電梯</span>}
            {property.has_parking && <span className="px-3 py-1 bg-sky-50 text-sky-700 text-sm rounded-full">車位</span>}
          </div>
        </div>

        <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white rounded-2xl p-6 mb-6 border border-amber-900/30">
          <h3 className="font-semibold mb-1 text-lg" style={{ fontFamily: '"Noto Serif TC", serif' }}>喜歡這間嗎？聯絡看屋</h3>
          <p className="text-stone-300 text-sm mb-4">由 {agency.agent_name} 親自為你服務</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <a href={`tel:${agency.agent_phone}`} className="flex-1 bg-amber-600 hover:bg-amber-500 text-white px-4 py-2.5 rounded-lg font-medium text-center transition-colors flex items-center justify-center gap-2">
              <Phone className="w-4 h-4" /> {agency.agent_phone}
            </a>
            <button onClick={onInquire} className="flex-1 bg-stone-700 text-white px-4 py-2.5 rounded-lg font-medium hover:bg-stone-600 transition-colors flex items-center justify-center gap-2 border border-stone-600">
              <MessageSquare className="w-4 h-4" /> 線上詢問
            </button>
          </div>
        </div>
      </article>
    </div>
  );
}

function InquiryModal({ property, agency, setData, onClose }) {
  const [form, setForm] = useState({ name: '', phone: '', message: `我對「${property.title}」有興趣，想了解更多。` });
  const [submitted, setSubmitted] = useState(false);

  const submit = () => {
    if (!form.name || !form.phone) { alert('請填寫姓名與電話'); return; }
    const inquiry = { id: `inq-${Date.now()}`, property_id: property.id, ...form, created_at: new Date().toISOString(), status: 'new' };
    setData(prev => ({ ...prev, inquiries: [...(prev.inquiries || []), inquiry] }));
    setSubmitted(true);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-md w-full overflow-hidden">
        <div className="p-6 border-b border-stone-100 flex items-center justify-between">
          <h2 className="font-semibold text-stone-900" style={{ fontFamily: '"Noto Serif TC", serif' }}>聯絡看屋</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-stone-400" /></button>
        </div>
        {submitted ? (
          <div className="p-8 text-center">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
            <h3 className="font-semibold text-stone-900 mb-1">已收到您的詢問</h3>
            <p className="text-sm text-stone-600 mb-4">{agency.agent_name} 會在 24 小時內聯絡您</p>
            <button onClick={onClose} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm">關閉</button>
          </div>
        ) : (
          <>
            <div className="p-6 space-y-4">
              <div className="bg-stone-50 rounded-lg p-3 text-sm">
                <div className="font-medium text-stone-900">{property.title}</div>
                <div className="text-xs text-stone-500 mt-1">{property.city}{property.district}</div>
              </div>
              <div><label className="text-xs text-stone-600 mb-1 block">您的姓名 *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" /></div>
              <div><label className="text-xs text-stone-600 mb-1 block">聯絡電話 *</label><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" /></div>
              <div><label className="text-xs text-stone-600 mb-1 block">想說的話</label><textarea value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} rows={3} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" /></div>
            </div>
            <div className="p-6 border-t border-stone-100 flex justify-end gap-2">
              <button onClick={onClose} className="px-4 py-2 text-sm text-stone-600 hover:bg-stone-100 rounded-lg">取消</button>
              <button onClick={submit} className="px-4 py-2 bg-stone-900 text-white text-sm rounded-lg hover:bg-stone-800">送出</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 品牌設定（新增的後台模組）
// ============================================================

function BrandSettingsModule({ data, setData }) {
  const [form, setForm] = useState(data.agency);
  const [logoUploading, setLogoUploading] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    setLogoUploading(true);
    try {
      const compressed = await compressLogo(file);
      setForm({ ...form, logo: compressed });
    } catch (e) {
      alert('上傳失敗：' + e.message);
    }
    setLogoUploading(false);
    e.target.value = '';
  };

  const removeLogo = () => setForm({ ...form, logo: null });

  const save = () => {
    setData(prev => ({ ...prev, agency: form }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const hasChanges = JSON.stringify(form) !== JSON.stringify(data.agency);

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>品牌設定</h1>
        <p className="text-sm text-slate-500">這些資訊會顯示在前台與所有客戶接觸點</p>
      </div>

      <div className="space-y-6">
        {/* Logo 區 */}
        <section className="bg-white border border-slate-200 rounded-lg p-6">
          <h2 className="font-medium text-slate-900 mb-1 flex items-center gap-2">
            <Palette className="w-4 h-4 text-slate-500" /> Logo
          </h2>
          <p className="text-xs text-slate-500 mb-4">建議使用透明背景 PNG · 自動壓縮至 600px · 不上傳則使用系統預設山峰圖示</p>

          <div className="flex items-center gap-6">
            <div className="w-24 h-24 bg-stone-50 border border-slate-200 rounded-xl flex items-center justify-center overflow-hidden">
              {form.logo ? (
                <img src={form.logo} alt="logo preview" className="w-full h-full object-contain p-2" />
              ) : (
                <PeakLogoIcon className="w-16 h-16" />
              )}
            </div>
            <div className="flex-1 space-y-2">
              <label className={`inline-flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg text-sm cursor-pointer hover:bg-slate-50 ${logoUploading ? 'opacity-50' : ''}`}>
                <Upload className="w-4 h-4" />
                {logoUploading ? '壓縮中...' : (form.logo ? '更換 Logo' : '上傳 Logo')}
                <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" disabled={logoUploading} />
              </label>
              {form.logo && (
                <button onClick={removeLogo} className="block text-xs text-rose-600 hover:text-rose-700">
                  移除自訂 Logo（恢復預設）
                </button>
              )}
            </div>
          </div>
        </section>

        {/* 品牌名稱與標語 */}
        <section className="bg-white border border-slate-200 rounded-lg p-6">
          <h2 className="font-medium text-slate-900 mb-4">品牌資訊</h2>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-slate-600 mb-1 block">品牌名稱 *</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              <p className="text-xs text-slate-400 mt-1">會顯示在前台 header、頁尾、後台側邊欄</p>
            </div>
            <div>
              <label className="text-xs text-slate-600 mb-1 block">標語（可留空）</label>
              <input value={form.tagline} onChange={e => setForm({ ...form, tagline: e.target.value })} placeholder="例：深耕大台北 12 年..." className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              <p className="text-xs text-slate-400 mt-1">會顯示在品牌名稱下方一行小字</p>
            </div>
          </div>
        </section>

        {/* 經紀人資訊 */}
        <section className="bg-white border border-slate-200 rounded-lg p-6">
          <h2 className="font-medium text-slate-900 mb-4">經紀人資訊</h2>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-slate-600 mb-1 block">經紀人姓名 *</label>
              <input value={form.agent_name} onChange={e => setForm({ ...form, agent_name: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-600 mb-1 block">電話 *</label>
                <input value={form.agent_phone} onChange={e => setForm({ ...form, agent_phone: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-600 mb-1 block">Line ID</label>
                <input value={form.agent_line} onChange={e => setForm({ ...form, agent_line: e.target.value })} placeholder="可留空" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-600 mb-1 block">Email</label>
              <input type="email" value={form.agent_email} onChange={e => setForm({ ...form, agent_email: e.target.value })} placeholder="可留空" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </div>
          </div>
        </section>

        {/* 預覽 */}
        <section className="bg-stone-50 border border-slate-200 rounded-lg p-6">
          <h2 className="font-medium text-slate-900 mb-3 text-sm">預覽（前台 Header）</h2>
          <div className="bg-white border border-stone-200 rounded-lg p-4 flex items-center justify-between">
            <BrandLogo agency={form} size="md" />
            <div className="flex items-center gap-1.5 text-sm text-stone-700">
              <Phone className="w-4 h-4" />{form.agent_phone}
            </div>
          </div>
        </section>

        {/* 儲存列 */}
        <div className="sticky bottom-0 bg-slate-50 -mx-8 px-8 py-4 border-t border-slate-200 flex items-center justify-between">
          <div className="text-sm">
            {saved ? (
              <span className="text-emerald-700 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" />已儲存，所有頁面已套用</span>
            ) : hasChanges ? (
              <span className="text-amber-700">有未儲存的變更</span>
            ) : (
              <span className="text-slate-500">所有設定已是最新</span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setForm(data.agency)} disabled={!hasChanges} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30">
              還原
            </button>
            <button onClick={save} disabled={!hasChanges} className="px-5 py-2 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-800 disabled:opacity-30">
              儲存變更
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 帳號安全（改帳密）
// ============================================================

function CredentialsModule({ user }) {
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const save = async () => {
    setMessage(null);
    if (newPwd.length < 6) {
      setMessage({ type: 'error', text: '新密碼至少需要 6 個字元' });
      return;
    }
    if (newPwd !== confirmPwd) {
      setMessage({ type: 'error', text: '兩次輸入的新密碼不一致' });
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPwd });
      if (error) throw error;
      setMessage({ type: 'success', text: '密碼已更新' });
      setNewPwd('');
      setConfirmPwd('');
    } catch (err) {
      setMessage({ type: 'error', text: err.message || '更新失敗' });
    }
    setLoading(false);
  };

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>帳號安全</h1>
        <p className="text-sm text-slate-500">修改你的後台登入密碼</p>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
        <h2 className="font-medium text-slate-900 mb-1 flex items-center gap-2">
          <UserCircle2 className="w-4 h-4 text-slate-500" /> 目前帳號
        </h2>
        <p className="text-sm text-slate-600 mb-4">{user?.email || '未登入'}</p>
        <p className="text-xs text-slate-400">Email 由 Supabase Auth 管理，目前無法在後台修改。如需更換 Email，請聯絡系統管理員。</p>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <h2 className="font-medium text-slate-900 mb-4 flex items-center gap-2">
          <Lock className="w-4 h-4 text-slate-500" /> 修改密碼
        </h2>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-slate-600 mb-1 block">新密碼 * <span className="text-slate-400">（至少 6 字元）</span></label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                value={newPwd}
                onChange={e => setNewPwd(e.target.value)}
                className="w-full px-3 py-2 pr-16 border border-slate-200 rounded-lg text-sm"
              />
              <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 hover:text-slate-700">
                {showNew ? '隱藏' : '顯示'}
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-600 mb-1 block">確認新密碼 *</label>
            <input
              type={showNew ? 'text' : 'password'}
              value={confirmPwd}
              onChange={e => setConfirmPwd(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          </div>

          {message && (
            <div className={`flex items-start gap-2 text-sm rounded-lg p-3 ${
              message.type === 'success'
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border border-rose-200 text-rose-800'
            }`}>
              {message.type === 'success' ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
              <span>{message.text}</span>
            </div>
          )}

          <button onClick={save} disabled={loading} className="w-full bg-slate-900 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-60">
            {loading ? '更新中...' : '更新密碼'}
          </button>
        </div>
      </div>
    </div>
  );
}



function KpiCard({ icon: Icon, label, value, sub, accent = 'slate' }) {
  const accents = { slate: 'text-slate-700', emerald: 'text-emerald-700', amber: 'text-amber-700', rose: 'text-rose-700', sky: 'text-sky-700' };
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-2"><span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span><Icon className={`w-4 h-4 ${accents[accent]}`} /></div>
      <div className={`text-2xl font-semibold ${accents[accent]}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function Dashboard({ data, autoTasks, onNavigate }) {
  const todayShowings = data.showings.filter(s => new Date(s.showing_time).toDateString() === new Date().toDateString());
  const activeNegotiations = data.negotiations.filter(n => n.status === 'in_progress');
  const expiringSoon = data.properties.filter(p => {
    const days = Math.ceil((new Date(p.commission_end_date) - new Date()) / 86400000);
    return days <= 14 && days > 0 && p.status !== 'closed';
  });
  const highPriorityTasks = autoTasks.filter(t => t.priority === 'high');
  const newInquiries = (data.inquiries || []).filter(i => i.status === 'new').length;
  const manualPending = (data.tasks || []).filter(t => !t.completed).length;
  const totalTasks = autoTasks.length + manualPending;

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900 mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>今日工作台</h1>
        <p className="text-sm text-slate-500">{new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <KpiCard icon={CheckSquare} label="待辦任務" value={totalTasks} sub={`${highPriorityTasks.length} 件高優先 · ${manualPending} 件我的任務`} accent="rose" />
        <KpiCard icon={Eye} label="今日帶看" value={todayShowings.length} sub="預約場次" accent="sky" />
        <KpiCard icon={Handshake} label="議價中" value={activeNegotiations.length} sub="待推進" accent="amber" />
        <KpiCard icon={Clock} label="委託到期" value={expiringSoon.length} sub="14 天內" accent="rose" />
        <KpiCard icon={MessageSquare} label="新詢問" value={newInquiries} sub="來自前台" accent="emerald" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-lg border border-slate-200">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2"><Flame className="w-4 h-4 text-rose-600" /><h2 className="font-semibold">今日優先處理</h2></div>
          <div className="divide-y divide-slate-100">
            {autoTasks.length === 0 && <div className="px-5 py-12 text-center text-slate-400 text-sm">太好了，目前沒有待處理項目</div>}
            {autoTasks.slice(0, 8).map(task => (
              <div key={task.id} className="px-5 py-3 hover:bg-slate-50 flex items-center gap-3">
                <StatusBadge status={task.priority} type="priority" />
                <span className="flex-1 text-sm text-slate-700">{task.title}</span>
                <button onClick={() => {
                  if (task.type === 'high_match') onNavigate('matching');
                  else if (task.related_type === 'buyer') onNavigate('buyers');
                  else if (task.related_type === 'property') onNavigate('properties');
                  else if (task.related_type === 'showing') onNavigate('showings');
                }} className="text-xs text-sky-700 hover:text-sky-800 font-medium flex items-center gap-1">處理 <ChevronRight className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-slate-600" /><h2 className="font-semibold">本月概況</h2></div>
          <div className="p-5 space-y-4">
            <div><div className="text-xs text-slate-500 mb-1">物件總數</div><div className="text-xl font-semibold">{data.properties.length}</div></div>
            <div className="flex justify-between">
              <div><div className="text-xs text-slate-500 mb-1">出售</div><div className="text-lg font-semibold text-rose-700">{data.properties.filter(p => p.sale_type === 'sale').length}</div></div>
              <div><div className="text-xs text-slate-500 mb-1">出租</div><div className="text-lg font-semibold text-teal-700">{data.properties.filter(p => p.sale_type === 'rent').length}</div></div>
            </div>
            <div><div className="text-xs text-slate-500 mb-1">在追蹤買方</div><div className="text-xl font-semibold">{data.buyers.filter(b => b.status === 'active').length}</div></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PropertiesModule({ data, setData }) {
  const [selected, setSelected] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [saleTypeFilter, setSaleTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [confirmCfg, setConfirmCfg] = useState(null);

  const filtered = data.properties.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (saleTypeFilter !== 'all' && p.sale_type !== saleTypeFilter) return false;
    if (search && !p.title.includes(search) && !p.district.includes(search)) return false;
    return true;
  });

  // 狀態切換：active → negotiating → closed / paused
  const updateStatus = (propertyId, newStatus) => {
    setData(prev => ({
      ...prev,
      properties: prev.properties.map(p => p.id === propertyId ? { ...p, status: newStatus } : p)
    }));
    if (selected?.id === propertyId) {
      setSelected({ ...selected, status: newStatus });
    }
  };

  const deleteProperty = (property) => {
    const relatedShowings = data.showings.filter(s => s.property_id === property.id).length;
    const relatedNegotiations = data.negotiations.filter(n => n.property_id === property.id).length;
    const relatedInquiries = (data.inquiries || []).filter(i => i.property_id === property.id).length;

    let message = '此操作無法復原。';
    if (relatedShowings + relatedNegotiations + relatedInquiries > 0) {
      message += '\n\n關聯資料：';
      if (relatedShowings) message += `\n· ${relatedShowings} 筆帶看紀錄`;
      if (relatedNegotiations) message += `\n· ${relatedNegotiations} 筆議價紀錄`;
      if (relatedInquiries) message += `\n· ${relatedInquiries} 筆客戶詢問`;
      message += '\n\n刪除物件後，這些紀錄會保留但失去關聯。';
    }

    setConfirmCfg({
      title: `永久刪除「${property.title}」？`,
      message,
      danger: true,
      confirmText: '永久刪除',
      onConfirm: () => {
        setData(prev => ({ ...prev, properties: prev.properties.filter(p => p.id !== property.id) }));
        setSelected(null);
      }
    });
  };

  if (selected) {
    const owner = data.owners.find(o => o.id === selected.owner_id);
    return (
      <div className="p-8 max-w-5xl">
        <button onClick={() => setSelected(null)} className="text-sm text-slate-500 mb-4 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> 返回列表</button>
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {selected.images && selected.images.length > 0 ? (
            <div className="bg-stone-100">
              <div className="grid grid-cols-3 gap-1 max-h-80 overflow-hidden">
                {selected.images.slice(0, 6).map((src, i) => (
                  <div key={i} className={`relative ${i === 0 ? 'col-span-2 row-span-2 max-h-80' : 'max-h-40'} overflow-hidden`}>
                    <img src={src} alt={`照片 ${i + 1}`} className="w-full h-full object-cover" />
                  </div>
                ))}
              </div>
            </div>
          ) : (<PropertyCover property={selected} size="md" />)}

          <div className="p-6 border-b border-slate-100">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h1 className="text-xl font-semibold mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>{selected.title}</h1>
                <p className="text-sm text-slate-500 flex items-center gap-1"><MapPin className="w-3 h-3" />{selected.city}{selected.district}{selected.address}</p>
              </div>
              <div className="flex flex-col gap-1 items-end">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${selected.sale_type === 'rent' ? 'bg-teal-100 text-teal-800' : 'bg-rose-100 text-rose-800'}`}>{selected.sale_type === 'rent' ? '出租' : '出售'}</span>
                <StatusBadge status={selected.status} type="property" saleType={selected.sale_type} />
              </div>
            </div>
            <div className="flex items-baseline gap-3">
              {selected.sale_type === 'sale' ? (
                <><span className="text-3xl font-semibold">{selected.total_price}</span><span className="text-slate-500">萬</span><span className="text-xs text-slate-400 ml-2">底價 {selected.min_price} 萬 · 行情 {selected.market_price} 萬</span></>
              ) : (
                <><span className="text-3xl font-semibold text-teal-700">{selected.monthly_rent?.toLocaleString()}</span><span className="text-slate-500">元 / 月</span><span className="text-xs text-slate-400 ml-2">押 {selected.deposit_months} 個月</span></>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 divide-x divide-slate-100 border-b border-slate-100">
            <div className="p-4"><div className="text-xs text-slate-500 mb-1">格局</div><div>{selected.layout_room}房{selected.layout_living}廳{selected.layout_bathroom}衛</div></div>
            <div className="p-4"><div className="text-xs text-slate-500 mb-1">主建坪</div><div>{selected.main_area} 坪</div></div>
            <div className="p-4"><div className="text-xs text-slate-500 mb-1">屋齡</div><div>{selected.age} 年 · {selected.floor}/{selected.total_floor}F</div></div>
          </div>

          <div className="p-6 border-b border-slate-100">
            <h3 className="text-sm font-medium text-slate-700 mb-3">物件介紹</h3>
            <p className="text-sm text-slate-600 leading-relaxed">{selected.description}</p>
          </div>

          {/* 狀態管理區 */}
          <div className="p-6 border-b border-slate-100 bg-slate-50/50">
            <h3 className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-slate-500" /> 狀態管理
            </h3>
            <div className="flex flex-wrap gap-2">
              {/* 重新上架（從下架或成交狀態恢復） */}
              {(selected.status === 'paused' || selected.status === 'closed') && (
                <button onClick={() => updateStatus(selected.id, 'active')} className="px-3 py-2 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  重新上架（{selected.sale_type === 'rent' ? '招租' : '銷售'}）
                </button>
              )}

              {/* 進入議價（只有出售、且當前是 active） */}
              {selected.status === 'active' && selected.sale_type === 'sale' && (
                <button onClick={() => updateStatus(selected.id, 'negotiating')} className="px-3 py-2 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 flex items-center gap-1.5">
                  <Handshake className="w-3.5 h-3.5" />
                  標記議價中
                </button>
              )}

              {/* 成交 / 出租 */}
              {(selected.status === 'active' || selected.status === 'negotiating') && (
                <button onClick={() => updateStatus(selected.id, 'closed')} className="px-3 py-2 bg-slate-700 text-white text-sm rounded-lg hover:bg-slate-800 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {selected.sale_type === 'rent' ? '標記已出租' : '標記已成交'}
                </button>
              )}

              {/* 下架（暫停） */}
              {selected.status !== 'paused' && selected.status !== 'closed' && (
                <button onClick={() => updateStatus(selected.id, 'paused')} className="px-3 py-2 bg-white border border-slate-300 text-slate-700 text-sm rounded-lg hover:bg-slate-100 flex items-center gap-1.5">
                  <Archive className="w-3.5 h-3.5" />
                  下架
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-3">
              {selected.status === 'active' && '目前正在前台公開展示中'}
              {selected.status === 'negotiating' && '前台會顯示為「議價中」'}
              {selected.status === 'closed' && '已完成交易，不在前台顯示'}
              {selected.status === 'paused' && '已下架，不在前台顯示'}
            </p>
          </div>

          {owner && (
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-sm font-medium text-slate-700 mb-3">屋主資訊（僅後台可見）</h3>
              <div className="bg-slate-50 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">姓名</span><span>{owner.name}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">電話</span><span>{owner.phone}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">動機</span><span>{owner.motivation}</span></div>
                {owner.note && <div className="pt-2 border-t border-slate-200 text-slate-600 text-xs">{owner.note}</div>}
              </div>
            </div>
          )}

          {/* 危險操作區 */}
          <div className="p-6 bg-rose-50/30">
            <h3 className="text-sm font-medium text-rose-700 mb-2 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> 危險操作
            </h3>
            <p className="text-xs text-slate-500 mb-3">
              如果這個物件是測試用、或永久不需要，可以完全刪除。建議優先使用「下架」保留資料。
            </p>
            <button onClick={() => deleteProperty(selected)} className="px-3 py-2 bg-white border border-rose-300 text-rose-700 text-sm rounded-lg hover:bg-rose-100 flex items-center gap-1.5">
              <Trash2 className="w-3.5 h-3.5" />
              永久刪除此物件
            </button>
          </div>
        </div>
        <ConfirmDialog config={confirmCfg} onClose={() => setConfirmCfg(null)} />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>物件管理</h1>
          <p className="text-sm text-slate-500">共 {data.properties.length} 件 · 出售 {data.properties.filter(p => p.sale_type === 'sale').length} · 出租 {data.properties.filter(p => p.sale_type === 'rent').length}</p>
        </div>
        <button onClick={() => setShowForm(true)} className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-800 flex items-center gap-2"><Plus className="w-4 h-4" /> 新增物件</button>
      </div>

      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋物件" className="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-sm" />
        </div>
        <select value={saleTypeFilter} onChange={e => setSaleTypeFilter(e.target.value)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm">
          <option value="all">租 / 售</option><option value="sale">僅出售</option><option value="rent">僅出租</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm">
          <option value="all">所有狀態</option><option value="active">上架中</option><option value="negotiating">議價中</option><option value="closed">已結案</option><option value="paused">已下架</option>
        </select>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {filtered.map((p, idx) => {
          const owner = data.owners.find(o => o.id === p.owner_id);
          const daysToExpire = Math.ceil((new Date(p.commission_end_date) - new Date()) / 86400000);
          return (
            <div key={p.id} onClick={() => setSelected(p)} className={`p-4 cursor-pointer hover:bg-slate-50 ${idx > 0 ? 'border-t border-slate-100' : ''}`}>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-slate-100">
                  {p.images && p.images.length > 0 ? (
                    <img src={p.images[0]} alt={p.title} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-stone-200 to-stone-50 flex items-center justify-center"><ImageIcon className="w-5 h-5 text-white/60" /></div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${p.sale_type === 'rent' ? 'bg-teal-100 text-teal-700' : 'bg-rose-100 text-rose-700'}`}>{p.sale_type === 'rent' ? '租' : '售'}</span>
                    <span className="font-medium truncate">{p.title}</span>
                    <StatusBadge status={p.status} type="property" saleType={p.sale_type} />
                  </div>
                  <div className="text-xs text-slate-500 flex items-center gap-3 flex-wrap">
                    <span>{p.city}{p.district}</span><span>·</span><span>{p.layout_room}房 / {p.main_area}坪 / {p.age}年</span><span>·</span><span>屋主 {owner?.name}</span>
                  </div>
                </div>
                <div className="text-right">
                  {p.sale_type === 'sale' ? (
                    <div className="font-semibold">{p.total_price} <span className="text-xs text-slate-500 font-normal">萬</span></div>
                  ) : (
                    <div className="font-semibold text-teal-700">{p.monthly_rent?.toLocaleString()} <span className="text-xs text-slate-500 font-normal">/月</span></div>
                  )}
                  {daysToExpire <= 14 && daysToExpire > 0 && <div className="text-xs text-rose-600 mt-1">委託 {daysToExpire} 天到期</div>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {showForm && <PropertyForm data={data} setData={setData} onClose={() => setShowForm(false)} />}
      <ConfirmDialog config={confirmCfg} onClose={() => setConfirmCfg(null)} />
    </div>
  );
}

function PropertyForm({ data, setData, onClose }) {
  const [form, setForm] = useState({
    sale_type: 'sale', title: '', owner_id: data.owners[0]?.id || '',
    description: '', cover_theme: 'stone', images: [],
    property_type: '電梯大樓', city: '台北市', district: '', address: '',
    total_price: '', min_price: '', main_area: '',
    monthly_rent: '', deposit_months: 2,
    layout_room: 2, layout_living: 2, layout_bathroom: 1,
    floor: 1, total_floor: 1, age: 0,
    has_parking: false, has_elevator: true, features: [],
    commission_end_date: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
    exclusive: false
  });
  const [showOwnerAdd, setShowOwnerAdd] = useState(false);

  const handleOwnerAdded = (newOwner) => {
    setData(prev => ({ ...prev, owners: [...prev.owners, newOwner] }));
    setForm({ ...form, owner_id: newOwner.id });
    setShowOwnerAdd(false);
  };

  const submit = () => {
    if (!form.title) { alert('請填寫標題'); return; }
    if (form.sale_type === 'sale' && !form.total_price) { alert('請填寫總價'); return; }
    if (form.sale_type === 'rent' && !form.monthly_rent) { alert('請填寫月租金'); return; }

    const newProp = {
      id: `${form.sale_type === 'rent' ? 'r' : 'p'}${Date.now()}`, ...form,
      total_price: form.sale_type === 'sale' ? Number(form.total_price) : null,
      min_price: form.sale_type === 'sale' ? (Number(form.min_price) || Number(form.total_price) * 0.95) : null,
      market_price: form.sale_type === 'sale' ? Number(form.total_price) : null,
      monthly_rent: form.sale_type === 'rent' ? Number(form.monthly_rent) : null,
      deposit_months: form.sale_type === 'rent' ? Number(form.deposit_months) : null,
      main_area: Number(form.main_area) || 0, age: Number(form.age) || 0, status: 'active',
    };
    setData(prev => ({ ...prev, properties: [...prev.properties, newProp] }));
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold">新增物件</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-slate-400" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="text-xs text-slate-600 mb-2 block">物件類型 *</label>
            <div className="flex gap-2">
              {[{ value: 'sale', label: '出售', color: 'rose' }, { value: 'rent', label: '出租', color: 'teal' }].map(opt => (
                <button key={opt.value} onClick={() => setForm({ ...form, sale_type: opt.value })} className={`flex-1 px-3 py-2 rounded-lg text-sm ${form.sale_type === opt.value ? `bg-${opt.color}-600 text-white` : 'bg-slate-100 text-slate-700'}`}>{opt.label}</button>
              ))}
            </div>
          </div>
          <div><label className="text-xs text-slate-600 mb-1 block">物件標題 *</label><input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
          <div>
            <label className="text-xs text-slate-600 mb-2 block flex items-center gap-1"><Camera className="w-3.5 h-3.5" /> 物件照片</label>
            <ImageUpload images={form.images} onChange={(images) => setForm({ ...form, images })} max={6} />
          </div>
          <div><label className="text-xs text-slate-600 mb-1 block">物件介紹</label><textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
          <div>
            <label className="text-xs text-slate-600 mb-1 block">屋主</label>
            <div className="flex gap-2">
              <select value={form.owner_id} onChange={e => setForm({ ...form, owner_id: e.target.value })} className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm">
                {data.owners.length === 0 && <option value="">尚無屋主，請先新增</option>}
                {data.owners.map(o => <option key={o.id} value={o.id}>{o.name} · {o.phone}</option>)}
              </select>
              <button type="button" onClick={() => setShowOwnerAdd(true)} className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm flex items-center gap-1 whitespace-nowrap" title="新增屋主">
                <Plus className="w-4 h-4" /> 新屋主
              </button>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs text-slate-600 mb-1 block">類型</label><select value={form.property_type} onChange={e => setForm({ ...form, property_type: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">{PROPERTY_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
            <div><label className="text-xs text-slate-600 mb-1 block">縣市 *</label><select value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">{Object.entries(TW_CITIES).map(([group, cities]) => (<optgroup key={group} label={group}>{cities.map(c => <option key={c} value={c}>{c}</option>)}</optgroup>))}</select></div>
            <div><label className="text-xs text-slate-600 mb-1 block">行政區</label><input value={form.district} onChange={e => setForm({ ...form, district: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
          </div>
          <div><label className="text-xs text-slate-600 mb-1 block">地址</label><input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
          {form.sale_type === 'sale' ? (
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs text-slate-600 mb-1 block">總價（萬）*</label><input type="number" value={form.total_price} onChange={e => setForm({ ...form, total_price: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
              <div><label className="text-xs text-slate-600 mb-1 block">底價（萬）</label><input type="number" value={form.min_price} onChange={e => setForm({ ...form, min_price: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
              <div><label className="text-xs text-slate-600 mb-1 block">坪數</label><input type="number" value={form.main_area} onChange={e => setForm({ ...form, main_area: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs text-slate-600 mb-1 block">月租金（元）*</label><input type="number" value={form.monthly_rent} onChange={e => setForm({ ...form, monthly_rent: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
              <div><label className="text-xs text-slate-600 mb-1 block">押金</label><input type="number" value={form.deposit_months} onChange={e => setForm({ ...form, deposit_months: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
              <div><label className="text-xs text-slate-600 mb-1 block">坪數</label><input type="number" value={form.main_area} onChange={e => setForm({ ...form, main_area: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs text-slate-600 mb-1 block">房</label><input type="number" value={form.layout_room} onChange={e => setForm({ ...form, layout_room: Number(e.target.value) })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
            <div><label className="text-xs text-slate-600 mb-1 block">廳</label><input type="number" value={form.layout_living} onChange={e => setForm({ ...form, layout_living: Number(e.target.value) })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
            <div><label className="text-xs text-slate-600 mb-1 block">衛</label><input type="number" value={form.layout_bathroom} onChange={e => setForm({ ...form, layout_bathroom: Number(e.target.value) })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs text-slate-600 mb-1 block">樓層</label><input type="number" value={form.floor} onChange={e => setForm({ ...form, floor: Number(e.target.value) })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
            <div><label className="text-xs text-slate-600 mb-1 block">總樓層</label><input type="number" value={form.total_floor} onChange={e => setForm({ ...form, total_floor: Number(e.target.value) })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
            <div><label className="text-xs text-slate-600 mb-1 block">屋齡</label><input type="number" value={form.age} onChange={e => setForm({ ...form, age: Number(e.target.value) })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.has_elevator} onChange={e => setForm({ ...form, has_elevator: e.target.checked })} />電梯</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.has_parking} onChange={e => setForm({ ...form, has_parking: e.target.checked })} />車位</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.exclusive} onChange={e => setForm({ ...form, exclusive: e.target.checked })} />專任</label>
          </div>
          <div><label className="text-xs text-slate-600 mb-1 block">特色（逗號分隔）</label><input value={form.features.join(',')} onChange={e => setForm({ ...form, features: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
          <div><label className="text-xs text-slate-600 mb-1 block">委託到期</label><input type="date" value={form.commission_end_date} onChange={e => setForm({ ...form, commission_end_date: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
        </div>
        <div className="p-6 border-t border-slate-100 flex justify-end gap-2 sticky bottom-0 bg-white">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">取消</button>
          <button onClick={submit} className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg">儲存</button>
        </div>
      </div>
      {showOwnerAdd && <OwnerForm onClose={() => setShowOwnerAdd(false)} onSave={handleOwnerAdded} />}
    </div>
  );
}

function InquiriesModule({ data, setData }) {
  const inquiries = data.inquiries || [];
  const markAsRead = (id) => setData(prev => ({ ...prev, inquiries: prev.inquiries.map(i => i.id === id ? { ...i, status: 'contacted' } : i) }));

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6"><h1 className="text-2xl font-semibold mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>客戶詢問</h1><p className="text-sm text-slate-500">來自前台 · 共 {inquiries.length} 筆</p></div>
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {inquiries.length === 0 && <div className="p-12 text-center text-slate-400"><MessageSquare className="w-10 h-10 mx-auto mb-3 text-slate-300" /><p className="text-sm">還沒有客戶詢問</p></div>}
        {inquiries.slice().reverse().map((inq, idx) => {
          const property = data.properties.find(p => p.id === inq.property_id);
          return (
            <div key={inq.id} className={`p-4 ${idx > 0 ? 'border-t border-slate-100' : ''} ${inq.status === 'new' ? 'bg-amber-50/30' : ''}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1"><span className="font-medium">{inq.name}</span><span className="text-xs text-slate-500">{inq.phone}</span>{inq.status === 'new' && <span className="px-1.5 py-0.5 bg-rose-100 text-rose-700 text-xs rounded">未聯絡</span>}</div>
                  <div className="text-xs text-slate-500 mb-2">物件：{property?.title || '已下架'}</div>
                  <div className="text-sm text-slate-700 bg-slate-50 rounded p-2.5">{inq.message}</div>
                  <div className="text-xs text-slate-400 mt-1">{new Date(inq.created_at).toLocaleString('zh-TW')}</div>
                </div>
                {inq.status === 'new' && <button onClick={() => markAsRead(inq.id)} className="text-xs text-sky-700 font-medium whitespace-nowrap">標記已聯絡</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatchingModule({ data }) {
  const [selectedBuyerId, setSelectedBuyerId] = useState(data.buyers[0]?.id);
  const buyer = data.buyers.find(b => b.id === selectedBuyerId);
  const matches = useMemo(() => {
    if (!buyer?.requirement) return [];
    return data.properties.filter(p => (p.status === 'active' || p.status === 'negotiating') && p.sale_type === 'sale').map(p => ({ property: p, match: calculateMatchScore(buyer.requirement, p) })).filter(m => m.match !== null).sort((a, b) => b.match.score - a.match.score);
  }, [buyer, data.properties]);

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-6"><h1 className="text-2xl font-semibold mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>智能媒合</h1></div>
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-6">
        <label className="text-xs text-slate-500 mb-2 block">選擇買方</label>
        <div className="flex flex-wrap gap-2">
          {data.buyers.map(b => <button key={b.id} onClick={() => setSelectedBuyerId(b.id)} className={`px-3 py-1.5 rounded-lg text-sm ${selectedBuyerId === b.id ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-700'}`}>{b.name}</button>)}
        </div>
      </div>
      {buyer && (
        <>
          <div className="bg-slate-900 text-white rounded-lg p-5 mb-6">
            <div className="flex items-center gap-2 mb-3"><Target className="w-4 h-4" /><span className="font-medium">{buyer.name} 的需求</span></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div><div className="text-slate-400 text-xs mb-1">預算</div><div>{buyer.requirement.budget_min} - {buyer.requirement.budget_max} 萬</div></div>
              <div><div className="text-slate-400 text-xs mb-1">區域</div><div>{buyer.requirement.must_districts.join('、')}</div></div>
              <div><div className="text-slate-400 text-xs mb-1">最低需求</div><div>{buyer.requirement.min_rooms}房 / {buyer.requirement.min_area}坪</div></div>
              <div><div className="text-slate-400 text-xs mb-1">用途</div><div>{buyer.buying_purpose}</div></div>
            </div>
          </div>
          <div className="space-y-3">
            {matches.map(({ property, match }) => (
              <div key={property.id} className="bg-white rounded-lg border border-slate-200 p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1"><h3 className="font-semibold">{property.title}</h3><span className={`text-xs px-2 py-0.5 rounded font-medium ${match.score >= 90 ? 'bg-emerald-100 text-emerald-800' : match.score >= 80 ? 'bg-sky-100 text-sky-800' : match.score >= 70 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>{match.level}</span></div>
                    <div className="text-xs text-slate-500">{property.district} · {property.layout_room}房 · {property.main_area}坪 · {property.age}年 · {property.total_price} 萬</div>
                  </div>
                  <div className="text-right"><div className="text-3xl font-semibold">{match.score}</div><div className="text-xs text-slate-500">分</div></div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-emerald-50/50 border border-emerald-100 rounded-lg p-3">
                    <div className="flex items-center gap-1 text-xs font-medium text-emerald-700 mb-2"><CheckCircle2 className="w-3 h-3" /> 符合原因</div>
                    <ul className="space-y-1 text-xs">{match.reasons.length > 0 ? match.reasons.map((r, i) => <li key={i}>· {r}</li>) : <li className="text-slate-400">無</li>}</ul>
                  </div>
                  <div className="bg-amber-50/50 border border-amber-100 rounded-lg p-3">
                    <div className="flex items-center gap-1 text-xs font-medium text-amber-700 mb-2"><AlertTriangle className="w-3 h-3" /> 可能抗性</div>
                    <ul className="space-y-1 text-xs">{match.concerns.length > 0 ? match.concerns.map((c, i) => <li key={i}>· {c}</li>) : <li className="text-slate-400">無</li>}</ul>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// 買方管理（新增 / 編輯 / 刪除）
// ============================================================

function BuyerForm({ buyer, onClose, onSave }) {
  const [form, setForm] = useState(buyer || {
    name: '', phone: '', line_id: '',
    buying_purpose: '自住', urgency: 'medium', loan_status: 'unknown',
    family_visited: false, status: 'active',
    requirement: {
      must_districts: [], must_types: ['電梯大樓'],
      budget_min: 800, budget_max: 1500,
      min_rooms: 2, min_area: 20, max_age: 30,
      need_parking: false,
      must_have: [], nice_to_have: [], reject_conditions: ['凶宅'],
    }
  });

  const updateReq = (key, value) => setForm(prev => ({ ...prev, requirement: { ...prev.requirement, [key]: value } }));
  const updateReqArr = (key, str) => updateReq(key, str.split(/[,、]/).map(s => s.trim()).filter(Boolean));

  const submit = () => {
    if (!form.name.trim()) { alert('請填寫姓名'); return; }
    if (form.requirement.budget_min > form.requirement.budget_max) { alert('預算下限不能高於上限'); return; }
    const result = {
      ...form,
      id: buyer?.id || `b${Date.now()}`,
      name: form.name.trim(),
      phone: form.phone.trim(),
      created_at: buyer?.created_at || new Date().toISOString().slice(0, 10),
    };
    onSave(result);
  };

  const req = form.requirement;

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold">{buyer ? '編輯買方' : '新增買方'}</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-slate-400" /></button>
        </div>

        <div className="p-6 space-y-6">
          {/* 基本資訊 */}
          <section>
            <h3 className="text-sm font-medium text-slate-900 mb-3 flex items-center gap-2">
              <UserCircle2 className="w-4 h-4 text-slate-500" /> 基本資訊
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-600 mb-1 block">姓名 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例：張先生" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs text-slate-600 mb-1 block">電話</label><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
                <div><label className="text-xs text-slate-600 mb-1 block">Line ID</label><input value={form.line_id} onChange={e => setForm({ ...form, line_id: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-slate-600 mb-1 block">用途</label>
                  <select value={form.buying_purpose} onChange={e => setForm({ ...form, buying_purpose: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">
                    <option>自住</option><option>投資</option><option>換屋</option><option>子女置產</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-600 mb-1 block">急迫度</label>
                  <select value={form.urgency} onChange={e => setForm({ ...form, urgency: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">
                    <option value="high">高</option><option value="medium">中</option><option value="low">低</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-600 mb-1 block">貸款</label>
                  <select value={form.loan_status} onChange={e => setForm({ ...form, loan_status: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">
                    <option value="unknown">未確認</option><option value="pre_approved">預核</option><option value="approved">已核</option><option value="cash">現金</option>
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.family_visited} onChange={e => setForm({ ...form, family_visited: e.target.checked })} />
                家人已陪同看過
              </label>
            </div>
          </section>

          {/* 購屋需求 */}
          <section>
            <h3 className="text-sm font-medium text-slate-900 mb-3 flex items-center gap-2">
              <Target className="w-4 h-4 text-slate-500" /> 購屋需求
              <span className="text-xs text-slate-400 font-normal">（用於智能媒合）</span>
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-600 mb-1 block">想找的行政區（逗號分隔）</label>
                <input value={req.must_districts.join('、')} onChange={e => updateReqArr('must_districts', e.target.value)} placeholder="例：信義區、大安區、文山區" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-600 mb-1 block">物件類型（逗號分隔）</label>
                <input value={req.must_types.join('、')} onChange={e => updateReqArr('must_types', e.target.value)} placeholder="例：電梯大樓、公寓" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs text-slate-600 mb-1 block">預算下限（萬）</label><input type="number" value={req.budget_min} onChange={e => updateReq('budget_min', Number(e.target.value))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
                <div><label className="text-xs text-slate-600 mb-1 block">預算上限（萬）</label><input type="number" value={req.budget_max} onChange={e => updateReq('budget_max', Number(e.target.value))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div><label className="text-xs text-slate-600 mb-1 block">最少房數</label><input type="number" value={req.min_rooms} onChange={e => updateReq('min_rooms', Number(e.target.value))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
                <div><label className="text-xs text-slate-600 mb-1 block">最少坪數</label><input type="number" value={req.min_area} onChange={e => updateReq('min_area', Number(e.target.value))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
                <div><label className="text-xs text-slate-600 mb-1 block">屋齡上限</label><input type="number" value={req.max_age} onChange={e => updateReq('max_age', Number(e.target.value))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={req.need_parking} onChange={e => updateReq('need_parking', e.target.checked)} />
                需要車位
              </label>
              <div>
                <label className="text-xs text-slate-600 mb-1 block">必要條件</label>
                <input value={req.must_have.join('、')} onChange={e => updateReqArr('must_have', e.target.value)} placeholder="例：需電梯、近捷運" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-600 mb-1 block">加分項</label>
                <input value={req.nice_to_have.join('、')} onChange={e => updateReqArr('nice_to_have', e.target.value)} placeholder="例：採光佳、高樓層、邊間" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-600 mb-1 block">排斥條件</label>
                <input value={req.reject_conditions.join('、')} onChange={e => updateReqArr('reject_conditions', e.target.value)} placeholder="例：凶宅、頂樓加蓋" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
            </div>
          </section>
        </div>

        <div className="p-6 border-t border-slate-100 flex justify-end gap-2 sticky bottom-0 bg-white">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">取消</button>
          <button onClick={submit} className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg">{buyer ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  );
}

function BuyersModule({ data, setData }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmCfg, setConfirmCfg] = useState(null);

  const handleSave = (buyer) => {
    setData(prev => {
      const exists = prev.buyers.some(b => b.id === buyer.id);
      return {
        ...prev,
        buyers: exists ? prev.buyers.map(b => b.id === buyer.id ? buyer : b) : [...prev.buyers, buyer]
      };
    });
    setShowForm(false);
    setEditing(null);
  };

  const handleDelete = (buyer) => {
    const showings = data.showings.filter(s => s.buyer_id === buyer.id).length;
    const negotiations = data.negotiations.filter(n => n.buyer_id === buyer.id).length;
    let message = '此操作無法復原。';
    if (showings + negotiations > 0) {
      message += '\n\n關聯資料：';
      if (showings) message += `\n· ${showings} 筆帶看紀錄`;
      if (negotiations) message += `\n· ${negotiations} 筆議價紀錄`;
      message += '\n\n刪除後這些紀錄會保留但失去買方關聯。';
    }
    setConfirmCfg({
      title: `刪除買方「${buyer.name}」？`,
      message,
      danger: true,
      confirmText: '永久刪除',
      onConfirm: () => setData(prev => ({ ...prev, buyers: prev.buyers.filter(b => b.id !== buyer.id) })),
    });
  };

  const buyersWithScore = data.buyers
    .map(b => ({ buyer: b, ...calculateBuyerScore(b, data.showings, data.negotiations, data.notes) }))
    .sort((a, b) => b.score - a.score);

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>買方管理</h1>
          <p className="text-sm text-slate-500">共 {data.buyers.length} 位</p>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-800 flex items-center gap-2">
          <Plus className="w-4 h-4" /> 新增買方
        </button>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {buyersWithScore.map(({ buyer, score, tier }, idx) => (
          <div key={buyer.id} className={`p-4 group hover:bg-slate-50 ${idx > 0 ? 'border-t border-slate-100' : ''}`}>
            <div className="flex items-center gap-4">
              <div className={`w-10 h-10 rounded-full bg-${tier.color}-100 flex items-center justify-center text-${tier.color}-700 font-semibold flex-shrink-0`}>
                {buyer.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <span className="font-medium text-slate-900">{buyer.name}</span>
                  <StatusBadge status={buyer.urgency} type="urgency" />
                  <span className="text-xs text-slate-500">{buyer.buying_purpose}</span>
                </div>
                <div className="text-xs text-slate-500">
                  {buyer.requirement.budget_min}-{buyer.requirement.budget_max} 萬
                  {buyer.requirement.must_districts.length > 0 && <> · {buyer.requirement.must_districts.join('、')}</>}
                </div>
              </div>
              <div className="text-right">
                <div className={`text-2xl font-semibold text-${tier.color}-700`}>{score}</div>
                <div className="text-xs text-slate-400">{tier.label}</div>
              </div>
              <div className="flex gap-1 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => { setEditing(buyer); setShowForm(true); }} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded" title="編輯">
                  <Edit3 className="w-4 h-4" />
                </button>
                <button onClick={() => handleDelete(buyer)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded" title="刪除">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
        {data.buyers.length === 0 && (
          <div className="p-12 text-center text-slate-400">
            <Users className="w-10 h-10 mx-auto mb-3 text-slate-300" />
            <p className="text-sm">還沒有買方資料</p>
            <p className="text-xs mt-1">點右上「新增買方」開始建立</p>
          </div>
        )}
      </div>

      {showForm && <BuyerForm buyer={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={handleSave} />}
      <ConfirmDialog config={confirmCfg} onClose={() => setConfirmCfg(null)} />
    </div>
  );
}

// ============================================================
// 屋主管理（新增 / 編輯 / 刪除）
// ============================================================

function OwnerForm({ owner, onClose, onSave }) {
  const [form, setForm] = useState(owner || {
    name: '', phone: '', line_id: '', motivation: '換屋',
    urgency: 'medium', personality_tag: '', decision_power: '本人', note: ''
  });

  const submit = () => {
    if (!form.name.trim()) { alert('請輸入屋主姓名'); return; }
    const result = owner
      ? { ...owner, ...form, name: form.name.trim(), phone: form.phone.trim() }
      : { id: `o${Date.now()}`, ...form, name: form.name.trim(), phone: form.phone.trim() };
    onSave(result);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold">{owner ? '編輯屋主' : '新增屋主'}</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-slate-400" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="text-xs text-slate-600 mb-1 block">姓名 *</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例：王國華" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-slate-600 mb-1 block">電話</label><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="0912-345-678" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
            <div><label className="text-xs text-slate-600 mb-1 block">Line ID</label><input value={form.line_id} onChange={e => setForm({ ...form, line_id: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-600 mb-1 block">出售動機</label>
              <select value={form.motivation} onChange={e => setForm({ ...form, motivation: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">
                <option>換屋</option><option>投資出場</option><option>繼承處分</option><option>資金需求</option><option>出租收益</option><option>其他</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-600 mb-1 block">急迫度</label>
              <select value={form.urgency} onChange={e => setForm({ ...form, urgency: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">
                <option value="high">高</option><option value="medium">中</option><option value="low">低</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-600 mb-1 block">個性標籤</label>
              <select value={form.personality_tag} onChange={e => setForm({ ...form, personality_tag: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">
                <option value="">未設定</option><option>好溝通</option><option>價格硬</option><option>保守</option><option>強勢</option><option>理性</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-600 mb-1 block">決策權</label>
              <select value={form.decision_power} onChange={e => setForm({ ...form, decision_power: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">
                <option>本人</option><option>夫妻共同</option><option>家族共同</option><option>代理人</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-600 mb-1 block">備註</label>
            <textarea value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} rows={2} placeholder="例：希望年底前處理掉" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
          </div>
        </div>
        <div className="p-6 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">取消</button>
          <button onClick={submit} className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg">{owner ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  );
}

function OwnersModule({ data, setData }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmCfg, setConfirmCfg] = useState(null);

  const handleSave = (owner) => {
    setData(prev => {
      const exists = prev.owners.some(o => o.id === owner.id);
      return {
        ...prev,
        owners: exists
          ? prev.owners.map(o => o.id === owner.id ? owner : o)
          : [...prev.owners, owner]
      };
    });
    setShowForm(false);
    setEditing(null);
  };

  const handleDelete = (owner) => {
    const ownerProps = data.properties.filter(p => p.owner_id === owner.id);
    if (ownerProps.length > 0) {
      setConfirmCfg({
        title: '無法刪除此屋主',
        message: `「${owner.name}」名下還有 ${ownerProps.length} 件物件。\n\n請先刪除或轉移這些物件，再刪除屋主。`,
        confirmText: '我知道了',
        cancelText: '',
        onConfirm: () => {},
      });
      return;
    }
    setConfirmCfg({
      title: `刪除屋主「${owner.name}」？`,
      message: '此操作無法復原。',
      danger: true,
      confirmText: '永久刪除',
      onConfirm: () => setData(prev => ({ ...prev, owners: prev.owners.filter(o => o.id !== owner.id) })),
    });
  };

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>屋主管理</h1>
          <p className="text-sm text-slate-500">共 {data.owners.length} 位屋主</p>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-800 flex items-center gap-2">
          <Plus className="w-4 h-4" /> 新增屋主
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.owners.map(owner => {
          const ownerProps = data.properties.filter(p => p.owner_id === owner.id);
          return (
            <div key={owner.id} className="bg-white rounded-lg border border-slate-200 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-slate-900">{owner.name}</h3>
                  <div className="mt-1 flex items-center gap-1.5">
                    <StatusBadge status={owner.urgency} type="urgency" />
                    {owner.personality_tag && <span className="text-xs text-slate-500">{owner.personality_tag}</span>}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => { setEditing(owner); setShowForm(true); }} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded" title="編輯">
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(owner)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded" title="刪除">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="space-y-1.5 text-sm">
                {owner.phone && <div className="flex items-center gap-2 text-slate-600"><Phone className="w-3.5 h-3.5" />{owner.phone}</div>}
                <div className="text-slate-600">動機：{owner.motivation}</div>
                <div className="text-slate-600">決策：{owner.decision_power}</div>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-100">
                <div className="text-xs text-slate-500 mb-2">名下物件 ({ownerProps.length})</div>
                {ownerProps.length === 0 ? (
                  <div className="text-xs text-slate-400">無</div>
                ) : (
                  ownerProps.map(p => (
                    <div key={p.id} className="text-sm py-1 flex items-center gap-2">
                      <span className={`px-1 py-0.5 rounded text-xs ${p.sale_type === 'rent' ? 'bg-teal-100 text-teal-700' : 'bg-rose-100 text-rose-700'}`}>{p.sale_type === 'rent' ? '租' : '售'}</span>
                      <span className="text-slate-700 truncate">{p.title}</span>
                    </div>
                  ))
                )}
              </div>
              {owner.note && <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500 italic">{owner.note}</div>}
            </div>
          );
        })}
        {data.owners.length === 0 && (
          <div className="col-span-full bg-white rounded-lg border border-slate-200 border-dashed p-12 text-center text-slate-400">
            <UserCircle2 className="w-10 h-10 mx-auto mb-3 text-slate-300" />
            <p className="text-sm">還沒有屋主資料</p>
            <p className="text-xs mt-1">點右上「新增屋主」開始建立</p>
          </div>
        )}
      </div>
      {showForm && <OwnerForm owner={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={handleSave} />}
      <ConfirmDialog config={confirmCfg} onClose={() => setConfirmCfg(null)} />
    </div>
  );
}

function ShowingsModule({ data }) {
  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-6"><h1 className="text-2xl font-semibold mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>帶看紀錄</h1></div>
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {data.showings.map((s, idx) => {
          const buyer = data.buyers.find(b => b.id === s.buyer_id);
          const property = data.properties.find(p => p.id === s.property_id);
          return (
            <div key={s.id} className={`p-4 ${idx > 0 ? 'border-t border-slate-100' : ''}`}>
              <div className="flex items-center gap-2"><span className="font-medium">{buyer?.name}</span><span className="text-slate-400">→</span><span>{property?.title}</span><span className="text-xs text-slate-400 ml-auto">{new Date(s.showing_time).toLocaleDateString('zh-TW')}</span></div>
              {s.like_points && <div className="text-xs text-emerald-700 mt-1">喜歡：{s.like_points}</div>}
              {s.dislike_points && <div className="text-xs text-rose-700">不喜歡：{s.dislike_points}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NegotiationsModule({ data }) {
  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-6"><h1 className="text-2xl font-semibold mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>議價追蹤</h1></div>
      <div className="space-y-4">
        {data.negotiations.map(n => {
          const property = data.properties.find(p => p.id === n.property_id);
          const buyer = data.buyers.find(b => b.id === n.buyer_id);
          return (
            <div key={n.id} className="bg-white rounded-lg border border-slate-200 p-5">
              <h3 className="font-semibold mb-3">{property?.title} · 買方 {buyer?.name}</h3>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div><div className="text-xs text-slate-500">屋主開價</div><div className="text-lg font-semibold">{n.owner_price}</div></div>
                <div><div className="text-xs text-slate-500">買方出價</div><div className="text-lg font-semibold text-sky-700">{n.buyer_offer}</div></div>
                <div><div className="text-xs text-slate-500">屋主反價</div><div className="text-lg font-semibold text-amber-700">{n.counter_offer}</div></div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// 任務中心（系統提醒 + 手動新增任務）
// ============================================================

function TaskForm({ task, onClose, onSave }) {
  const [form, setForm] = useState(task || {
    title: '', priority: 'medium', due_date: '', note: '', completed: false,
  });

  const submit = () => {
    if (!form.title.trim()) { alert('請填寫任務內容'); return; }
    onSave({
      ...form,
      id: task?.id || `t${Date.now()}`,
      title: form.title.trim(),
      created_at: task?.created_at || new Date().toISOString(),
    });
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-md w-full">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{task ? '編輯任務' : '新增任務'}</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-slate-400" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="text-xs text-slate-600 mb-1 block">任務內容 *</label>
            <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="例：明天下午帶王太太看新店物件" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-600 mb-1 block">優先級</label>
              <select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm">
                <option value="high">高優先</option>
                <option value="medium">中優先</option>
                <option value="low">低優先</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-600 mb-1 block">截止日期</label>
              <input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-600 mb-1 block">備註</label>
            <textarea value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} rows={2} placeholder="可選" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
          </div>
        </div>
        <div className="p-6 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">取消</button>
          <button onClick={submit} className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg">{task ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  );
}

function TasksModule({ data, setData, autoTasks }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmCfg, setConfirmCfg] = useState(null);

  const manualTasks = data.tasks || [];
  const incomplete = manualTasks.filter(t => !t.completed)
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return (a.due_date || '9999').localeCompare(b.due_date || '9999');
    });
  const completed = manualTasks.filter(t => t.completed);

  const handleSave = (task) => {
    setData(prev => {
      const list = prev.tasks || [];
      const exists = list.some(t => t.id === task.id);
      return {
        ...prev,
        tasks: exists ? list.map(t => t.id === task.id ? task : t) : [...list, task]
      };
    });
    setShowForm(false);
    setEditing(null);
  };

  const toggleComplete = (id) => {
    setData(prev => ({
      ...prev,
      tasks: (prev.tasks || []).map(t => t.id === id ? { ...t, completed: !t.completed } : t)
    }));
  };

  const handleDelete = (task) => {
    setConfirmCfg({
      title: `刪除任務「${task.title}」？`,
      message: '此操作無法復原。',
      danger: true,
      confirmText: '刪除',
      onConfirm: () => setData(prev => ({ ...prev, tasks: (prev.tasks || []).filter(t => t.id !== task.id) })),
    });
  };

  // 判斷截止日逾期
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold mb-1" style={{ fontFamily: '"Noto Serif TC", serif' }}>任務中心</h1>
          <p className="text-sm text-slate-500">{autoTasks.length} 件系統提醒 · {incomplete.length} 件待辦</p>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-800 flex items-center gap-2">
          <Plus className="w-4 h-4" /> 新增任務
        </button>
      </div>

      {/* 系統提醒（自動產生） */}
      <section className="mb-8">
        <h2 className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-500" />
          系統提醒
          <span className="text-xs text-slate-400 font-normal">（由資料變化自動產生）</span>
        </h2>
        {autoTasks.length === 0 ? (
          <div className="bg-white rounded-lg border border-slate-200 p-6 text-center text-sm text-slate-400">
            目前沒有系統提醒，太棒了
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
            {autoTasks.map(task => (
              <div key={task.id} className="p-4 flex items-center gap-3">
                <StatusBadge status={task.priority} type="priority" />
                <span className="flex-1 text-sm text-slate-700">{task.title}</span>
                <span className="text-xs text-slate-400 hidden md:inline">系統自動</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 我的任務（手動建立） */}
      <section className="mb-8">
        <h2 className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-2">
          <CheckSquare className="w-4 h-4 text-sky-500" />
          我的任務
          <span className="text-xs text-slate-400 font-normal">（{incomplete.length} 件待辦）</span>
        </h2>
        {incomplete.length === 0 ? (
          <div className="bg-white rounded-lg border border-slate-200 border-dashed p-8 text-center">
            <CheckSquare className="w-10 h-10 mx-auto mb-2 text-slate-300" />
            <p className="text-sm text-slate-500">沒有待辦任務</p>
            <p className="text-xs text-slate-400 mt-1">右上方「新增任務」可以建立提醒</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
            {incomplete.map(task => {
              const overdue = task.due_date && task.due_date < today;
              return (
                <div key={task.id} className="p-4 flex items-center gap-3 group hover:bg-slate-50">
                  <button onClick={() => toggleComplete(task.id)} className="text-slate-300 hover:text-emerald-600 flex-shrink-0" title="標記完成">
                    <Square className="w-5 h-5" />
                  </button>
                  <StatusBadge status={task.priority} type="priority" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-700">{task.title}</div>
                    {task.note && <div className="text-xs text-slate-500 mt-0.5">{task.note}</div>}
                  </div>
                  {task.due_date && (
                    <span className={`text-xs flex-shrink-0 ${overdue ? 'text-rose-600 font-medium' : 'text-slate-500'}`}>
                      {overdue && '⚠ '}{task.due_date}
                    </span>
                  )}
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button onClick={() => { setEditing(task); setShowForm(true); }} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded" title="編輯">
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDelete(task)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded" title="刪除">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 已完成 */}
      {completed.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-slate-500 mb-2 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            已完成
            <span className="text-xs text-slate-400 font-normal">（{completed.length} 件）</span>
          </h2>
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
            {completed.slice().reverse().map(task => (
              <div key={task.id} className="p-4 flex items-center gap-3 group hover:bg-slate-50 opacity-60">
                <button onClick={() => toggleComplete(task.id)} className="text-emerald-600 flex-shrink-0" title="取消完成">
                  <CheckCircle2 className="w-5 h-5" />
                </button>
                <span className="flex-1 text-sm text-slate-600 line-through truncate">{task.title}</span>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <button onClick={() => handleDelete(task)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded" title="刪除">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {showForm && <TaskForm task={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={handleSave} />}
      <ConfirmDialog config={confirmCfg} onClose={() => setConfirmCfg(null)} />
    </div>
  );
}

// ============================================================
// 主應用
// ============================================================

export default function RealEstateSystem() {
  const [data, setData] = useState(SEED_DATA);
  const [mode, setMode] = useState('storefront'); // 'storefront' | 'login'
  const [currentView, setCurrentView] = useState('dashboard');
  const [loaded, setLoaded] = useState(false);
  const [confirmCfg, setConfirmCfg] = useState(null);
  const [user, setUser] = useState(null);
  const [syncStatus, setSyncStatus] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'error'

  // 監聽 Supabase Auth 狀態
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user || null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const newUser = session?.user || null;
      setUser(newUser);
      // 登入成功時自動切換到後台
      if (newUser && mode === 'login') {
        setMode('storefront'); // 重設 mode
        setCurrentView('dashboard');
      }
    });

    return () => subscription.unsubscribe();
  }, [mode]);

  // 載入資料：登入後讀自己的；未登入讀最新更新的一筆（前台公開資料）
  useEffect(() => {
    (async () => {
      try {
        let query = supabase.from('app_data').select('data');
        if (user) {
          query = query.eq('user_id', user.id);
        } else {
          query = query.order('updated_at', { ascending: false }).limit(1);
        }
        const { data: rows, error } = await query;
        if (error) throw error;

        if (rows && rows.length > 0 && rows[0].data && Object.keys(rows[0].data).length > 0) {
          const parsed = rows[0].data;
          setData({
            ...SEED_DATA,
            ...parsed,
            agency: { ...SEED_DATA.agency, ...(parsed.agency || {}) },
            inquiries: parsed.inquiries || [],
            tasks: parsed.tasks || [],
          });
        } else if (user) {
          // 登入後第一次：上傳預設資料當作 seed
          await supabase.from('app_data').upsert({ user_id: user.id, data: SEED_DATA });
        }
      } catch (e) {
        console.error('載入失敗', e);
      }
      setLoaded(true);
    })();
  }, [user]);

  // 自動同步：data 變動時 debounce 0.8 秒後寫回 Supabase
  useEffect(() => {
    if (!loaded || !user) return;
    setSyncStatus('saving');
    const timer = setTimeout(async () => {
      try {
        const { error } = await supabase.from('app_data').upsert({ user_id: user.id, data });
        if (error) throw error;
        setSyncStatus('saved');
        setTimeout(() => setSyncStatus('idle'), 1500);
      } catch (e) {
        console.error('同步失敗', e);
        setSyncStatus('error');
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [data, loaded, user]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '.') {
        e.preventDefault();
        if (mode === 'storefront' && !user) setMode('login');
      }
      if (e.key === 'Escape' && mode === 'login') setMode('storefront');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, user]);

  useEffect(() => {
    const handler = () => { if (mode === 'storefront' && !user) setMode('login'); };
    window.addEventListener('admin-secret-trigger', handler);
    return () => window.removeEventListener('admin-secret-trigger', handler);
  }, [mode, user]);

  const autoTasks = useMemo(() => generateAutoTasks(data), [data]);

  // 未登入 + mode 是 login → 顯示登入頁
  if (!user && mode === 'login') {
    return <LoginPage agency={data.agency} onBack={() => setMode('storefront')} />;
  }

  // 未登入 → 前台
  if (!user) {
    return (
      <>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;600&display=swap');`}</style>
        <Storefront data={data} setData={setData} />
      </>
    );
  }

  // 後台
  const newInquiriesCount = (data.inquiries || []).filter(i => i.status === 'new').length;
  const navItems = [
    { id: 'dashboard', label: '工作台', icon: LayoutDashboard },
    { id: 'properties', label: '物件管理', icon: Building2 },
    { id: 'inquiries', label: '客戶詢問', icon: MessageSquare, badge: newInquiriesCount },
    { id: 'owners', label: '屋主管理', icon: UserCircle2 },
    { id: 'buyers', label: '買方管理', icon: Users },
    { id: 'matching', label: '智能媒合', icon: Target, highlight: true },
    { id: 'showings', label: '帶看紀錄', icon: Eye },
    { id: 'negotiations', label: '議價追蹤', icon: Handshake },
    { id: 'tasks', label: '任務中心', icon: CheckSquare, badge: autoTasks.length },
    { id: 'settings', label: '品牌設定', icon: Settings, divider: true },
    { id: 'credentials', label: '帳號安全', icon: Lock },
  ];

  const logout = () => {
    setConfirmCfg({
      title: '確定要登出嗎？',
      message: '登出後將回到前台。下次需要重新登入。',
      confirmText: '登出',
      onConfirm: async () => {
        await supabase.auth.signOut();
        setMode('storefront');
      },
    });
  };

  return (
    <div className="flex h-screen bg-slate-50" style={{ fontFamily: '-apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;600&display=swap');`}</style>

      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-5 border-b border-slate-100">
          <BrandLogo agency={data.agency} size="md" />
          <div className="flex items-center gap-1.5 mt-2">
            {syncStatus === 'saving' && <><div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" /><p className="text-xs text-slate-500">同步中...</p></>}
            {syncStatus === 'saved' && <><div className="w-1.5 h-1.5 rounded-full bg-emerald-500" /><p className="text-xs text-emerald-600">已同步到雲端</p></>}
            {syncStatus === 'error' && <><div className="w-1.5 h-1.5 rounded-full bg-rose-500" /><p className="text-xs text-rose-600">同步失敗</p></>}
            {syncStatus === 'idle' && <><div className="w-1.5 h-1.5 rounded-full bg-emerald-500" /><p className="text-xs text-slate-500">{user?.email}</p></>}
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map(item => {
            const Icon = item.icon;
            const active = currentView === item.id;
            return (
              <React.Fragment key={item.id}>
                {item.divider && <div className="my-2 border-t border-slate-100" />}
                <button onClick={() => setCurrentView(item.id)} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>
                  <Icon className="w-4 h-4" />
                  <span className="flex-1 text-left">{item.label}</span>
                  {item.highlight && !active && <Sparkles className="w-3 h-3 text-amber-500" />}
                  {item.badge > 0 && <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${active ? 'bg-white/20 text-white' : 'bg-rose-100 text-rose-700'}`}>{item.badge}</span>}
                </button>
              </React.Fragment>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-100">
          <button onClick={logout} className="w-full px-3 py-2 text-sm text-slate-600 hover:bg-rose-50 hover:text-rose-700 rounded-lg flex items-center gap-2 transition-colors">
            <LogOut className="w-4 h-4" /> 登出
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        {currentView === 'dashboard' && <Dashboard data={data} autoTasks={autoTasks} onNavigate={setCurrentView} />}
        {currentView === 'properties' && <PropertiesModule data={data} setData={setData} />}
        {currentView === 'inquiries' && <InquiriesModule data={data} setData={setData} />}
        {currentView === 'owners' && <OwnersModule data={data} setData={setData} />}
        {currentView === 'buyers' && <BuyersModule data={data} setData={setData} />}
        {currentView === 'matching' && <MatchingModule data={data} />}
        {currentView === 'showings' && <ShowingsModule data={data} />}
        {currentView === 'negotiations' && <NegotiationsModule data={data} />}
        {currentView === 'tasks' && <TasksModule data={data} setData={setData} autoTasks={autoTasks} />}
        {currentView === 'settings' && <BrandSettingsModule data={data} setData={setData} />}
        {currentView === 'credentials' && <CredentialsModule user={user} />}
      </main>

      <ConfirmDialog config={confirmCfg} onClose={() => setConfirmCfg(null)} />
    </div>
  );
}
