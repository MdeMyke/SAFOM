import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  async findRoles() {
    return this.prisma.role.findMany({
      select: {
        id: true,
        name: true,
        description: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async getPermissionsByUserId(userId: number): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      select: {
        role: {
          select: {
            permissions: {
              select: {
                permission: {
                  select: {
                    action: true,
                    resource: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const permissions = rows.flatMap((row) =>
      row.role.permissions.map(
        (rp) => `${rp.permission.resource}.${rp.permission.action}`,
      ),
    );

    return [...new Set(permissions)];
  }
}

