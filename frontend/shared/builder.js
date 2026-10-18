/* HindujaOneJourney — admin console (workflow builder).
   Edits are saved to a server-side DRAFT. Customers keep seeing the last
   PUBLISHED version until an admin presses Publish; the portal picks up the
   new version on its next page load (no redeploy). */
'use strict';
(function () {
  const HOJ = window.HOJ, h = HOJ.h, clone = HOJ.clone, coerce = HOJ.coerce;
  const OPS = ['==', '!=', '<', '<=', '>', '>='];
  const BLOCKS = {
    hero: { label: 'Hero / how it works', props: [] }, stepHeader: { label: 'Step header', props: [] },
    heading: { label: 'Heading', props: ['text'], defaults: { text: 'New heading' } },
    paragraph: { label: 'Paragraph', props: ['text'], defaults: { text: 'Some explanatory text.' } },
    banner: { label: 'Info banner', props: ['text'], defaults: { text: 'Helpful message for the customer.' } },
    note: { label: 'Small note', props: ['text'], defaults: { text: 'Small print.' } },
    profileForm: { label: 'Profile form', props: [] }, recommendationCards: { label: 'Recommendation cards', props: [] },
    customisePanel: { label: 'Customise panel', props: [] }, reviewList: { label: 'Review list', props: [] },
    paymentSummary: { label: 'Payment summary', props: [] }, kycForm: { label: 'KYC details', props: [] },
    consents: { label: 'Consent checkboxes', props: ['items'], defaults: { items: ['I agree to the terms'] } },
    wallet: { label: 'Policy wallet', props: [] }, nextBestAction: { label: 'Next-best action', props: [] },
    cta: { label: 'Button', props: ['label', 'action'], defaults: { label: 'Continue', action: 'next' } }
  };
  const PREFILL_KEYS = ['employee.name', 'employee.age', 'spouse.covered', 'spouse.age', 'children.count', 'children.ages', 'parents.covered', 'gmc.sumInsuredLakh', 'gmc.members',
    'personalHealth.status', 'address.pincode', 'vehicles.twoWheeler.owned', 'vehicles.twoWheeler.reg', 'vehicles.fourWheeler.owned', 'vehicles.fourWheeler.reg',
    'travel.international', 'travel.tripsPerYear', 'home.owned', 'home.pincode'];
  const rid = p => p + '_' + Math.random().toString(36).slice(2, 7);

  let root, A;

  /* ------------------------------------------------------- server sync */
  async function loadAll() {
    const res = await HOJ.api('/admin/api/config');
    Object.assign(A, { cfg: res.draft.body, basedOn: res.draft.basedOn, published: res.published, hasUnpublished: res.hasUnpublishedChanges, draftBy: res.draft.updatedBy });
    if (!A.sampleValues) A.sampleValues = (await HOJ.api('/admin/api/sample-profile')).values;
    A.saveErrors = []; A.saveState = ''; refreshRulePreview();
  }
  let saveTimer;
  function mutate(fn) {
    fn(A.cfg); A.hasUnpublished = true; A.saveState = 'Saving…'; render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const res = await HOJ.api('/admin/api/config/draft', { method: 'PUT', body: { config: A.cfg, basedOn: A.basedOn } });
        A.saveErrors = res.errors; A.saveState = 'Draft saved';
        refreshRulePreview();
      } catch (e) { A.saveState = 'Not saved: ' + e.message; }
      render();
    }, 500);
  }
  function sampleProfile() {
    const p = {};
    for (const [fid, f] of Object.entries(A.cfg.fields)) p[fid] = f.prefill && A.sampleValues[f.prefill] !== undefined ? A.sampleValues[f.prefill] : (f.type === 'toggle' ? false : '');
    return p;
  }
  async function refreshRulePreview() {
    try { A.ruleHits = new Set((await HOJ.api('/admin/api/preview/recommendations', { method: 'POST', body: { config: A.cfg, profile: sampleProfile() } })).recommendations.map(r => r.ruleId)); }
    catch (e) { A.ruleHits = null; }
    render();
  }
  async function publish() {
    if (A.saveErrors.length) { alert('Fix the listed problems before publishing.'); return; }
    const note = prompt('Publish this draft to all customers?\n\nOptional note for the version history:', '');
    if (note === null) return;
    clearTimeout(saveTimer);
    try {
      await HOJ.api('/admin/api/config/draft', { method: 'PUT', body: { config: A.cfg, basedOn: A.basedOn } });
      const res = await HOJ.api('/admin/api/config/publish', { method: 'POST', body: { note } });
      A.flash = `Version ${res.version} is live. Customers get it on their next page load.`;
      await loadAll(); A.versions = null;
    } catch (e) { alert(e.message + (e.data && e.data.errors ? '\n\n• ' + e.data.errors.join('\n• ') : '')); }
    render();
  }
  async function discard() {
    if (!confirm('Discard all unpublished changes and go back to the live version?')) return;
    clearTimeout(saveTimer);
    await HOJ.api('/admin/api/config/draft', { method: 'DELETE' });
    await loadAll(); A.flash = 'Draft discarded.'; render();
  }

  /* ---------------------------------------------------------- DnD */
  let DRAG = null;
  function draggable(payload, attrs = {}) {
    return { ...attrs, draggable: 'true', ondragstart: e => { DRAG = payload; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'x'); } catch (_) { /* old browsers */ } },
      ondragend: () => { DRAG = null; document.querySelectorAll('.over,.dropbefore').forEach(n => n.classList.remove('over', 'dropbefore')); } };
  }
  function dropList(onDrop, accept, kids) {
    const el = h('div', { class: 'dnd-list',
      ondragover: e => { if (!DRAG || !accept(DRAG)) return; e.preventDefault(); el.classList.add('over');
        el.querySelectorAll(':scope > .item').forEach(n => n.classList.remove('dropbefore'));
        const t = e.target.closest('.item'); if (t && t.parentNode === el) t.classList.add('dropbefore'); },
      ondragleave: e => { if (!el.contains(e.relatedTarget)) { el.classList.remove('over'); el.querySelectorAll('.dropbefore').forEach(n => n.classList.remove('dropbefore')); } },
      ondrop: e => { if (!DRAG || !accept(DRAG)) return; e.preventDefault(); const items = [...el.querySelectorAll(':scope > .item')], t = e.target.closest('.item');
        const idx = t && t.parentNode === el ? items.indexOf(t) : items.length; const p = DRAG; DRAG = null; onDrop(p, idx); } }, kids);
    return el;
  }
  const moveIn = (arr, from, to) => { const [x] = arr.splice(from, 1); arr.splice(to > from ? to - 1 : to, 0, x); };
  const upDown = (arr, i) => [
    h('button', { class: 'iconbtn', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: e => { e.stopPropagation(); mutate(() => moveIn(arr, i, i - 1)); } }, '↑'),
    h('button', { class: 'iconbtn', title: 'Move down', 'aria-label': 'Move down', disabled: i === arr.length - 1, onclick: e => { e.stopPropagation(); mutate(() => moveIn(arr, i, i + 2)); } }, '↓')];

  /* --------------------------------------------------------- tabs */
  function stepsTab() {
    const cfg = A.cfg, sel = cfg.steps.find(s => s.id === A.layoutStep) || cfg.steps[0];
    return h('div', { class: 'cols two' },
      h('div', { class: 'panel' }, h('h3', null, 'Journey steps — drag to reorder'),
        dropList((p, idx) => mutate(c => moveIn(c.steps, c.steps.findIndex(s => s.id === p.id), idx)), p => p.kind === 'step',
          cfg.steps.map((s, i) => h('div', draggable({ kind: 'step', id: s.id }, { class: 'item' + (s.enabled ? '' : ' off') + (s.id === sel.id ? ' selected' : ''), onclick: () => { A.layoutStep = s.id; render(); } }),
            h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
            h('div', { class: 'grow' }, h('strong', null, s.title), h('div', { class: 'sub' }, `${s.type} · ${s.blocks.length} blocks${s.counted ? ' · counted in "Step x of y"' : ''}`)),
            h('label', { class: 'switch', onclick: e => e.stopPropagation() }, h('input', { type: 'checkbox', checked: s.enabled, 'aria-label': 'Enable ' + s.title, onchange: e => mutate(() => { s.enabled = e.target.checked; }) })),
            upDown(cfg.steps, i)))),
        h('p', { class: 'note' }, 'Core steps (profile, recommend, review, checkout, done) must stay enabled and in order; problems are listed at the top and block publishing. Intro and Customise are optional.')),
      h('div', { class: 'panel' }, h('h3', null, 'Step settings'),
        h('div', { class: 'form-grid' },
          h('label', null, 'Title', h('input', { value: sel.title, onchange: e => mutate(() => { sel.title = e.target.value; }) })),
          h('label', null, 'Subtitle', h('textarea', { rows: 3, onchange: e => mutate(() => { sel.subtitle = e.target.value; }) }, sel.subtitle || '')),
          h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: sel.counted, onchange: e => mutate(() => { sel.counted = e.target.checked; }) }), 'Count in "Step x of y"'),
          !sel.counted && h('label', null, 'Chip text (when not counted)', h('input', { value: sel.chip || '', onchange: e => mutate(() => { sel.chip = e.target.value; }) })),
          h('button', { class: 'btn small ghost', onclick: () => { A.tab = 'layout'; render(); } }, 'Edit this screen\'s layout →'))));
  }

  function condRow(c, fieldIds, onRemove) {
    return h('div', { class: 'cond' },
      h('select', { 'aria-label': 'Field', value: c.field, onchange: e => mutate(() => { c.field = e.target.value; }) }, [...fieldIds, 'family_count', 'vehicle_count'].map(id => h('option', { value: id }, (A.cfg.fields[id] && A.cfg.fields[id].label) || id))),
      h('select', { 'aria-label': 'Operator', value: c.op, onchange: e => mutate(() => { c.op = e.target.value; }) }, OPS.map(o => h('option', { value: o }, o))),
      h('input', { 'aria-label': 'Value', value: String(c.value), onchange: e => mutate(() => { c.value = coerce(e.target.value); }) }),
      h('button', { class: 'iconbtn', 'aria-label': 'Remove condition', onclick: onRemove }, '✕'));
  }

  function profileTab() {
    const cfg = A.cfg, allIds = Object.keys(cfg.fields), f = cfg.fields[A.selField];
    const dropField = sec => (p, idx) => mutate(c => {
      let id = p.id;
      if (p.kind === 'newField') { id = rid('custom'); c.fields[id] = { label: 'New ' + p.type + ' field', type: p.type, options: p.type === 'select' ? ['Option A', 'Option B'] : undefined }; A.selField = id; }
      else { const from = c.sections.find(s => s.id === p.sec); const fi = from.fields.indexOf(id); if (from.id === sec.id && fi < idx) idx--; from.fields.splice(fi, 1); }
      c.sections.find(s => s.id === sec.id).fields.splice(idx, 0, id);
    });
    return h('div', { class: 'cols' },
      h('div', { class: 'panel' }, h('h3', null, 'Field palette'), h('p', { class: 'note', style: 'margin-top:0' }, 'Drag into a section.'),
        [['text', 'Text'], ['number', 'Number'], ['toggle', 'Yes / No toggle'], ['select', 'Dropdown']].map(([t, l]) => h('div', draggable({ kind: 'newField', type: t }, { class: 'palette-item' }), '+ ' + l))),
      h('div', { class: 'panel' }, h('h3', null, 'Profile sections'),
        cfg.sections.map((sec, si) => h('div', { class: 'sectionbox' },
          h('div', { class: 'sh' }, h('span', { class: 'chip' }, si + 1), h('input', { value: sec.title, 'aria-label': 'Section title', onchange: e => mutate(() => { sec.title = e.target.value; }) }),
            upDown(cfg.sections, si),
            h('button', { class: 'iconbtn', title: 'Delete section', 'aria-label': 'Delete section', onclick: () => { if (sec.fields.length && !confirm('Delete this section and remove its fields from the form?')) return; mutate(c => c.sections.splice(si, 1)); } }, '✕')),
          dropList(dropField(sec), p => p.kind === 'field' || p.kind === 'newField',
            sec.fields.map((fid, fi) => { const fd = cfg.fields[fid]; if (!fd) return null;
              return h('div', draggable({ kind: 'field', id: fid, sec: sec.id }, { class: 'item' + (A.selField === fid ? ' selected' : ''), onclick: () => { A.selField = fid; render(); } }),
                h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
                h('div', { class: 'grow' }, h('strong', null, fd.label), h('div', { class: 'sub' }, [fd.type, fd.prefill && 'pre-filled', fd.required && 'required', fd.showIf && `if ${fd.showIf.field} ${fd.showIf.op} ${fd.showIf.value}`].filter(Boolean).join(' · '))),
                upDown(sec.fields, fi)); })))),
        h('button', { class: 'btn small ghost', onclick: () => mutate(c => c.sections.push({ id: rid('sec'), title: 'New section', fields: [] })) }, '+ Add section')),
      h('div', { class: 'panel' }, h('h3', null, 'Field properties'),
        !f ? h('p', { class: 'note' }, 'Select a field to edit it.') : h('div', { class: 'form-grid' },
          h('label', null, 'Field id (used in rules)', h('input', { value: A.selField, disabled: true })),
          h('label', null, 'Label', h('input', { value: f.label, onchange: e => mutate(() => { f.label = e.target.value; }) })),
          h('label', null, 'Section', h('select', { value: (cfg.sections.find(s => s.fields.includes(A.selField)) || {}).id || '', onchange: e => mutate(c => { c.sections.forEach(s => { s.fields = s.fields.filter(x => x !== A.selField); }); c.sections.find(s => s.id === e.target.value).fields.push(A.selField); }) },
            cfg.sections.map(s => h('option', { value: s.id }, s.title)))),
          h('label', null, 'Type', h('select', { value: f.type, onchange: e => mutate(() => { f.type = e.target.value; if (f.type === 'select' && !f.options) f.options = ['Option A']; }) }, ['text', 'number', 'toggle', 'select'].map(t => h('option', { value: t }, t)))),
          f.type === 'select' && h('label', null, 'Options (comma separated)', h('input', { value: (f.options || []).join(', '), onchange: e => mutate(() => { f.options = e.target.value.split(',').map(s => s.trim()).filter(Boolean); }) })),
          h('label', null, 'Pre-fill from (profile API key)', h('select', { value: f.prefill || '', onchange: e => mutate(() => { f.prefill = e.target.value || undefined; }) }, h('option', { value: '' }, '— none —'), PREFILL_KEYS.map(k => h('option', { value: k }, k)))),
          h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!f.required, onchange: e => mutate(() => { f.required = e.target.checked; }) }), 'Required'),
          h('label', null, 'Prefix / suffix', h('div', { style: 'display:flex;gap:6px' },
            h('input', { placeholder: 'prefix', value: f.prefix || '', onchange: e => mutate(() => { f.prefix = e.target.value || undefined; }) }),
            h('input', { placeholder: 'suffix', value: f.suffix || '', onchange: e => mutate(() => { f.suffix = e.target.value || undefined; }) }))),
          h('label', null, 'Help text', h('input', { value: f.help || '', onchange: e => mutate(() => { f.help = e.target.value || undefined; }) })),
          h('div', null, h('div', { class: 'minihead' }, 'Show only if'),
            f.showIf ? condRow(f.showIf, allIds.filter(x => x !== A.selField), () => mutate(() => { delete f.showIf; }))
                     : h('button', { class: 'btn small ghost', onclick: () => mutate(() => { f.showIf = { field: allIds[0], op: '==', value: true }; }) }, '+ Add condition')),
          h('button', { class: 'btn small ghost danger', onclick: () => {
            const used = cfg.rules.some(r => r.when.some(c => c.field === A.selField));
            if (!confirm(used ? 'A recommendation rule uses this field. Remove it anyway? (The rule will show an error until fixed.)' : 'Remove this field?')) return;
            mutate(c => { c.sections.forEach(s => { s.fields = s.fields.filter(x => x !== A.selField); }); delete c.fields[A.selField]; A.selField = null; }); } }, 'Remove field'))));
  }

  function rulesTab() {
    const cfg = A.cfg, fieldIds = Object.keys(cfg.fields);
    return h('div', { class: 'cols two' },
      h('div', null,
        h('p', { class: 'note', style: 'margin-top:0' }, 'Rules run on the server, top to bottom; the first matching rule for a product decides its tag and "why recommended" text. Drag the ⋮⋮ handle to change priority. Use {field_id}, {family_count} or {vehicle_count} in text.'),
        dropList((p, idx) => mutate(c => moveIn(c.rules, c.rules.findIndex(r => r.id === p.id), idx)), p => p.kind === 'rule',
          cfg.rules.map((r, i) => {
            const hit = A.ruleHits && A.ruleHits.has(r.id);
            return h('div', { class: 'item rule' + (hit ? ' match' : '') },
              h('div', { class: 'rule-head' }, h('span', draggable({ kind: 'rule', id: r.id }, { class: 'grip', title: 'Drag to change priority' }), '⋮⋮'),
                h('input', { class: 'input strong', value: r.name, 'aria-label': 'Rule name', onchange: e => mutate(() => { r.name = e.target.value; }) }),
                A.ruleHits && h('span', { class: hit ? 'badge' : 'badge amber' }, hit ? 'Used for sample profile' : 'Not used for sample'),
                h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': 'Enable rule', onchange: e => mutate(() => { r.enabled = e.target.checked; }) })),
                upDown(cfg.rules, i),
                h('button', { class: 'iconbtn', 'aria-label': 'Delete rule', onclick: () => confirm('Delete this rule?') && mutate(c => c.rules.splice(i, 1)) }, '✕')),
              h('div', { class: 'form-grid three' },
                h('label', null, 'When', h('select', { value: r.match, onchange: e => mutate(() => { r.match = e.target.value; }) }, h('option', { value: 'all' }, 'ALL conditions match'), h('option', { value: 'any' }, 'ANY condition matches'))),
                h('label', null, 'Then recommend', h('select', { value: r.product, onchange: e => mutate(() => { r.product = e.target.value; }) }, cfg.catalogue.map(p => h('option', { value: p.id }, p.name)))),
                h('label', null, 'Tag as', h('select', { value: r.tag, onchange: e => mutate(() => { r.tag = e.target.value; }) }, Object.keys(cfg.tags).map(t => h('option', { value: t }, t))))),
              h('div', { style: 'margin:8px 0' }, r.when.map((c, ci) => condRow(c, fieldIds, () => mutate(() => r.when.splice(ci, 1)))),
                h('button', { class: 'btn small ghost', onclick: () => mutate(() => r.when.push({ field: fieldIds[0], op: '==', value: true })) }, '+ Condition')),
              h('div', { class: 'form-grid' },
                h('label', null, 'Card headline', h('input', { value: r.headline, onchange: e => mutate(() => { r.headline = e.target.value; }) })),
                h('label', null, '"Why recommended" points (one per line)', h('textarea', { rows: 3, onchange: e => mutate(() => { r.reasons = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); }) }, r.reasons.join('\n')))));
          })),
        h('button', { class: 'btn small ghost', onclick: () => mutate(c => c.rules.push({ id: rid('r'), name: 'New rule', enabled: true, match: 'all', when: [], product: c.catalogue[0].id, tag: 'Relevant', headline: 'Why this is relevant', reasons: [] })) }, '+ Add rule')),
      h('div', { class: 'panel' }, h('h3', null, 'Tags'),
        Object.entries(cfg.tags).map(([t, v]) => h('div', { class: 'item static' }, h('span', { class: 'tag ' + v.tone }, t), h('div', { class: 'grow' }),
          h('label', { class: 'inline small' }, h('input', { type: 'checkbox', checked: v.preselect, onchange: e => mutate(() => { v.preselect = e.target.checked; }) }), 'Pre-selected'))),
        h('label', { class: 'switch', style: 'margin-top:10px' }, h('input', { type: 'checkbox', checked: cfg.showUnmatched, onchange: e => mutate(c => { c.showUnmatched = e.target.checked; }) }), h('span', null, 'Show products no rule matched (as Optional)')),
        h('h3', { style: 'margin-top:16px' }, 'Sample profile used for testing'),
        h('pre', null, JSON.stringify(HOJ.context(sampleProfile()), null, 2))));
  }

  function catalogueTab() {
    const csv = a => (a || []).join(', '), parse = s => s.split(',').map(x => coerce(x.trim())).filter(x => x !== '');
    return h('div', null, h('p', { class: 'note', style: 'margin-top:0' }, '"Code" values are sent to the rating and policy systems — IT maps them to the real product/cover codes. GST % is applied by the backend; confirm the current rate for each product with Finance before go-live.'),
      A.cfg.catalogue.map(p => h('div', { class: 'panel', style: 'margin-bottom:14px' },
        h('div', { class: 'prodhead' },
          h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: p.enabled, 'aria-label': 'Enable ' + p.name, onchange: e => mutate(() => { p.enabled = e.target.checked; }) })),
          h('input', { class: 'input strong', style: 'max-width:200px', value: p.name, 'aria-label': 'Product name', onchange: e => mutate(() => { p.name = e.target.value; }) }),
          h('label', { class: 'note' }, 'Code ', h('input', { class: 'input', style: 'width:120px', value: p.code, onchange: e => mutate(() => { p.code = e.target.value; }) })),
          h('label', { class: 'note' }, 'GST % ', h('input', { class: 'input', type: 'number', style: 'width:80px', value: p.gstPct, onchange: e => mutate(() => { p.gstPct = +e.target.value; }) }))),
        h('div', { class: 'scroll-x' }, h('table', { class: 'prodtable' },
          h('thead', null, h('tr', null, ['Cover', 'Code', 'Optional', 'Included by default', 'Amount label', 'Amount options', 'Default', 'Option label', 'Options', 'Default', ''].map(t => h('th', null, t)))),
          h('tbody', null, p.components.map((c, ci) => h('tr', null,
            h('td', null, h('input', { value: c.name, 'aria-label': 'Cover name', onchange: e => mutate(() => { c.name = e.target.value; }) })),
            h('td', null, h('input', { value: c.code, 'aria-label': 'Cover code', onchange: e => mutate(() => { c.code = e.target.value; }) })),
            h('td', null, h('input', { type: 'checkbox', checked: c.optional, 'aria-label': 'Optional', onchange: e => mutate(() => { c.optional = e.target.checked; }) })),
            h('td', null, h('input', { type: 'checkbox', checked: c.included, 'aria-label': 'Included by default', onchange: e => mutate(() => { c.included = e.target.checked; }) })),
            h('td', null, h('input', { value: c.si ? c.si.label : '', placeholder: '—', onchange: e => mutate(() => { if (!e.target.value) delete c.si; else (c.si = c.si || { unit: '', options: [1], default: 1 }).label = e.target.value; }) })),
            h('td', null, c.si && h('input', { value: csv(c.si.options), onchange: e => mutate(() => { c.si.options = parse(e.target.value); if (!c.si.options.includes(c.si.default)) c.si.default = c.si.options[0]; }) })),
            h('td', null, c.si && h('select', { value: String(c.si.default), onchange: e => mutate(() => { c.si.default = coerce(e.target.value); }) }, c.si.options.map(o => h('option', { value: String(o) }, o)))),
            h('td', null, h('input', { value: c.opt ? c.opt.label : '', placeholder: '—', onchange: e => mutate(() => { if (!e.target.value) delete c.opt; else (c.opt = c.opt || { options: ['Standard'], default: 'Standard' }).label = e.target.value; }) })),
            h('td', null, c.opt && h('input', { value: csv(c.opt.options), onchange: e => mutate(() => { c.opt.options = e.target.value.split(',').map(s => s.trim()).filter(Boolean); if (!c.opt.options.includes(c.opt.default)) c.opt.default = c.opt.options[0]; }) })),
            h('td', null, c.opt && h('select', { value: c.opt.default, onchange: e => mutate(() => { c.opt.default = e.target.value; }) }, c.opt.options.map(o => h('option', { value: o }, o)))),
            h('td', null, h('button', { class: 'iconbtn', 'aria-label': 'Remove cover', onclick: () => confirm('Remove this cover?') && mutate(() => p.components.splice(ci, 1)) }, '✕'))))))),
        h('button', { class: 'btn small ghost', style: 'margin-top:8px', onclick: () => mutate(() => p.components.push({ id: rid('c'), code: 'NEW-COVER', name: 'New cover', optional: true, included: false, rate: 'pa', si: { label: 'Sum insured', unit: 'lakh', options: [5, 10], default: 5 } })) }, '+ Add cover'))));
  }

  /* layout + live preview (renders the real journey components with the draft and a sample profile) */
  let preview = null, previewKey = null, previewProfile = null;
  function previewJourney() {
    if (preview) return preview;
    const papi = {
      profile: () => HOJ.api('/admin/api/sample-profile'),
      recommend: profile => { previewProfile = profile; return HOJ.api('/admin/api/preview/recommendations', { method: 'POST', body: { config: A.cfg, profile } }); },
      quote: (productId, selection) => HOJ.api('/admin/api/preview/quote', { method: 'POST', body: { config: A.cfg, productId, selection, profile: previewProfile } }),
      checkout: async () => { throw new HOJ.ApiError('Checkout is disabled in preview', 400); },
      policies: async () => ({ policies: [] })
    };
    return (preview = HOJ.createJourney({ config: clone(A.cfg), api: papi, mode: 'preview', onChange: () => { if (A.tab === 'layout') render(); } }));
  }
  function layoutTab() {
    const st = A.cfg.steps.find(s => s.id === A.layoutStep) || A.cfg.steps[0], blk = st.blocks.find(b => b.id === A.selBlock);
    const onDrop = (p, idx) => mutate(() => {
      if (p.kind === 'newBlock') { const b = { id: rid('b'), type: p.type, ...clone(BLOCKS[p.type].defaults || {}) }; st.blocks.splice(idx, 0, b); A.selBlock = b.id; }
      else moveIn(st.blocks, st.blocks.findIndex(b => b.id === p.id), idx);
    });
    const pj = previewJourney(), key = JSON.stringify(A.cfg) + st.id;
    if (key !== previewKey) { previewKey = key; pj.setConfig(clone(A.cfg)); pj.preparePreview(st.id).then(() => render()); }
    return h('div', { class: 'cols layout' },
      h('div', { class: 'panel' }, h('h3', null, 'Components'), h('p', { class: 'note', style: 'margin-top:0' }, 'Drag onto the screen.'),
        Object.entries(BLOCKS).map(([t, d]) => h('div', draggable({ kind: 'newBlock', type: t }, { class: 'palette-item' }), '+ ' + d.label))),
      h('div', { class: 'panel' },
        h('div', { class: 'prodhead' }, h('h3', { style: 'margin:0' }, 'Screen'),
          h('select', { class: 'input', style: 'max-width:260px', 'aria-label': 'Screen', value: st.id, onchange: e => { A.layoutStep = e.target.value; A.selBlock = null; render(); } }, A.cfg.steps.map(s => h('option', { value: s.id }, s.title)))),
        dropList(onDrop, p => p.kind === 'block' || p.kind === 'newBlock',
          st.blocks.map((b, i) => h('div', draggable({ kind: 'block', id: b.id }, { class: 'item' + (b.id === A.selBlock ? ' selected' : ''), onclick: () => { A.selBlock = b.id; render(); } }),
            h('span', { class: 'grip' }, '⋮⋮'), h('div', { class: 'grow' }, h('strong', null, (BLOCKS[b.type] || {}).label || b.type), h('div', { class: 'sub' }, b.text || b.label || (b.items ? b.items.length + ' items' : ''))),
            upDown(st.blocks, i), h('button', { class: 'iconbtn', 'aria-label': 'Remove block', onclick: e => { e.stopPropagation(); mutate(() => st.blocks.splice(i, 1)); } }, '✕')))),
        blk && h('div', { class: 'form-grid boxed' }, h('strong', null, 'Block properties'),
          (BLOCKS[blk.type] || { props: [] }).props.length ? BLOCKS[blk.type].props.map(pr =>
            pr === 'items' ? h('label', null, 'Items (one per line)', h('textarea', { rows: 4, onchange: e => mutate(() => { blk.items = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); }) }, (blk.items || []).join('\n')))
            : pr === 'action' ? h('label', null, 'Action', h('select', { value: blk.action, onchange: e => mutate(() => { blk.action = e.target.value; }) }, [['next', 'Go to next step'], ['prev', 'Go to previous step'], ['pay', 'Pay (KYC → payment → issue)']].map(([v, l]) => h('option', { value: v }, l))))
            : h('label', null, pr[0].toUpperCase() + pr.slice(1), h('input', { value: blk[pr] || '', onchange: e => mutate(() => { blk[pr] = e.target.value; }) })))
            : h('p', { class: 'note' }, 'This component is data-driven; its content comes from the profile, rules and catalogue.'))),
      h('div', null, h('h3', { class: 'minihead' }, 'Live preview (sample profile, draft config)'), h('div', { class: 'preview' }, h('div', { class: 'scale' }, pj.renderPreview(st.id)))));
  }

  async function lazy(key, url, pick) { if (A[key] == null) { A[key] = 'loading'; try { A[key] = pick(await HOJ.api(url)); } catch (e) { A[key] = { error: e.message }; } render(); } }
  function publishTab() {
    lazy('versions', '/admin/api/config/versions', r => r.versions);
    const v = A.versions;
    return h('div', { class: 'cols two' },
      h('div', { class: 'panel' }, h('h3', null, 'Version history'),
        v === 'loading' ? h('span', { class: 'spinner' }) : v.error ? h('div', { class: 'alert' }, v.error) :
        h('table', { class: 'prodtable' }, h('thead', null, h('tr', null, ['Version', 'Published', 'By', 'Note', ''].map(t => h('th', null, t)))),
          h('tbody', null, v.map(x => h('tr', null, h('td', null, h('strong', null, 'v' + x.version), x.version === A.published.version && h('span', { class: 'badge', style: 'margin-left:6px' }, 'LIVE')),
            h('td', null, new Date(x.publishedAt).toLocaleString()), h('td', null, x.publishedBy), h('td', null, x.note || ''),
            h('td', null, x.version !== A.published.version && h('button', { class: 'btn small ghost', onclick: async () => {
              if (!confirm(`Make version ${x.version} live again? This publishes it as a new version; your current draft is discarded.`)) return;
              try { const r = await HOJ.api('/admin/api/config/rollback', { method: 'POST', body: { version: x.version } }); A.flash = `Rolled back — version ${r.version} is live.`; await loadAll(); A.versions = null; } catch (e) { alert(e.message); }
              render(); } }, 'Roll back to this'))))))),
      h('div', { class: 'panel' }, h('h3', null, 'Import / export'),
        h('p', { class: 'note' }, 'Export the draft as JSON to back it up or move it between environments (e.g. UAT → production). Importing replaces the current draft; it still needs Publish.'),
        h('div', { class: 'cta-row', style: 'justify-content:flex-start' },
          h('button', { class: 'btn small ghost', onclick: () => {
            const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(A.cfg, null, 2)], { type: 'application/json' })), download: 'journey-config.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); } }, 'Export draft JSON'),
          h('button', { class: 'btn small ghost', onclick: () => {
            const inp = h('input', { type: 'file', accept: 'application/json' });
            inp.onchange = async () => { try { const c = JSON.parse(await inp.files[0].text()); if (!c.steps || !c.rules) throw new Error('not a journey config'); mutate(() => { A.cfg = c; }); } catch (e) { alert('Import failed: ' + e.message); } };
            inp.click(); } }, 'Import JSON into draft'))));
  }
  function activityTab() {
    lazy('activity', '/admin/api/activity', r => r);
    const a = A.activity;
    if (a === 'loading') return h('span', { class: 'spinner' });
    if (a.error) return h('div', { class: 'alert' }, a.error);
    return h('div', { class: 'cols two' },
      h('div', { class: 'panel' }, h('h3', null, 'Recent recommendations (leads)'), !a.leads.length ? h('p', { class: 'note' }, 'None yet.') :
        h('table', { class: 'prodtable' }, h('thead', null, h('tr', null, ['When', 'Employee', 'Config', 'Recommended'].map(t => h('th', null, t)))),
          h('tbody', null, a.leads.map(l => h('tr', null, h('td', null, new Date(l.at).toLocaleString()), h('td', null, l.user), h('td', null, 'v' + l.configVersion), h('td', null, l.recommended.join(', '))))))),
      h('div', { class: 'panel' }, h('h3', null, 'Recent policies'), !a.policies.length ? h('p', { class: 'note' }, 'None yet.') :
        h('table', { class: 'prodtable' }, h('thead', null, h('tr', null, ['When', 'Product', 'Status', 'Premium'].map(t => h('th', null, t)))),
          h('tbody', null, a.policies.map(p => h('tr', null, h('td', null, new Date(p.created_at).toLocaleString()), h('td', null, p.product_name), h('td', null, p.status), h('td', null, HOJ.inr(p.total))))))),
      h('button', { class: 'btn small ghost', onclick: () => { A.activity = null; render(); } }, 'Refresh'));
  }
  function logsTab() {
    lazy('logs', '/admin/api/logs', r => r.calls);
    const l = A.logs;
    if (l === 'loading') return h('span', { class: 'spinner' });
    if (l.error) return h('div', { class: 'alert' }, l.error);
    return h('div', null, h('div', { class: 'prodhead' }, h('p', { class: 'note', style: 'margin:0' }, 'Calls from the backend to the integration adapters (currently all MOCK). PAN, mobile and e-mail are masked. Kept in memory only (last 200).'),
      h('button', { class: 'btn small ghost', style: 'margin-left:auto', onclick: () => { A.logs = null; render(); } }, 'Refresh')),
      !l.length ? h('p', { class: 'note' }, 'No calls yet — walk through the customer portal to generate some.') :
      l.map(c => h('details', { class: 'log' }, h('summary', null, h('span', { class: 'method' }, c.operation), h('strong', null, c.system), h('span', { class: c.error ? 'bad' : 'ok', style: 'margin-left:auto' }, c.error ? 'ERROR' : 'OK'), h('span', { class: 'note' }, `${c.ms} ms · ${new Date(c.at).toLocaleTimeString()}`)),
        h('div', { class: 'note' }, 'Request'), h('pre', null, JSON.stringify(c.request, null, 2)),
        h('div', { class: 'note' }, 'Response'), h('pre', null, c.error || JSON.stringify(c.response, null, 2)),
        c.soapRequest && [h('div', { class: 'note' }, 'SOAP request (illustrative — the real envelope comes from the WSDL)'), h('pre', null, c.soapRequest)])));
  }

  /* --------------------------------------------------------- shell */
  const TABS = [['steps', 'Journey steps', stepsTab], ['profile', 'Profile questions', profileTab], ['rules', 'Recommendation rules', rulesTab],
    ['catalogue', 'Product catalogue', catalogueTab], ['layout', 'Screen layout', layoutTab], ['publish', 'Versions & publish', publishTab],
    ['activity', 'Activity', activityTab], ['logs', 'Integration log', logsTab]];

  function render() {
    if (!A.cfg) return;
    const y = window.scrollY, tab = TABS.find(t => t[0] === A.tab) || TABS[0];
    root.replaceChildren(
      h('header', { class: 'admin-top' }, h('span', { class: 'name' }, 'Journey admin console'), h('span', { class: 'who' }, A.user.name || A.user.email),
        h('button', { class: 'linkbtn light', onclick: () => HOJ.signOut('admin') }, 'Sign out')),
      h('main', { class: 'bld' },
        h('div', { class: 'bld-head' },
          h('div', { class: 'grow' }, h('h1', null, 'Workflow builder'),
            h('div', { class: 'note' }, `Live: version ${A.published.version} (published ${new Date(A.published.publishedAt).toLocaleString()} by ${A.published.publishedBy}). `,
              A.hasUnpublished ? h('strong', { class: 'amber-text' }, 'You have unpublished changes.') : 'Draft matches the live version.', A.saveState && ' · ' + A.saveState)),
          A.hasUnpublished && h('button', { class: 'btn small ghost', onclick: discard }, 'Discard draft'),
          h('button', { class: 'btn small', disabled: !A.hasUnpublished || A.saveErrors.length > 0, onclick: publish }, 'Publish to customers')),
        A.flash && h('div', { class: 'banner', style: 'margin-bottom:12px' }, A.flash, ' ', h('button', { class: 'linkbtn', onclick: () => { A.flash = ''; render(); } }, 'Dismiss')),
        A.saveErrors.length > 0 && h('div', { class: 'warn' }, h('strong', null, 'Fix before publishing:'), h('ul', null, A.saveErrors.map(e => h('li', null, e)))),
        h('div', { class: 'bld-tabs', role: 'tablist' }, TABS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(tab[0] === k), onclick: () => { A.tab = k; if (['publish', 'activity', 'logs'].includes(k)) A[{ publish: 'versions', activity: 'activity', logs: 'logs' }[k]] = null; render(); } }, l))),
        tab[2]()));
    window.scrollTo(0, y);
  }

  HOJ.Admin = {
    async start(el, user) {
      root = el; A = { user, tab: 'steps', layoutStep: 'profile', saveErrors: [], saveState: '', flash: '', ruleHits: null };
      root.replaceChildren(h('main', { class: 'bld' }, h('span', { class: 'spinner' }), ' Loading…'));
      try { await loadAll(); } catch (e) { HOJ.fatal(root, e.message); return; }
      render();
    }
  };
})();
