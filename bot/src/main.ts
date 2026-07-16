import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  // Validation globale des DTOs (types + bornes)
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));

  // CORS — piloté par CORS_ORIGIN (whitelist CSV). Jamais '*' en prod.
  const corsEnv = process.env.CORS_ORIGIN?.trim();
  if (!corsEnv || corsEnv === '*') {
    if (process.env.NODE_ENV === 'production') {
      Logger.warn('CORS_ORIGIN non défini en production — CORS restreint (aucune origine navigateur autorisée)', 'Bootstrap');
      app.enableCors({ origin: false });
    } else {
      // Dev uniquement : ouvert pour faciliter les tests locaux
      app.enableCors({ origin: '*' });
    }
  } else {
    const whitelist = corsEnv.split(',').map((o) => o.trim()).filter(Boolean);
    app.enableCors({ origin: whitelist, credentials: true });
    Logger.log(`CORS whitelist : ${whitelist.join(', ')}`, 'Bootstrap');
  }

  // Swagger avec branding personnalisé
  const swaggerPath = 'api-docs';

  // Anti-cache middleware pour Swagger
  app.use(`/${swaggerPath}`, (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
  });

  const config = new DocumentBuilder()
    .setTitle("L'Horloge Suisse v2")
    .setDescription('Bot de trading crypto multi-strat\u00e9gie sur Arbitrum \u2014 API de contr\u00f4le et monitoring')
    .setVersion('2.0.0')
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(swaggerPath, app, document, {
    customSiteTitle: "L'Horloge Suisse v2 — API",
    customCss: `
      .swagger-ui .topbar { display: none; }
      .swagger-ui .info .title { font-size: 2em; color: #1a1a2e; }
      .swagger-ui .info .description p { color: #333; font-size: 1.1em; }
      .swagger-ui .opblock-tag { font-size: 1.1em; border-bottom: 2px solid #e0e0e0; }
      .swagger-ui .opblock.opblock-get .opblock-summary { border-color: #3b82f6; }
      .swagger-ui .opblock.opblock-post .opblock-summary { border-color: #10b981; }
      body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    `,
  });

  const port = 3000;
  await app.listen(port);
  Logger.log(`\ud83d\udd52 L'Horloge Suisse v2 d\u00e9marr\u00e9e sur le port ${port}`, 'Bootstrap');
  Logger.log(`\ud83d\udcda API docs : http://localhost:${port}/${swaggerPath}`, 'Bootstrap');
}

bootstrap();
