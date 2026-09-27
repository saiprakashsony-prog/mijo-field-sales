require('dotenv').config();
require('express-async-errors'); // lets async route handlers' rejections reach the error middleware below instead of crashing the process
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/distributors', require('./routes/distributors'));
app.use('/api/territories', require('./routes/territories'));
app.use('/api/mandals', require('./routes/mandals'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/retailers', require('./routes/retailers'));
app.use('/api/visits', require('./routes/visits'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/schemes', require('./routes/schemes').router);
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/users', require('./routes/users'));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized error handler — keeps a single bad request/DB hiccup from taking the whole server down
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.sqlMessage || err.message || 'Server error' });
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`MIJO Field Sales server running on port ${PORT}`));
