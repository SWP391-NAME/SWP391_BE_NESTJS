import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService as _RedisService } from '@liaoliaots/nestjs-redis';

@Injectable()
export class RedisService {
  private readonly redisClient: Redis;

  constructor(private readonly redisService: _RedisService) {
    this.redisClient = this.redisService.getOrThrow();
  }

  set(key: string, value: string, ttl?: number): Promise<string> {
    if (ttl) {
      return this.redisClient.setex(key, ttl, value);
    }
    return this.redisClient.set(key, value);
  }

  get(key: string): Promise<string | null> {
    return this.redisClient.get(key);
  }

  del(key: string): Promise<number> {
    return this.redisClient.del(key);
  }
}
