require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const db = (t, p) => pool.query(t, p);

app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

// ── HEALTH ──
app.get('/api/health', (req, res) => res.json({ success: true, service: 'Xona.Hast.tj' }));
app.get('/api/cities', (req, res) => res.json({ success: true, cities: ['Душанбе','Худжанд','Бохтар','Куляб','Истаравшан','Канибадам','Пенджикент','Хорог','Турсунзаде'] }));
app.get('/api/pricing', (req, res) => res.json({ success: true, listing: { create: { price: 0, days: 14 } }, bump: [{ days:2,price:3 },{ days:3,price:4 },{ days:5,price:5 }], reactivate: { price: 5 } }));

// ── AUTH ──
const genCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const genPromo = () => { let c='XH-'; const s='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for(let i=0;i<6;i++) c+=s[Math.floor(Math.random()*s.length)]; return c; };
const authMW = async (req, res, next) => {
  try {
    const t = req.headers.authorization?.split(' ')[1];
    const d = jwt.verify(t, process.env.JWT_SECRET || 'secret');
    const u = (await db('SELECT * FROM users WHERE id=$1 AND is_blocked=FALSE',[d.id])).rows[0];
    if (!u) return res.status(401).json({ success:false, message:'Не найден' });
    req.user = u; next();
  } catch(e) { res.status(401).json({ success:false, message:'Неверный токен' }); }
};
const adminMW = async (req,res,next) => authMW(req,res,async()=>{ if(req.user.role!=='admin') return res.status(403).json({success:false,message:'Только админ'}); next(); });

app.post('/api/auth/send-code', async (req,res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success:false, message:'Укажите телефон' });
    await db('DELETE FROM sms_codes WHERE phone=$1',[phone]);
    const code = genCode();
    await db('INSERT INTO sms_codes (phone,code,expires_at) VALUES ($1,$2,$3)',[phone,code,new Date(Date.now()+5*60000)]);
    console.log(`📱 SMS ${phone}: ${code}`);
    res.json({ success:true, message:'SMS отправлен', dev_code: code });
  } catch(e) { res.status(500).json({ success:false, message:'Ошибка' }); }
});

app.post('/api/auth/verify-code', async (req,res) => {
  try {
    const { phone, code, name } = req.body;
    const r = await db('SELECT * FROM sms_codes WHERE phone=$1 AND code=$2 AND is_used=FALSE AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1',[phone,code]);
    if (!r.rows.length) return res.status(400).json({ success:false, message:'Неверный код' });
    await db('UPDATE sms_codes SET is_used=TRUE WHERE id=$1',[r.rows[0].id]);
    let user = (await db('SELECT * FROM users WHERE phone=$1',[phone])).rows[0];
    let isNew = false;
    if (!user) { isNew=true; user=(await db('INSERT INTO users (phone,name,promo_code,is_verified) VALUES ($1,$2,$3,TRUE) RETURNING *',[phone,name||null,genPromo()])).rows[0]; }
    const token = jwt.sign({ id:user.id, phone:user.phone, role:user.role }, process.env.JWT_SECRET||'secret', { expiresIn:'30d' });
    res.json({ success:true, is_new:isNew, token, user:{ id:user.id, phone:user.phone, name:user.name, role:user.role, promo_code:user.promo_code } });
  } catch(e) { console.error(e); res.status(500).json({ success:false, message:'Ошибка' }); }
});

app.get('/api/auth/me', authMW, (req,res) => res.json({ success:true, user:req.user }));
app.put('/api/auth/profile', authMW, async (req,res) => {
  const u = (await db('UPDATE users SET name=$1 WHERE id=$2 RETURNING *',[req.body.name,req.user.id])).rows[0];
  res.json({ success:true, user:u });
});

// ── LISTINGS ──
app.get('/api/listings', async (req,res) => {
  try {
    const { city,type,deal,rooms,min_price,max_price,search,page=1,limit=20,sort='vip_first' } = req.query;
    const conds = ["l.status='active'", "l.expires_at > NOW()"];
    const params = [];
    let p = 1;
    if (city)      { conds.push(`l.city=$${p++}`);           params.push(city); }
    if (type)      { conds.push(`l.type=$${p++}`);           params.push(type); }
    if (deal)      { conds.push(`l.deal=$${p++}`);           params.push(deal); }
    if (rooms)     { conds.push(`l.rooms=$${p++}`);          params.push(parseInt(rooms)); }
    if (min_price) { conds.push(`l.price_somoni>=$${p++}`);  params.push(parseFloat(min_price)); }
    if (max_price) { conds.push(`l.price_somoni<=$${p++}`);  params.push(parseFloat(max_price)); }
    if (search)    { conds.push(`(l.title ILIKE $${p++} OR l.description ILIKE $${p++})`); params.push(`%${search}%`,`%${search}%`); }
    const order = sort==='price_asc'?'l.price_somoni ASC':sort==='price_desc'?'l.price_somoni DESC':sort==='newest'?'l.created_at DESC':"CASE WHEN l.vip_type='premium' THEN 1 WHEN l.vip_type='vip' THEN 2 ELSE 3 END, l.created_at DESC";
    const offset = (parseInt(page)-1)*parseInt(limit);
    const [rows,cnt] = await Promise.all([
      db(`SELECT l.*,u.name as user_name,u.phone as user_phone,u.role as user_role FROM listings l LEFT JOIN users u ON u.id=l.user_id WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT $${p} OFFSET $${p+1}`,[...params,parseInt(limit),offset]),
      db(`SELECT COUNT(*) FROM listings l WHERE ${conds.join(' AND ')}`,params)
    ]);
    res.json({ success:true, data:rows.rows, pagination:{ total:parseInt(cnt.rows[0].count), page:parseInt(page), pages:Math.ceil(parseInt(cnt.rows[0].count)/parseInt(limit)) } });
  } catch(e) { console.error(e); res.status(500).json({ success:false, message:'Ошибка' }); }
});

app.get('/api/listings/my/list', authMW, async (req,res) => {
  const r = await db('SELECT * FROM listings WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]);
  res.json({ success:true, data:r.rows });
});

app.get('/api/listings/:id', async (req,res) => {
  try {
    const r = await db('SELECT l.*,u.name as user_name,u.phone as user_phone,u.role as user_role FROM listings l LEFT JOIN users u ON u.id=l.user_id WHERE l.id=$1 AND l.status=$2',[req.params.id,'active']);
    if (!r.rows.length) return res.status(404).json({ success:false, message:'Не найдено' });
    await db('UPDATE listings SET views_count=views_count+1 WHERE id=$1',[req.params.id]);
    res.json({ success:true, data:r.rows[0] });
  } catch(e) { res.status(500).json({ success:false, message:'Ошибка' }); }
});

app.post('/api/listings', authMW, upload.array('photos',10), async (req,res) => {
  try {
    const { title,description,type,deal,price_somoni,price_usd,rooms,area_m2,floor,floors_total,city,district,address,lat,lng,contact_phone,contact_whatsapp } = req.body;
    if (!title||!type||!deal) return res.status(400).json({ success:false, message:'Заполните обязательные поля' });
    const photos = req.files ? req.files.map((_,i)=>`https://placeholder.com/photo_${i+1}.jpg`) : [];
    const expires = new Date(Date.now()+14*24*60*60*1000);
    const l = (await db(`INSERT INTO listings (user_id,title,description,type,deal,price_somoni,price_usd,rooms,area_m2,floor,floors_total,city,district,address,lat,lng,photos,contact_phone,contact_whatsapp,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'active',$20) RETURNING *`,[req.user.id,title,description,type,deal,price_somoni||null,price_usd||null,rooms||null,area_m2||null,floor||null,floors_total||null,city||'Душанбе',district||null,address||null,lat||null,lng||null,JSON.stringify(photos),contact_phone||req.user.phone,contact_whatsapp||null,expires])).rows[0];
    res.status(201).json({ success:true, message:'Объявление опубликовано! 14 дней бесплатно.', data:l });
  } catch(e) { console.error(e); res.status(500).json({ success:false, message:'Ошибка' }); }
});

app.delete('/api/listings/:id', authMW, async (req,res) => {
  await db("UPDATE listings SET status='archived' WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);
  res.json({ success:true, message:'Архивировано' });
});

app.post('/api/listings/:id/favorite', authMW, async (req,res) => {
  const ex = await db('SELECT * FROM favorites WHERE user_id=$1 AND listing_id=$2',[req.user.id,req.params.id]);
  if (ex.rows.length) { await db('DELETE FROM favorites WHERE user_id=$1 AND listing_id=$2',[req.user.id,req.params.id]); return res.json({ success:true, favorited:false }); }
  await db('INSERT INTO favorites (user_id,listing_id) VALUES ($1,$2)',[req.user.id,req.params.id]);
  res.json({ success:true, favorited:true });
});

// ── PAYMENTS ──
const BUMPS = [{ days:2,price:3 },{ days:3,price:4 },{ days:5,price:5 }];
app.get('/api/payments/bump-options/:id', authMW, async (req,res) => {
  const l = (await db('SELECT * FROM listings WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id])).rows[0];
  if (!l) return res.status(404).json({ success:false, message:'Не найдено' });
  const exp = new Date(l.expires_at);
  const daysLeft = Math.max(0,Math.ceil((exp-Date.now())/86400000));
  const isExp = exp < new Date();
  res.json({ success:true, data:{ is_expired:isExp, days_left:daysLeft, plans:isExp?[]:BUMPS, reactivation_price:5 } });
});

app.post('/api/payments/bump', authMW, async (req,res) => {
  try {
    const { listing_id, days } = req.body;
    const plan = BUMPS.find(p=>p.days===parseInt(days));
    if (!plan) return res.status(400).json({ success:false, message:'Неверный план', plans:BUMPS });
    const l = (await db('SELECT * FROM listings WHERE id=$1 AND user_id=$2',[listing_id,req.user.id])).rows[0];
    if (!l) return res.status(404).json({ success:false, message:'Не найдено' });
    const base = new Date(l.expires_at) > new Date() ? new Date(l.expires_at) : new Date();
    const newExp = new Date(base.getTime()+plan.days*86400000);
    await db("UPDATE listings SET expires_at=$1,status='active',last_bumped_at=NOW(),bump_count=COALESCE(bump_count,0)+1 WHERE id=$2",[newExp,listing_id]);
    await db("INSERT INTO payments (user_id,listing_id,type,amount_somoni,status,payment_method,days) VALUES ($1,$2,'bump',$3,'success','dev',$4)",[req.user.id,listing_id,plan.price,plan.days]);
    res.json({ success:true, paid:true, message:`Поднято на ${plan.days} дней!`, price:plan.price });
  } catch(e) { res.status(500).json({ success:false, message:'Ошибка' }); }
});

app.post('/api/payments/reactivate', authMW, async (req,res) => {
  const newExp = new Date(Date.now()+14*86400000);
  await db("UPDATE listings SET status='active',expires_at=$1 WHERE id=$2 AND user_id=$3",[newExp,req.body.listing_id,req.user.id]);
  await db("INSERT INTO payments (user_id,listing_id,type,amount_somoni,status,payment_method,days) VALUES ($1,$2,'reactivate',5,'success','dev',14)",[req.user.id,req.body.listing_id]);
  res.json({ success:true, paid:true, message:'Реактивировано на 14 дней!' });
});

app.get('/api/payments/history', authMW, async (req,res) => {
  const r = await db('SELECT p.*,l.title as listing_title FROM payments p LEFT JOIN listings l ON l.id=p.listing_id WHERE p.user_id=$1 ORDER BY p.created_at DESC LIMIT 50',[req.user.id]);
  res.json({ success:true, data:r.rows });
});

// ── ADMIN ──
app.post('/api/admin/verify-shake-code', (req,res) => {
  if (req.body.code !== (process.env.ADMIN_SHAKE_CODE||'123456')) return res.status(403).json({ success:false, message:'Неверный код' });
  res.json({ success:true, message:'Добро пожаловать в админку!' });
});

app.get('/api/admin/stats', adminMW, async (req,res) => {
  const [u,l,p] = await Promise.all([
    db('SELECT COUNT(*) FROM users'),
    db("SELECT COUNT(*) FILTER (WHERE status='active') as active, COUNT(*) FILTER (WHERE status='pending') as pending FROM listings"),
    db("SELECT COALESCE(SUM(amount_somoni) FILTER (WHERE status='success'),0) as revenue FROM payments")
  ]);
  res.json({ success:true, stats:{ users:u.rows[0], listings:l.rows[0], payments:p.rows[0] } });
});

app.get('/api/admin/listings/pending', adminMW, async (req,res) => {
  const r = await db("SELECT l.*,u.name as user_name,u.phone as user_phone FROM listings l LEFT JOIN users u ON u.id=l.user_id WHERE l.status='pending' ORDER BY l.created_at ASC");
  res.json({ success:true, data:r.rows });
});

app.post('/api/admin/listings/:id/approve', adminMW, async (req,res) => {
  const l = (await db("UPDATE listings SET status='active' WHERE id=$1 RETURNING *",[req.params.id])).rows[0];
  res.json({ success:true, data:l });
});

app.post('/api/admin/listings/:id/reject', adminMW, async (req,res) => {
  const l = (await db("UPDATE listings SET status='rejected',reject_reason=$1 WHERE id=$2 RETURNING *",[req.body.reason||'Нарушение правил',req.params.id])).rows[0];
  res.json({ success:true, data:l });
});

app.post('/api/admin/users/:id/give-vip', adminMW, async (req,res) => {
  const { days=7, listing_id } = req.body;
  const vipUntil = new Date(Date.now()+days*86400000);
  if (listing_id) await db("UPDATE listings SET vip_type='vip',vip_until=$1 WHERE id=$2",[vipUntil,listing_id]);
  await db("INSERT INTO payments (user_id,listing_id,type,amount_somoni,status,payment_method,days) VALUES ($1,$2,'vip',0,'success','admin',$3)",[req.params.id,listing_id||null,days]);
  res.json({ success:true, message:`VIP на ${days} дней выдан бесплатно!` });
});

app.post('/api/admin/users/:id/block', adminMW, async (req,res) => {
  await db('UPDATE users SET is_blocked=TRUE,block_reason=$1 WHERE id=$2',[req.body.reason,req.params.id]);
  res.json({ success:true, message:'Заблокирован' });
});

app.post('/api/admin/promo', adminMW, async (req,res) => {
  const { count=1, type='registration' } = req.body;
  const codes = [];
  for(let i=0;i<Math.min(count,50);i++) { const c=genPromo(); await db('INSERT INTO promo_codes (code,type,created_by) VALUES ($1,$2,$3)',[c,type,req.user.id]); codes.push(c); }
  res.json({ success:true, codes });
});

// ── USERS ──
app.get('/api/users/:id/profile', async (req,res) => {
  const u = (await db('SELECT u.id,u.name,u.avatar_url,u.role,u.created_at,COUNT(DISTINCT l.id) FILTER (WHERE l.status=$1) as active_listings FROM users u LEFT JOIN listings l ON l.user_id=u.id WHERE u.id=$2 AND u.is_blocked=FALSE GROUP BY u.id',['active',req.params.id])).rows[0];
  if (!u) return res.status(404).json({ success:false, message:'Не найден' });
  const badges = { agent:{label:'Риелтор ✓',color:'#16A34A'}, developer:{label:'Застройщик',color:'#2563EB'} };
  res.json({ success:true, data:{ ...u, role_badge:badges[u.role]||null, is_verified:['agent','developer','admin'].includes(u.role) } });
});

app.get('/api/users/:id/listings', async (req,res) => {
  const r = await db("SELECT * FROM listings WHERE user_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 50",[req.params.id]);
  res.json({ success:true, data:r.rows });
});

app.post('/api/users/:id/set-role', adminMW, async (req,res) => {
  const u = (await db('UPDATE users SET role=$1 WHERE id=$2 RETURNING id,name,phone,role',[req.body.role,req.params.id])).rows[0];
  res.json({ success:true, data:u });
});

// ── DB INIT ──
async function initDB() {
  await db(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await db(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), phone VARCHAR(20) UNIQUE NOT NULL, name VARCHAR(100), avatar_url TEXT, role VARCHAR(20) DEFAULT 'user', is_verified BOOLEAN DEFAULT FALSE, is_blocked BOOLEAN DEFAULT FALSE, block_reason TEXT, promo_code VARCHAR(20) UNIQUE, vip_until TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS sms_codes (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), phone VARCHAR(20) NOT NULL, code VARCHAR(6) NOT NULL, is_used BOOLEAN DEFAULT FALSE, expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS listings (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID REFERENCES users(id), title VARCHAR(200) NOT NULL, description TEXT, type VARCHAR(30) NOT NULL, deal VARCHAR(20) NOT NULL, price_somoni NUMERIC(12,2), price_usd NUMERIC(10,2), rooms INT, area_m2 NUMERIC(8,2), floor INT, floors_total INT, city VARCHAR(100) DEFAULT 'Душанбе', district VARCHAR(100), address TEXT, lat NUMERIC(10,7), lng NUMERIC(10,7), photos JSONB DEFAULT '[]', status VARCHAR(20) DEFAULT 'active', vip_type VARCHAR(20), vip_until TIMESTAMP, views_count INT DEFAULT 0, contact_phone VARCHAR(20), contact_whatsapp VARCHAR(20), tg_post_id TEXT, ig_post_id TEXT, expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '14 days'), last_bumped_at TIMESTAMP, bump_count INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID REFERENCES users(id), listing_id UUID REFERENCES listings(id), type VARCHAR(30) NOT NULL, amount_somoni NUMERIC(10,2) DEFAULT 0, status VARCHAR(20) DEFAULT 'pending', payment_method VARCHAR(30), days INT, created_at TIMESTAMP DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS promo_codes (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), code VARCHAR(20) UNIQUE NOT NULL, type VARCHAR(20) DEFAULT 'registration', created_by UUID, used_by UUID, is_used BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS favorites (user_id UUID, listing_id UUID, created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (user_id, listing_id))`);
  await db(`CREATE TABLE IF NOT EXISTS blacklist (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), phone VARCHAR(20), user_id UUID, reason TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  console.log('✅ База данных готова!');
}
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🏠 Xona.Hast.tj API запущен на порту ${PORT}`));
initDB().catch(e => console.error('❌ Ошибка БД:', e));
