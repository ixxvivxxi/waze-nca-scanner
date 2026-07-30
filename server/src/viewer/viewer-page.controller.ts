import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

@Controller('viewer')
export class ViewerPageController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async getPage(@Res() res: Response): Promise<void> {
    const htmlPath = join(__dirname, 'viewer.page.html');
    const html = await readFile(htmlPath, 'utf8');
    res.send(html);
  }
}
