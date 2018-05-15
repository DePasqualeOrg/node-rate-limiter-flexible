const RateLimiterAbstract = require('./RateLimiterAbstract');
const RateLimiterRes = require('./RateLimiterRes');
const BlockedKeys = require('./component/BlockedKeys');

const handleRedisError = function(funcName, resolve, reject, key, pointsToConsume) {
  if (!(this.insuranceLimiter instanceof RateLimiterAbstract)) {
    reject(new Error('Redis Client error'));
  } else {
    this.insuranceLimiter[funcName](key, pointsToConsume)
      .then((res) => {
        resolve(res);
      })
      .catch((res) => {
        reject(res);
      })
  }
};

const afterConsume = function(resolve, reject, rlKey, results) {
  const [resSet, consumed, resTtlMs] = results;
  const res = new RateLimiterRes();
  let isFirstInDuration = resSet === 'OK';

  res.remainingPoints = Math.max(this.points - consumed, 0);
  if (resTtlMs === -1) { // If rlKey created by incrby() not by set()
    isFirstInDuration = true;
    res.msBeforeNext = this.duration;
    this.redis.expire(rlKey, this.duration);
  } else {
    res.msBeforeNext = resTtlMs;
  }

  if (consumed > this.points) {
    // Block key for this.blockDuration seconds
    if (this.blockOnPointsConsumed > 0 && consumed >= this.blockOnPointsConsumed) {
      this._blockedKeys.add(rlKey, this.blockDuration);
      res.msBeforeNext = this.msBlockDuration;
    }

    reject(res);
  } else {
    if (this.execEvenly && res.msBeforeNext > 0 && !isFirstInDuration) {
      const delay = Math.ceil(res.msBeforeNext / (res.remainingPoints + 2));
      setTimeout(resolve, delay, res);
    } else {
      resolve(res);
    }
  }
};

class RateLimiterRedis extends RateLimiterAbstract {
  /**
   *
   * @param {Object} opts
   * Defaults {
   *   ... see other in RateLimiterAbstract
   *
   *   redis: RedisClient
   *   memoryInsurance: true, // Enable using current process memory to limit rates on Redis error
   * }
   */
  constructor(opts) {
    super(opts);

    this.redis = opts.redis;
    this.blockOnPointsConsumed = opts.blockOnPointsConsumed;
    this.blockDuration = opts.blockDuration;
    this.insuranceLimiter = opts.insuranceLimiter;
    this._blockedKeys = new BlockedKeys();
  }

  get redis() {
    return this._redis;
  }

  set redis(value) {
    if (typeof value === 'undefined') {
      throw new Error('redis is not set');
    }
    this._redis = value;
  }

  get blockOnPointsConsumed() {
    return this._blockOnPointsConsumed;
  }

  set blockOnPointsConsumed(value) {
    this._blockOnPointsConsumed = value ? parseInt(value) : 0;
    if (this.blockOnPointsConsumed > 0 && this.points >= this.blockOnPointsConsumed) {
      throw new Error('blockOnPointsConsumed option must be more than points option');
    }
  }

  get blockDuration() {
    return this._blockDuration;
  }

  get msBlockDuration() {
    return this._blockDuration * 1000;
  }

  set blockDuration(value) {
    this._blockDuration = value ? parseInt(value) : 0;
    if (this.blockDuration > 0 && this.blockOnPointsConsumed === 0) {
      throw new Error('blockOnPointsConsumed option must be set up');
    }
  }

  get insuranceLimiter() {
    return this._insuranceLimiter;
  }

  set insuranceLimiter(value) {
    if (typeof value !== 'undefined' && !(value instanceof RateLimiterAbstract)) {
      throw new Error('insuranceLimiter must be instance of RateLimiterAbstract');
    }
    this._insuranceLimiter = value;
  }

  /**
   *
   * @param key
   * @param pointsToConsume
   * @returns {Promise<any>}
   */
  consume(key, pointsToConsume = 1) {
    return new Promise((resolve, reject) => {
      const rlKey = this.getKey(key);

      if (this.blockOnPointsConsumed > 0) {
        const msBeforeBlockExpires = this._blockedKeys.msBeforeExpire(rlKey);
        if (msBeforeBlockExpires > 0) {
          return reject(new RateLimiterRes(0, msBeforeBlockExpires));
        }
      }

      this.redis.multi()
        .set(rlKey, 0, 'EX', this.duration, 'NX')
        .incrby(rlKey, pointsToConsume)
        .pttl(rlKey)
        .exec((err, results) => {
          if (err) {
            handleRedisError.call(this, 'consume', resolve, reject, key, pointsToConsume);
          } else {
            afterConsume.call(this, resolve, reject, rlKey, results);
          }
        });
    });
  }

  penalty(key, points = 1) {
    const rlKey = this.getKey(key);
    return new Promise((resolve, reject) => {
      this.redis.incrby(rlKey, points, (err, value) => {
        if (err) {
          handleRedisError.call(this, 'penalty', resolve, reject, key, points);
        } else {
          resolve(value);
        }
      });
    });
  }

  reward(key, points = 1) {
    const rlKey = this.getKey(key);
    return new Promise((resolve, reject) => {
      this.redis.incrby(rlKey, -points, (err, value) => {
        if (err) {
          handleRedisError.call(this, 'reward', resolve, reject, key, points);
        } else {
          resolve(value);
        }
      });
    });
  }
}

module.exports = RateLimiterRedis;
