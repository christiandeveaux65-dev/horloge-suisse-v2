import { SetMetadata } from '@nestjs/common';

/**
 * Marque une route comme PUBLIQUE : l'ApiKeyGuard la laisse passer sans exiger
 * le header x-api-key. Utilisé pour le webhook Telegram (Telegram ne peut pas
 * envoyer notre clé API ; la sécurité repose sur le secret token Telegram).
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
