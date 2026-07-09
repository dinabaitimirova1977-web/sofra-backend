const { createClient } = require('redis');

const client = createClient({
  url: process.env.REDIS_URL || 'redis://:redis123@localhost:6379',
});

client.on('error',   (err) => console.error('Redis error:', err.message));
client.on('connect', ()    => console.log('✅ Redis connected'));

const connect = async () => {
  if (!client.isOpen) await client.connect();
};

const set = (key, value, ttl = 3600) =>
  client.setEx(key, ttl, JSON.stringify(value));

const get = async (key) => {
  const val = await client.get(key);
  return val ? JSON.parse(val) : null;
};

const del = (key) => client.del(key);

module.exports = { connect, set, get, del, client };
