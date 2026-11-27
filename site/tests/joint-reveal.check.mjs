#!/usr/bin/env node
/* Статическая проверка анимации выката поля «Совместный альбом»
   (второй артист) в форме добавления и в редакторе релиза.

   Регрессия, которую ловим: у открытого состояния .cb__reveal.is-revealed
   стоял max-height: none. При скрытии переход none → 0px не интерполируется
   (не анимируется), и поле ввода исчезало резко вместо плавного схлопывания.
   Второй риск — скрытие/показ мимо setJointReveal: без класса is-revealed
   открытое поле остаётся с overflow: hidden и обрезает выпадающие подсказки. */

import { readFileSync } from 'node:fs';

let failed = 0;
const check = (name, ok, expected = true) => {
  if (ok === expected) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}: ожидалось ${expected}, получено ${ok}`);
    failed++;
  }
};

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

console.log('проверка: поле «Совместный альбом» скрывается плавно');

const revealed = css.match(/\.cb__reveal\.is-revealed\s*\{[^}]*\}/)?.[0] ?? '';
check('у открытого состояния есть правило .is-revealed', revealed.length > 0);
check('max-height не уходит в none (иначе скрытие не анимируется)', revealed.includes('max-height: none'), false);
check('открытое состояние снимает обрезку (overflow: visible)', revealed.includes('overflow: visible'));

const base = css.match(/\.cb__reveal\s*\{[^}]*\}/)?.[0] ?? '';
check('базовое состояние анимирует max-height', base.includes('max-height') && base.includes('transition'));
check('скрытое состояние остаётся отрендеренным (display: block)', /\.cb__reveal\[hidden\]\s*\{\s*display:\s*block/.test(css));

check('скрытие/показ в форме добавления идут через setJointReveal',
  !js.includes('jointBox.hidden') && js.includes('setJointReveal(jointBox'));
check('скрытие/показ в редакторе релиза идут через setJointReveal',
  !js.includes('editJointBox.hidden') && js.includes('setJointReveal(editJointBox'));

if (failed) {
  console.log(`\nПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки анимации совместного альбома пройдены.');
