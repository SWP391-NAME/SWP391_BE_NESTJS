import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AccountModule } from './modules/account/account.module';
import { AuthModule } from './modules/auth/auth.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from './modules/auth/guard/jwt-auth.guard';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './modules/prisma/prisma.module';
import { ScheduleModule } from './modules/schedule/schedule.module';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { EmailModule } from './modules/email/email.module';
import { RedisModule } from './modules/redis/redis.module';
import { RoleGuard } from './common/guard/role.guard';
import { ResponseInterceptor } from './common/interceptor/response.interceptor';
import { HttpExceptionFilter } from './common/filter/http-exception.filter';
import { CustomerModule } from './modules/customer/customer.module';
import { VehicleModule } from './modules/vehicle/vehicle.module';
import { UploadModule } from './modules/upload/upload.module';
import { StaffModule } from './modules/employee/staff/staff.module';
import { TechnicianModule } from './modules/employee/technician/technician.module';
import { ServiceModule } from './modules/service/service.module';
import { CategoryModule } from './modules/category/category.module';
import { PartModule } from './modules/part/part.module';
import { MembershipModule } from './modules/membership/membership.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { PaymentModule } from './modules/payment/payment.module';
import { ServicePartModule } from './modules/service-part/service-part.module';
import { PackageModule } from './modules/package/package.module';
import { PackageDetailModule } from './modules/package-detail/package-detail.module';
import { CertificateModule } from './modules/employee/certificate/certificate.module';
import { EmployeeModule } from './modules/employee/employee.module';
import { ShiftModule } from './modules/shift/shift.module';
import { WorkScheduleModule } from './modules/work-schedule/work-schedule.module';
import { WorkCenterModule } from './modules/work-center/work-center.module';
import { BookingModule } from './modules/booking/booking.module';
import { BookingDetailModule } from './modules/booking-detail/booking-detail.module';
import { BookingAssignmentModule } from './modules/booking-assignment/booking-assignment.module';
import { VehicleHandoverModule } from './modules/vehiclehandover/vehiclehandover.module';
import { ChatModule } from './modules/chat/chat.module';
import { WebsocketModule } from './common/socket/socket.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { NotificationModule } from './modules/notification/notification.module';
import { NotificationInterceptor } from './common/interceptor/notification.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env${process.env.NODE_ENV ? '.' + process.env.NODE_ENV : ''}`,
    }),
    UploadModule,
    AccountModule,
    AuthModule,
    PrismaModule,
    ScheduleModule,
    RedisModule,
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        transport: {
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          auth: {
            user: configService.get<string>('MAIL_USER'),
            pass: configService.get<string>('MAIL_PASSWORD'),
          },
        },
        defaults: {
          from: '"No Reply" <no-reply@example.com>',
        },
        template: {
          dir: process.cwd() + '/src/modules/email/templates',
          adapter: new HandlebarsAdapter(),
          options: {
            inlineCss: true,
            strict: true,
          },
        },
      }),
    }),
    EmailModule,
    CustomerModule,
    CertificateModule,
    VehicleModule,
    ServiceModule,
    CategoryModule,
    PartModule,
    StaffModule,
    MembershipModule,
    StripeModule.forRoot(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-09-30.clover' }),
    SubscriptionModule,
    PaymentModule,
    ServicePartModule,
    PackageModule,
    PackageDetailModule,
    WorkScheduleModule,
    ShiftModule,
    EmployeeModule,
    WorkCenterModule,
    ServiceModule,
    BookingModule,
    BookingDetailModule,
    BookingAssignmentModule,
    TechnicianModule,
    VehicleHandoverModule,
    ChatModule,
    WebsocketModule,
    DashboardModule,
    NotificationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RoleGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: NotificationInterceptor,
    },
  ],
})
export class AppModule {}
