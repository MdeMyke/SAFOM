export class CreateTicketDto {
  titulo!: string;
  descripcion?: string;
  categoriaId!: number;
  subcategoriaId!: number;
  prioridadId!: number;

  /**
   * Stub hasta integrar auth/sesión.
   * Si no llega, se asumirá 1 en el servicio.
   */
  userId?: number;
}

