let channel = null;

const connect = async () => {
  try {
    const amqp = require('amqplib');
    const url  = process.env.RABBITMQ_URL || 'amqp://sofra:sofra123@rabbitmq:5672';
    const conn = await amqp.connect(url);
    channel    = await conn.createChannel();

    await channel.assertExchange('sofra', 'topic', { durable: true });
    await channel.assertQueue('orders',        { durable: true });
    await channel.assertQueue('notifications', { durable: true });
    await channel.bindQueue('orders',        'sofra', 'order.*');
    await channel.bindQueue('notifications', 'sofra', '*.notify');

    console.log('✅ RabbitMQ connected');

    conn.on('error', (e) => {
      console.warn('RabbitMQ connection error:', e.message);
      channel = null;
    });
  } catch (err) {
    console.warn('⚠️ RabbitMQ not available:', err.message);
    channel = null;
    throw err;
  }
};

const publishEvent = async (routingKey, payload) => {
  if (!channel) return;
  try {
    channel.publish(
      'sofra', routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true }
    );
  } catch (e) {
    console.warn('Queue publish error:', e.message);
  }
};

const consume = async (queue, handler) => {
  if (!channel) return;
  channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const data = JSON.parse(msg.content.toString());
      await handler(data);
      channel.ack(msg);
    } catch (err) {
      console.error('Queue handler error:', err);
      channel.nack(msg, false, false);
    }
  });
};

module.exports = { connect, publishEvent, consume };
