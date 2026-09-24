// Analysis panel: summary, chart and warning list.

import { el } from './dom.js';
import { t, nf } from '../i18n.js';
import { LoadChart, fmtTime } from '../view/chart.js';

export class AnalysisPanel {
  constructor(root, { onSeek, onWarning, onWorkholding }) {
    this.root = root;
    this.onWarning = onWarning;
    this.onWorkholding = onWorkholding;
    this.filter = 'all';
    this.canvas = el('canvas');
    this.chart = new LoadChart(this.canvas, onSeek);
    this.build();
  }

  // Builds the static structure (again after a language change).
  build() {
    this.verdict = el('div', { class: 'verdict', 'data-kind': 'idle' }, el('div', { class: 'verdict-title', text: t('an.idle.title') }), el('p', { text: t('an.idle.text') }));
    this.stats = el('div', { class: 'stats' });
    this.canvas.setAttribute('aria-label', t('an.chartAria'));
    this.chartBox = el('div', { class: 'chart-box' }, this.canvas);
    this.filters = el('div', { class: 'filters', role: 'group', 'aria-label': t('an.filterAria') });
    this.list = el('ul', { class: 'warn-list' });
    this.events = el('ul', { class: 'warn-list' });
    this.notes = el('div', { class: 'section' });
    this.wh = el('div', { class: 'wh-list' });
    this.root.replaceChildren(
      this.verdict,
      this.stats,
      el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h3', { text: t('an.chart') }), el('span', { class: 'hint', text: t('an.chartHint') })), this.chartBox),
      el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h3', { text: t('an.warnings') }), this.filters), this.list),
      el('div', { class: 'section' }, el('h3', { text: t('wh.options') }), this.wh),
      el('div', { class: 'section' }, el('h3', { text: t('an.events') }), this.events),
      this.notes,
    );
    if (this.r) this.setResult(this.r);
  }

  setResult(r) {
    this.r = r;
    const s = r.summary;
    let kind = 'ok', title = t('an.ok.title'), text = t('an.ok.text');
    const brk = r.events.find((e) => e.type === 'break');
    const lost = r.events.find((e) => e.type === 'lost');
    if (r.error) {
      kind = 'crit'; title = `error:${r.error.code} – ${t('an.line', { line: r.error.line })}`;
      text = t('an.error.text', { msg: r.error.message });
    } else if (r.alarm) {
      kind = 'crit'; title = `${r.alarm.code} – ${t('an.line', { line: r.alarm.line })}`; text = r.alarm.text;
    } else if (brk) {
      kind = 'crit'; title = t('an.break.title', { line: brk.line }); text = t('an.break.text');
    } else if (lost) {
      kind = 'crit'; title = t('an.lost.title'); text = t('an.lost.text', { line: lost.line });
    } else if (s.counts.crit) {
      kind = 'crit'; title = s.counts.crit === 1 ? t('an.crit.one') : t('an.crit.many', { n: s.counts.crit }); text = t('an.crit.text');
    } else if (s.counts.warn) {
      kind = 'warn'; title = s.counts.warn === 1 ? t('an.warn.one') : t('an.warn.many', { n: s.counts.warn }); text = t('an.warn.text');
    }
    if (r.error && brk) text += t('an.alsoBreak', { line: brk.line });
    this.verdict.dataset.kind = kind;
    this.verdict.replaceChildren(el('div', { class: 'verdict-title', text: title }), el('p', { text }));

    const stat = (label, value, sub, hot) => el('div', { class: 'stat' }, el('span', { text: label }), el('b', { class: hot ? 'hot' : '', text: value }), sub ? el('small', { text: sub }) : null);
    const extra = s.naiveTime > 0 ? Math.round(((s.totalTime - s.naiveTime) / s.naiveTime) * 100) : 0;
    this.stats.replaceChildren(
      stat(t('an.runtime'), fmtTime(s.totalTime), t('an.runtimeSub', { p: `${extra >= 0 ? '+' : ''}${extra}` })),
      stat(t('an.removed'), `${nf(s.removed / 1000, 2)} cm³`, t('an.removedSub', { cut: nf(s.cutDist / 1000, 2), rapid: nf(s.rapidDist / 1000, 2) })),
      stat(t('an.maxLoad'), `${nf(s.maxLoad * 100)} %`, null, s.maxLoad > 1),
      stat(t('an.maxForce'), `${nf(s.maxForce, 1)} N`, t('an.maxForceSub', { d: nf(s.maxDefl, 3) }), s.maxDefl > 0.2),
    );

    this.chart.setData(r);
    this.renderWorkholding();
    this.renderFilters();
    this.renderList();

    this.events.replaceChildren(...r.events.slice(0, 200).map((e) => {
      const sev = ['break', 'lost', 'alarm', 'error'].includes(e.type) ? 'crit' : e.type === 'pause' || e.type === 'tool' ? 'warn' : 'info';
      return el('li', {}, el('button', { type: 'button', class: 'warn-item', 'data-sev': sev, onclick: () => this.onWarning({ line: e.line, t: e.t }) },
        el('span', { class: 'bar' }),
        el('span', { class: 'w-title', text: e.text }),
        el('span', { class: 'w-meta', text: t('an.eventMeta', { time: fmtTime(e.t), line: e.line }) }),
      ));
    }));
    this.notes.replaceChildren();
    if (r.notes.length) {
      this.notes.append(el('h3', { text: t('an.notes') }), ...r.notes.slice(0, 20).map((n) => el('p', { class: 'hint', text: t('an.noteLine', { line: n.line, text: n.text }) })));
    }
  }

  renderWorkholding() {
    const w = this.r.workholding;
    if (!w) { this.wh.replaceChildren(); return; }
    const issueText = (i) => t(`wh.i.${i.key}`, { ...(i.p || {}), part: i.p && i.p.part ? t(`wh.part.${i.p.part}`) : '', obj: i.p && i.p.obj ? t(`wh.obj.${i.p.obj}`) : '' });
    this.wh.replaceChildren(...w.options.map((o) => {
      const used = o.id === w.selected;
      const action = used
        ? el('span', { class: 'wh-used', text: w.auto ? t('wh.autoPicked') : t('wh.inUse') })
        : o.rating === 'na' ? null : el('button', { type: 'button', class: 'btn btn-sm', text: t('wh.use'), onclick: () => this.onWorkholding(o.id) });
      return el('div', { class: 'wh-card', 'data-rating': o.rating, 'data-used': String(used) },
        el('div', { class: 'wh-head' },
          el('span', { class: 'wh-name', text: t(`wh.name.${o.id}`) }),
          el('span', { class: 'wh-rating', text: t(`wh.rating.${o.rating}`) }),
          action,
        ),
        el('p', { class: 'wh-desc', text: t(`wh.desc.${o.id}`) }),
        o.rating !== 'na' ? el('p', { class: 'wh-hold', text: t('wh.hold', { hold: nf(o.hold), f: nf(w.maxForce, 1) }) }) : null,
        o.issues.length ? el('ul', { class: 'wh-issues' }, ...o.issues.map((i) => el('li', { 'data-sev': i.sev, text: issueText(i) }))) : null,
      );
    }));
  }

  renderFilters() {
    const c = this.r.summary.counts;
    const mk = (id, label, count, cls) => el('button', { type: 'button', class: 'chip', 'aria-pressed': String(this.filter === id), onclick: () => { this.filter = id; this.renderFilters(); this.renderList(); } },
      label, count !== null ? el('span', { class: `badge ${cls || ''}`, text: count }) : null);
    this.filters.replaceChildren(
      mk('all', t('an.all'), null),
      mk('crit', t('an.critical'), c.crit, c.crit ? 'crit' : ''),
      mk('warn', t('an.warningsF'), c.warn, c.warn ? 'warn' : ''),
      mk('info', t('an.info'), c.info),
    );
  }

  renderList() {
    const items = this.r.warnings.filter((w) => this.filter === 'all' || w.severity === this.filter);
    const shown = items.slice(0, 250);
    this.list.replaceChildren(...shown.map((w) => {
      const occ = w.occ && w.occ.length ? w.occ : [{ line: w.line, t: w.t }];
      const meta = el('span', { class: 'w-meta', text: occ.length > 1 ? t('an.places', { line: occ[0].line, n: occ.length }) : t('an.line', { line: occ[0].line }) });
      let idx = -1;
      const btn = el('button', { type: 'button', class: 'warn-item', 'data-sev': w.severity, title: occ.length > 1 ? t('an.nextPlace') : '', onclick: () => {
        idx = (idx + 1) % occ.length;
        if (occ.length > 1) meta.textContent = t('an.placeOf', { line: occ[idx].line, i: idx + 1, n: occ.length });
        this.onWarning(occ[idx]);
      } },
        el('span', { class: 'bar' }),
        el('span', { class: 'w-title', text: w.title }),
        meta,
        el('span', { class: 'w-detail', text: w.detail }),
        w.fix ? el('span', { class: 'w-fix' }, el('b', { text: t('an.fix') }), w.fix) : null,
      );
      return el('li', {}, btn);
    }));
    if (!items.length) this.list.append(el('li', { class: 'hint', text: this.filter === 'all' ? t('an.none') : t('an.noneCat') }));
    if (items.length > shown.length) this.list.append(el('li', { class: 'hint', text: t('an.more', { n: items.length - shown.length }) }));
  }

  setTime(time) {
    this.chart.setTime(time);
  }
}
