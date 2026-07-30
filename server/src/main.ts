import 'dotenv/config';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true;
  if (/^https:\/\/(www\.|beta\.)waze\.com$/i.test(origin)) return true;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return true;
  return false;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
  });

  app.enableCors({
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) => {
      cb(null, isAllowedCorsOrigin(origin));
    },
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Access-Control-Request-Private-Network'],
    maxAge: 86400,
  });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
