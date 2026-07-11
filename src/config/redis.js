let client = null;
let isConnected = false;

const connect = async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('⚠️ REDIS_URL not set, Redis disabled');
    return;
  }
  try {
    const { createClient } = require('redis');
    client = createClient({ url: redisUrl });
    client.on('error', (err) => console.warn('Redis error:', err.message));
    await client.connect();
    isConnected = true;
    console.log('✅ Redis connected');
  } catch (err) {
    console.warn('⚠️ Redis not available:', err.message);
    client = null;
    isConnected = false;
  }
};

const set = async (key, value, ttl = 3600) => {
  if (!isConnected || !client) return null;
  try {
    return await client.setEx(key, ttl, JSON.stringify(value));
  } catch (e) { return null; }
};

const get = async (key) => {
  if (!isConnected || !client) return null;
  try {
    const val = await client.get(key);
    return val ? JSON.parse(val) : null;
  } catch (e) { return null; }
};

const del = async (key) => {
  if (!isConnected || !client) return null;
  try { return await client.del(key); } catch (e) { return null; }
};

const getClient = () => client;

module.exports = { connect, set, get, del, client: new Proxy({}, {
  get: (_, prop) => {
    if (client) return client[prop];
    return async () => null;
  }
})};
