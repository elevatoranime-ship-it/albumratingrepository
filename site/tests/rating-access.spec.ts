import { expect, test } from '@playwright/test';
import { allRatingsConfirmed, canEvaluate, requiredEvaluators, sameEvaluators } from '../rating-access';

const personal = { evaluatorId: 'one' };
const profiles = ['one', 'two'];
const confirmed = { one: { score: 0, confirmed: true } };

test('персональный релиз: только назначенный участник, даже без второго профиля', () => {
  expect(canEvaluate(personal, 'one')).toBe(true);
  expect(canEvaluate(personal, 'two')).toBe(false);
  expect(canEvaluate(personal, undefined)).toBe(false);
  expect(canEvaluate(undefined, 'one')).toBe(false);
  expect(requiredEvaluators(personal, profiles)).toEqual(['one']);
  expect(allRatingsConfirmed(personal, ['one'], [confirmed])).toBe(true);
  expect(allRatingsConfirmed(personal, profiles, [confirmed, confirmed])).toBe(true);
});

test('полнота: пустой альбом, отсутствующий трек и черновик не подтверждаются', () => {
  expect(allRatingsConfirmed(personal, profiles, [])).toBe(false);
  expect(allRatingsConfirmed(personal, profiles, [confirmed, undefined])).toBe(false);
  expect(allRatingsConfirmed(personal, profiles, [{ one: { score: 10, confirmed: false } }])).toBe(false);
  expect(allRatingsConfirmed(personal, profiles, [{ two: { score: 10, confirmed: true } }])).toBe(false);
});

test('старые релизы: нужны обе подтверждённые оценки каждого трека', () => {
  const both = { ...confirmed, two: { score: 8, confirmed: true } };
  expect(canEvaluate({}, 'two')).toBe(true);
  expect(allRatingsConfirmed({}, profiles, [confirmed])).toBe(false);
  expect(allRatingsConfirmed({}, ['one'], [confirmed])).toBe(false);
  expect(allRatingsConfirmed({}, profiles, [both, confirmed])).toBe(false);
  expect(allRatingsConfirmed({}, profiles, [both, both])).toBe(true);
});

test('совместимость привязок: общий, персональный и другой участник', () => {
  expect(sameEvaluators({}, { evaluatorId: null })).toBe(true);
  expect(sameEvaluators(personal, personal)).toBe(true);
  expect(sameEvaluators(personal, {})).toBe(false);
  expect(sameEvaluators(personal, { evaluatorId: 'two' })).toBe(false);
});
