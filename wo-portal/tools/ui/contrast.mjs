// WCAG 2.x relative luminance and contrast, so the button decision rests on a
// number rather than on my arithmetic.
const lin = (c) => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ratio = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (x + .05) / (y + .05); };

const WHITE = '#FFFFFF';
for (const c of ['#FF5100', '#CC4100', '#B83A00', '#E04700']) {
  const r = ratio(c, WHITE);
  console.log(`${c} on white text  ${r.toFixed(2)}:1  ` +
    `normal-AA(4.5) ${r >= 4.5 ? 'PASS' : 'fail'}  ` +
    `large-AA(3.0) ${r >= 3 ? 'PASS' : 'fail'}  ` +
    `normal-AAA(7) ${r >= 7 ? 'PASS' : 'fail'}`);
}
console.log('\nAlso, disabled buttons — .btn[disabled] is opacity .55 over the page white:');
for (const c of ['#FF5100', '#CC4100']) {
  // opacity .55 composites the orange toward the white page behind it.
  const [r, g, b] = hex(c).map((v) => Math.round(v * .55 + 255 * .45));
  const eff = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  // and the white label composites the same way
  const lbl = Math.round(255 * .55 + 255 * .45);
  const rr = ratio(eff, `#${[lbl, lbl, lbl].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase());
  console.log(`  ${c} @ .55 -> ${eff} vs white label  ${rr.toFixed(2)}:1  ${rr >= 4.5 ? 'PASS' : 'FAIL'}`);
}
