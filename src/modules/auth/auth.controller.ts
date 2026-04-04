import { Controller, Post, Req, UseGuards, Res, Get, Query, Patch } from '@nestjs/common';
import { Body } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignUpDTO, SignUpResponseDTO } from './dto/signup.dto';
import { LocalAuthGuard } from './guard/local-auth.guard';
import { GoogleOauthGuard } from './guard/google-oauth.guard';
import { Response, Request } from 'express';
import { Public } from '../../common/decorator/public.decorator';
import { Serialize } from 'src/common/interceptor/serialize.interceptor';
import { OAuthUserDTO } from './dto/oauth-user.dto';
import { CurrentUser } from 'src/common/decorator/current-user.decorator';
import { JWT_Payload } from 'src/common/types';
import {
  ApiBody,
  ApiTags,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiExcludeEndpoint,
} from '@nestjs/swagger';
import { SignInDTO, SignInResponseDTO } from './dto/signin.dto';
import ResetPasswordBodyDTO from './dto/reset-password-body.dto';
import ChangePasswordBodyDTO from './dto/change-password-body.dto';
import { RequestResetPasswordDTO } from './dto/request-reset-password.dto';
import { VerifyResetPasswordDTO } from './dto/verify-reset-password.dto';
import * as ms from 'ms';
import { ConfigService } from '@nestjs/config';
import { AccountService } from 'src/modules/account/account.service';
import { AccountWithProfileDTO, Profile } from '../account/dto/account-with-profile.dto';
import { plainToInstance } from 'class-transformer';
import { CustomerDTO } from '../customer/dto/customer.dto';
import { SkipResponseInterceptor } from 'src/common/decorator/skip-response.decorator';
import { Account } from '@prisma/client';
import { encodeBase64 } from 'src/utils';

export interface RequestWithOAuthUser extends Omit<Request, 'user'> {
  user: OAuthUserDTO;
}

export interface RequestWithUserPayload extends Omit<Request, 'user'> {
  user: JWT_Payload;
}

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly accountService: AccountService
  ) {}

  @Public()
  @Post('/signup')
  @Serialize(SignUpResponseDTO)
  async signUp(@Body() body: SignUpDTO) {
    const { account, customer } = await this.authService.signUp(body);

    const accountWithProfile: AccountWithProfileDTO = {
      ...account,
      // password: account.password ?? '',
      profile: plainToInstance(CustomerDTO, customer) as Profile,
    };
    return {
      account: accountWithProfile,
      message: 'Sign up successful',
    };
  }

  @Public()
  @UseGuards(LocalAuthGuard)
  @Serialize(SignInResponseDTO)
  @Post('/signin')
  @ApiBody({ type: SignInDTO })
  async signIn(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken, account } = await this.authService.signIn(
      req.user as Account
    );
    const rfExpireTime = this.configService.get<ms.StringValue>('RF_EXPIRE_TIME');
    const maxAge = rfExpireTime ? ms(rfExpireTime) : ms('7d');
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge,
    });
    return {
      account: account,
      accessToken,
      message: 'Sign in successful',
    };
  }

  @ApiBearerAuth('jwt-auth')
  @Post('signout')
  async signOut(@Req() req: RequestWithUserPayload) {
    const token = req.headers.authorization?.split(' ')[1];
    await this.authService.signOut(req.user.sub, token!);
    return {
      message: 'Sign out successful',
    };
  }

  @Public()
  @Get('/refresh-token')
  @ApiCookieAuth('refreshToken')
  async refreshToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies['refreshToken'];
    const { accessToken, refreshToken } = await this.authService.refreshToken(token);
    const rfExpireTime = this.configService.get<ms.StringValue>('RF_EXPIRE_TIME');
    const maxAge = rfExpireTime ? ms(rfExpireTime) : ms('7d');
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge,
    });
    return {
      accessToken,
      message: 'Refresh token successful',
    };
  }

  @Get('verify-email')
  @Public()
  @SkipResponseInterceptor()
  async verifyEmail(@Query('code') code: string, @Res() res: Response) {
    const isSuccess = await this.authService.verifyEmail(code);
    const frontendUrl = this.configService.get('FRONTEND_URL') || 'http://localhost:5173';
    return res.redirect(`${frontendUrl}/auth/verify?success=${isSuccess}`);
  }

  @Public()
  @Post('resend-activation-email')
  @ApiBody({ schema: { properties: { email: { type: 'string', example: 'user@example.com' } } } })
  async resendEmail(@Body('email') email: string) {
    await this.authService.resendActivationEmail(email);
    return {
      message: 'Resend activation email successfully',
    };
  }

  @Public()
  @ApiExcludeEndpoint()
  @Get('google/login')
  @UseGuards(GoogleOauthGuard)
  async googleAuth() {
    // Initiates Google OAuth2 flow
  }

  @Public()
  @ApiExcludeEndpoint()
  @Get('google/callback')
  @UseGuards(GoogleOauthGuard)
  @SkipResponseInterceptor()
  async googleAuthCallback(@Req() req: RequestWithOAuthUser, @Res() res: Response) {
    try {
      const { accessToken, refreshToken } = await this.authService.googleOAuthSignIn(req.user);
      const rfExpireTime = this.configService.get<ms.StringValue>('RF_EXPIRE_TIME');
      const maxAge = rfExpireTime ? ms(rfExpireTime) : ms('7d');

      const isProduction = process.env.NODE_ENV === 'production';
      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge,
      });
      const encoded = encodeBase64(accessToken);
      // Redirect to frontend with access token
      const frontendUrl = this.configService.get('FRONTEND_URL') || 'http://localhost:5173';
      return res.redirect(`${frontendUrl}/auth/success?token=${encoded}`);
    } catch (error) {
      return res.redirect(
        `${this.configService.get('FRONTEND_URL')}/auth/failed?message=${error.message}`
      );
    }
  }

  @Get('/me')
  @ApiBearerAuth('jwt-auth')
  async getMe(@CurrentUser() user: JWT_Payload) {
    const account = await this.accountService.getAccountById(user.sub);
    return {
      account,
      message: 'Get current user successful',
    };
  }

  @Patch('me/change-password')
  @ApiBearerAuth('jwt-auth')
  async changePassword(@CurrentUser() user: JWT_Payload, @Body() body: ChangePasswordBodyDTO) {
    const { oldPassword, newPassword, confirmNewPassword } = body;
    await this.authService.changePassword(user.sub, oldPassword, newPassword, confirmNewPassword);
    return {
      message: 'Change password successful',
    };
  }

  @Post('reset-password/request')
  @Public()
  async requestResetPassword(@Body() body: RequestResetPasswordDTO) {
    const { email } = body;
    await this.authService.requestResetPassword(email);
    return {
      message: 'Reset password request successful',
    };
  }

  @Post('reset-password/verify')
  @Public()
  async verifyResetPassword(@Body() body: VerifyResetPasswordDTO) {
    const { code, email } = body;
    await this.authService.verifyResetCode(code, email);
    return {
      message: 'Reset password successful',
    };
  }

  @Post('reset-password/confirm')
  @Public()
  async resetPassword(@Body() body: ResetPasswordBodyDTO) {
    const { code, newPassword, confirmNewPassword } = body;
    await this.authService.resetPassword(code, newPassword, confirmNewPassword);

    return {
      message: 'Password reset successful',
    };
  }
}
