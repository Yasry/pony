const { Redis } = require("@upstash/redis");

const ADDITIONS_KEY = "pony:additions";
const CUSTOM_KEY = "pony:custom";

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  return new Redis({ url, token });
}

function toObject(value) {
  if (value && typeof value === "object") {
    return value;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  return null;
}

module.exports = async function handler(req, res) {
  const redis = getRedis();

  if (!redis) {
    res.status(500).json({ error: "kv_not_configured" });
    return;
  }

  if (req.method === "GET") {
    try {
      const [rawAdditions, rawCustom] = await Promise.all([
        redis.lrange(ADDITIONS_KEY, 0, 299),
        redis.lrange(CUSTOM_KEY, 0, -1)
      ]);

      const additionLogs = (rawAdditions || [])
        .map(toObject)
        .filter((item) => item && typeof item.ts === "number")
        .map((item) => ({ ts: item.ts, id: item.id || String(item.ts) }));

      const customLogs = (rawCustom || [])
        .map(toObject)
        .filter((item) => item && typeof item.message === "string")
        .map((item) => ({
          id: item.id || String(item.ts || Date.now()),
          ts: Number(item.ts) || Date.now(),
          message: String(item.message).slice(0, 280)
        }));

      res.status(200).json({ additionLogs, customLogs });
      return;
    } catch (error) {
      res.status(500).json({ error: "fetch_failed" });
      return;
    }
  }

  if (req.method === "POST") {
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const type = body.type;

    if (type !== "addition" && type !== "custom") {
      res.status(400).json({ error: "invalid_type" });
      return;
    }

    try {
      if (type === "addition") {
        const entry = {
          id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`,
          ts: Date.now()
        };

        await redis.lpush(ADDITIONS_KEY, entry);
        await redis.ltrim(ADDITIONS_KEY, 0, 999);

        res.status(200).json({ ok: true, entry });
        return;
      }

      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        res.status(400).json({ error: "empty_message" });
        return;
      }

      const entry = {
        id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`,
        ts: Date.now(),
        message: message.slice(0, 280)
      };

      await redis.lpush(CUSTOM_KEY, entry);

      res.status(200).json({ ok: true, entry });
      return;
    } catch (error) {
      res.status(500).json({ error: "write_failed" });
      return;
    }
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "method_not_allowed" });
};
