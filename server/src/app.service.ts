import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  health(): { ok: boolean; service: string } {
    return { ok: true, service: 'nca-scanner' };
  }
}
