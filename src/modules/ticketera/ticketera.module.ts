import { Module } from '@nestjs/common';
import { TicketeraController } from './ticketera.controller';
import { TicketeraService } from './ticketera.service';

@Module({
  controllers: [TicketeraController],
  providers: [TicketeraService],
})
export class TicketeraModule {}

