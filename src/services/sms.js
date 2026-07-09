const redis = require('../config/redis');
const crypto = require('crypto');

const OTP_TTL     = 120;  // 2 минуты
const OTP_LENGTH  = 6;
const MAX_ATTEMPTS = 3;   // максимум попыток ввода
const MAX_SENDS   = 5;    // максимум отправок в час с одного номера

// ─── Генерация OTP ────────────────────────────────────────
const generateOTP = () =>
  crypto.randomInt(100000, 999999).toString();

// ─── Ключи Redis ──────────────────────────────────────────
const keys = {
  otp:      (phone) => `otp:code:${phone}`,
  attempts: (phone) => `otp:attempts:${phone}`,
  sends:    (phone) => `otp:sends:${phone}`,
  blocked:  (phone) => `otp:blocked:${phone}`,
};

// ─── Отправка OTP ─────────────────────────────────────────
const sendOTP = async (phone) => {
  // Проверяем блокировку
  const blocked = await redis.get(keys.blocked(phone));
  if (blocked) {
    const ttl = await redis.client.ttl(keys.blocked(phone));
    throw { status: 429, message: `Номер заблокирован. Попробуйте через ${Math.ceil(ttl / 60)} мин` };
  }

  // Считаем отправки за час
  const sends = await redis.client.incr(keys.sends(phone));
  if (sends === 1) await redis.client.expire(keys.sends(phone), 3600);
  if (sends > MAX_SENDS) {
    // Блокируем на 1 час
    await redis.client.setEx(keys.blocked(phone), 3600, '1');
    throw { status: 429, message: 'Превышен лимит отправок. Номер заблокирован на 1 час' };
  }

  const code = generateOTP();

  // Сохраняем код в Redis
  await redis.set(keys.otp(phone), { code, phone }, OTP_TTL);
  // Сбрасываем счётчик попыток
  await redis.del(keys.attempts(phone));

  // Отправляем SMS через провайдера
  await sendViaSMSProvider(phone, code);

  return { expires_in: OTP_TTL, sends_left: MAX_SENDS - sends };
};

// ─── Верификация OTP ──────────────────────────────────────
const verifyOTP = async (phone, inputCode) => {
  const stored = await redis.get(keys.otp(phone));

  if (!stored) {
    throw { status: 400, message: 'Код истёк или не был отправлен' };
  }

  // Счётчик неверных попыток
  const attempts = await redis.client.incr(keys.attempts(phone));
  if (attempts === 1) await redis.client.expire(keys.attempts(phone), OTP_TTL);

  if (attempts > MAX_ATTEMPTS) {
    await redis.del(keys.otp(phone));
    throw { status: 429, message: 'Превышено количество попыток. Запросите новый код' };
  }

  if (stored.code !== inputCode) {
    throw {
      status: 400,
      message: 'Неверный код',
      attempts_left: MAX_ATTEMPTS - attempts,
    };
  }

  // Код верный — удаляем из Redis
  await redis.del(keys.otp(phone));
  await redis.del(keys.attempts(phone));

  return true;
};

// ─── SMS провайдер ────────────────────────────────────────
// Поддерживаем несколько провайдеров с фоллбэком
const sendViaSMSProvider = async (phone, code) => {
  const message = `Sofra: ваш код подтверждения ${code}. Действителен ${OTP_TTL / 60} минуты.`;

  const provider = process.env.SMS_PROVIDER || 'console';

  switch (provider) {
    case 'smsc':
      return sendViaSMSC(phone, message);
    case 'smsru':
      return sendViaSMSRu(phone, message);
    case 'twilio':
      return sendViaTwilio(phone, message);
    default:
      // В dev режиме просто выводим в консоль
      console.log(`\n📱 SMS → ${phone}: ${message}\n`);
      return;
  }
};

// ─── SMSC.ru ──────────────────────────────────────────────
const sendViaSMSC = async (phone, message) => {
  const https = require('https');
  const params = new URLSearchParams({
    login:   process.env.SMSC_LOGIN,
    psw:     process.env.SMSC_PASSWORD,
    phones:  phone,
    mes:     message,
    fmt:     3,  // JSON ответ
    charset: 'utf-8',
  });

  const url = `https://smsc.ru/sys/send.php?${params}`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (data.error) throw new Error(`SMSC error: ${data.error}`);
  return data;
};

// ─── SMS.ru ───────────────────────────────────────────────
const sendViaSMSRu = async (phone, message) => {
  const params = new URLSearchParams({
    api_id: process.env.SMSRU_API_ID,
    to:     phone,
    msg:    message,
    json:   1,
  });

  const resp = await fetch(`https://sms.ru/sms/send?${params}`);
  const data = await resp.json();

  if (data.status !== 'OK') throw new Error(`SMS.ru error: ${data.status_text}`);
  return data;
};

// ─── Twilio ───────────────────────────────────────────────
const sendViaTwilio = async (phone, message) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;

  const body = new URLSearchParams({ To: phone, From: from, Body: message });
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }
  );

  const data = await resp.json();
  if (data.error_code) throw new Error(`Twilio error: ${data.error_message}`);
  return data;
};

module.exports = { sendOTP, verifyOTP };
