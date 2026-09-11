// Высота карточки Hot Movers не должна зависеть от содержимого: строки разной
// высоты, состав ленты меняется каждый тик. Сторож против трёх возвратов:
// замера высоты в JS, content-driven высоты обёртки и анимации ухода строки
// (уходящая строка занимает слот, который уже занят новой монетой).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const render = readFileSync(
  new URL('../src/modules/dashboard/web/src/hotMovers/render.js', import.meta.url),
  'utf8',
);
const scss = readFileSync(
  new URL('../src/modules/dashboard/web/src/styles/features/_signals.scss', import.meta.url),
  'utf8',
);

test('высота ленты не меряется в JS', () => {
  for (const probe of ['offsetHeight', 'clientHeight', 'style.height'])
    assert.ok(!render.includes(probe), `render.js снова меряет высоту: ${probe}`);
});

test('высота обёртки — calc из счётчиков строк', () => {
  const block = scss.slice(scss.indexOf('.hm-scroll-wrap {'));
  assert.match(block, /height:\s*calc\(\s*var\(--hm-head-h\)/);
  assert.ok(render.includes('--hm-rows'), 'JS не ставит счётчик основных строк');
  assert.ok(render.includes('--hm-pos-rows'), 'JS не ставит счётчик под-строк позиций');
});

test('уходящая строка удаляется сразу, без анимации ухода', () => {
  assert.ok(!render.includes('hm-leaving'), 'вернулась отложенная уборка строки');
  assert.ok(!scss.includes('hm-leaving'), 'вернулась анимация ухода строки');
});
