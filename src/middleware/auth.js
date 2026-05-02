'use strict';

const bcrypt = require('bcryptjs');
const config = require('../config/config');
const { isSubscriptionActive } = require('../database/localDb');

function isAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Unauthorized. Please login.' });
}

function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(403).json({ error: 'Forbidden. Admin access only.' });
}

async function isPaid(req, res, next) {
  try {
    if (req.session.isAdmin) return next();
    const uid = req.session.userId;
    if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
    const active = await isSubscriptionActive(uid);
    if (!active) return res.status(403).json({
      error: 'No active subscription. Please purchase a plan.',
    });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Subscription check failed.' });
  }
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function comparePassword(plain, hashed) {
  return bcrypt.compare(plain, hashed);
}

function isStrongPassword(password) {
  if (!password || password.length < 8) return false;
  if (!/[A-Z]/.test(password))          return false;
  if (!/[^a-zA-Z0-9]/.test(password))   return false;
  return true;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidWhatsApp(number) {
  return typeof number === 'string' && /^[0-9]{10,15}$/.test(number.replace(/[^0-9]/g, ''));
}

module.exports = {
  isAuth, isAdmin, isPaid,
  hashPassword, comparePassword,
  isStrongPassword, isValidEmail, isValidWhatsApp,
};
