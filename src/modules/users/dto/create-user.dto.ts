export class CreateUserDto {
  cedula!: string;
  nombre!: string;
  correo!: string;
  telefono?: string;
  password?: string;
  roles!: string[];
}

