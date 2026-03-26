import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private mapPrismaCreateError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(', ') : String(error.meta?.target ?? '');
      if (target.includes('cedula')) {
        throw new ConflictException('Ya existe un usuario con esa cedula');
      }
      if (target.includes('correo')) {
        throw new ConflictException('Ya existe un usuario con ese correo');
      }
      throw new ConflictException('Ya existe un usuario con los datos enviados');
    }
    throw error;
  }

  async findAll() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return users.map((user) => ({
      id: user.id,
      cedula: user.cedula,
      nombre: user.nombre,
      correo: user.correo,
      telefono: user.telefono ?? '',
      roles: user.roles.map((entry) => entry.role.name),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  }

  async findByRole(roleName: string) {
    if (!roleName) {
      throw new NotFoundException('Rol no especificado');
    }

    const users = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        roles: {
          some: {
            role: { name: roleName },
          },
        },
      },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return users.map((user) => ({
      id: user.id,
      cedula: user.cedula,
      nombre: user.nombre,
      correo: user.correo,
      telefono: user.telefono ?? '',
      roles: user.roles.map((entry) => entry.role.name),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  }

  async create(dto: CreateUserDto) {
    const roleNames = dto.roles ?? [];
    const roleRows = await this.prisma.role.findMany({
      where: { name: { in: roleNames } },
      select: { id: true, name: true },
    });
    if (roleRows.length !== roleNames.length) {
      const existingRoles = new Set(roleRows.map((role) => role.name));
      const missingRoles = roleNames.filter((roleName) => !existingRoles.has(roleName));
      throw new BadRequestException(`Roles no válidos: ${missingRoles.join(', ')}`);
    }
    const roleIds = roleRows.map((role) => role.id);

    try {
      const user = await this.prisma.user.create({
        data: {
          cedula: dto.cedula,
          nombre: dto.nombre,
          correo: dto.correo,
          telefono: dto.telefono ?? null,
          password: dto.password ?? 'cambiar123',
          roles: {
            create: roleIds.map((roleId) => ({
              roleId,
            })),
          },
        },
        include: {
          roles: {
            include: {
              role: true,
            },
          },
        },
      });

      return {
        id: user.id,
        cedula: user.cedula,
        nombre: user.nombre,
        correo: user.correo,
        telefono: user.telefono ?? '',
        roles: user.roles.map((entry) => entry.role.name),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };
    } catch (error) {
      this.mapPrismaCreateError(error);
    }
  }

  async update(id: number, dto: UpdateUserDto) {
    const existing = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Usuario no encontrado');
    }

    let roleIds: number[] | undefined;
    if (dto.roles) {
      const roleRows = await this.prisma.role.findMany({
        where: { name: { in: dto.roles } },
        select: { id: true },
      });
      roleIds = roleRows.map((role) => role.id);
    }

    const user = await this.prisma.$transaction(async (tx) => {
      if (roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        if (roleIds.length > 0) {
          await tx.userRole.createMany({
            data: roleIds.map((roleId) => ({ userId: id, roleId })),
            skipDuplicates: true,
          });
        }
      }

      return tx.user.update({
        where: { id },
        data: {
          nombre: dto.nombre,
          correo: dto.correo,
          telefono: dto.telefono,
        },
        include: {
          roles: {
            include: {
              role: true,
            },
          },
        },
      });
    });

    return {
      id: user.id,
      cedula: user.cedula,
      nombre: user.nombre,
      correo: user.correo,
      telefono: user.telefono ?? '',
      roles: user.roles.map((entry) => entry.role.name),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async remove(id: number): Promise<void> {
    const existing = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Usuario no encontrado');
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
      },
    });
  }
}

