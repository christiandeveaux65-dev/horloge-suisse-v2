import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';

/**
 * Guard d'authentification par API key.
 * Header attendu : x-api-key
 * Vérification : SHA-256(clé reçue) === API_KEY_HASH (env)
 * Si API_KEY_HASH non défini → auth désactivée (mode dev)
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const apiKeyHash = this.config.get<string>('API_KEY_HASH');
    if (!apiKeyHash) {
      // Mode dev : pas d'auth
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const receivedKey = request.headers['x-api-key'];

    if (!receivedKey) {
      throw new UnauthorizedException('Header x-api-key manquant');
    }

    const hash = createHash('sha256').update(receivedKey).digest('hex');
    if (hash !== apiKeyHash) {
      this.logger.warn('Tentative d\'accès avec clé API invalide');
      throw new UnauthorizedException('Clé API invalide');
    }

    return true;
  }
}
