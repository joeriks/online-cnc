// Analyspanelen: sammanfattning, diagram och varningslista.

import { el, nf } from './dom.js';
import { LoadChart, fmtTime } from '../view/chart.js';

export class AnalysisPanel {
  constructor(root, { onSeek, onWarning }) {
    this.root = root;
    this.onWarning = onWarning;
    this.filter = 'all';
    this.verdict = el('div', { class: 'verdict', 'data-kind': 'idle' }, el('div', { class: 'verdict-title', text: 'Inte simulerat ännu' }), el('p', { text: 'Tryck på Simulera för att köra programmet.' }));
    this.stats = el('div', { class: 'stats' });
    const canvas = el('canvas', { 'aria-label': 'Spindellast och matning över tid' });
    this.chartBox = el('div', { class: 'chart-box' }, canvas);
    this.chart = new LoadChart(canvas, onSeek);
    this.filters = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filtrera varningar' });
    this.list = el('ul', { class: 'warn-list' });
    this.events = el('ul', { class: 'warn-list' });
    this.notes = el('div', { class: 'section' });
    root.append(
      this.verdict,
      this.stats,
      el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h3', { text: 'Last och matning' }), el('span', { class: 'hint', text: 'Klicka för att hoppa' })), this.chartBox),
      el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h3', { text: 'Varningar' }), this.filters), this.list),
      el('div', { class: 'section' }, el('h3', { text: 'Händelser' }), this.events),
      this.notes,
    );
  }

  setResult(r) {
    this.r = r;
    const s = r.summary;
    // Utlåtande
    let kind = 'ok', title = 'Programmet ser bra ut', text = 'Inga allvarliga problem hittades med den här maskinen, verktyget och materialet.';
    const brk = r.events.find((e) => e.type === 'break');
    const lost = r.events.find((e) => e.type === 'lost');
    if (r.error) {
      kind = 'crit'; title = `error:${r.error.code} på rad ${r.error.line}`;
      text = `${r.error.message}. GRBL avvisar raden och avsändaren stannar – allt före raden hinner köras.`;
    } else if (r.alarm) {
      kind = 'crit'; title = `${r.alarm.code} på rad ${r.alarm.line}`; text = r.alarm.text;
    } else if (brk) {
      kind = 'crit'; title = `Verktyget går av på rad ${brk.line}`; text = 'Se varningarna för orsaken. Resten av programmet körs utan att skära.';
    } else if (lost) {
      kind = 'crit'; title = 'Maskinen tappar steg'; text = `Första stegförlusten på rad ${lost.line}. Detaljen blir förskjuten efter den punkten.`;
    } else if (s.counts.crit) {
      kind = 'crit'; title = s.counts.crit === 1 ? 'Ett allvarligt problem' : `${s.counts.crit} allvarliga problem`; text = 'Åtgärda de röda varningarna innan du kör på riktigt.';
    } else if (s.counts.warn) {
      kind = 'warn'; title = s.counts.warn === 1 ? 'Körbart, men en sak bör ses över' : `Körbart, men ${s.counts.warn} saker bör ses över`; text = 'Gula varningar påverkar kvalitet, verktygsslitage eller tid.';
    }
    if (r.error && brk) text += ` Verktyget går dessutom av på rad ${brk.line}.`;
    this.verdict.dataset.kind = kind;
    this.verdict.replaceChildren(el('div', { class: 'verdict-title', text: title }), el('p', { text }));

    const stat = (label, value, sub, hot) => el('div', { class: 'stat' }, el('span', { text: label }), el('b', { class: hot ? 'hot' : '', text: value }), sub ? el('small', { text: sub }) : null);
    const extra = s.naiveTime > 0 ? Math.round(((s.totalTime - s.naiveTime) / s.naiveTime) * 100) : 0;
    this.stats.replaceChildren(
      stat('Körtid', fmtTime(s.totalTime), `${extra >= 0 ? '+' : ''}${extra} % mot F-värdena, pga acceleration`),
      stat('Borttagen volym', `${nf(s.removed / 1000, 2)} cm³`, `${nf(s.cutDist / 1000, 2)} m skär · ${nf(s.rapidDist / 1000, 2)} m G0`),
      stat('Max spindellast', `${nf(s.maxLoad * 100)} %`, null, s.maxLoad > 1),
      stat('Max skärkraft', `${nf(s.maxForce, 1)} N`, `utböjning max ${nf(s.maxDefl, 3)} mm`, s.maxDefl > 0.2),
    );

    this.chart.setData(r);
    this.renderFilters();
    this.renderList();

    this.events.replaceChildren(...r.events.slice(0, 200).map((e) => {
      const sev = ['break', 'lost', 'alarm', 'error'].includes(e.type) ? 'crit' : e.type === 'pause' || e.type === 'tool' ? 'warn' : 'info';
      return el('li', {}, el('button', { type: 'button', class: 'warn-item', 'data-sev': sev, onclick: () => this.onWarning({ line: e.line, t: e.t }) },
        el('span', { class: 'bar' }),
        el('span', { class: 'w-title', text: e.text }),
        el('span', { class: 'w-meta', text: `${fmtTime(e.t)} · rad ${e.line}` }),
      ));
    }));
    this.notes.replaceChildren();
    if (r.notes.length) {
      this.notes.append(el('h3', { text: 'Noteringar' }), ...r.notes.slice(0, 20).map((n) => el('p', { class: 'hint', text: `Rad ${n.line}: ${n.text}` })));
    }
  }

  renderFilters() {
    const c = this.r.summary.counts;
    const mk = (id, label, count, cls) => el('button', { type: 'button', class: 'chip', 'aria-pressed': String(this.filter === id), onclick: () => { this.filter = id; this.renderFilters(); this.renderList(); } },
      label, count !== null ? el('span', { class: `badge ${cls || ''}`, text: count }) : null);
    this.filters.replaceChildren(
      mk('all', 'Alla', null),
      mk('crit', 'Kritiska', c.crit, c.crit ? 'crit' : ''),
      mk('warn', 'Varningar', c.warn, c.warn ? 'warn' : ''),
      mk('info', 'Info', c.info),
    );
  }

  renderList() {
    const items = this.r.warnings.filter((w) => this.filter === 'all' || w.severity === this.filter);
    const shown = items.slice(0, 250);
    this.list.replaceChildren(...shown.map((w) => {
      const occ = w.occ && w.occ.length ? w.occ : [{ line: w.line, t: w.t }];
      const meta = el('span', { class: 'w-meta', text: occ.length > 1 ? `rad ${occ[0].line} · ${occ.length} ställen` : `rad ${occ[0].line}` });
      let idx = -1;
      const btn = el('button', { type: 'button', class: 'warn-item', 'data-sev': w.severity, title: occ.length > 1 ? 'Klicka igen för nästa ställe' : '', onclick: () => {
        idx = (idx + 1) % occ.length;
        if (occ.length > 1) meta.textContent = `rad ${occ[idx].line} · ${idx + 1} av ${occ.length}`;
        this.onWarning(occ[idx]);
      } },
        el('span', { class: 'bar' }),
        el('span', { class: 'w-title', text: w.title }),
        meta,
        el('span', { class: 'w-detail', text: w.detail }),
      );
      return el('li', {}, btn);
    }));
    if (!items.length) this.list.append(el('li', { class: 'hint', text: this.filter === 'all' ? 'Inga varningar.' : 'Inga varningar i den här kategorin.' }));
    if (items.length > shown.length) this.list.append(el('li', { class: 'hint', text: `… och ${items.length - shown.length} till.` }));
  }

  setTime(t) {
    this.chart.setTime(t);
  }
}
