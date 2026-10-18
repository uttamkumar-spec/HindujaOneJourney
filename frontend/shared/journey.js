/* HindujaOneJourney — journey renderer.
   Draws every screen from the published journey config fetched at page load,
   so a change published in the admin console reaches customers on their next
   page load — no rebuild or redeploy of this file.

   createJourney({ config, api, mode }) — mode 'live' (portal) or 'preview' (admin layout preview).
   api: profile(), recommend(profile), quote(productId, selection), checkout(payload), policies() */
'use strict';
(function () {
  const HOJ = window.HOJ, h = HOJ.h, inr = HOJ.inr;

  HOJ.createJourney = function ({ config, api, mode = 'live', onChange }) {
    const live = mode === 'live';
    let cfg = config;
    const S = {
      stepId: null, section: 0, profile: {}, prefill: {}, profileStatus: 'idle', errors: {}, formError: '',
      recs: null, members: [], recsStatus: 'idle', recsKey: null, selection: {}, quotes: {}, quoting: {},
      detail: null, custTab: null, kyc: {}, consents: {}, paying: false, payError: '', policies: [], navBusy: false
    };
    let root = null;
    const rerender = () => { if (root && live) draw(); else if (onChange) onChange(); };

    const enabledSteps = () => cfg.steps.filter(s => s.enabled);
    const currentStep = () => enabledSteps().find(s => s.id === S.stepId) || enabledSteps()[0];
    const productById = id => cfg.catalogue.find(p => p.id === id);
    const ctx = () => HOJ.context(S.profile);
    const tagTone = t => (cfg.tags[t] || {}).tone || 'muted';

    /* ------------------------------------------------------- data */
    async function loadProfile() {
      if (S.profileStatus === 'ready' || S.profileStatus === 'loading') return;
      S.profileStatus = 'loading'; rerender();
      try {
        const { values } = await api.profile();
        for (const [fid, f] of Object.entries(cfg.fields)) {
          if (f.prefill && values[f.prefill] !== undefined) { S.profile[fid] = values[f.prefill]; S.prefill[fid] = values[f.prefill]; }
          else if (S.profile[fid] === undefined) S.profile[fid] = f.type === 'toggle' ? false : '';
        }
        for (const k of ['pan', 'mobile', 'email', 'address']) S.kyc[k] = values['kyc.' + k] || '';
        S.profileStatus = 'ready';
      } catch (e) { S.profileStatus = 'error'; S.formError = e.message; }
      rerender();
    }
    async function loadRecs() {
      const key = JSON.stringify(S.profile);
      if (S.recsKey === key && S.recs) return true;
      S.recsStatus = 'loading'; rerender();
      try {
        const res = await api.recommend(S.profile);
        S.recs = res.recommendations; S.members = res.members; S.recsKey = key; S.recsStatus = 'ready';
        S.quotes = {};                                     // profile changed → requote
        for (const sel of Object.values(S.selection)) sel.members = sel.members.filter(k => S.members.some(m => m.key === k));
        return true;
      } catch (e) { S.recsStatus = 'error'; S.formError = e.message; return false; }
      finally { rerender(); }
    }
    function recommendations() {
      return (S.recs || []).map(r => ({ ...r, product: productById(r.productId) })).filter(r => r.product);
    }
    function visibleComps(prod) { const c = ctx(); return prod.components.filter(x => HOJ.shown(x, c)); }
    function ensureSelection(rec) {
      const pid = rec.product.id;
      if (S.selection[pid]) return S.selection[pid];
      const comps = {};
      for (const c of rec.product.components) comps[c.id] = { included: !!c.included, si: c.si ? c.si.default : null, opt: c.opt ? c.opt.default : null };
      return (S.selection[pid] = { selected: !!(cfg.tags[rec.tag] || {}).preselect, comps, members: S.members.map(m => m.key) });
    }
    const selectedProducts = () => recommendations().filter(r => S.selection[r.product.id] && S.selection[r.product.id].selected).map(r => r.product);

    const qTimers = {};
    function scheduleQuote(prod) {
      const sel = S.selection[prod.id], payload = { comps: sel.comps, members: prod.usesMembers ? sel.members : undefined };
      const key = JSON.stringify([S.recsKey, payload]);
      if (S.quotes[prod.id] && S.quotes[prod.id].key === key) return;
      S.quoting[prod.id] = true;
      clearTimeout(qTimers[prod.id]);
      qTimers[prod.id] = setTimeout(async () => {
        let q;
        try { q = { key, res: await api.quote(prod.id, payload) }; } catch (e) { q = { key, err: e.message }; }
        const now = S.selection[prod.id];
        if (JSON.stringify([S.recsKey, { comps: now.comps, members: prod.usesMembers ? now.members : undefined }]) === key) { S.quotes[prod.id] = q; S.quoting[prod.id] = false; }
        rerender();
      }, 300);
    }
    const quoteAllSelected = () => selectedProducts().forEach(scheduleQuote);
    function totals() {
      let premium = 0, gst = 0, pending = false, error = false;
      for (const p of selectedProducts()) {
        const q = S.quotes[p.id];
        if (S.quoting[p.id] || !q) { pending = true; continue; }
        if (q.err) { error = true; continue; }
        premium += q.res.premium; gst += q.res.gst;
      }
      return { premium, gst, total: premium + gst, pending, error };
    }

    /* ------------------------------------------------- navigation */
    async function goto(stepId) {
      S.stepId = stepId; S.detail = null; S.errors = {}; S.formError = '';
      const st = currentStep();
      if (st.type !== 'intro') await loadProfile();
      if (['recommend', 'customise', 'review', 'checkout'].includes(st.type) && S.profileStatus === 'ready') {
        if (await loadRecs()) { recommendations().forEach(ensureSelection); quoteAllSelected(); }
      }
      rerender(); if (live) window.scrollTo(0, 0);
    }
    function validateProfile() {
      const c = ctx(), errs = {};
      for (const sec of cfg.sections) for (const fid of sec.fields) {
        const f = cfg.fields[fid];
        if (f && f.required && HOJ.shown(f, c) && (S.profile[fid] === '' || S.profile[fid] == null)) errs[fid] = 'Required';
      }
      S.errors = errs;
      const bad = cfg.sections.findIndex(sec => sec.fields.some(f => errs[f]));
      if (bad >= 0) S.section = bad;
      return !Object.keys(errs).length;
    }
    async function next() {
      if (S.navBusy) return;
      const st = currentStep(), list = enabledSteps(), i = list.indexOf(st);
      if (st.type === 'profile') {
        if (!validateProfile()) { rerender(); return; }
        S.navBusy = true; rerender();
        const ok = await loadRecs(); S.navBusy = false;
        if (!ok) { rerender(); return; }
      }
      if ((st.type === 'recommend' || st.type === 'customise') && !selectedProducts().length) { S.formError = 'Select at least one product to continue.'; rerender(); return; }
      if (st.type === 'review' && totals().error) { S.formError = 'One or more premiums could not be calculated — please retry.'; rerender(); return; }
      if (i < list.length - 1) goto(list[i + 1].id);
    }
    function prev() { const list = enabledSteps(), i = list.indexOf(currentStep()); if (i > 0) goto(list[i - 1].id); }
    async function pay(block) {
      const items = (block && block.items) || [];
      if (items.some((_, i) => !S.consents[i])) { S.payError = 'Please accept all declarations to continue.'; rerender(); return; }
      const t = totals(); if (t.pending || t.error) return;
      S.paying = true; S.payError = ''; rerender();
      try {
        const res = await api.checkout({ quoteIds: selectedProducts().map(p => S.quotes[p.id].res.quoteId).filter(Boolean),
          consents: items.map((_, i) => !!S.consents[i]), kyc: S.kyc });
        S.policies = res.policies;
        for (const p of selectedProducts()) S.selection[p.id].selected = false;
        S.quotes = {};
        const done = enabledSteps().find(s => s.type === 'done');
        S.paying = false;
        if (done) goto(done.id); else rerender();
      } catch (e) { S.paying = false; S.payError = e.message; if (e.status === 409) S.quotes = {}; rerender(); }
    }

    /* ---------------------------------------------------- blocks */
    const R = {};
    R.hero = () => {
      const steps = enabledSteps().filter(s => s.counted);
      return h('div', { class: 'hero' },
        h('div', null, h('div', { class: 'eyebrow' }, 'GROUP-TO-RETAIL PROTECTION'), h('h1', null, currentStep().title), h('p', null, currentStep().subtitle)),
        h('div', { class: 'how' }, h('h3', null, 'How it works'),
          h('ol', null, steps.map((s, i) => h('li', null, h('b', null, i + 1), h('div', null, h('strong', null, s.title), h('div', { class: 'note' }, s.subtitle)))))));
    };
    R.stepHeader = () => {
      const st = currentStep(), counted = enabledSteps().filter(s => s.counted), i = counted.indexOf(st);
      const chip = i >= 0 ? `Step ${i + 1} of ${counted.length}` : st.chip;
      return h('div', { class: 'step-head' }, h('div', { class: 'row' }, h('h1', null, st.title), chip && h('span', { class: 'chip' }, chip)), st.subtitle && h('p', null, st.subtitle));
    };
    R.heading = b => h('h2', null, b.text);
    R.paragraph = b => h('p', { style: 'margin:0' }, b.text);
    R.banner = b => h('div', { class: 'banner' }, b.text);
    R.note = b => h('div', { class: 'note' }, b.text);
    R.cta = b => {
      const st = currentStep(), list = enabledSteps(), first = list.indexOf(st) <= 0 || st.type === 'done', t = totals();
      const busy = S.navBusy || (b.action === 'pay' && (S.paying || t.pending || t.error));
      return h('div', null,
        S.formError && b.action !== 'pay' && h('div', { class: 'alert', role: 'alert', style: 'margin-bottom:10px' }, S.formError),
        h('div', { class: 'cta-row' },
          !first && b.action !== 'prev' && h('button', { class: 'btn ghost', onclick: prev }, 'Back'),
          h('button', { class: 'btn', disabled: busy, onclick: () => b.action === 'pay' ? pay(st.blocks.find(x => x.type === 'consents')) : b.action === 'prev' ? prev() : next() },
            (S.paying && b.action === 'pay') || (S.navBusy && b.action === 'next') ? [h('span', { class: 'spinner' }), ' Please wait…'] : b.label)));
    };

    function fieldInput(fid, f) {
      const v = S.profile[fid], set = (val, re) => { S.profile[fid] = val; delete S.errors[fid]; if (re) rerender(); };
      const id = 'f-' + fid;
      if (f.type === 'toggle') return h('label', { class: 'switch' }, h('input', { id, type: 'checkbox', checked: !!v, onchange: e => set(e.target.checked, true) }), h('span', null, v ? 'Yes' : 'No'));
      if (f.type === 'select') return h('select', { id, onchange: e => set(e.target.value, true), value: v ?? '' }, h('option', { value: '' }, 'Select…'), (f.options || []).map(o => h('option', { value: o }, o)));
      const inp = h('input', { id, type: f.type === 'number' ? 'number' : 'text', value: v ?? '', min: f.type === 'number' ? 0 : null,
        oninput: e => set(f.type === 'number' ? (e.target.value === '' ? '' : +e.target.value) : e.target.value), onchange: () => rerender() });
      return f.prefix || f.suffix ? h('div', { class: 'affix' }, f.prefix && h('span', null, f.prefix), inp, f.suffix && h('span', null, f.suffix)) : inp;
    }
    R.profileForm = () => {
      if (S.profileStatus !== 'ready') return h('div', { class: 'card' }, S.profileStatus === 'error' ? 'Could not load your details: ' + S.formError : [h('span', { class: 'spinner' }), ' Loading your pre-filled details…']);
      const c = ctx(), secs = cfg.sections, si = Math.min(S.section, secs.length - 1), sec = secs[si];
      if (!sec) return h('div', { class: 'card' }, 'No profile sections configured.');
      return h('div', { class: 'card' },
        h('div', { class: 'tabs', role: 'tablist' }, secs.map((s, i) => h('button', { role: 'tab', 'aria-selected': String(i === si), onclick: () => { S.section = i; rerender(); } }, `${i + 1}  ${s.title}`))),
        h('div', { class: 'grid2' }, sec.fields.map(fid => {
          const f = cfg.fields[fid]; if (!f || !HOJ.shown(f, c)) return null;
          const pre = f.prefill && S.prefill[fid] !== undefined && S.prefill[fid] === S.profile[fid];
          return h('div', { class: 'field' + (pre ? ' pre' : '') },
            h('label', { class: 'lbl', for: 'f-' + fid }, h('span', null, f.label, f.required ? ' *' : ''), pre && h('span', { class: 'badge' }, 'Pre-filled')),
            fieldInput(fid, f), f.help && h('div', { class: 'help' }, f.help), S.errors[fid] && h('div', { class: 'err' }, S.errors[fid]));
        })),
        si < secs.length - 1 && h('div', { class: 'cta-row', style: 'margin-top:14px' }, h('button', { class: 'btn ghost small', onclick: () => { S.section = si + 1; rerender(); } }, `Continue to ${secs[si + 1].title.toLowerCase()} →`)),
        h('p', { class: 'note', style: 'margin:12px 0 0' }, 'Only relevant follow-up fields are displayed.'));
    };

    const siLabel = (c, v) => v == null ? '' : c.si.unit === 'lakh' ? `₹${v} lakh` : c.si.unit === '₹/day' ? `₹${v}/day` : c.si.unit ? `${v} ${c.si.unit}` : String(v);
    function compSummary(prod) { const sel = S.selection[prod.id]; return visibleComps(prod).filter(c => sel && (sel.comps[c.id].included || !c.optional)).map(c => c.name).join(' + ') || 'Nothing included'; }
    const recsPending = () => S.recsStatus === 'loading' ? h('div', { class: 'card' }, h('span', { class: 'spinner' }), ' Finding the right protection for you…')
      : S.recsStatus === 'error' ? h('div', { class: 'alert' }, S.formError || 'Could not load recommendations') : null;

    R.recommendationCards = () => {
      const pending = recsPending(); if (pending) return pending;
      const recs = recommendations();
      if (!recs.length) return h('div', { class: 'card' }, 'No products available right now.');
      return h('div', { class: 'grid2' }, recs.map(rec => {
        const sel = ensureSelection(rec);
        return h('div', { class: 'rec' + (sel.selected ? ' sel' : '') },
          h('div', { class: 'top' }, h('h3', null, rec.product.name), h('span', { class: 'tag ' + tagTone(rec.tag) }, rec.tag)),
          h('div', null, h('strong', null, compSummary(rec.product))),
          h('div', { class: 'why' }, rec.headline),
          h('div', { class: 'acts' },
            h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: sel.selected, 'aria-label': 'Select ' + rec.product.name, onchange: e => { sel.selected = e.target.checked; S.formError = ''; quoteAllSelected(); rerender(); } }), h('span', null, sel.selected ? 'Selected' : 'Select')),
            h('button', { class: 'btn ghost small', style: 'margin-left:auto', onclick: () => { S.detail = rec.product.id; rerender(); } }, 'Details & why')));
      }));
    };
    function detailModal() {
      const rec = recommendations().find(r => r.product.id === S.detail); if (!rec) return null;
      const prod = rec.product, sel = ensureSelection(rec), close = () => { S.detail = null; rerender(); };
      return h('div', { class: 'modal-bg', onclick: e => { if (e.target === e.currentTarget) close(); } },
        h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': prod.name + ' recommendation' },
          h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px' },
            h('h2', null, `Recommended ${prod.name} protection`), h('button', { class: 'iconbtn', onclick: close, 'aria-label': 'Close' }, '✕')),
          h('div', { class: 'detail' },
            h('div', null, visibleComps(prod).map(c => {
              const cs = sel.comps[c.id];
              return h('div', { class: 'comp-row' + (cs.included || !c.optional ? ' inc' : '') },
                h('strong', null, c.name), h('span', null, c.si ? siLabel(c, cs.si) : c.opt ? cs.opt : ''),
                h('span', { class: 'muted' }, c.scope || (c.opt && c.si ? cs.opt : '')),
                c.optional ? h('button', { class: 'btn small ' + (cs.included ? 'ghost' : 'secondary'), onclick: () => { cs.included = !cs.included; if (sel.selected) scheduleQuote(prod); rerender(); } }, cs.included ? 'Remove' : 'Add')
                           : h('span', { class: 'badge' }, 'Included'));
            })),
            h('div', { class: 'whybox' }, h('strong', null, 'Why recommended?'), h('ul', null, rec.reasons.map(r => h('li', null, r))),
              h('div', { class: 'cta-row', style: 'margin-top:14px;justify-content:flex-start' },
                h('button', { class: 'btn small', onclick: () => { sel.selected = true; quoteAllSelected(); close(); } }, 'Proceed'),
                h('button', { class: 'btn small secondary', onclick: () => { sel.selected = true; S.custTab = prod.id; const c = enabledSteps().find(s => s.type === 'customise'); c ? goto(c.id) : close(); } }, 'Customise'))))));
    }

    function quoteBox(prod) {
      const q = S.quotes[prod.id];
      if (S.quoting[prod.id]) return h('div', { class: 'card' }, h('span', { class: 'spinner' }), ' Recalculating premium…');
      if (!q) return h('div', { class: 'card note' }, 'Premium will be calculated.');
      if (q.err) return h('div', { class: 'card' }, h('div', { class: 'alert' }, q.err), h('button', { class: 'btn small ghost', onclick: () => { delete S.quotes[prod.id]; scheduleQuote(prod); rerender(); } }, 'Retry'));
      return h('div', { class: 'card' }, h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' }, h('strong', null, 'Updated premium'), q.res.mock && h('span', { class: 'mockflag' }, 'MOCK RATE')),
        h('table', { class: 'lines' }, h('tbody', null, q.res.lines.map(l => h('tr', null, h('td', null, l.name), h('td', null, inr(l.premium)))),
          h('tr', null, h('td', null, `GST (${prod.gstPct}%)`), h('td', null, inr(q.res.gst))),
          h('tr', { class: 'total' }, h('td', null, 'Total'), h('td', null, inr(q.res.total))))));
    }
    R.customisePanel = () => {
      const pending = recsPending(); if (pending) return pending;
      const prods = selectedProducts();
      if (!prods.length) return h('div', { class: 'card' }, 'No products selected yet. Go back and select at least one recommendation.');
      if (!prods.find(p => p.id === S.custTab)) S.custTab = prods[0].id;
      const prod = productById(S.custTab), sel = S.selection[prod.id];
      const change = () => { scheduleQuote(prod); rerender(); };
      return h('div', null,
        h('div', { class: 'tabs', role: 'tablist' }, prods.map(p => h('button', { role: 'tab', 'aria-selected': String(p.id === prod.id), onclick: () => { S.custTab = p.id; rerender(); } }, p.name))),
        h('div', { class: 'cust' },
          h('div', { class: 'card' },
            prod.usesMembers && h('div', { class: 'field', style: 'margin-bottom:14px' }, h('div', { class: 'lbl' }, 'Members'),
              h('div', { class: 'members' }, S.members.map(m => {
                const on = sel.members.includes(m.key);
                return h('label', { class: on ? 'on' : '' }, h('input', { type: 'checkbox', checked: on, disabled: m.key === 'self', onchange: e => { sel.members = e.target.checked ? [...sel.members, m.key] : sel.members.filter(k => k !== m.key); change(); } }), `${m.label}${m.age ? ' · ' + m.age : ''}`);
              }))),
            visibleComps(prod).map(c => {
              const cs = sel.comps[c.id], on = cs.included || !c.optional;
              return h('div', { class: 'comp-row' + (on ? ' inc' : '') },
                h('div', null, h('strong', null, c.name), c.scope && h('div', { class: 'note' }, c.scope)),
                c.si ? h('label', { class: 'field' }, h('span', { class: 'lbl' }, c.si.label), h('select', { 'aria-label': c.name + ' ' + c.si.label, disabled: !on, value: String(cs.si), onchange: e => { cs.si = HOJ.coerce(e.target.value); change(); } }, c.si.options.map(o => h('option', { value: String(o) }, siLabel(c, o))))) : h('span'),
                c.opt ? h('label', { class: 'field' }, h('span', { class: 'lbl' }, c.opt.label), h('select', { 'aria-label': c.name + ' ' + c.opt.label, disabled: !on, value: cs.opt, onchange: e => { cs.opt = e.target.value; change(); } }, c.opt.options.map(o => h('option', { value: o }, o)))) : h('span'),
                c.optional ? h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: cs.included, 'aria-label': 'Include ' + c.name, onchange: e => { cs.included = e.target.checked; change(); } })) : h('span', { class: 'badge' }, 'Included'));
            }),
            h('div', { class: 'cta-row', style: 'justify-content:space-between;margin-top:8px' },
              h('button', { class: 'linkbtn', onclick: () => { sel.selected = false; rerender(); } }, `Remove ${prod.name} from my selection`))),
          quoteBox(prod)));
    };
    function productDesc(prod) {
      const c = ctx(), sel = S.selection[prod.id];
      if (prod.usesMembers) return `${sel ? sel.members.length : c.family_count} member(s)`;
      if (prod.usesTravellers) return `${c.family_count} traveller(s)`;
      if (prod.usesVehicles) return `${c.vehicle_count} vehicle(s)`;
      return '';
    }
    R.reviewList = () => {
      const pending = recsPending(); if (pending) return pending;
      const cust = enabledSteps().find(s => s.type === 'customise');
      return h('div', { class: 'card' }, recommendations().map(rec => {
        const p = rec.product, sel = ensureSelection(rec), q = S.quotes[p.id];
        return h('div', { class: 'rv-row' },
          h('strong', null, p.name), h('span', { class: 'muted' }, productDesc(p)), h('span', null, compSummary(p)),
          h('span', { class: 'amt' }, !sel.selected ? h('span', { class: 'muted' }, 'Not selected') : S.quoting[p.id] || !q ? h('span', { class: 'spinner' }) : q.err ? h('span', { class: 'bad' }, 'Error') : inr(q.res.total)),
          h('span', { class: 'rv-acts' },
            h('button', { class: 'btn small ' + (sel.selected ? 'ghost' : 'secondary'), onclick: () => { sel.selected = !sel.selected; S.formError = ''; quoteAllSelected(); rerender(); } }, sel.selected ? 'Remove' : 'Add'),
            sel.selected && cust && h('button', { class: 'btn small ghost', onclick: () => { S.custTab = p.id; goto(cust.id); } }, 'Edit')));
      }));
    };
    R.paymentSummary = () => {
      const t = totals(), n = selectedProducts().length, mock = selectedProducts().some(p => S.quotes[p.id] && S.quotes[p.id].res && S.quotes[p.id].res.mock);
      return h('div', { class: 'card summary' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('strong', null, 'Payment summary'), mock && h('span', { class: 'mockflag' }, 'MOCK RATES')),
        h('table', { class: 'lines' }, h('tbody', null,
          h('tr', null, h('td', null, `Premium (${n} product${n === 1 ? '' : 's'})`), h('td', null, t.pending ? '…' : inr(t.premium))),
          h('tr', null, h('td', null, 'GST'), h('td', null, t.pending ? '…' : inr(t.gst))),
          h('tr', { class: 'total' }, h('td', null, 'Total payable'), h('td', null, t.pending ? h('span', { class: 'spinner' }) : inr(t.total))))));
    };
    R.kycForm = () => h('div', { class: 'card' }, h('div', { class: 'grid4' }, [['pan', 'PAN'], ['mobile', 'Mobile number'], ['email', 'Email'], ['address', 'Address']].map(([k, l]) =>
      h('div', { class: 'field pre' }, h('label', { class: 'lbl', for: 'kyc-' + k }, h('span', null, l), h('span', { class: 'badge' }, 'Pre-filled')),
        h('input', { id: 'kyc-' + k, type: 'text', value: S.kyc[k] || '', oninput: e => { S.kyc[k] = e.target.value; } })))));
    R.consents = b => h('div', { class: 'card checks' }, h('strong', null, 'Declarations and consent'),
      (b.items || []).map((t, i) => h('label', null, h('input', { type: 'checkbox', checked: !!S.consents[i], onchange: e => { S.consents[i] = e.target.checked; S.payError = ''; rerender(); } }), h('span', null, t))),
      S.payError && h('div', { class: 'alert', role: 'alert', style: 'margin-top:8px' }, S.payError));
    R.wallet = () => h('div', { class: 'card' }, h('h3', { style: 'margin-bottom:6px' }, 'My Policies'),
      S.policies.length ? S.policies.map(p => h('div', { class: 'wallet-row' },
        h('div', null, h('strong', null, p.productName || p.product_name), h('div', { class: 'note' }, (p.policyNo || p.policy_no) ? 'Policy ' + (p.policyNo || p.policy_no) : 'Policy number on issuance')),
        h('span', { class: 'badge' + (p.status === 'Issued' ? '' : ' amber') }, p.status)))
      : h('p', { class: 'note' }, 'No policies yet.'));
    R.nextBestAction = () => {
      const bought = new Set(S.policies.map(p => p.productId || p.product_id)), nba = recommendations().find(r => !bought.has(r.product.id));
      if (!nba) return null;
      const rec = enabledSteps().find(s => s.type === 'recommend');
      return h('div', { class: 'card nba' }, h('strong', null, 'Next-best action'),
        h('p', null, `Complete your ${nba.product.name} insurance details — ${nba.headline.toLowerCase()}.`),
        h('button', { class: 'btn small', onclick: () => { Object.values(S.selection).forEach(s => { s.selected = false; }); S.selection[nba.product.id].selected = true; rec && goto(rec.id); } }, 'Continue'));
    };
    const renderBlock = b => { const fn = R[b.type]; return h('div', { class: 'block' }, fn ? fn(b) : h('div', { class: 'alert' }, 'Unknown block: ' + b.type)); };

    function draw() {
      const st = currentStep();
      if (!st) { root.replaceChildren(h('div', { class: 'alert' }, 'This journey has no enabled steps.')); return; }
      root.replaceChildren(h('div', null, st.blocks.map(renderBlock)), S.detail ? detailModal() : '');
    }

    return {
      mount(el) { root = el; goto(enabledSteps()[0] && enabledSteps()[0].id); },
      async loadPolicies() { try { S.policies = (await api.policies()).policies; } catch (e) { /* wallet shows empty */ } },
      /* preview (admin): render one step's blocks with sample data */
      setConfig(c) { cfg = c; S.recsKey = null; S.quotes = {}; S.selection = {}; },
      async preparePreview(stepId) {
        S.stepId = stepId;
        await loadProfile();
        const st = currentStep();
        if (st && ['recommend', 'customise', 'review', 'checkout'].includes(st.type) && S.profileStatus === 'ready' && await loadRecs()) {
          recommendations().forEach(r => { const s = ensureSelection(r); s.selected = s.selected || st.type !== 'recommend'; }); quoteAllSelected();
        }
      },
      renderPreview(stepId) {
        S.stepId = stepId; const st = currentStep();
        return st ? h('div', null, st.blocks.map(b => { try { return renderBlock(b); } catch (e) { return h('div', { class: 'alert' }, 'Preview error: ' + e.message); } })) : h('div', { class: 'alert' }, 'Step is disabled');
      }
    };
  };

  /* ---------------------------------------------------- portal app */
  HOJ.Portal = {
    async start(root, user) {
      const portalApi = {
        profile: () => HOJ.api('/api/profile/me'),
        recommend: profile => HOJ.api('/api/recommendations', { method: 'POST', body: { profile } }),
        quote: (productId, selection) => HOJ.api('/api/quotes', { method: 'POST', body: { productId, selection } }),
        checkout: payload => HOJ.api('/api/checkout', { method: 'POST', body: payload }),
        policies: () => HOJ.api('/api/policies/me')
      };
      let cfg;
      try { cfg = (await HOJ.api('/api/journey-config')).config; }
      catch (e) { HOJ.fatal(root, e.message); return; }
      const main = h('main', { class: 'page' });
      root.replaceChildren(
        h('header', { class: 'portal-head' }, h('div', { class: 'in' },
          h('div', { class: 'logo' }, cfg.brand.name, h('small', null, cfg.brand.tagline)),
          h('nav', null, h('span', { class: 'who' }, user.name || user.email), h('button', { class: 'linkbtn', onclick: () => HOJ.signOut('portal') }, 'Sign out')))),
        main);
      const j = HOJ.createJourney({ config: cfg, api: portalApi, mode: 'live' });
      await j.loadPolicies();
      j.mount(main);
    }
  };
})();
