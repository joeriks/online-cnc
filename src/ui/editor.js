// Enkel G-kodseditor: textarea + virtualiserad radnummerlist med varningsmarkeringar.

export class Editor {
  constructor({ textarea, gutter, gutterInner, highlight, onChange }) {
    this.ta = textarea;
    this.gutter = gutter;
    this.inner = gutterInner;
    this.hl = highlight;
    this.onChange = onChange;
    this.severity = {};
    this.current = 0;
    this.lineCount = 1;
    this.lh = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    textarea.addEventListener('input', () => {
      this.countLines();
      this.render();
      onChange?.(this.ta.value);
    });
    textarea.addEventListener('scroll', () => this.render());
    new ResizeObserver(() => this.render()).observe(textarea);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand?.('insertText', false, '  ');
      }
    });
  }

  countLines() {
    let n = 1;
    const v = this.ta.value;
    for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 10) n++;
    this.lineCount = n;
  }

  get value() {
    return this.ta.value;
  }

  set value(v) {
    this.ta.value = v;
    this.ta.scrollTop = 0;
    this.countLines();
    this.render();
  }

  setSeverity(map) {
    this.severity = map || {};
    this.render();
  }

  setCurrentLine(line, follow = true) {
    if (line === this.current) return;
    this.current = line;
    if (follow && line > 0 && document.activeElement !== this.ta) {
      const top = (line - 1) * this.lh;
      const h = this.ta.clientHeight;
      if (top < this.ta.scrollTop + this.lh || top > this.ta.scrollTop + h - 2 * this.lh) {
        this.ta.scrollTop = Math.max(0, top - h / 3);
      }
    }
    this.render();
  }

  // Markera en rad och scrolla dit.
  selectLine(line) {
    const lines = this.ta.value.split('\n');
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[line - 1] || '').length;
    this.ta.focus({ preventScroll: true });
    this.ta.setSelectionRange(start, end);
    this.ta.scrollTop = Math.max(0, (line - 1) * this.lh - this.ta.clientHeight / 3);
    this.current = line;
    this.render();
  }

  render() {
    const st = this.ta.scrollTop;
    const h = this.ta.clientHeight;
    const first = Math.max(1, Math.floor(st / this.lh) + 1);
    const last = Math.min(this.lineCount, Math.ceil((st + h) / this.lh) + 1);
    this.inner.style.transform = `translateY(${-st}px)`;
    let html = '';
    for (let n = first; n <= last; n++) {
      const sev = this.severity[n];
      const cls = `gl${sev ? ` sev-${sev}` : ''}${n === this.current ? ' cur' : ''}`;
      html += `<div class="${cls}" style="top:${(n - 1) * this.lh}px">${n}</div>`;
    }
    this.inner.innerHTML = html;
    if (this.current > 0) {
      const top = (this.current - 1) * this.lh - st;
      this.hl.hidden = top < -this.lh || top > h;
      this.hl.style.top = `${top}px`;
    } else this.hl.hidden = true;
  }
}
