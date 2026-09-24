// Små hjälpfunktioner för att bygga formulär.

let uid = 0;

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

const nextId = (prefix) => `${prefix}-${++uid}`;

function labelRow(label, code) {
  return el('span', {}, label, code ? el('code', { text: code }) : null);
}

export function numField(label, value, onChange, { unit, code, step = 'any', min, max, id } = {}) {
  const inputId = id || nextId('f');
  const input = el('input', { type: 'number', id: inputId, value: value ?? '', step, min, max, inputmode: 'decimal' });
  input.addEventListener('change', () => {
    const v = parseFloat(input.value.replace(',', '.'));
    if (Number.isFinite(v)) onChange(v);
  });
  const wrap = unit ? el('div', { class: 'with-unit' }, input, el('i', { text: unit })) : input;
  return el('label', { class: 'field', for: inputId }, labelRow(label, code), wrap);
}

export function textField(label, value, onChange, { id } = {}) {
  const inputId = id || nextId('f');
  const input = el('input', { type: 'text', id: inputId, value: value ?? '' });
  input.addEventListener('change', () => onChange(input.value));
  return el('label', { class: 'field', for: inputId }, labelRow(label), input);
}

export function selectField(label, options, value, onChange, { code, id } = {}) {
  const inputId = id || nextId('f');
  const sel = el('select', { id: inputId });
  for (const [v, text] of options) {
    const o = el('option', { value: v, text });
    if (String(v) === String(value)) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return el('label', { class: 'field', for: inputId }, labelRow(label, code), sel);
}

export function checkField(label, checked, onChange, { code, id } = {}) {
  const inputId = id || nextId('c');
  const input = el('input', { type: 'checkbox', id: inputId });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'check', for: inputId }, input, el('span', {}, label, code ? ` ${code}` : ''));
}

export function axisField(label, values, onChange, { code, step = 'any', idPrefix } = {}) {
  const row = el('div', { class: 'axis-row' });
  const prefix = idPrefix || nextId('ax');
  ['X', 'Y', 'Z'].forEach((a, i) => {
    const input = el('input', { type: 'number', id: `${prefix}-${a}`, value: values[i], step, inputmode: 'decimal', 'aria-label': `${label} ${a}` });
    input.addEventListener('change', () => {
      const v = parseFloat(input.value.replace(',', '.'));
      if (Number.isFinite(v)) onChange(i, v);
    });
    row.append(el('label', {}, el('b', { text: a }), input));
  });
  return el('div', { class: 'axis-group' }, labelRow(label, code), row);
}

export function section(title, ...children) {
  return el('div', { class: 'section' }, title ? el('h3', { text: title }) : null, ...children);
}

export { nf } from '../i18n.js';
