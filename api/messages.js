const { Redis } = require("@upstash/redis");

const ADDITIONS_KEY = "pony:additions";
const CUSTOM_KEY = "pony:custom";
const COUNT_TOTAL_KEY = "pony:count:total";
const COUNT_DAY_PREFIX = "pony:count:day:";
const COUNT_WEEK_PREFIX = "pony:count:week:";
const COUNT_MONTH_PREFIX = "pony:count:month:";

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

function formatDayKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatMonthKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getISOWeekKey(date) {
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getCounterKeys(nowDate) {
  const prevMonth = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - 1, 1));

  return {
    total: COUNT_TOTAL_KEY,
    today: `${COUNT_DAY_PREFIX}${formatDayKey(nowDate)}`,
    week: `${COUNT_WEEK_PREFIX}${getISOWeekKey(nowDate)}`,
    currentMonth: `${COUNT_MONTH_PREFIX}${formatMonthKey(nowDate)}`,
    prevMonth: `${COUNT_MONTH_PREFIX}${formatMonthKey(prevMonth)}`
  };
}

async function readCounters(redis, nowDate) {
  const keys = getCounterKeys(nowDate);

  const [total, today, week, prevMonth] = await Promise.all([
    redis.get(keys.total),
    redis.get(keys.today),
    redis.get(keys.week),
    redis.get(keys.prevMonth)
  ]);

  return {
    addsTotal: Number(total) || 0,
    addsToday: Number(today) || 0,
    addsWeek: Number(week) || 0,
    addsPrevMonth: Number(prevMonth) || 0
  };
}

module.exports = async function handler(req, res) {
  const redis = getRedis();

  if (!redis) {
    res.status(500).json({ error: "kv_not_configured" });
    return;
  }

  if (req.method === "GET") {
    try {
      const nowDate = new Date();
      const [rawAdditions, rawCustom] = await Promise.all([
        redis.lrange(ADDITIONS_KEY, 0, 299),
        redis.lrange(CUSTOM_KEY, 0, -1)
      ]);
      const counters = await readCounters(redis, nowDate);

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

      res.status(200).json({ additionLogs, customLogs, counters });
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
        const nowDate = new Date();
        const counterKeys = getCounterKeys(nowDate);
        const entry = {
          id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`,
          ts: Date.now()
        };

        await Promise.all([
          redis.lpush(ADDITIONS_KEY, entry),
          redis.ltrim(ADDITIONS_KEY, 0, 999),
          redis.incr(counterKeys.total),
          redis.incr(counterKeys.today),
          redis.incr(counterKeys.week),
          redis.incr(counterKeys.currentMonth)
        ]);

        const counters = await readCounters(redis, nowDate);

        res.status(200).json({ ok: true, entry, counters });
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
