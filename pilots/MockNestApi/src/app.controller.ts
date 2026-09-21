import { Controller, Get } from '@nestjs/common';
import { describe, FalconZone, getSecretKeyName } from 'mock-node-library';

@Controller('mock-nest-api')
export class AppController {
  @Get('falcon')
  getFalconStatus(): string {
    return describe(FalconZone.Falcon);
  }

  @Get('secret-key-name')
  getSecretKeyNameRoute(): string {
    return getSecretKeyName();
  }
}
