import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule as _RedisModule } from '@liaoliaots/nestjs-redis';
import { RedisService } from './redis.service';

@Global()
@Module({
  imports: [
    ConfigModule,
    _RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        readyLog: true,
        config: {
          host: configService.get<string>('REDIS_HOST'),
          port: configService.get<number>('REDIS_PORT'),
          password: configService.get<string>('REDIS_PASSWORD'),
        },
      }),
    }),
  ],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule { }
