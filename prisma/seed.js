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

  // =========================
  // CATALOGOS (Prioridades, Categorias, Subcategorias)
  // =========================

  const prioridadesSeed = [
    { nombre: 'BAJA', nivel: 1 },
    { nombre: 'MEDIA', nivel: 2 },
    { nombre: 'ALTA', nivel: 3 },
  ];

  for (const item of prioridadesSeed) {
    const exists = await prisma.prioridad.findFirst({ where: { nombre: item.nombre } });
    if (!exists) {
      await prisma.prioridad.create({ data: item });
    }
  }

  const estadosSeed = [
    { nombre: 'abierto' },
    { nombre: 'asignado' },
    { nombre: 'en_progreso' },
    { nombre: 'pendiente_aprobacion' },
    { nombre: 'resuelto' },
    { nombre: 'cerrado' },
  ];

  for (const item of estadosSeed) {
    const exists = await prisma.estado.findFirst({ where: { nombre: item.nombre } });
    if (!exists) {
      await prisma.estado.create({ data: item });
    }
  }

  const categoriasSeed = [
    { nombre: 'Soporte', descripcion: 'Soporte funcional y técnico' },
    { nombre: 'Desarrollo', descripcion: 'Requerimientos y ajustes de desarrollo' },
    { nombre: 'Gestión de datos', descripcion: 'Administración de bases de datos y reportes' },
    { nombre: 'Infraestructura', descripcion: 'Infraestructura y seguridad' },
  ];

  for (const item of categoriasSeed) {
    const exists = await prisma.categoria.findFirst({ where: { nombre: item.nombre } });
    if (!exists) {
      await prisma.categoria.create({ data: item });
    }
  }

  const categorias = await prisma.categoria.findMany({
    where: { nombre: { in: categoriasSeed.map((c) => c.nombre) } },
    select: { id: true, nombre: true },
  });
  const categoriaIdByNombre = new Map(categorias.map((c) => [c.nombre, c.id]));

  const subcategoriasSeed = [
    // SOPORTE
    { categoria: 'Soporte', nombre: 'Incidentes de la plataforma' },
    { categoria: 'Soporte', nombre: 'Creación y modificación de usuarios' },
    { categoria: 'Soporte', nombre: 'Parametrización de usuarios' },
    { categoria: 'Soporte', nombre: 'Parametrización de módulos' },
    { categoria: 'Soporte', nombre: 'Parametrización y permisos de Roles' },
    { categoria: 'Soporte', nombre: 'Caida plataforma' },
    { categoria: 'Soporte', nombre: 'Fallas operativas con Modulos especificos' },
    { categoria: 'Soporte', nombre: 'Parametrización y ajuste servicios / medicamentos' },
    { categoria: 'Soporte', nombre: 'Parametrización y ajuste de CUPS' },
    { categoria: 'Soporte', nombre: 'Parametrización y ajuste de CUMS' },
    { categoria: 'Soporte', nombre: 'Error en cargue de archivos adjuntos' },
    { categoria: 'Soporte', nombre: 'Error de funcionalidad Módulo Cuentas medicas' },
    { categoria: 'Soporte', nombre: 'Error de funcionalidad Módulo RIPS' },
    { categoria: 'Soporte', nombre: 'Error de contenido paquete rips' },
    { categoria: 'Soporte', nombre: 'Error cargue de RIPS' },
    { categoria: 'Soporte', nombre: 'Notificacion de correos' },
    { categoria: 'Soporte', nombre: 'Error de estructura y contenido' },

    // DESARROLLO
    { categoria: 'Desarrollo', nombre: 'Requerimientos de desarrollo' },
    { categoria: 'Desarrollo', nombre: 'Requerimientos de Controles de cambio' },
    { categoria: 'Desarrollo', nombre: 'Ajustes post desarrollo' },
    { categoria: 'Desarrollo', nombre: 'Ajustes post pruebas técnicas y funcionales' },
    { categoria: 'Desarrollo', nombre: 'Solicitud de despligue al ambiente de pruebas' },
    { categoria: 'Desarrollo', nombre: 'Solicitud de despligue al ambiente de producción' },
    { categoria: 'Desarrollo', nombre: 'Integración con modulos de SUIM-HORUS' },
    { categoria: 'Desarrollo', nombre: 'Integración con Sistemas externos' },
    { categoria: 'Desarrollo', nombre: 'Ajuste y actualiazción de Integraciones' },

    // GESTION DE DATOS
    { categoria: 'Gestión de datos', nombre: 'Parametrización de Bases de datos' },
    { categoria: 'Gestión de datos', nombre: 'Ajuste de Bases de datos' },
    { categoria: 'Gestión de datos', nombre: 'Backup de Bases de datos' },
    { categoria: 'Gestión de datos', nombre: 'Parametrización de Estadisticas - Dash board' },
    { categoria: 'Gestión de datos', nombre: 'Ajustes de Estadisticas - Dash board' },
    { categoria: 'Gestión de datos', nombre: 'Ajuste / parametrización de estructura de Reportes' },
    { categoria: 'Gestión de datos', nombre: 'Generación de reportes' },

    // INFRAESTRUCTURA
    { categoria: 'Infraestructura', nombre: 'Incidentes de la infraestructura' },
    { categoria: 'Infraestructura', nombre: 'Solicitud de informes de indisponibilidad' },
    { categoria: 'Infraestructura', nombre: 'Solicitud de informes de Seguridad de la información' },
    { categoria: 'Infraestructura', nombre: 'Pruebas de Seguridad de la información' },
    { categoria: 'Infraestructura', nombre: 'Solicitud de actividades de Seguridad de la información' },
    { categoria: 'Infraestructura', nombre: 'Documentación sobre Seguridad de la información' },
    { categoria: 'Infraestructura', nombre: 'Validación de la velocidad de la plataforma' },
    { categoria: 'Infraestructura', nombre: 'Inconsistencias con el Catpcha' },
    { categoria: 'Infraestructura', nombre: 'Inconsistencias de ingreso plataforma (seguridad)' },
  ];

  for (const item of subcategoriasSeed) {
    const categoriaId = categoriaIdByNombre.get(item.categoria);
    if (!categoriaId) continue;

    const exists = await prisma.subcategoria.findFirst({
      where: { categoriaId, nombre: item.nombre },
    });
    if (!exists) {
      await prisma.subcategoria.create({
        data: { categoriaId, nombre: item.nombre },
      });
    }
  }
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

