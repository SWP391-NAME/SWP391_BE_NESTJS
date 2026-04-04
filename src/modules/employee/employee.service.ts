import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/modules/prisma/prisma.service';
import { Prisma, AccountRole, CenterStatus } from '@prisma/client';
import { PaginationResponse } from 'src/common/dto/pagination-response.dto';
import { EmployeeQueryDTO, EmployeeQueryWithPaginationDTO } from './dto/employee-query.dto';
import { EmployeeWithCenterDTO } from './dto/employee-with-center.dto';
import { plainToInstance } from 'class-transformer';
import { UpdateEmployeeWithCenterDTO } from './dto/update-employee-with-center.dto';
import { UpdateTechnicianDTO } from './technician/dto/update-technician.dto';
import { UpdateStaffDTO } from './staff/dto/update-staff.dto';
import { BadRequestException, NotFoundException } from '@nestjs/common/exceptions';
import { AccountStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { hashPassword, parseDate, vnToUtcDate, utcToVNDate } from 'src/utils';
import { CreateTechnicianDTO } from './technician/dto/create-technician.dto';
import { CreateStaffDTO } from './staff/dto/create-staff.dto';
import { ConflictException } from '@nestjs/common/exceptions/conflict.exception';

@Injectable()
export class EmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService
  ) {}

  // === HELPER: Common Where Clause for Active WorkCenter ===
  private getActiveWorkCenterWhere() {
    return {
      OR: [{ endDate: null }, { endDate: { gte: new Date() } }],
    };
  }

  // === HELPER: Transform Prisma Account → DTO ===
  private transformAccountToDTO(account: any): any {
    const workCenter = account.employee?.workCenters?.[0]?.serviceCenter;
    return {
      id: account.id,
      email: account.email,
      phone: account.phone,
      role: account.role,
      status: account.status,
      avatar: account.avatar,
      avatarPublicId: account.avatarPublicId,
      providerId: account.providerId,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      profile: account.employee
        ? {
            firstName: account.employee.firstName,
            lastName: account.employee.lastName,
            createdAt: account.employee.createdAt,
            updatedAt: account.employee.updatedAt,
            certificates:
              account.employee.certificates?.map((c: any) => ({
                name: c.name,
                issuedAt: c.issuedAt,
                expiresAt: c.expiresAt,
              })) ?? [],
          }
        : null,
      workCenter: workCenter
        ? {
            id: workCenter.id,
            name: workCenter.name,
            address: workCenter.address,
            status: workCenter.status,
            startDate: account.employee.workCenters[0].startDate,
            endDate: account.employee.workCenters[0].endDate,
          }
        : { id: null, name: 'Not assigned', startDate: null, endDate: null },
    };
  }

  // === VALIDATION: Generic Field Validator ===
  private validateField(
    value: string | undefined,
    field: string,
    errors: Record<string, string>,
    options: {
      required?: boolean;
      minLength?: number;
      maxLength?: number;
      regex?: RegExp;
      regexMessage?: string;
      custom?: (v: string) => boolean;
      customMessage?: string;
    }
  ) {
    if (value === undefined) return;

    const trimmed = value.trim();
    if (options.required && !trimmed) {
      errors[field] = `${this.capitalize(field)} is required and cannot be empty`;
      return;
    }

    if (trimmed && options.minLength && trimmed.length < options.minLength) {
      errors[field] = `${this.capitalize(field)} must be at least ${options.minLength} characters`;
      return;
    }

    if (trimmed && options.maxLength && trimmed.length > options.maxLength) {
      errors[field] = `${this.capitalize(field)} must not exceed ${options.maxLength} characters`;
      return;
    }

    if (trimmed && options.regex && !options.regex.test(trimmed)) {
      errors[field] = options.regexMessage || `${this.capitalize(field)} is invalid`;
      return;
    }

    if (trimmed && options.custom && !options.custom(trimmed)) {
      errors[field] = options.customMessage || `${this.capitalize(field)} is invalid`;
    }
  }

  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // === VALIDATION: WorkCenter ===
  private validateWorkCenter(
    workCenter:
      | UpdateEmployeeWithCenterDTO
      | { centerId?: string; startDate?: string; endDate?: string },
    errors: Record<string, string>,
    isCreate = false
  ) {
    const { centerId, startDate, endDate } = workCenter;

    // centerId
    if (centerId !== undefined) {
      const trimmed = centerId.trim();
      if (isCreate && !trimmed) {
        errors['workCenter.centerId'] = 'Service Center ID is required and cannot be empty';
      } else if (trimmed) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(trimmed)) {
          errors['workCenter.centerId'] = 'Service Center ID must be a valid UUID';
        }
      }
    }

    // startDate
    if (startDate !== undefined) {
      const trimmed = startDate.trim();
      if (isCreate && !trimmed) {
        errors['workCenter.startDate'] = 'Start date is required and cannot be empty';
      } else if (trimmed && !parseDate(startDate)) {
        errors['workCenter.startDate'] = 'Start date must be a valid date (YYYY-MM-DD)';
      }
    }

    // endDate
    if (endDate !== undefined && endDate.trim() !== '') {
      if (!parseDate(endDate)) {
        errors['workCenter.endDate'] = 'End date must be a valid date (YYYY-MM-DD)';
      }
    }

    // date range
    if (startDate?.trim() && endDate?.trim()) {
      const s = parseDate(startDate);
      const e = parseDate(endDate);
      if (s && e && s >= e) {
        errors['workCenter.dateRange'] = 'Start date must be before end date';
      }
    }
  }

  // === VALIDATION: WorkCenter Assignment Conflict ===
  private async validateWorkCenterAssignment(
    employeeId: string,
    workCenter: UpdateEmployeeWithCenterDTO,
    currentAssignment: any,
    errors: Record<string, string>
  ) {
    const { centerId, startDate: newStartDate } = workCenter;
    const isRemoving = !centerId?.trim();
    const isChanging =
      currentAssignment && centerId?.trim() && currentAssignment.centerId !== centerId.trim();

    if (isRemoving || isChanging) {
      const hasActiveShifts = await this.checkEmployeeHasActiveShifts(employeeId);
      if (hasActiveShifts) {
        errors['workCenter.centerId'] =
          'Cannot change or remove service center: Employee has active/upcoming shifts.';
      }
    }
  }

  // === GET: Pagination + Filters ===
  async getEmployees(
    filter: EmployeeQueryWithPaginationDTO,
    role: AccountRole
  ): Promise<PaginationResponse<EmployeeWithCenterDTO>> {
    let { page = 1, pageSize = 10, orderBy = 'asc', sortBy = 'createdAt' } = filter;
    page = Math.max(page, 1);
    pageSize = Math.max(pageSize, 1);

    const where = this.buildEmployeeWhere(filter, role);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.account.findMany({
        where,
        select: this.getEmployeeSelectFields(),
        orderBy: { [sortBy]: orderBy },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.account.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const transformedData = data.map(emp => this.transformAccountToDTO(emp));

    return {
      data: plainToInstance(EmployeeWithCenterDTO, transformedData, {
        excludeExtraneousValues: true,
      }),
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  // === GET: All Employees (No Pagination) ===
  async getAllEmployees(filter: EmployeeQueryDTO): Promise<EmployeeWithCenterDTO[]> {
    const where = this.buildEmployeeWhere(filter, null);
    const data = await this.prisma.account.findMany({
      where,
      select: this.getEmployeeSelectFields(),
      orderBy: { [filter.sortBy || 'createdAt']: filter.orderBy || 'asc' },
    });

    const transformedData = data.map(emp => this.transformAccountToDTO(emp));
    return plainToInstance(EmployeeWithCenterDTO, transformedData, {
      excludeExtraneousValues: true,
    });
  }

  // === BUILD WHERE: Shared Filter Logic ===
  private buildEmployeeWhere(
    filter: EmployeeQueryDTO | EmployeeQueryWithPaginationDTO,
    role: AccountRole | null
  ) {
    const where: Prisma.AccountWhereInput = role
      ? { role }
      : { role: { in: [AccountRole.STAFF, AccountRole.TECHNICIAN] } };

    // Account filters
    if (filter.email) where.email = { contains: filter.email, mode: 'insensitive' };
    if (filter.phone) where.phone = { contains: filter.phone, mode: 'insensitive' };
    if (filter.status) where.status = filter.status;

    // Search
    if (filter.search) {
      const search = filter.search.trim();
      const parts = search.split(' ');
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { employee: { firstName: { contains: search, mode: 'insensitive' } } },
        { employee: { lastName: { contains: search, mode: 'insensitive' } } },
        parts.length > 1
          ? {
              employee: {
                AND: [
                  { firstName: { contains: parts[0], mode: 'insensitive' } },
                  { lastName: { contains: parts[1], mode: 'insensitive' } },
                ],
              },
            }
          : null,
      ].filter(Boolean) as Prisma.AccountWhereInput[];
    }

    // Employee filters
    const employeeWhere: Prisma.EmployeeWhereInput = {};
    const employeeConditions: any[] = [];

    if (filter.employeeId) employeeWhere.accountId = filter.employeeId;
    if (filter.firstName)
      employeeWhere.firstName = { contains: filter.firstName, mode: 'insensitive' };
    if (filter.lastName)
      employeeWhere.lastName = { contains: filter.lastName, mode: 'insensitive' };

    // hasWorkCenter
    if (filter.hasWorkCenter !== undefined) {
      employeeConditions.push(
        filter.hasWorkCenter
          ? { workCenters: { some: this.getActiveWorkCenterWhere() } }
          : { workCenters: { none: {} } }
      );
    }

    // centerId / name
    if (filter.centerId || filter.name) {
      const wc: Prisma.WorkCenterWhereInput = {};
      if (filter.centerId) wc.centerId = filter.centerId;
      if (filter.name) wc.serviceCenter = { name: { contains: filter.name, mode: 'insensitive' } };
      wc.OR = this.getActiveWorkCenterWhere().OR;

      if (filter.hasWorkCenter !== false) {
        employeeConditions.push({ workCenters: { some: wc } });
      }
    }

    if (employeeConditions.length > 0) employeeWhere.AND = employeeConditions;
    if (Object.keys(employeeWhere).length > 0) where.employee = employeeWhere;

    return where;
  }

  // === SELECT: Shared Query Fields ===
  private getEmployeeSelectFields() {
    return {
      id: true,
      email: true,
      phone: true,
      role: true,
      status: true,
      avatar: true,
      avatarPublicId: true,
      providerId: true,
      createdAt: true,
      updatedAt: true,
      employee: {
        select: {
          firstName: true,
          lastName: true,
          createdAt: true,
          updatedAt: true,
          certificates: { select: { name: true, issuedAt: true, expiresAt: true } },
          workCenters: {
            where: this.getActiveWorkCenterWhere(),
            select: {
              id: true,
              startDate: true,
              endDate: true,
              serviceCenter: { select: { id: true, name: true, address: true, status: true } },
            },
            orderBy: { startDate: 'desc' as const },
            take: 1,
          },
        },
      },
    } as const;
  }

  // === CHECK: Technician Active Bookings ===
  async checkTechnicianHasAssigned(accountId: string): Promise<boolean> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { role: true },
    });
    if (!account || account.role !== AccountRole.TECHNICIAN) return false;

    const count = await this.prisma.bookingAssignment.count({
      where: {
        employeeId: accountId,
        booking: { status: { in: ['ASSIGNED', 'IN_PROGRESS', 'CHECKED_IN', 'CHECKED_OUT'] } },
      },
    });
    return count > 0;
  }
  // Update getTechnicianActiveBookings
  async getTechnicianActiveBookings(employeeId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: employeeId },
      select: { role: true },
    });
    if (!account || account.role !== AccountRole.TECHNICIAN) return [];

    const assignments = await this.prisma.bookingAssignment.findMany({
      where: {
        employeeId,
        booking: { status: { in: ['ASSIGNED', 'CHECKED_IN', 'IN_PROGRESS', 'CHECKED_OUT'] } },
      },
      select: {
        id: true,
        booking: {
          select: {
            id: true,
            status: true,
            bookingDate: true,
            customer: { select: { account: { select: { email: true } } } },
          },
        },
      },
      orderBy: { booking: { bookingDate: 'asc' as const } },
    });

    return assignments.map(a => ({
      assignmentId: a.id,
      bookingId: a.booking.id,
      bookingDate: a.booking.bookingDate,
      status: a.booking.status,
      customerEmail: a.booking.customer?.account?.email,
    }));
  }

  // Update checkEmployeeHasActiveShifts
  async checkEmployeeHasActiveShifts(employeeId: string): Promise<boolean> {
    const vnNow = utcToVNDate(new Date());
    const vnTodayStart = new Date(vnNow.getFullYear(), vnNow.getMonth(), vnNow.getDate());
    const todayStartUtc = vnToUtcDate(vnTodayStart);

    const schedules = await this.prisma.workSchedule.findMany({
      where: {
        employeeId,
        date: { gte: todayStartUtc },
      },
      include: { shift: true },
      orderBy: { date: 'asc' as const },
    });

    if (schedules.length === 0) return false;

    for (const s of schedules) {
      const scheduleDateVN = utcToVNDate(s.date);

      if (scheduleDateVN > vnNow) return true;

      if (!s.shift?.startTime || !s.shift?.endTime) continue;

      const startTimeStr =
        s.shift.startTime instanceof Date
          ? s.shift.startTime.toTimeString().slice(0, 8)
          : s.shift.startTime;

      const endTimeStr =
        s.shift.endTime instanceof Date
          ? s.shift.endTime.toTimeString().slice(0, 8)
          : s.shift.endTime;

      const [startH, startM] = startTimeStr.split(':').map(Number);
      const [endH, endM] = endTimeStr.split(':').map(Number);

      const isOvernight = endH < startH || (endH === startH && endM < startM);

      const shiftEnd = new Date(
        scheduleDateVN.getFullYear(),
        scheduleDateVN.getMonth(),
        scheduleDateVN.getDate(),
        endH,
        endM
      );

      if (isOvernight) {
        shiftEnd.setDate(shiftEnd.getDate() + 1);
      }

      if (vnNow < shiftEnd) return true;
    }

    return false;
  }

  // === ASSIGN: Service Center ===
  async assignEmployeeToServiceCenter(
    employeeId: string,
    workCenterData: UpdateEmployeeWithCenterDTO
  ) {
    const { centerId, startDate, endDate } = workCenterData;
    const parsedStart = parseDate(startDate);
    const parsedEnd = endDate ? parseDate(endDate) : null;

    if (!parsedStart)
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { startDate: 'Invalid start date' },
      });
    if (endDate && !parsedEnd)
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { endDate: 'Invalid end date' },
      });

    const start = vnToUtcDate(parsedStart);
    const end = parsedEnd ? vnToUtcDate(parsedEnd) : null;

    const employee = await this.prisma.employee.findUnique({
      where: { accountId: employeeId },
      include: {
        workCenters: { where: this.getActiveWorkCenterWhere(), include: { serviceCenter: true } },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const current = employee.workCenters[0];

    // Remove assignment
    if (!centerId?.trim()) {
      if (!current) return { employeeId, workCenter: { id: null, name: 'Not assigned' } };
      const hasShifts = await this.checkEmployeeHasActiveShifts(employeeId);
      if (hasShifts) throw new ConflictException('Cannot remove: active shifts');
      await this.prisma.workCenter.update({
        where: { id: current.id },
        data: { endDate: new Date() },
      });
      return { employeeId, workCenter: { id: null, name: 'Not assigned' } };
    }

    const center = await this.prisma.serviceCenter.findUnique({ where: { id: centerId } });
    if (!center) throw new NotFoundException(`Service center ${centerId} not found`);
    if (center.status === CenterStatus.CLOSED)
      throw new BadRequestException('Cannot assign to closed center');

    // Update same center
    if (current?.centerId === centerId) {
      const updated = await this.prisma.workCenter.update({
        where: { id: current.id },
        data: { startDate: start, endDate: end },
        include: {
          serviceCenter: { select: { id: true, name: true, address: true, status: true } },
        },
      });
      return { employeeId, workCenter: updated.serviceCenter };
    }

    // Change center
    if (current) {
      const hasShifts = await this.checkEmployeeHasActiveShifts(employeeId);
      if (hasShifts) throw new ConflictException('Cannot change center: active shifts');

      const vnNow = utcToVNDate(new Date());
      const vnTodayStart = new Date(vnNow.getFullYear(), vnNow.getMonth(), vnNow.getDate());
      const todayStartUtc = vnToUtcDate(vnTodayStart);

      // Check overlap, not allow startDate in range of current assignment
      // End current assignment today = startDate new assignment = today
      const currentStartVN = utcToVNDate(current.startDate);
      const currentEndVN = current.endDate ? utcToVNDate(current.endDate) : null;
      const isStrictlyInside =
        parsedStart > currentStartVN && (!currentEndVN || parsedStart < currentEndVN);

      if (isStrictlyInside) {
        const isToday =
          parsedStart.getFullYear() === vnTodayStart.getFullYear() &&
          parsedStart.getMonth() === vnTodayStart.getMonth() &&
          parsedStart.getDate() === vnTodayStart.getDate();

        if (!isToday) {
          const endStr = currentEndVN ? currentEndVN.toLocaleDateString('vi-VN') : 'present';
          throw new ConflictException(
            `Start date ${startDate} overlaps with current assignment (${currentStartVN.toLocaleDateString(
              'vi-VN'
            )} - ${endStr})`
          );
        }
      }

      await this.prisma.workCenter.update({
        where: { id: current.id },
        data: { endDate: todayStartUtc },
      });
    }

    const newAssignment = await this.prisma.workCenter.create({
      data: { employeeId, centerId, startDate: start, endDate: end },
      include: { serviceCenter: { select: { id: true, name: true, address: true, status: true } } },
    });

    return { employeeId, workCenter: newAssignment.serviceCenter };
  }

  // === UPDATE ===
  async updateEmployee(
    employeeId: string,
    updateData: UpdateTechnicianDTO | UpdateStaffDTO
  ): Promise<{
    data: EmployeeWithCenterDTO;
    employeeId: string;
    notifications: {
      profileUpdated: boolean;
      centerUpdated: boolean;
      centerRemoved: boolean;
      oldCenterName?: string;
      newCenterName?: string;
    };
  }> {
    if (!employeeId) throw new BadRequestException('Employee ID is required');
    if (!updateData || Object.keys(updateData).length === 0)
      throw new BadRequestException('No update data provided');

    const { firstName, lastName, phone, status, workCenter } = updateData;
    const errors: Record<string, string> = {};

    const existing = await this.prisma.account.findUnique({
      where: { id: employeeId },
      include: {
        employee: { include: { workCenters: { where: this.getActiveWorkCenterWhere() } } },
      },
    });
    if (!existing?.employee) throw new NotFoundException('Employee not found');

    const isTechnician = existing.role === AccountRole.TECHNICIAN;
    if (isTechnician && (await this.checkTechnicianHasAssigned(employeeId))) {
      const bookings = await this.getTechnicianActiveBookings(employeeId);
      if (status && ['DISABLED', 'BANNED'].includes(status)) {
        throw new ConflictException(`Cannot disable: ${bookings.length} active booking(s)`);
      }
      if (
        workCenter &&
        (!workCenter.centerId?.trim() ||
          existing.employee.workCenters[0]?.centerId !== workCenter.centerId?.trim())
      ) {
        throw new ConflictException(
          `Cannot change service center while employee still has active bookings at the current center.`
        );
      }
    }

    // Validate fields
    this.validateField(firstName, 'firstName', errors, {
      required: true,
      minLength: 2,
      maxLength: 30,
      regex: /^[\p{L}\s'-]+$/u,
    });
    this.validateField(lastName, 'lastName', errors, {
      required: true,
      maxLength: 30,
      regex: /^[\p{L}\s'-]+$/u,
    });
    this.validateField(phone, 'phone', errors, {
      required: true,
      regex: /^[0-9]{10,11}$/,
      regexMessage: 'Phone must be 10-11 digits',
    });
    this.validateField(status, 'status', errors, {
      custom: v => Object.values(AccountStatus).includes(v as AccountStatus),
      customMessage: `Status must be one of: ${Object.values(AccountStatus).join(', ')}`,
    });

    if (workCenter) {
      this.validateWorkCenter(workCenter, errors);
      await this.validateWorkCenterAssignment(
        employeeId,
        workCenter,
        existing.employee.workCenters[0],
        errors
      );
    }

    if (Object.keys(errors).length > 0) {
      throw new BadRequestException({ message: 'Validation failed', errors });
    }

    let profileUpdated = false;
    let centerUpdated = false;
    let centerRemoved = false;
    let oldCenterName: string | undefined;
    let newCenterName: string | undefined;

    // Update account
    if (phone !== undefined || status !== undefined) {
      const updateData: any = {};
      if (phone !== undefined && phone !== existing.phone) updateData.phone = phone;
      if (status !== undefined && status !== existing.status) updateData.status = status;

      if (Object.keys(updateData).length > 0) {
        await this.prisma.account.update({
          where: { id: employeeId },
          data: updateData,
        });
        profileUpdated = true;
      }
    }

    // Update employee
    if (firstName !== undefined || lastName !== undefined) {
      const updateData: any = {};
      if (firstName !== undefined && firstName !== existing.employee.firstName)
        updateData.firstName = firstName;
      if (lastName !== undefined && lastName !== existing.employee.lastName)
        updateData.lastName = lastName;

      if (Object.keys(updateData).length > 0) {
        await this.prisma.employee.update({
          where: { accountId: employeeId },
          data: updateData,
        });
        profileUpdated = true;
      }
    }

    // Assign work center
    if (workCenter) {
      const currentCenterId = existing.employee.workCenters[0]?.centerId;
      const newCenterId = workCenter.centerId?.trim() || null;

      if (currentCenterId && !newCenterId) {
        centerRemoved = true;
        oldCenterName = (
          await this.prisma.serviceCenter.findUnique({ where: { id: currentCenterId } })
        )?.name;
      } else if (!currentCenterId && newCenterId) {
        centerUpdated = true;
        newCenterName = (await this.prisma.serviceCenter.findUnique({ where: { id: newCenterId } }))
          ?.name;
      } else if (currentCenterId && newCenterId && currentCenterId !== newCenterId) {
        centerRemoved = true;
        centerUpdated = true;
        const [oldCenter, newCenter] = await Promise.all([
          this.prisma.serviceCenter.findUnique({
            where: { id: currentCenterId },
            select: { name: true },
          }),
          this.prisma.serviceCenter.findUnique({
            where: { id: newCenterId },
            select: { name: true },
          }),
        ]);
        oldCenterName = oldCenter?.name;
        newCenterName = newCenter?.name;
      }

      await this.assignEmployeeToServiceCenter(employeeId, workCenter);
    }

    const updated = await this.prisma.account.findUnique({
      where: { id: employeeId },
      select: this.getEmployeeSelectFields(),
    });

    return {
      data: plainToInstance(EmployeeWithCenterDTO, this.transformAccountToDTO(updated!), {
        excludeExtraneousValues: true,
      }),
      employeeId,
      notifications: {
        profileUpdated,
        centerUpdated,
        centerRemoved,
        oldCenterName,
        newCenterName,
      },
    };
  }

  // === CREATE ===
  async createEmployee(
    createData: CreateTechnicianDTO | CreateStaffDTO,
    role: AccountRole
  ): Promise<EmployeeWithCenterDTO> {
    const { email, phone, firstName, lastName, workCenter } = createData;
    const errors: Record<string, string> = {};

    // Validate email
    if (!email?.trim()) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = 'Invalid email';
    } else {
      const exists = await this.prisma.account.findUnique({ where: { email } });
      if (exists) errors.email = 'Email already exists';
    }

    this.validateField(firstName, 'firstName', errors, {
      required: true,
      minLength: 2,
      maxLength: 30,
      regex: /^[\p{L}\s'-]+$/u,
    });
    this.validateField(lastName, 'lastName', errors, {
      required: true,
      maxLength: 30,
      regex: /^[\p{L}\s'-]+$/u,
    });
    this.validateField(phone, 'phone', errors, { required: true, regex: /^[0-9]{10,11}$/ });

    if (workCenter) {
      const { centerId, startDate } = workCenter;
      const hasCenterId = centerId?.trim();
      const hasStartDate = startDate?.trim();

      if (hasCenterId || hasStartDate) {
        this.validateWorkCenter(workCenter, errors, true);
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new BadRequestException({ message: 'Validation failed', errors });
    }

    const defaultPwd = this.configService.get<string>(
      role === AccountRole.TECHNICIAN ? 'DEFAULT_TECHNICIAN_PASSWORD' : 'DEFAULT_STAFF_PASSWORD'
    );
    if (!defaultPwd) throw new Error(`Default password not set for ${role}`);

    const accountId = await this.prisma.$transaction(async tx => {
      const acc = await tx.account.create({
        data: { email, phone, password: await hashPassword(defaultPwd), role, status: 'VERIFIED' },
      });
      await tx.employee.create({ data: { accountId: acc.id, firstName, lastName } });
      return acc.id;
    });

    if (workCenter) {
      const { centerId, startDate } = workCenter;
      if (centerId?.trim() && startDate?.trim()) {
        await this.assignEmployeeToServiceCenter(accountId, workCenter);
      }
    }

    const created = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: this.getEmployeeSelectFields(),
    });

    return plainToInstance(EmployeeWithCenterDTO, this.transformAccountToDTO(created!), {
      excludeExtraneousValues: true,
    });
  }
}
