require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const roles = [
    { name: 'super_admin', description: 'Acceso total al sistema' },
    { name: 'soporte', description: 'Soporte funcional y operativo' },
    { name: 'desarrollo', description: 'Equipo de desarrollo' },
    { name: 'gestion_de_datos', description: 'Gestion y calidad de datos' },
    { name: 'infraestructura', description: 'Operacion de infraestructura y plataforma' },
  ];

  const permissions = [
    { action: 'read', resource: 'users', description: 'Ver usuarios' },
    { action: 'create', resource: 'users', description: 'Crear usuarios' },
    { action: 'update', resource: 'users', description: 'Editar usuarios' },
    { action: 'delete', resource: 'users', description: 'Eliminar usuarios' },
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description },
      create: role,
    });
  }

  for (const permission of permissions) {
    await prisma.permission.upsert({
      where: { action_resource: { action: permission.action, resource: permission.resource } },
      update: { description: permission.description },
      create: permission,
    });
  }

  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: 'super_admin' } });
  const userRead = await prisma.permission.findUniqueOrThrow({
    where: { action_resource: { action: 'read', resource: 'users' } },
  });

  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: superAdmin.id, permissionId: userRead.id } },
    update: {},
    create: { roleId: superAdmin.id, permissionId: userRead.id },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

