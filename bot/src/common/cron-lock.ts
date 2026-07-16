import { PrismaService } from '../prisma/prisma.service';

/**
 * Verrou distribué léger pour crons multi-instances.
 *
 * PROBLÈME : les décorateurs @Cron de NestJS s'exécutent dans CHAQUE instance en
 * cours (ex : serveur de preview + serveur de production tournant simultanément).
 * Résultat : trades exécutés en double, résumés Telegram envoyés deux fois, et
 * charge RPC doublée (429). Ce verrou garantit qu'une itération de cron donnée ne
 * s'exécute que dans UNE seule instance.
 *
 * MÉCANISME : chaque "tick" de cron correspond à un bucket temporel
 * (Math.floor(now / intervalMs)). La première instance qui réclame le bucket
 * courant via un UPDATE conditionnel atomique (sérialisé par Postgres) gagne ; les
 * autres voient la valeur déjà positionnée et s'abstiennent.
 *
 * FAIL-OPEN : en cas d'erreur DB, on autorise l'exécution (on ne bloque JAMAIS le
 * trading / la surveillance des risques sur une panne de base transitoire).
 *
 * @returns true si CETTE instance doit exécuter l'itération courante.
 */
export async function acquireCronRun(
  prisma: PrismaService,
  name: string,
  intervalMs: number,
): Promise<boolean> {
  const KEY = `cronlock_${name}`;
  const bucket = String(Math.floor(Date.now() / intervalMs));
  try {
    // Garantit l'existence de la ligne (no-op si déjà présente).
    await prisma.app_config.upsert({ where: { key: KEY }, create: { key: KEY, value: '' }, update: {} });
    // UPDATE atomique conditionnel : ne réussit que si le bucket courant n'est pas déjà pris.
    const res = await prisma.app_config.updateMany({
      where: { key: KEY, value: { not: bucket } },
      data: { value: bucket },
    });
    return res.count > 0;
  } catch {
    return true; // fail-open
  }
}
