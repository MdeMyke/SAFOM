# Auth y RBAC

## Diferencia clave

- Autenticacion (`auth`): responde "quien eres".
- Autorizacion (`rbac`): responde "que puedes hacer".

Ambas capas son complementarias:

1. Primero autenticas al usuario.
2. Luego validas sus permisos para cada recurso/accion.

## Estructura actual del proyecto

### Modulo Auth (`src/modules/auth`)

- `auth.module.ts`
- `auth.service.ts`
- `guards/jwt-auth.guard.ts`
- `strategies/jwt.strategy.ts`

Estado actual:

- Existe la base del guard y servicio.
- `AuthService.validateToken` es un placeholder inicial.
- Todavia no se integra Passport/JWT real ni carga de usuario desde DB.

### Modulo RBAC (`src/modules/rbac`)

- `rbac.module.ts`
- `rbac.service.ts`
- `decorators/permisos.decorator.ts`
- `guards/permisos.guard.ts`
- `constants/rbac.constants.ts`
- `types/rbac.types.ts`

Estado actual:

- Ya existe validacion por permisos en endpoints con `@Permisos(...)`.
- `PermisosGuard` permite fallback por header (`x-permisos`) para pruebas.
- `RbacService` consulta permisos efectivos por `userId` desde Prisma.

## Flujo esperado (objetivo)

1. `JwtAuthGuard` valida token real.
2. Se resuelve el usuario autenticado y se adjunta en `req.user`.
3. `PermisosGuard` toma `req.user` y valida permisos requeridos del endpoint.
4. Si cumple, continua; si no, responde `403`.

## Flujo temporal actual (pruebas)

Mientras no este JWT completo, `PermisosGuard` puede leer:

- `x-permisos: users.read,users.update`

Esto acelera pruebas funcionales de RBAC sin bloquear avance.

## Pendientes recomendados

- Integrar Passport JWT real en `auth`.
- Cargar permisos desde Prisma por usuario (sin depender de headers).
- Encadenar guardias: autenticacion primero, autorizacion despues.
- Agregar pruebas e2e de `401` y `403`.

