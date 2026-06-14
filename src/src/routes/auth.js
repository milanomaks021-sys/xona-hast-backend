const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { query } = require('../../config/database');

const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const generatePromo = () => { let c='XH-'; const s='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for(let i=0;i<6;i++) c+=s[Math.floor(Math.random()*s.length)]; return c; };

router.post('/send-code', async (req, res) => {
  try {
    const phone = req.body.phone;
    if (!phone) return res.status(400).json({ success: false, message: 'Укажите телефон' });
    await query('DELETE FROM sms_codes WHERE phone = $1', [phone]);
    const code = generateCode();
    const exp = new Date(Date.now() + 5 * 60 * 1000);
    await query('INSERT INTO sms_codes (phone, code, expires_at) VALUES ($1, $2, $3)', [phone, code, exp]);
    console.log(`SMS ${phone}: ${code}`);
    res.json({ success: true, message: 'SMS отправлен', ...(process.env.NODE_ENV !== 'production' && { dev_code: code }) });
  } catch(e) { res.status(500).json({ success: false, message: 'Ошибка' }); }
});

router.post('/verify-code', async (req, res) => {
  try {
    const { phone, code, name, promo_code } = req.body;
    const r = await query('SELECT * FROM sms_codes WHERE phone=$1 AND code=$2 AND is_used=FALSE AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1', [phone, code]);
    if (!r.rows.length) return res.status(400).json({ success: false, message: 'Неверный код' });
    await query('UPDATE sms_codes SET is_used=TRUE WHERE id=$1', [r.rows[0].id]);
    let user = (await query('SELECT * FROM users WHERE phone=$1', [phone])).rows[0];
    let isNew = false;
    if (!user) {
      isNew = true;
      user = (await query('INSERT INTO users (phone, name, promo_code, is_verified) VALUES ($1,$2,$3,TRUE) RETURNING *', [phone, name||null, generatePromo()])).rows[0];
    }
    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, is_new: isNew, token, user: { id: user.id, phone: user.phone, name: user.name, role: user.role, promo_code: user.promo_code } });
  } catch(e) { console.error(e); res.status(500).json({ success: false, message: 'Ошибка' }); }
});

router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = (await query('SELECT * FROM users WHERE id=$1', [decoded.id])).rows[0];
    res.json({ success: true, user });
  } catch(e) { res.status(401).json({ success: false, message: 'Не авторизован' }); }
});

module.exports = router;
