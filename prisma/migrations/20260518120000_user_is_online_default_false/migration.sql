-- Usuarios nuevos quedan offline hasta que inicien sesión.
ALTER TABLE `User` MODIFY `is_online` TINYINT NOT NULL DEFAULT 0;
