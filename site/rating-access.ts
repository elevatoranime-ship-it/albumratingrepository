/** null/отсутствующее поле — прежнее совместное оценивание. */
export interface RatingAccess { evaluatorId?: string | null; }
export interface ConfirmableRating { score: number; confirmed: boolean; }

export function canEvaluate(release: RatingAccess | undefined, profileId: string | undefined): boolean {
  return Boolean(release && profileId && (!release.evaluatorId || release.evaluatorId === profileId));
}

export function sameEvaluators(a: RatingAccess, b: RatingAccess): boolean {
  return (a.evaluatorId ?? null) === (b.evaluatorId ?? null);
}

export function requiredEvaluators(release: RatingAccess, profiles: Iterable<string>): string[] {
  return release.evaluatorId ? [release.evaluatorId] : [...profiles];
}

/** Пустой альбом и неполный список участников общего релиза не подтверждаются. */
export function allRatingsConfirmed(
  release: RatingAccess,
  profiles: Iterable<string>,
  rows: Array<Record<string, ConfirmableRating> | undefined>,
): boolean {
  const required = requiredEvaluators(release, profiles);
  if (!rows.length || required.length < (release.evaluatorId ? 1 : 2)) return false;
  return rows.every((row) => required.every((id) => row?.[id]?.confirmed === true));
}
