import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountService } from 'src/modules/account/account.service';
import { SignUpDTO } from './dto/signup.dto';
import { CreateAccountDTO } from 'src/modules/account/dto/create-account.dto';
import { comparePassword, hashPassword } from 'src/utils';
import { SignInDTO } from './dto/signin.dto';
import { TokenService } from './token.service';
import { Account, AccountStatus, AuthProvider } from '@prisma/client';
import { JWT_Payload, TokenType } from 'src/common/types';
import { EmailService } from 'src/modules/email/email.service';
import { v4 as uuidv4 } from 'uuid';
import { RedisService } from 'src/modules/redis/redis.service';
import { ConfigService } from '@nestjs/config';
import * as ms from 'ms';
import { OAuthUserDTO } from './dto/oauth-user.dto';
import { randomInt } from 'crypto';
import { ValidationException } from 'src/common/exception/validation.exception';
import { CustomerService } from '../customer/customer.service';
import { CreateCustomerDTO } from '../customer/dto/create-customer.dto';
import { AccountWithProfileDTO } from '../account/dto/account-with-profile.dto';
@Injectable()
export class AuthService {
  constructor(
    private readonly accountService: AccountService,
    private readonly customerService: CustomerService,
    private readonly tokenService: TokenService,
    private readonly emailService: EmailService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService
  ) {}

  // getConfig() {
  //   return {
  //     AT_Expired: this.configService.get<ms.StringValue>('AC_EXPIRE_TIME'),
  //   };
  // }

  async signUp(signUpDTO: SignUpDTO) {
    const { email, password, confirmPassword, firstName, lastName, phone, address } = signUpDTO;

    if (password !== confirmPassword) {
      throw new ValidationException({
        confirmPassword: 'Password confirmation does not match password',
      });
    }

    const existingAccount = await this.accountService.getAccountByEmail(email);
    if (existingAccount) {
      throw new BadRequestException('Account with this email already exists');
    }

    const hashedPassword = await hashPassword(password);

    const createBody: CreateAccountDTO = {
      email,
      password: hashedPassword,
      phone,
    };

    const account = await this.accountService.createAccount(createBody);

    if (!account) {
      throw new InternalServerErrorException('Failed to create account');
    }
    const customerBody: CreateCustomerDTO = {
      accountId: account?.id,
      firstName,
      lastName,
      address,
    };
    const customer = await this.customerService.createCustomer(customerBody);

    // send verification mail
    const activationCode = uuidv4();
    const expiredTime =
      ms(this.configService.get<ms.StringValue>('EMAIL_VERIFY_EXPIRE_TIME')!) / 1000;
    const activationData = {
      email: account?.email,
      createdAt: new Date().toISOString(),
    };
    Promise.all([
      await this.redisService.set(
        `activation:${activationCode}`,
        JSON.stringify(activationData),
        expiredTime
      ),
      await this.redisService.set(
        `activation:account:${account?.email}`,
        activationCode,
        expiredTime
      ),
    ]);
    this.emailService.sendActivationEmail(email, firstName, activationCode);
    return {
      account,
      customer,
    };
  }

  async validateUser(signInDTO: SignInDTO): Promise<AccountWithProfileDTO | null> {
    const account = await this.accountService.getAccountByEmail(signInDTO.email);
    if (!account) {
      return null;
    }
    if (account.provider.includes(AuthProvider.EMAIL)) {
      const isPasswordValid = await comparePassword(signInDTO.password, account.password!);
      if (isPasswordValid) {
        return account;
      }
    }
    return null;
  }
  async signIn(
    account: Account
  ): Promise<{ accessToken: string; refreshToken: string; account: Account }> {
    const payload: JWT_Payload = {
      email: account.email,
      sub: account.id,
      role: account.role,
      status: account.status,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.tokenService.generateToken(payload, TokenType.ACCESS),
      this.tokenService.generateToken(payload, TokenType.REFRESH),
    ]);
    await this.tokenService.storeToken(account.id, refreshToken);
    return {
      accessToken,
      account,
      refreshToken,
    };
  }

  async signOut(userId: string, accessToken: string): Promise<void> {
    await this.tokenService.deleteToken(userId);
    const { exp } = await this.tokenService.decodeToken(accessToken, TokenType.ACCESS);
    
    // exp is in seconds absolute. Calculate relative TTL in seconds.
    const ttlInSeconds = exp! - Math.floor(Date.now() / 1000);
    
    if (ttlInSeconds > 0) {
      await this.redisService.set(`bl:${accessToken}`, '1', ttlInSeconds);
    }
  }

  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    if (!refreshToken) {
      throw new BadRequestException('Refresh token not found');
    }
    const payload = await this.tokenService.verifyToken(refreshToken, TokenType.REFRESH);
    const storedToken = await this.tokenService.getToken(payload.sub);
    if (!storedToken || storedToken !== refreshToken) {
      throw new UnauthorizedException('Invalid or revoked refresh token');
    }
    const { sub, email, role, status } = payload;
    const newPayload = {
      sub,
      email,
      role,
      status,
    };
    const [accessToken, newRefreshToken] = await Promise.all([
      this.tokenService.generateToken(newPayload, TokenType.ACCESS),
      this.tokenService.generateToken(newPayload, TokenType.REFRESH),
    ]);
    await this.tokenService.storeToken(sub, newRefreshToken);
    return { accessToken, refreshToken: newRefreshToken };
  }

  async verifyEmail(activationCode: string): Promise<boolean> {
    const data = await this.redisService.get(`activation:${activationCode}`);
    if (!data) {
      throw new BadRequestException('Invalid or expired activation code');
    }
    const { email } = JSON.parse(data);
    const account = await this.accountService.getAccountByEmail(email);
    if (!account) {
      throw new BadRequestException('Account not found');
    }

    if (account.status === AccountStatus.VERIFIED) {
      throw new BadRequestException('Account is already verified');
    }

    // Activate email
    const isSuccess = await this.accountService.activateAccount(email);
    // Delete activation codes
    await this.redisService.del(`activation:${activationCode}`);
    await this.redisService.del(`activation:account:${email}`);
    return isSuccess;
  }

  async changePassword(
    id: string,
    oldPassword: string,
    newPassword: string,
    confirmNewpassword: string
  ) {
    const account = await this.accountService.getAccountById(id);
    if (!account) {
      return;
    }

    if (confirmNewpassword !== newPassword) {
      throw new BadRequestException('New password and confirmation do not match');
    }

    if (oldPassword === newPassword) {
      throw new BadRequestException('New password must be different from old password');
    }

    const isPasswordValid = await comparePassword(oldPassword, account.password!);
    if (!isPasswordValid) {
      throw new BadRequestException('Old password is incorrect');
    }
    const hashed = await hashPassword(newPassword);
    await this.accountService.changePassword(id, hashed);
  }

  async resendActivationEmail(email: string) {
    const account = await this.accountService.getAccountByEmail(email);
    if (!account) {
      return;
    }

    const { profile } = account;

    if (account.status === AccountStatus.VERIFIED) {
      throw new BadRequestException('Account is already verified');
    }

    const oldActivationCode = await this.redisService.get(`activation:account:${email}`);
    if (oldActivationCode) {
      await this.redisService.del(`activation:${oldActivationCode}`);
      await this.redisService.del(`activation:account:${email}`);
    }

    const activationCode = uuidv4();
    const expiredTime =
      ms(this.configService.get<ms.StringValue>('EMAIL_VERIFY_EXPIRE_TIME')!) / 1000;
    const activationData = {
      email: account.email,
      createdAt: new Date().toISOString(),
    };
    await this.redisService.set(
      `activation:${activationCode}`,
      JSON.stringify(activationData),
      expiredTime
    );
    await this.redisService.set(`activation:account:${account.email}`, activationCode, expiredTime);
    this.emailService.sendActivationEmail(account.email, profile?.firstName || '', activationCode);
  }

  async requestResetPassword(email: string) {
    const account = await this.accountService.getAccountByEmail(email);
    if (!account) {
      return;
    }

    if (account.provider.length === 1 && account.provider.includes(AuthProvider.GOOGLE)) {
      throw new BadRequestException('Account registered with Google OAuth cannot reset password');
    }

    if (account.status !== AccountStatus.VERIFIED) {
      throw new BadRequestException('Only verified account can request reset password');
    }

    const { profile } = account;
    const oldOtp = await this.redisService.get(`reset_password:account:${email}`);
    if (oldOtp) {
      await this.redisService.del(`reset_password:${oldOtp}`);
    }

    const otp = randomInt(100000, 999999).toString();
    const expiredTime =
      ms(this.configService.get<ms.StringValue>('RESET_PASSWORD_EXPIRE_TIME')!) / 1000;
    const otpData = {
      email,
      id: account.id,
      createdAt: new Date().toISOString(),
    };
    await Promise.all([
      this.redisService.set(`reset_password:${otp}`, JSON.stringify(otpData), expiredTime),
      this.redisService.set(`reset_password:account:${email}`, otp, expiredTime),
    ]);
    this.emailService.sendResetPasswordEmail(account.email, profile?.firstName || '', otp);
  }

  async verifyResetCode(code: string, email: string): Promise<boolean> {
    const otpData = await this.redisService.get(`reset_password:${code}`);
    if (!otpData) {
      throw new BadRequestException('Invalid or expired reset password code');
    }
    const { email: otpEmail } = JSON.parse(otpData);
    if (otpEmail !== email) {
      throw new BadRequestException('Invalid reset code for this email address');
    }

    return true;
  }

  async resetPassword(code: string, newPassword: string, confirmNewPassword: string) {
    if (newPassword !== confirmNewPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const data = await this.redisService.get(`reset_password:${code}`);
    if (!data) {
      throw new BadRequestException('Invalid or expired reset password code');
    }

    const { email, id } = JSON.parse(data);

    // Lấy account hiện tại
    const account = await this.accountService.getAccountById(id);
    if (!account) {
      throw new BadRequestException('Account not found');
    }
    if (account.password) {
      const isSamePassword = await comparePassword(newPassword, account.password || '');
      if (isSamePassword) {
        throw new BadRequestException('New password cannot be the same as the old password');
      }
    }

    const hashed = await hashPassword(newPassword);
    await this.accountService.changePassword(id, hashed);

    await Promise.all([
      this.redisService.del(`reset_password:${code}`),
      this.redisService.del(`reset_password:account:${email}`),
    ]);
  }

  async googleOAuthSignIn(
    oauthUser: OAuthUserDTO
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const account = await this.accountService.findOrCreateOAuthAccount(oauthUser);
    const payload: JWT_Payload = {
      email: account.email,
      sub: account.id,
      role: account.role,
      status: account.status,
    };

    const accessToken = await this.tokenService.generateToken(payload, TokenType.ACCESS);

    const refreshToken = await this.tokenService.generateToken(payload, TokenType.REFRESH);

    await this.tokenService.storeToken(account.id, refreshToken);

    return {
      accessToken,
      refreshToken,
    };
  }
}
