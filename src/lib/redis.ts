import Redis from "ioredis";

const globalForRedis = global as unknown as {
  redisPublisher: Redis;
};

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL environment variable is not set");
  }
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}

export const redisPublisher =
  globalForRedis.redisPublisher || createRedisClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redisPublisher = redisPublisher;
}

export function createRedisSubscriber(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL environment variable is not set");
  }
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}
