require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ success: true, service: 'Xona.Hast.tj API', version: '1.0.0' });
});

const authRoutes = require('./routes/auth');
const listingRoutes = require('./routes/listings');
const paymentRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/users');

app.use('/api/auth', authRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);

app.get('/api/cities', (req, res) => {
  res.json({ success: true, cities: ['Душанбе','Худжанд','Бохтар','Куляб','Истаравшан','Канибадам','Пенджикент','Хорог','Турсунзаде'] });
});

app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Не найдено' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🏠 Xona.Hast.tj запущен на порту ${PORT}`));
module.exports = app;
