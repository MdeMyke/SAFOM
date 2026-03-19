# RBAC Base

## Estado actual

El proyecto usa un modulo dedicado de RBAC en `src/modules/rbac` para autorizacion por permisos.

Componentes actuales:

- Decorador `@Permisos(...)`
- Guard `PermisosGuard`
- Servicio `RbacService` para resolver permisos desde Prisma

## Que es RBAC y por que escala

RBAC (Role-Based Access Control) es un modelo donde los accesos no se asignan usuario por usuario, sino por roles.

En esta arquitectura:

- Puedes crear muchos roles segun crezca el negocio (no hay limite practico).
- A cada rol se le asignan permisos especificos por accion y recurso.
- Un usuario puede tener uno o varios roles al mismo tiempo.

Esto mantiene el sistema escalable porque, en lugar de codificar reglas fijas por perfil, solo agregas o ajustas permisos en base de datos:

- Si aparece un nuevo equipo/area, creas un rol nuevo.
- Si cambia una responsabilidad, solo actualizas sus permisos.
- El backend sigue usando el mismo `PermisosGuard` y el mismo decorador `@Permisos(...)`.

Con esto, la autorizacion crece sin rehacer la arquitectura.

## Modelado en Prisma

Modelos de RBAC:

- `Role`
- `Permission` (mapeado a tabla `Permisos`)
- `UserRole`
- `RolePermission` (mapeado a tabla `RolePermisos`)

Regla clave:

- `Permission` tiene unicidad compuesta por `action + resource`

## Roles reales del aplicativo

Los roles oficiales actuales son:

- `super_admin`
- `soporte`
- `desarrollo`
- `gestion_de_datos`
- `infraestructura`

Estos roles se cargan desde `prisma/seed.js`.

## Base de datos actual

Actualmente el proyecto esta configurado para MySQL (XAMPP):

- `provider = "mysql"` en `prisma/schema.prisma`
- `DATABASE_URL` de ejemplo en `env.example`

## Prueba rapida de RBAC

1. Sincronizar schema:

```bash
npx prisma db push
```

2. Sembrar datos base:

```bash
npm run prisma:seed
```

3. Levantar API:

```bash
npm run start:dev
```

4. Probar endpoint protegido:

- `GET /admin/users`
- Header: `x-permisos: users.read`

Sin ese permiso, responde `403`.

## Siguiente paso recomendado

Reemplazar el fallback de `x-permisos` por permisos reales del usuario autenticado (JWT/session) y poblar `req.user` desde el flujo de autenticacion.

