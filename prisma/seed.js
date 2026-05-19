require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  const roles = [
    { name: 'super_admin', description: 'Acceso total al sistema' },
    { name: 'admin', description: 'Administrador del sistema' },
    { name: 'interno', description: 'Usuario interno' },
    { name: 'externo', description: 'Usuario externo' },
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
    // Permisos globales (para pruebas)
    { action: 'externo', resource: 'global', description: 'Permiso global para usuarios externos' },
    { action: 'interno', resource: 'global', description: 'Permiso global para usuarios internos' },
    { action: 'admin', resource: 'global', description: 'Permiso global para administradores' },
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
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });
  const internoRole = await prisma.role.findUniqueOrThrow({ where: { name: 'interno' } });
  const externoRole = await prisma.role.findUniqueOrThrow({ where: { name: 'externo' } });

  const permissionGlobalExterno = await prisma.permission.findUniqueOrThrow({
    where: { action_resource: { action: 'externo', resource: 'global' } },
  });
  const permissionGlobalInterno = await prisma.permission.findUniqueOrThrow({
    where: { action_resource: { action: 'interno', resource: 'global' } },
  });
  const permissionGlobalAdmin = await prisma.permission.findUniqueOrThrow({
    where: { action_resource: { action: 'admin', resource: 'global' } },
  });

  // Vinculos base
  const rolePermissionPairs = [
    // super_admin: todo lo global
    { roleId: superAdmin.id, permissionId: permissionGlobalExterno.id },
    { roleId: superAdmin.id, permissionId: permissionGlobalInterno.id },
    { roleId: superAdmin.id, permissionId: permissionGlobalAdmin.id },
    // admin: admin + interno
    { roleId: adminRole.id, permissionId: permissionGlobalAdmin.id },
    { roleId: adminRole.id, permissionId: permissionGlobalInterno.id },
    // interno
    { roleId: internoRole.id, permissionId: permissionGlobalInterno.id },
    // externo
    { roleId: externoRole.id, permissionId: permissionGlobalExterno.id },
  ];

  for (const pair of rolePermissionPairs) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: pair.roleId, permissionId: pair.permissionId } },
      update: {},
      create: pair,
    });
  }

  // =========================
  // USUARIO INICIAL (AUTH)
  // =========================
  const initialEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@safom.local').trim().toLowerCase();
  const initialPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin123*';
  const initialCedula = process.env.SEED_ADMIN_CEDULA || '0000000000';
  const initialNombre = process.env.SEED_ADMIN_NOMBRE || 'Super Admin';

  const passwordHash = await bcrypt.hash(initialPassword, 10);

  const seededUser = await prisma.user.upsert({
    where: { correo: initialEmail },
    update: {
      nombre: initialNombre,
      cedula: initialCedula,
      password: passwordHash,
      passwordChangeAt: new Date(),
      deletedAt: null,
    },
    create: {
      correo: initialEmail,
      nombre: initialNombre,
      cedula: initialCedula,
      password: passwordHash,
      passwordChangeAt: new Date(),
    },
    select: { id: true, correo: true },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: seededUser.id, roleId: superAdmin.id } },
    update: {},
    create: { userId: seededUser.id, roleId: superAdmin.id },
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

  const etiquetasSeed = [
    {
      nombre: 'Escalado',
      color: '#FED7AA',
      descripcion: 'Conversación escalada desde inbox',
    },
  ];

  for (const item of etiquetasSeed) {
    await prisma.etiqueta.upsert({
      where: { nombre: item.nombre },
      update: {
        color: item.color,
        descripcion: item.descripcion,
        deletedAt: null,
        deletedBy: null,
      },
      create: item,
    });
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

  await seedFlujoSoporteHorus(prisma);
}

/**
 * Flujo WhatsApp soporte HORUS (estados + reglas).
 * Idempotente: elimina y recrea el flujo `soporte_horus` si ya existía.
 */
async function seedFlujoSoporteHorus(prisma) {
  const nombreFlujo = 'soporte_horus';
  const existing = await prisma.flujo.findFirst({ where: { nombre: nombreFlujo } });
  if (existing) {
    await prisma.reglaFlujo.deleteMany({ where: { flujoId: existing.id } });
    await prisma.estadoFlujo.deleteMany({ where: { flujoId: existing.id } });
    await prisma.flujo.delete({ where: { id: existing.id } });
  }

  const flujo = await prisma.flujo.create({ data: { nombre: nombreFlujo } });

  const nombresEstados = [
    'inicio',
    'tipo_identificacion',
    'esperando_cedula',
    'esperando_nit',
    'esperando_nombre',
    'tipo_usuario',
    'menu_afiliado',
    'menu_prestador',
    'menu_externo',
    'menu_empleado',
    'esperando_asesor',
    'flujo_finalizado',
  ];

  const menuTipoUsuario =
    'Seleccione el tipo de usuario:\n\n1️⃣ Afiliado\n2️⃣ Prestador\n3️⃣ Externo\n4️⃣ Empleado';

  const reglaInvalida = (estado, textoRespuesta) => ({
    estado,
    tipoDisparador: 'default',
    valorDisparador: null,
    textoRespuesta,
    siguiente: estado,
  });

  const estadoIdByNombre = new Map();
  for (const nombre of nombresEstados) {
    const row = await prisma.estadoFlujo.create({
      data: { flujoId: flujo.id, nombreEstado: nombre },
    });
    estadoIdByNombre.set(nombre, row.id);
  }

  const idOf = (nombre) => {
    const id = estadoIdByNombre.get(nombre);
    if (!id) throw new Error(`Estado flujo no definido: ${nombre}`);
    return id;
  };

  const motivoOpcionesAfiliado = {
    '1': 'problema_acceso_horus',
    '2': 'actualizar_contacto',
    '3': 'info_radicado_afiliaciones',
    '4': 'info_autorizaciones',
    '5': 'problema_app_fomag',
    '6': 'libre_eleccion',
    '7': 'puntos_atencion',
    '8': 'error_solicitud_radicado',
    '9': 'como_colocar_pqrs',
    '10': 'otros_tramites_fomag',
  };

  const motivoOpcionesPrestador = {
    '1': 'problema_acceso_horus',
    '2': 'solicitar_usuario_horus',
    '3': 'sistema_lento_intermitente',
    '4': 'info_capacitaciones',
    '5': 'problema_rips_json',
    '6': 'problema_soportes_atencion',
    '7': 'soportes_administrativos',
    '8': 'glosas_devoluciones',
    '9': 'problema_transcripcion',
    '10': 'otro_inconveniente',
  };

  const motivoOpcionesExternoEmpleado = {
    '1': 'problema_acceso_horus',
    '2': 'solicitar_usuario_horus',
    '3': 'sistema_lento_intermitente',
    '4': 'info_capacitaciones',
    '5': 'problema_auditoria',
    '6': 'problema_reportes',
    '7': 'permiso_o_rol',
    '8': 'problema_centro_regulador',
    '9': 'problema_transcripcion',
    '10': 'otro_inconveniente',
  };

  const reglas = [
    {
      estado: 'inicio',
      tipoDisparador: 'cualquier_texto',
      valorDisparador: '*',
      textoRespuesta:
        '👋 Bienvenido al soporte técnico de SUIM HORUS\n\nSeleccione el tipo de identificación:\n\n1️⃣ Cédula\n2️⃣ NIT',
      siguiente: 'tipo_identificacion',
    },
    {
      estado: 'tipo_identificacion',
      tipoDisparador: 'texto',
      valorDisparador: '1',
      textoRespuesta: 'Digite su número de cédula\n\n(solo números)',
      siguiente: 'esperando_cedula',
      tipoAccion: 'merge_metadata',
      payloadAccion: { tipo_documento: 'cedula' },
    },
    {
      estado: 'tipo_identificacion',
      tipoDisparador: 'texto',
      valorDisparador: '2',
      textoRespuesta: 'Digite su número de NIT\n\n(solo números)',
      siguiente: 'esperando_nit',
      tipoAccion: 'merge_metadata',
      payloadAccion: { tipo_documento: 'nit' },
    },
    {
      estado: 'esperando_cedula',
      tipoDisparador: 'regex',
      valorDisparador: '^[0-9]{5,20}$',
      textoRespuesta: 'Digite su nombre completo\n\n(solo letras, mínimo 3 caracteres)',
      siguiente: 'esperando_nombre',
    },
    reglaInvalida(
      'esperando_cedula',
      '❌ Número no válido. Digite solo números de cédula (entre 5 y 20 dígitos).\n\nEjemplo: 1234567890',
    ),
    {
      estado: 'esperando_nit',
      tipoDisparador: 'regex',
      valorDisparador: '^[0-9]{5,20}$',
      textoRespuesta: 'Digite su nombre completo\n\n(solo letras, mínimo 3 caracteres)',
      siguiente: 'esperando_nombre',
    },
    reglaInvalida(
      'esperando_nit',
      '❌ Número no válido. Digite solo números de NIT (entre 5 y 20 dígitos).\n\nEjemplo: 900123456',
    ),
    {
      estado: 'esperando_nombre',
      tipoDisparador: 'regex',
      valorDisparador: "^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\\s.'-]{3,80}$",
      textoRespuesta: menuTipoUsuario,
      siguiente: 'tipo_usuario',
    },
    reglaInvalida(
      'esperando_nombre',
      '❌ Nombre no válido. Digite su nombre completo (mínimo 3 letras, sin números).',
    ),
    reglaInvalida(
      'tipo_identificacion',
      '❌ Opción no válida. Responda solo con el número:\n\n1 — Cédula\n2 — NIT',
    ),
    {
      estado: 'tipo_usuario',
      tipoDisparador: 'texto',
      valorDisparador: '1',
      textoRespuesta:
        'Seleccione la opción que mejor describa su solicitud:\n\n1️⃣ No puede ingresar a Horus\n2️⃣ Actualizar datos de contacto\n3️⃣ Información radicado afiliaciones\n4️⃣ Información autorizaciones\n5️⃣ Problemas APP FOMAG\n6️⃣ Libre elección\n7️⃣ Puntos de atención\n8️⃣ Error solicitud radicado\n9️⃣ Cómo colocar PQRS\n🔟 Otros trámites FOMAG',
      siguiente: 'menu_afiliado',
      tipoAccion: 'merge_metadata',
      payloadAccion: { tipo_usuario: 'afiliado' },
    },
    {
      estado: 'tipo_usuario',
      tipoDisparador: 'texto',
      valorDisparador: '2',
      textoRespuesta:
        'Seleccione la opción que mejor describa su solicitud:\n\n1️⃣ No puede ingresar a Horus\n2️⃣ Solicitar usuario Horus\n3️⃣ Sistema lento/intermitente\n4️⃣ Información capacitaciones\n5️⃣ Problema RIPS JSON\n6️⃣ Problema soportes atención\n7️⃣ Soportes administrativos\n8️⃣ Glosas y devoluciones\n9️⃣ Problema transcripción\n🔟 Otro inconveniente',
      siguiente: 'menu_prestador',
      tipoAccion: 'merge_metadata',
      payloadAccion: { tipo_usuario: 'prestador' },
    },
    {
      estado: 'tipo_usuario',
      tipoDisparador: 'texto',
      valorDisparador: '3',
      textoRespuesta:
        'Seleccione la opción que mejor describa su solicitud:\n\n1️⃣ No puede ingresar a Horus\n2️⃣ Solicitar usuario Horus\n3️⃣ Sistema lento/intermitente\n4️⃣ Información capacitaciones\n5️⃣ Problema auditoría\n6️⃣ Problema reportes\n7️⃣ Permiso o rol\n8️⃣ Problema centro regulador\n9️⃣ Problema transcripción\n🔟 Otro inconveniente',
      siguiente: 'menu_externo',
      tipoAccion: 'merge_metadata',
      payloadAccion: { tipo_usuario: 'externo' },
    },
    {
      estado: 'tipo_usuario',
      tipoDisparador: 'texto',
      valorDisparador: '4',
      textoRespuesta:
        'Seleccione la opción que mejor describa su solicitud:\n\n1️⃣ No puede ingresar a Horus\n2️⃣ Solicitar usuario Horus\n3️⃣ Sistema lento/intermitente\n4️⃣ Información capacitaciones\n5️⃣ Problema auditoría\n6️⃣ Problema reportes\n7️⃣ Permiso o rol\n8️⃣ Problema centro regulador\n9️⃣ Problema transcripción\n🔟 Otro inconveniente',
      siguiente: 'menu_empleado',
      tipoAccion: 'merge_metadata',
      payloadAccion: { tipo_usuario: 'empleado' },
    },
    reglaInvalida(
      'tipo_usuario',
      '❌ Opción no válida. Responda solo con el número:\n\n1 — Afiliado\n2 — Prestador\n3 — Externo\n4 — Empleado',
    ),
    {
      estado: 'menu_afiliado',
      tipoDisparador: 'regex',
      valorDisparador: '^(1|2|3|4|5|6|7|8|9|10)$',
      textoRespuesta:
        '✅ Tu solicitud fue registrada correctamente.\n\nUn asesor especializado atenderá tu caso lo antes posible.',
      siguiente: 'esperando_asesor',
      tipoAccion: 'merge_metadata',
      payloadAccion: { motivoOpciones: motivoOpcionesAfiliado },
    },
    reglaInvalida(
      'menu_afiliado',
      '❌ Opción no válida. Responda con un número del 1 al 10 según el menú anterior.',
    ),
    {
      estado: 'menu_prestador',
      tipoDisparador: 'regex',
      valorDisparador: '^(1|2|3|4|5|6|7|8|9|10)$',
      textoRespuesta:
        '✅ Tu solicitud fue registrada correctamente.\n\nUn asesor especializado atenderá tu caso lo antes posible.',
      siguiente: 'esperando_asesor',
      tipoAccion: 'merge_metadata',
      payloadAccion: { motivoOpciones: motivoOpcionesPrestador },
    },
    reglaInvalida(
      'menu_prestador',
      '❌ Opción no válida. Responda con un número del 1 al 10 según el menú anterior.',
    ),
    {
      estado: 'menu_externo',
      tipoDisparador: 'regex',
      valorDisparador: '^(1|2|3|4|5|6|7|8|9|10)$',
      textoRespuesta:
        '✅ Tu solicitud fue registrada correctamente.\n\nUn asesor especializado atenderá tu caso lo antes posible.',
      siguiente: 'esperando_asesor',
      tipoAccion: 'merge_metadata',
      payloadAccion: { motivoOpciones: motivoOpcionesExternoEmpleado },
    },
    reglaInvalida(
      'menu_externo',
      '❌ Opción no válida. Responda con un número del 1 al 10 según el menú anterior.',
    ),
    {
      estado: 'menu_empleado',
      tipoDisparador: 'regex',
      valorDisparador: '^(1|2|3|4|5|6|7|8|9|10)$',
      textoRespuesta:
        '✅ Tu solicitud fue registrada correctamente.\n\nUn asesor interno atenderá tu caso lo antes posible.',
      siguiente: 'esperando_asesor',
      tipoAccion: 'merge_metadata',
      payloadAccion: { motivoOpciones: motivoOpcionesExternoEmpleado },
    },
    reglaInvalida(
      'menu_empleado',
      '❌ Opción no válida. Responda con un número del 1 al 10 según el menú anterior.',
    ),
  ];

  for (const r of reglas) {
    await prisma.reglaFlujo.create({
      data: {
        flujoId: flujo.id,
        estadoActualId: idOf(r.estado),
        tipoDisparador: r.tipoDisparador,
        valorDisparador: r.valorDisparador,
        textoRespuesta: r.textoRespuesta,
        siguienteEstadoId: idOf(r.siguiente),
        tipoAccion: r.tipoAccion ?? null,
        payloadAccion: r.payloadAccion ?? undefined,
      },
    });
  }

  console.log(`[seed] Flujo "${nombreFlujo}" creado (${reglas.length} reglas, ${nombresEstados.length} estados).`);
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

