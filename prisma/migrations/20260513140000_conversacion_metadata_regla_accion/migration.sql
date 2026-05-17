-- AlterTable
ALTER TABLE `conversaciones` ADD COLUMN `metadata` JSON NULL;

-- AlterTable
ALTER TABLE `reglas_flujo` ADD COLUMN `tipo_accion` VARCHAR(191) NULL,
    ADD COLUMN `payload_accion` JSON NULL;
