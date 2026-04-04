import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-google-oauth20';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthProvider } from '@prisma/client';

@Injectable()
export class GoogleOauth2 extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID')!,
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET')!,
      callbackURL: configService.get<string>('GOOGLE_CALLBACK_URL')!,
      scope: ['profile', 'email'],
      proxy: true,
    });
  }

  async validate(accessToken: string, refreshToken: string, profile: any, done: Function) {
    const user = {
      provider: AuthProvider.GOOGLE,
      providerId: profile.id,
      email: profile.emails[0].value as string,
      firstName: profile.name.givenName as string,
      lastName: profile.name.familyName as string,
      avatar: profile.photos[0].value as string,
    };
    done(null, user);
  }
}
